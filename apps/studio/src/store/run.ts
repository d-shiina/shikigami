// Runs in Writer: the state of a run, its trace and log, and the helpers
// that find where a run is on the chart.
import type { LogLevel, PauseReason, RunError, RunEventEnvelope, RunStatus, Flow, Step } from "@spellsheet/schema";
import type { RunEvidence, StepTestResult } from "../lib/api";
import { CALL } from "../lib/stepTypes";
import { emptyTrace, type RunTrace } from "../lib/runTrace";
import type { StudioState } from "./index";
import { findStep } from "./steps";

/** How Studio starts a run (`startRun`). */
export interface RunOptions {
  /** Pause before the first step. */
  step?: boolean;
  stopAt?: string;
  startAt?: string;
  startValues?: Record<string, unknown>;
  /** Values for the flow's inputs; leaving one out uses its default. */
  inputs?: Record<string, unknown>;
}

export type StepRunState = "running" | "succeeded" | "failed" | "skipped" | "paused";

/** Where an interactive run waits for the person (the Runtime's `paused` event). */
export type Pause = {
  seq: number;
  stepId: string;
  stepType: string;
  reason: PauseReason;
  /** Set when it paused because the step failed. */
  error: RunError | null;
  /** Every variable's value at that point (masked, previews for large ones). */
  variables: Record<string, unknown>;
  /** The flow revision the run executes. */
  revision: number;
  /** The `flow.call` steps it paused inside (outermost first); empty in the open flow. */
  callPath: string[];
};

export type LogEntry = {
  seq: number;
  at: string;
  level: LogLevel;
  message: string;
  stepId?: string | null;
  /** Inside a called flow: the call steps down to the flow `stepId` is in. */
  callPath?: string[];
  /** The node run (`RunTrace`) it belongs to; null or unset for the run itself. */
  node?: number | null;
  /** What the line marks in the run, drawn as its own row: start, end, pause, resume. */
  mark?: "start" | "end" | "pause" | "resume";
  /** A node's failure: the tree shows it on the node itself. */
  fromStep?: boolean;
};

/** A node anywhere a run went: `stepId` in the flow the calls of `path` lead to. */
export type StepPlace = { path: string[]; stepId: string };

/**
 * Where an error of the open flow's `stepId` happened: down inside the
 * called flow when it failed in there. `details.subFlow` names that flow and
 * (`callPath`) the calls below `stepId` that led to it. A record without the
 * calls is searched on the chart, and only a single route counts: one flow
 * called from two places could be either.
 */
export function errorPlace(root: Flow | null, called: Record<string, Flow>, stepId: string, details: unknown): StepPlace {
  const sub = details && typeof details === "object" ? (details as { subFlow?: { flowId?: unknown; stepId?: unknown; callPath?: unknown } }).subFlow : undefined;
  const flowId = typeof sub?.flowId === "string" ? sub.flowId : null;
  const inner = typeof sub?.stepId === "string" ? sub.stepId : null;
  const outer: StepPlace = { path: [], stepId };
  if (!root || !flowId || !inner) return outer;
  const leadsThere = (path: string[]) => {
    const chain = diveChain(root, called, path);
    const here = chain.length === path.length ? chain.at(-1)?.flow : undefined;
    return here?.id === flowId && findStep(here.steps ?? [], inner) !== null;
  };
  if (Array.isArray(sub?.callPath)) {
    const path = [stepId, ...sub.callPath.filter((id): id is string => typeof id === "string")];
    return leadsThere(path) ? { path, stepId: inner } : outer;
  }
  const calls = (steps: Step[]): string[] =>
    steps.flatMap((s) => [...(s.type === CALL && s.id ? [s.id] : []), ...Object.values(s.blocks ?? {}).flatMap(calls)]);
  const found: string[][] = [];
  const search = (path: string[]) => {
    if (found.length > 1) return;
    const chain = diveChain(root, called, path);
    if (chain.length !== path.length) return;
    if (leadsThere(path)) found.push(path);
    if (path.length >= 8) return;
    for (const id of calls(chain.at(-1)!.flow.steps ?? [])) search([...path, id]);
  };
  search([stepId]);
  return found.length === 1 ? { path: found[0]!, stepId: inner } : outer;
}

/**
 * One variable write reported by the Runtime (`variableChanged`). Declared
 * here until the schema package carries the event; unknown fields are
 * ignored, so the shape only needs to be a subset of what arrives.
 */
export type VariableChange = {
  seq: number;
  at: string;
  variable: string;
  value: unknown;
  /** The step that wrote it; absent for inputs and defaults set at start. */
  stepId?: string | null;
  /** Element number inside a parallel forEach. */
  iteration?: number | null;
  /** The value is masked as "***". */
  secret?: boolean;
  /** The value is a shortened preview. */
  truncated?: boolean;
};

export function asVariableChange(env: RunEventEnvelope): VariableChange | null {
  const e = env as unknown as { type: string } & Partial<VariableChange>;
  if (e.type !== "variableChanged" || typeof e.variable !== "string") return null;
  return {
    seq: env.seq,
    at: env.at,
    variable: e.variable,
    value: e.value,
    stepId: e.stepId ?? null,
    iteration: e.iteration ?? null,
    secret: e.secret === true,
    truncated: e.truncated === true,
  };
}

/** The run id a node run alone has (Tauri `test_step`; also the browser 「画面から選ぶ」 opens). */
export const STEP_TEST_RUN = "studio-pick";

/** A node run alone (「ノードの単体実行」) and what it gave. */
export type StepTest = {
  flowId: string;
  stepId: string;
  running: boolean;
  result: StepTestResult | null;
  /** Why it could not start (not a failure of the node: that is in `result`). */
  error: string | null;
};

export type RunState = {
  runId: string;
  /** The flow being run (known from `runStarted`). */
  flowId: string | null;
  status: RunStatus;
  pause: Pause | null;
  /** The screen at an error pause, once Studio has looked at it. */
  evidence: RunEvidence | null;
  /** Why the run failed, until the person closes the notice. */
  failure: RunError | null;
  steps: Record<string, StepRunState>;
  logs: LogEntry[];
  /** The nodes the run went through, as the run log draws them. */
  trace: RunTrace;
  changes: VariableChange[];
  /** When each step began, in run order (retries not counted), to tell what a step saw. */
  starts: StepStart[];
  /**
   * Steps of called flows, by the call steps they ran under (`callKey`):
   * what an unfolded or entered call shows. Their events never touch `steps`.
   */
  inner: Record<string, Record<string, StepRunState>>;
  /** The step each call path started last (a control step stays running while its blocks run). */
  innerLatest: Record<string, string>;
  /**
   * How far each loop got (`loopRound` / `loopEnded`), by `loopKey`: the
   * frame shows it, during the run and after. A loop inside another one
   * shows its latest pass.
   */
  loops: Record<string, LoopRun>;
  /** When each step's latest attempt began and what it waits for, by `clockKey`: the clock on a running node. */
  clocks: Record<string, StepClock>;
  /** When the run paused (ms since the epoch): a resume moves the clocks on by the pause, as the runtime's timeouts do. */
  pausedAt: number | null;
  /** The flow revision it runs (a resume can move it to a newer one). */
  revision: number | null;
  /** The person cleared the marks it left on the chart. */
  trailHidden: boolean;
  /** Stop was pressed and the run has not ended yet. */
  stopping: boolean;
};

/** How far a loop got in a run: its round now (from 1), out of how many when known, and how it ended. */
export type LoopRun = { round: number; total: number | null; ended: boolean; leftEarly: boolean };

/** Key of a loop in `RunState.loops`: the calls it ran inside and its step. */
export const loopKey = (path: string[], stepId: string): string => `${path.join("/")}|${stepId}`;

/**
 * A running step's clock: when its attempt began (ms since the epoch), how
 * long it waits on purpose (a delay) and when it gives up (its timeout).
 */
export type StepClock = { since: number; waitMs: number | null; limitMs: number | null };

/** Key of a step in `RunState.clocks`: the calls it ran inside and its step. */
export const clockKey = (path: string[], stepId: string): string => `${path.join("/")}|${stepId}`;

/** The `flow.call` steps a run event happened inside (outermost first). */
export const callPathOf = (env: RunEventEnvelope): string[] => (env as { callPath?: string[] }).callPath ?? [];

/** Key of a call path (outermost call step first), for `inner` and `unfolded`. */
export const callKey = (path: string[]): string => path.join("/");

/** One level of the chart the person has entered: the call step and the flow it runs. */
export type DiveLevel = { stepId: string; flow: Flow };

/**
 * The flows behind a path of entered call steps, outermost first. Stops at
 * the first call that is gone or whose flow is not loaded.
 */
export function diveChain(root: Flow | null, called: Record<string, Flow>, path: string[]): DiveLevel[] {
  const chain: DiveLevel[] = [];
  let current = root;
  for (const stepId of path) {
    const step = current ? findStep(current.steps ?? [], stepId) : undefined;
    const target = step?.type === CALL ? step.params?.flow : undefined;
    const callee = typeof target === "string" ? called[target] : undefined;
    if (!callee) break;
    chain.push({ stepId, flow: callee });
    current = callee;
  }
  return chain;
}

/**
 * Breakpoints a run of the open flow stops at: its own, and those of every
 * flow it calls as `<flowId>/<stepId>` (copies of a flow share step IDs).
 */
export function runBreakpoints(s: Pick<StudioState, "flow" | "called" | "breakpoints">): string[] {
  if (!s.flow) return [];
  const called = Object.keys(s.called).flatMap((id) => (s.breakpoints[id] ?? []).map((step) => `${id}/${step}`));
  return [...(s.breakpoints[s.flow.id] ?? []), ...called];
}

/** Flows a step tree calls directly. */
export function calledIds(steps: Step[]): string[] {
  const ids = new Set<string>();
  const walk = (list: Step[]) => {
    for (const step of list) {
      const target = step.type === CALL ? step.params?.flow : undefined;
      if (typeof target === "string" && target) ids.add(target);
      for (const children of Object.values(step.blocks ?? {})) walk(children);
    }
  };
  walk(steps);
  return [...ids];
}

export type StepStart = { stepId: string; seq: number };

/** A run that has not ended yet (running or paused). */
export const isActive = (run: RunState | null) => run?.status === "running" || run?.status === "paused" || run?.status === "pending";

export const newRun = (runId: string, flowId: string | null = null): RunState => ({
  runId,
  flowId,
  status: "running",
  pause: null,
  evidence: null,
  failure: null,
  steps: {},
  logs: [],
  trace: emptyTrace(),
  changes: [],
  starts: [],
  inner: {},
  innerLatest: {},
  loops: {},
  clocks: {},
  pausedAt: null,
  revision: null,
  trailHidden: false,
  stopping: false,
});

/**
 * The run whose marks the chart shows: the open flow's latest run, while
 * it runs and afterwards, until the flow is edited, another run starts or
 * the person clears them. Marks of an older revision would point at steps that
 * have changed since.
 */
export function trailOf(s: Pick<StudioState, "run" | "flow">): RunState | null {
  const run = s.run;
  if (!run || !s.flow || run.flowId !== s.flow.id) return null;
  if (isActive(run)) return run;
  if (run.trailHidden) return null;
  return run.revision === s.flow.revision ? run : null;
}
