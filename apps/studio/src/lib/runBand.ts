// The run band (src-tauri/src/run_band.rs): what it shows of a run while
// Writer is minimised. The flow's nodes in a row, left to right in the
// order they run: the ones passed are checked, the one running is lit, a
// loop is a frame over its body with the round it is on. A step with
// branches (if, try, …) shows only the branch it took, once it has taken one.
//
// Pure: the band feeds it the run's events and draws what comes back.
import type { RunEventEnvelope, RunReport, RunStatus, Step, StepTypeDef } from "@shikigami/schema";
import { LOOP_TYPES } from "./stepTypes";
import type { StepClock } from "../store";

export type BandState = {
  /**
   * The last event taken in (its seq): events come in order (the replay,
   * then the live ones), so an older or equal one was already counted.
   */
  lastSeq: number;
  /** Steps finished in the current round of every loop they are in. */
  done: Set<string>;
  failed: Set<string>;
  /** Steps started and not finished, innermost last. */
  running: string[];
  clocks: Record<string, StepClock>;
  /** Loop step → the round it is on. */
  rounds: Record<string, { round: number; total: number | null }>;
  /** The block each step with blocks last ran (block name). */
  lanes: Record<string, string>;
  /** A step waiting for a person, with what to do. */
  human: string | null;
  /** That step (its calls and id), whose end ends the wait. */
  humanAt: string | null;
  status: RunStatus;
  startedAt: number | null;
  finishedAt: number | null;
};

export const emptyBand = (): BandState => ({
  lastSeq: -1,
  done: new Set(),
  failed: new Set(),
  running: [],
  clocks: {},
  rounds: {},
  lanes: {},
  human: null,
  humanAt: null,
  status: "running",
  startedAt: null,
  finishedAt: null,
});

/** Parent step and block of every step, to find the lane a step runs in. */
export function parents(steps: Step[]): Map<string, { parent: string; block: string }> {
  const map = new Map<string, { parent: string; block: string }>();
  const walk = (list: Step[]) => {
    for (const step of list) {
      for (const [block, inner] of Object.entries(step.blocks ?? {})) {
        for (const child of inner) if (child.id) map.set(child.id, { parent: step.id ?? "", block });
        walk(inner);
      }
    }
  };
  walk(steps);
  return map;
}

function descendants(step: Step | undefined, out: Set<string> = new Set()): Set<string> {
  for (const inner of Object.values(step?.blocks ?? {})) {
    for (const child of inner) {
      if (child.id) out.add(child.id);
      descendants(child, out);
    }
  }
  return out;
}

function find(steps: Step[], id: string): Step | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const inner of Object.values(step.blocks ?? {})) {
      const found = find(inner, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The state after `env`. Events inside a called flow (`callPath`) count for
 * the `flow.call` node only, which is what the band shows of it; the one
 * thing taken from them is a request to a person.
 */
export function bandStep(state: BandState, env: RunEventEnvelope, steps: Step[], now = Date.now()): BandState {
  if (env.seq <= state.lastSeq) return state;
  const next: BandState = { ...state, lastSeq: env.seq };
  const at = Date.parse(env.at);
  const when = Number.isNaN(at) ? now : at;
  const inner = (env.callPath ?? []).length > 0;
  const waitKey = `${(env.callPath ?? []).join("/")}|${"stepId" in env ? env.stepId : ""}`;
  // The step a person was asked about is done (inside a call too): the wait is over.
  if (env.type === "stepFinished" && state.humanAt === waitKey) {
    next.human = null;
    next.humanAt = null;
  }
  switch (env.type) {
    case "runStarted":
      next.startedAt = when;
      break;
    case "stepStarted": {
      if (inner) break;
      next.running = [...state.running.filter((id) => id !== env.stepId), env.stepId];
      next.clocks = { ...state.clocks, [env.stepId]: { since: when, waitMs: env.waitMs ?? null, limitMs: env.limitMs ?? null } };
      const done = new Set(state.done);
      done.delete(env.stepId);
      next.done = done;
      // Tried again (a retry, or 「再試行」 after a pause): no longer failed.
      if (state.failed.has(env.stepId)) {
        const failed = new Set(state.failed);
        failed.delete(env.stepId);
        next.failed = failed;
      }
      // The lane it runs in, for each step around it.
      const up = parents(steps);
      const lanes = { ...state.lanes };
      // Starting again (the next round of a loop around it): the way it and
      // the steps inside it go is not known until they take it again.
      delete lanes[env.stepId];
      for (const id of descendants(find(steps, env.stepId))) delete lanes[id];
      for (let id: string | undefined = env.stepId; id; ) {
        const around: { parent: string; block: string } | undefined = up.get(id);
        if (!around) break;
        lanes[around.parent] = around.block;
        id = around.parent;
      }
      next.lanes = lanes;
      break;
    }
    case "stepFinished": {
      if (inner) break;
      next.running = state.running.filter((id) => id !== env.stepId);
      if (env.outcome === "failed" && !env.willRetry) next.failed = new Set(state.failed).add(env.stepId);
      else if (env.outcome !== "failed") next.done = new Set(state.done).add(env.stepId);
      break;
    }
    case "loopRound": {
      if (inner) break;
      next.rounds = { ...state.rounds, [env.stepId]: { round: env.round, total: env.total ?? null } };
      // A new round: its body has not run yet.
      const body = descendants(find(steps, env.stepId));
      next.done = new Set([...state.done].filter((id) => !body.has(id)));
      next.failed = new Set([...state.failed].filter((id) => !body.has(id)));
      next.lanes = Object.fromEntries(Object.entries(state.lanes).filter(([id]) => !body.has(id)));
      break;
    }
    case "humanActionRequired":
      next.human = env.message;
      next.humanAt = waitKey;
      break;
    case "paused":
      next.status = "paused";
      break;
    case "resumed":
      next.status = "running";
      break;
    case "runFinished":
      next.status = env.status;
      next.running = [];
      next.human = null;
      next.humanAt = null;
      next.finishedAt = when;
      break;
    default:
      break;
  }
  return next;
}

export type BandItem =
  | { kind: "node"; step: Step; state: "done" | "now" | "failed" | "ahead" }
  | {
      kind: "frame";
      step: Step;
      state: "done" | "now" | "failed" | "ahead";
      /** The round of a loop, when it has begun one. */
      round: { round: number; total: number | null } | null;
      /** The block shown inside (a branch: the one taken). */
      block: string;
      items: BandItem[];
    };

/**
 * The row the band draws. `defs` names a step type's blocks in order;
 * a loop shows its body even before it starts, a step with branches only
 * once it has taken one (before that it is a single node).
 */
export function bandItems(steps: Step[], state: BandState, defs: Map<string, StepTypeDef>): BandItem[] {
  const stateOf = (id: string): "done" | "now" | "failed" | "ahead" =>
    state.running.includes(id) ? "now" : state.failed.has(id) ? "failed" : state.done.has(id) ? "done" : "ahead";
  const build = (list: Step[]): BandItem[] =>
    list.flatMap((step): BandItem[] => {
      if (!step.id) return [];
      const id = step.id;
      const blocks = Object.keys(step.blocks ?? {});
      if (blocks.length === 0) return [{ kind: "node", step, state: stateOf(id) }];
      const loop = LOOP_TYPES.has(step.type);
      const declared = (defs.get(step.type)?.blocks ?? []).map((b) => b.name).filter((b) => blocks.includes(b));
      const first = declared[0] ?? blocks[0];
      const block = state.lanes[id] ?? (loop || blocks.length === 1 ? first : undefined);
      // Not entered yet (and the way it goes not known), or a branch it
      // took that is empty: one node.
      if (!block || (step.blocks?.[block] ?? []).length === 0) return [{ kind: "node", step, state: stateOf(id) }];
      return [
        {
          kind: "frame",
          step,
          state: stateOf(id),
          round: loop ? (state.rounds[id] ?? null) : null,
          block,
          items: build(step.blocks?.[block] ?? []),
        },
      ];
    });
  return build(steps);
}

/**
 * The end of a run from its report: for a replay cut short (a long run
 * keeps only its first events), so the band still shows how it ended.
 */
export function bandEnded(state: BandState, report: RunReport): BandState {
  if (state.finishedAt !== null) return state;
  const at = Date.parse(report.finishedAt);
  const from = Date.parse(report.startedAt);
  return {
    ...state,
    status: report.status,
    running: [],
    human: null,
    humanAt: null,
    startedAt: state.startedAt ?? (Number.isNaN(from) ? null : from),
    finishedAt: Number.isNaN(at) ? Date.now() : at,
  };
}

/** The step the band keeps in view: the innermost running one, else the last one passed. */
export function focusStep(state: BandState): string | null {
  return state.running.at(-1) ?? null;
}
