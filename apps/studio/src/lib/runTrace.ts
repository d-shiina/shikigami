// The run log as a tree of node runs (docs/design/run-log.md): each node the
// run went through is one row, in the order it started, with how long it
// took and how it ended. A control node (a loop, a branch, a frame) and a
// sub-flow call hold the rows of the nodes run inside them, and a loop
// splits them into its rounds. Log lines hang under the node that wrote them.
import type { RunEventEnvelope, Step, StepOutcome } from "@shikigami/schema";

/** One run of one node (a retry continues the same run). */
export type TraceNode = {
  /** The `seq` of its first start: unique within the run. */
  key: number;
  stepId: string;
  stepType: string;
  /** The calls it ran inside (outermost first). */
  callPath: string[];
  /** The node run it ran inside, or null at the top of the flow. */
  parent: number | null;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Unset while it runs. */
  outcome?: StepOutcome;
  /** The attempt now running or last run (1 = no retry). */
  attempt: number;
  /** It failed and will be tried again. */
  retrying?: boolean;
  /** Why it failed, in words (set by the store). */
  error?: string;
  /** The run ended (stopped, or a parallel branch given up) before this node did. */
  stopped?: boolean;
};

/** Where a node sits in its flow: the node it is inside, or null at the top. */
export type Place = { stepId: string; callPath: string[] };

/**
 * The node `stepId` is directly inside in `steps`: null at the top level,
 * undefined when it is not there.
 */
export function enclosing(steps: Step[], stepId: string, parent: string | null = null): string | null | undefined {
  for (const step of steps) {
    if (step.id === stepId) return parent;
    for (const children of Object.values(step.blocks ?? {})) {
      const found = enclosing(children, stepId, step.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export type RunTrace = {
  nodes: TraceNode[];
  /** Keys of the node runs that have started and not ended, oldest first. */
  open: number[];
};

export const emptyTrace = (): RunTrace => ({ nodes: [], open: [] });

/** Node types that run other nodes inside them, so what starts meanwhile is theirs. */
export function holdsNodes(stepType: string): boolean {
  return (
    stepType === "flow.call" ||
    stepType === "wait.until" ||
    (stepType.startsWith("control.") && !["control.break", "control.continue", "control.fail"].includes(stepType))
  );
}

/** Loops: their rounds are shown one by one. */
export function isLoop(stepType: string): boolean {
  return stepType === "control.forEach" || stepType === "control.while" || stepType === "control.repeat";
}

const sameCall = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The latest run of `stepId` in that call, open ones first. */
export function findNode(trace: RunTrace, stepId: string, callPath: string[]): TraceNode | undefined {
  for (let i = trace.open.length - 1; i >= 0; i--) {
    const node = trace.nodes.find((n) => n.key === trace.open[i]);
    if (node && node.stepId === stepId && sameCall(node.callPath, callPath)) return node;
  }
  for (let i = trace.nodes.length - 1; i >= 0; i--) {
    const node = trace.nodes[i]!;
    if (node.stepId === stepId && sameCall(node.callPath, callPath)) return node;
  }
  return undefined;
}

/**
 * The trace after one run event. Only `stepStarted` and `stepFinished`
 * change it; the error words are put on by the caller (`withError`).
 */
export function traceEvent(
  trace: RunTrace,
  env: RunEventEnvelope,
  /** The node a step is written inside (from the flows), when known: undefined when not. */
  parentOf?: (stepId: string, callPath: string[]) => Place | null | undefined,
): RunTrace {
  const callPath = env.callPath ?? [];
  if (env.type === "stepStarted") {
    // A retry runs the same node again: it stays one row.
    const again = env.attempt > 1 ? findNode(trace, env.stepId, callPath) : undefined;
    if (again?.retrying) {
      const node: TraceNode = { ...again, attempt: env.attempt, retrying: false, outcome: undefined, endedAt: undefined, durationMs: undefined, error: undefined };
      return { nodes: trace.nodes.map((n) => (n.key === again.key ? node : n)), open: [...trace.open, again.key] };
    }
    // Inside the node it is written in, by the flow: parallel branches run
    // at once, so the newest open node may be another branch's.
    let parent: number | null = null;
    const place = parentOf?.(env.stepId, callPath);
    const where = place === null ? null : place ? findOpen(trace, place.stepId, place.callPath) : undefined;
    if (where !== undefined) parent = where;
    // Not known from the flow (an old revision, a flow not loaded): the newest
    // open node that holds others (a plain node that has not ended never is).
    else for (let i = trace.open.length - 1; i >= 0; i--) {
      const open = trace.nodes.find((n) => n.key === trace.open[i]);
      if (open && holdsNodes(open.stepType)) {
        parent = open.key;
        break;
      }
    }
    const node: TraceNode = { key: env.seq, stepId: env.stepId, stepType: env.stepType, callPath, parent, startedAt: env.at, attempt: env.attempt };
    return { nodes: [...trace.nodes, node], open: [...trace.open, node.key] };
  }
  if (env.type === "stepFinished") {
    const node = findNode(trace, env.stepId, callPath);
    if (!node) return trace;
    const done: TraceNode = {
      ...node,
      endedAt: env.at,
      // A retried node: from its first start, the waits between included.
      durationMs: Math.max(env.durationMs, Date.parse(env.at) - Date.parse(node.startedAt) || 0),
      outcome: env.outcome,
      retrying: env.willRetry === true,
    };
    return { nodes: trace.nodes.map((n) => (n.key === node.key ? done : n)), open: trace.open.filter((k) => k !== node.key) };
  }
  if (env.type === "runFinished") {
    // Nodes that never ended (the run was stopped, or a parallel branch was
    // given up when another failed) end with it.
    const left = new Set(trace.open);
    const nodes = trace.nodes.map((n) =>
      left.has(n.key) || n.retrying
        ? { ...n, endedAt: env.at, durationMs: Math.max(0, Date.parse(env.at) - Date.parse(n.startedAt) || 0), outcome: n.outcome ?? ("skipped" as const), retrying: false, stopped: n.outcome === undefined }
        : n,
    );
    return { nodes, open: [] };
  }
  return trace;
}

/** The newest open run of `stepId` in that call (null when none is open). */
function findOpen(trace: RunTrace, stepId: string, callPath: string[]): number | null | undefined {
  for (let i = trace.open.length - 1; i >= 0; i--) {
    const node = trace.nodes.find((n) => n.key === trace.open[i]);
    if (node && node.stepId === stepId && sameCall(node.callPath, callPath)) return node.key;
  }
  return undefined;
}

/** Puts the words of a failure on the run of `stepId` that just ended. */
export function withError(trace: RunTrace, stepId: string, callPath: string[], error: string): RunTrace {
  const node = findNode(trace, stepId, callPath);
  if (!node) return trace;
  return { ...trace, nodes: trace.nodes.map((n) => (n.key === node.key ? { ...n, error } : n)) };
}

/** A log line as the tree shows it. */
export type TraceLine = {
  seq: number;
  at: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  /** The node run it belongs to, or null for the run itself. */
  node: number | null;
};

/** What a row of the tree is. */
export type TraceRow =
  | { kind: "node"; node: TraceNode; depth: number; children: number; problems: Problems }
  | { kind: "round"; parent: number; index: number; depth: number; startedAt: string; endedAt?: string; outcome?: StepOutcome; children: number; problems: Problems }
  | { kind: "line"; line: TraceLine; depth: number };

export type Problems = { errors: number; warnings: number };

type Item = { seq: number; node?: TraceNode; line?: TraceLine };

/**
 * The rows to draw, top to bottom. `isOpen(id, auto)` says whether a node
 * (`n<key>`) or a round (`n<key>.<index>`) shows what is inside it; `auto` is
 * what it would be left alone (open while running, failing or warning).
 * `filter` keeps only errors and warnings, or only the flow's own log lines,
 * and the rows that lead to them.
 */
export type TraceFilter = "all" | "flow" | "problems";

/** Lines a node of this type writes are the flow's own words (「ログ出力」), not SpellSheet's. */
export const FLOW_LOG = "log.message";

export function traceRows(
  nodes: TraceNode[],
  lines: TraceLine[],
  isOpen: (id: string, auto: boolean) => boolean,
  filter: TraceFilter = "all",
): TraceRow[] {
  const byKey = new Map(nodes.map((n) => [n.key, n] as const));
  const keepLine = (line: TraceLine) =>
    filter === "all" ||
    (filter === "problems" ? line.level === "error" || line.level === "warn" : line.node !== null && byKey.get(line.node)?.stepType === FLOW_LOG);
  // Under each node: whether anything the filter keeps is there.
  const kept = new Map<number, boolean>();
  const keeps = (key: number): boolean => {
    const known = kept.get(key);
    if (known !== undefined) return known;
    const node = byKey.get(key)!;
    const yes =
      (filter === "problems" && node.error !== undefined) ||
      (kids.get(key) ?? []).some((i) => (i.line ? keepLine(i.line) : keeps(i.node!.key)));
    kept.set(key, yes);
    return yes;
  };
  const onlyProblems = filter !== "all";
  const kids = new Map<number | null, Item[]>();
  const add = (parent: number | null, item: Item) => {
    const list = kids.get(parent) ?? [];
    list.push(item);
    kids.set(parent, list);
  };
  for (const node of nodes) add(node.parent, { seq: node.key, node });
  for (const line of lines) add(line.node, { seq: line.seq, line });
  for (const list of kids.values()) list.sort((a, b) => a.seq - b.seq);

  // What went wrong anywhere under each node, counted once.
  const problemsOf = new Map<number, Problems>();
  const count = (key: number): Problems => {
    const known = problemsOf.get(key);
    if (known) return known;
    const p: Problems = { errors: 0, warnings: 0 };
    for (const item of kids.get(key) ?? []) {
      if (item.line?.level === "error") p.errors++;
      if (item.line?.level === "warn") p.warnings++;
      if (item.node) {
        const inner = count(item.node.key);
        p.errors += inner.errors + (item.node.error && inner.errors === 0 ? 1 : 0);
        p.warnings += inner.warnings;
      }
    }
    problemsOf.set(key, p);
    return p;
  };
  const sum = (items: Item[]): Problems =>
    items.reduce(
      (p, item) => {
        if (item.line?.level === "error") p.errors++;
        if (item.line?.level === "warn") p.warnings++;
        if (item.node) {
          const inner = count(item.node.key);
          p.errors += inner.errors + (item.node.error && inner.errors === 0 ? 1 : 0);
          p.warnings += inner.warnings;
        }
        return p;
      },
      { errors: 0, warnings: 0 },
    );
  const hasProblem = (p: Problems) => p.errors + p.warnings > 0;

  const rows: TraceRow[] = [];
  const walk = (items: Item[], depth: number) => {
    for (const item of items) {
      if (item.line) {
        if (!keepLine(item.line)) continue;
        rows.push({ kind: "line", line: item.line, depth });
        continue;
      }
      const node = item.node!;
      const inside = kids.get(node.key) ?? [];
      const problems = count(node.key);
      if (onlyProblems && !keeps(node.key)) continue;
      rows.push({ kind: "node", node, depth, children: inside.length, problems });
      // A plain node holds only its log lines: always shown, like part of its row.
      if (!holdsNodes(node.stepType)) {
        walk(inside, depth + 1);
        continue;
      }
      const auto = node.outcome === undefined || node.retrying === true || hasProblem(problems) || node.outcome === "failed";
      if (inside.length === 0 || !isOpen(`n${node.key}`, auto || onlyProblems)) continue;
      if (!isLoop(node.stepType)) {
        walk(inside, depth + 1);
        continue;
      }
      // A round begins each time the body's first node starts again.
      const first = inside.find((i) => i.node)?.node?.stepId;
      const rounds: Item[][] = [];
      for (const it of inside) {
        if (it.node && it.node.stepId === first) rounds.push([]);
        if (rounds.length === 0) rounds.push([]);
        rounds.at(-1)!.push(it);
      }
      rounds.forEach((round, index) => {
        const runs = round.filter((i) => i.node).map((i) => i.node!);
        const p = sum(round);
        if (onlyProblems && !round.some((i) => (i.line ? keepLine(i.line) : keeps(i.node!.key)))) return;
        const running = runs.some((n) => n.outcome === undefined);
        const failed = runs.some((n) => n.outcome === "failed" && !n.retrying);
        const stopped = runs.some((n) => n.stopped);
        const last = runs.at(-1);
        rows.push({
          kind: "round",
          parent: node.key,
          index,
          depth: depth + 1,
          startedAt: runs[0]?.startedAt ?? round[0]!.line!.at,
          endedAt: running ? undefined : (last?.endedAt ?? undefined),
          outcome: running ? undefined : failed ? "failed" : stopped ? "skipped" : "succeeded",
          children: round.length,
          problems: p,
        });
        const autoRound = running || hasProblem(p) || index === rounds.length - 1;
        if (isOpen(`n${node.key}.${index}`, autoRound || onlyProblems)) walk(round, depth + 2);
      });
    }
  };
  walk(kids.get(null) ?? [], 0);
  return rows;
}

/** A time span as the log shows it: 0.62 秒, 16.5 秒, 1 分 05 秒. */
export function spanText(ms: number, units: { sec: string; min: string }): string {
  if (ms < 1000) return `${(Math.max(ms, 0) / 1000).toFixed(2)} ${units.sec}`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} ${units.sec}`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m} ${units.min} ${String(s).padStart(2, "0")} ${units.sec}`;
}

/** How long after the start, as a clock: 0:03, 12:40, 1:02:05. */
export function sinceText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
