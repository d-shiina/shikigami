// Derives a flowchart from the step tree. This is a pure *view* of the
// flow: positions are computed, never stored, so AI edits and GUI edits
// always render identically and no layout data leaks into flow files.
//
// Steps run top to bottom; a step's blocks sit side by side below it, framed
// together with it (the step is the frame's head), and a loop draws a line
// from the end of its body back to where its body starts, inside its frame.
import type { Step, StepTypeDef } from "@spellsheet/schema";
import { BREAK, CASE, CONTINUE, FAIL, IF, LOOP_TYPES, PARALLEL, SWITCH, TRY } from "../lib/stepTypes";
import { branchQuestion, headSummary, laneLabel, loopBackLabel, loopExitLabel, loopQuestion } from "../lib/keywords";
import { typeTitle } from "../lib/sentence";
import { READING } from "../lib/reading";
import { asksByName } from "../lib/keywords";
import { NODE_HEAD_H, nodeHeight } from "../lib/nodeRows";

export const NODE_W = 290;
export const SLOT_H = 40;
/** Room above a step for the flow edge, its label and the review toolbar. */
const GAP_Y = 56;
/**
 * The flow's start and end (see TerminalNodeData): a small rounded tag over
 * its first node and under its last, TERMINAL_H tall. They are not steps: the
 * line starts at one and ends at the other.
 */
export const TERMINAL_H = 30;
export const START_ID = "flow:start";
export const END_ID = "flow:end";
/** From the start down to the first node: room for the review toolbar over it. */
const START_GAP = 44;
/** From the "+" at the end (or the last node) down to the end: room for the label of a line out of a loop. */
const END_GAP = 36;
/**
 * The 「＋ ノード追加」 at the end of a block that has nodes (a branch, a
 * loop's body, …), on the line just under its last node: it adds a node
 * there, inside the block. The line runs through it on to what comes next.
 * TAIL_SIZE tall and TAIL_W wide, as the one on a line between nodes.
 */
export const TAIL_SIZE = 24;
export const TAIL_W = 96;
const TAIL_GAP = 16;
/**
 * Room beside a step: its sockets (where a variable's line starts or ends) sit
 * on its edges, and the curve of a lit variable line swings out a little past
 * them. Variable chips sit inside the step's rows, so nothing else needs room.
 */
export const READ_ROOM = 20;
export const WRITE_ROOM = 20;
/** Between side-by-side lanes. */
const GAP_X = READ_ROOM + WRITE_ROOM + 32;
/**
 * Every step with blocks (a loop, if, try, …) is drawn as a frame that holds
 * everything in its blocks; the step itself is the frame's head (HEAD_H tall,
 * as wide as the frame), so the frame is the node. Its blocks hang below the
 * head side by side as columns, and their lines meet again at one point (a
 * join) on the frame's bottom edge, where the line goes on to the next step.
 */
export const HEAD_H = 38;
export const FRAME_TOP = 0;
/**
 * Under the blocks: room for the lines to turn into the join, which sits on
 * the frame's bottom edge (half in, half out), so the line on to the next
 * step leaves from the edge and never starts inside the frame.
 */
const JOIN_GAP = 32;
export const JOIN_SIZE = 8;
/**
 * A loop's line back runs from the end of its body up the left of its frame,
 * LOOP_LINE_X in from the edge (outside the read chips and the frames of
 * steps inside), and back into the line that enters its body, just under the
 * head: the next item runs the body again from the top. It never leaves the
 * frame, and the line on to the next step leaves from the frame's bottom edge.
 */
export const LOOP_LINE_X = 14;
/**
 * Where a loop decides whether to go round again: a hexagon on its line with
 * the question inside ("次の 1 件がある？"), as wide as the question. A loop that checks first (for each, repeat, while) has it at
 * the top of its body: "はい" runs the body, whose line comes back into it,
 * and "いいえ" runs down the right of the frame (LOOP_LINE_X in) and out.
 * A wait checks after its check block, so it has it at the bottom: "いいえ"
 * goes back up the left to the top of the block, "はい" goes on out.
 */
export const DECIDE_H = 28;
/** The pointed ends of a decision: how far each runs in from its side. */
export const DECIDE_POINT = 12;
/** How wide a decision is: as wide as its question, with room for its pointed ends. */
export function decideWidth(question: string, max = NODE_W - 20): number {
  return Math.ceil(Math.min(Math.max(textWidth(question, 12) + 2 * DECIDE_POINT + 2 * 10, 96), max));
}
/** Between the head (or the end of a wait's block) and the decision. */
const DECIDE_GAP = 28;
/** Under a loop's body: its line back turns, then (a little lower, apart from it) the "いいえ" line into the frame's edge. */
const LOOP_BOTTOM = 54;
/**
 * A loop's foot: the frame's bottom edge is a band, as tall as FOOT_H, that
 * says 「繰り返し終了」. Every way out of the loop meets there: its "いいえ"
 * (all done) and each break inside it. The line passes through it on to
 * the next step, and a run leaves how many rounds it made on it.
 */
export const FOOT_H = 30;
/** Under a wait's decision: its "はい" line down to the frame's edge. */
const WAIT_BOTTOM = 60;
const LOOP_FRAME = { left: READ_ROOM + 12 + 24, right: WRITE_ROOM + 12 + 24 };
const WAIT_UNTIL = "wait.until";
/**
 * Steps that go round: the loops, and a wait that runs its check again until
 * its condition holds. Each draws a line back to the start of its body.
 */
const CIRCLING: ReadonlySet<string> = new Set([...LOOP_TYPES, WAIT_UNTIL]);
/** An if or a switch asks its question in a decision under its head, like a loop. */
export const asksUnderHead = (step: Step): boolean => step.type === IF || step.type === SWITCH;
/** Loops that decide after their block has run, not before. */
const CHECKS_AFTER: ReadonlySet<string> = new Set([WAIT_UNTIL]);
/** Steps the flow does not go on from: out of a loop, round to its next pass, or stopped with an error. */
const STOPPING: ReadonlySet<string> = new Set([BREAK, CONTINUE, FAIL]);
/** A break, continue or fail that runs: a disabled one is skipped, and the flow goes on past it. */
const ends = (step: Step | undefined): boolean => !!step && STOPPING.has(step.type) && !step.disabled;
const BLOCK_FRAME = { left: READ_ROOM + 12, right: WRITE_ROOM + 12 };
/** Beside the blocks of a step: room for its frame to sit inside the frame of a step around it. */
const BLOCK_ROOM = 16;
/**
 * A case of a switch is the heading of its column, not a node: a small tab
 * (CASE_H tall) with the values it matches, where the other columns have
 * their heading (はい, その他, …: on the line, CASE_LIFT above the column).
 * Its steps start at the top of the column like theirs.
 */
export const CASE_H = 20;
const CASE_LIFT = 10;

/** What the head of a frame shows besides the step (see HEAD_H). */
export type HeadData = {
  width: number;
  /** Where the flow line enters and leaves the head, from its left edge: over its blocks, not always its middle. */
  lineX: number;
  collapsed: boolean;
  /** Nodes inside, said on a folded head. */
  count: number;
  /** The try has no "finally" yet: the head offers to add one. */
  addFinally?: boolean;
  /** A switch: the head offers to add a case. */
  addCase?: boolean;
};

export type StepNodeData = {
  kind: "step";
  step: Step;
  def: StepTypeDef | undefined;
  parentId: string | null;
  block: string | null;
  index: number;
  /** A fail (break, continue) in a try that has a "最後に必ず": that runs before the flow stops. */
  thenFinally?: boolean;
  /** The step is the head of a frame (a loop, if, …): drawn as the frame's top edge. */
  head?: HeadData;
  /** A case of a switch: drawn as the tab over its column. */
  tab?: boolean;
};

/** Where the blocks of a frame meet again, on its bottom edge (a loop's is only where its line leaves). */
export type JoinNodeData = {
  kind: "join";
  parentId: string;
  shown: boolean;
  /** Not marked, but a single line passes through it (across the frame's edge). */
  through?: boolean;
  /** A loop's decision (see DECIDE_H): what it asks. */
  question?: string;
  /** A loop's decision: how wide it is (see decideWidth). */
  width?: number;
  /** A loop's decision that comes after its block (a wait's), not before. */
  after?: boolean;
  /** Where a try's "実行" fails from (see CATCH_DROP): the first step of its "失敗したとき", which runs when it does. */
  failTo?: string;
  /** A wait's way out: taken only once the wait itself succeeded, not each time its check ran. */
  met?: boolean;
  /** A loop's foot (see FOOT_H): the band across its frame's bottom, where every way out of it meets. */
  foot?: FootData;
};

/** A loop's foot: as wide as its frame, its line passing through at `lineX`. */
export type FootData = {
  width: number;
  lineX: number;
  /** The loop's type: what the band calls its end. */
  type: string;
  /** Breaks inside it (not inside a loop within it): they come out here too. */
  breaks: string[];
};

export type SlotNodeData = {
  kind: "slot";
  parentId: string | null;
  block: string | null;
  label: string;
  /** The small "+" under a block's last node (or the flow's), to add at the end of it (see TAIL_SIZE). */
  tail?: boolean;
};

/**
 * Where the flow starts (`start`) or ends (`end`): a tag, not a step. The
 * start holds the values the flow takes in, the end the values it gives
 * back, so the lines of those values have somewhere to start and end.
 * Positioned by its top centre (it is as wide as what it says).
 */
export type TerminalNodeData = { kind: "terminal"; end: boolean };

/** Which way out of an if or a switch a node or frame sits in: the branch's id and its column (see LayoutEdge.alt). */
export type BranchPlace = { owner: string; i: number };

export type LayoutNode = {
  id: string;
  type: "step" | "slot" | "join" | "terminal";
  position: { x: number; y: number };
  data: StepNodeData | SlotNodeData | JoinNodeData | TerminalNodeData;
  /** The ways out of branches it sits in, innermost last. */
  branches?: BranchPlace[];
};

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** From a fail (break, continue) that ends a column of a try to its "最後に必ず", which still runs before the flow stops. */
  thenFinally?: boolean;
  /** A loop's line back from the end of its body to where its body starts (see LOOP_LINE_X). */
  loop?: boolean;
  /** For a loop's line back: the x it runs up at. */
  detourX?: number;
  /** A loop's line leaves its decision from the side (back up a wait's left, or "いいえ" down a loop's right). */
  fromDecide?: boolean;
  /** A loop's line back ends in the left side of its decision. */
  intoDecide?: boolean;
  /** For a loop's "いいえ": the x it runs down at, on the right of the frame. */
  railX?: number;
  /** A wait's line back: the answer it takes ("いいえ"), on the line beside its decision; its label says what happens. */
  answer?: string;
  /** For a loop's "いいえ": when it leaves ("すべて終わったら"), beside the line where it runs into the foot. */
  exit?: string;
  /** For a line into or out of the side of a loop's decision: half its width. */
  half?: number;
  /** Into a try's "失敗したとき": its label is shown in the colour of errors, so the way a failure takes stands out. */
  failure?: boolean;
  /** The loop or branch this line goes round in or out of: pointing at it moves the line (see BlockEdge). */
  owner?: string;
  /** One of the ways out of a branch's decision: its place among them, which light in turn (only one is taken). */
  alt?: { i: number; n: number };
  /** Into a try's "失敗したとき": the line its ticks join, and where each tick leaves a step of "実行" (see CATCH_DROP). */
  bracket?: { x: number; ticks: { x: number; y: number }[]; span?: { top: number; bottom: number } };
  /** From the head of a frame down into one of its columns: turns just under the head. */
  split?: boolean;
  /** Not drawn: from a loop's head to where its line leaves, so a run's trail carries on past the loop. */
  hidden?: boolean;
};

export type FrameKind = "loop" | "if" | "switch" | "try" | "parallel" | "group";

/** The frame around a step with blocks and its blocks (see FRAME_TOP). */
export type LayoutFrame = {
  /** The step's id. */
  id: string;
  kind: FrameKind;
  type: string;
  /** How many frames it sits inside. */
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The ways out of branches it sits in, innermost last. */
  branches?: BranchPlace[];
};

/** The innermost frame around a point on the chart, or null outside every frame. */
export function frameAt(frames: readonly LayoutFrame[], x: number, y: number): LayoutFrame | null {
  let best: LayoutFrame | null = null;
  for (const f of frames) {
    if (x < f.x || x > f.x + f.width || y < f.y || y > f.y + f.height) continue;
    if (!best || f.depth > best.depth) best = f;
  }
  return best;
}

export type Layout = { nodes: LayoutNode[]; edges: LayoutEdge[]; frames: LayoutFrame[]; width: number; height: number };

type Defs = ReadonlyMap<string, StepTypeDef>;

/** Extra height a step's node needs (a call shown unfolded), by step id. */
export type Extra = ReadonlyMap<string, number>;
const NO_EXTRA: Extra = new Map();

function frameKind(type: string): FrameKind {
  if (CIRCLING.has(type)) return "loop";
  if (type === IF) return "if";
  if (type === SWITCH) return "switch";
  if (type === TRY) return "try";
  if (type === PARALLEL) return "parallel";
  return "group";
}
/** Blocks whose children are branches of their own: each child gets its own lane. */
const FAN_OUT_BLOCKS: Record<string, string> = { [PARALLEL]: "branches", [SWITCH]: "cases" };
/** Steps that are one branch of the step around them: framed by it, not on their own. */
const UNFRAMED = new Set([CASE]);
/**
 * A try's "失敗したとき" is not a choice made at its head: any step of its
 * "実行" can fail and jump there. So its column starts CATCH_DROP lower, and
 * its line comes from the side of "実行": a short dashed tick off each of its
 * steps into a line down their right (FAIL_X past the column), and from the
 * top of that across into "失敗したとき".
 */
const CATCH_DROP = 44;
export const FAIL_X = 16;
const catches = (step: Step, lane: Lane): boolean => step.type === TRY && lane.name === "catch";
/** Blocks shown only once they have nodes: the head of their step offers to add the first. */
const OPTIONAL_BLOCKS: Record<string, string> = { [TRY]: "finally" };

/** `tail`: ends in a "+" to add at its end (not a lane of one of a parallel's branches, where that would start another branch). */
type Lane = { name: string; label: string; steps: Step[]; start: number; tail: boolean };

/** A step drawn as a frame with a head (see HEAD_H). */
function isHead(step: Step, defs: Defs): boolean {
  if (UNFRAMED.has(step.type)) return false;
  return (defs.get(step.type)?.blocks?.length ?? 0) > 0 || Object.keys(step.blocks ?? {}).length > 0;
}

/** Frames folded to their head, by step id. */
export type Collapsed = ReadonlySet<string>;
const NONE: Collapsed = new Set();

/** Block lanes of a step: declared blocks in registry order, then unknown ones. */
function lanes(step: Step, defs: Defs, collapsed: Collapsed = NONE): Lane[] {
  if (step.id && collapsed.has(step.id) && isHead(step, defs)) return [];
  const def = defs.get(step.type);
  const declared = def?.blocks ?? [];
  const result: Lane[] = declared.map((b) => ({
    name: b.name,
    label: laneLabel(step, b.name, b.label),
    steps: step.blocks?.[b.name] ?? [],
    start: 0,
    tail: true,
  }));
  for (const [name, steps] of Object.entries(step.blocks ?? {})) {
    if (!declared.some((b) => b.name === name)) result.push({ name, label: name, steps, start: 0, tail: true });
  }
  const fanOut = FAN_OUT_BLOCKS[step.type];
  const optional = OPTIONAL_BLOCKS[step.type];
  // Nothing runs after a break, continue or fail: no "+" to add at the end of its block.
  for (const lane of result) if (ends(lane.steps.at(-1))) lane.tail = false;
  return result.flatMap((lane) =>
    lane.name === optional && lane.steps.length === 0
      ? []
      : lane.name === fanOut && lane.steps.length > 0
        ? lane.steps.map((child, i) => ({ ...lane, label: "", steps: [child], start: i, tail: false }))
        : [lane],
  );
}

/** The steps around step `id`, outermost first (empty when it is at the top or not found). */
export function ancestorsOf(steps: Step[], id: string): string[] {
  for (const step of steps) {
    if (step.id === id) return [];
    for (const children of Object.values(step.blocks ?? {})) {
      const inner = ancestorsOf(children, id);
      if (inner.length > 0 || children.some((c) => c.id === id)) return [...(step.id ? [step.id] : []), ...inner];
    }
  }
  return [];
}

/** How many steps are inside a step's blocks, all the way down. */
function countInside(step: Step): number {
  return Object.values(step.blocks ?? {}).reduce((n, list) => n + list.reduce((m, s) => m + 1 + countInside(s), 0), 0);
}

type Size = { w: number; h: number };

const SLOT: Size = { w: NODE_W, h: SLOT_H };

function nodeSize(step: Step, defs: Defs, extra: Extra): Size {
  if (isHead(step, defs)) return { w: NODE_W, h: HEAD_H };
  return { w: NODE_W, h: nodeHeight(step, defs.get(step.type), extra.get(step.id ?? "") ?? 0) };
}

/**
 * Roughly how wide a frame's head needs to be to show its title, name and
 * summary without cutting them (see FrameHead): a frame is at least this wide,
 * up to HEAD_MAX, past which the name and summary are cut and the whole
 * sentence is in the head's tooltip.
 */
const HEAD_MAX = READING ? 760 : 520;
function textWidth(s: string, px: number): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? px : px * 0.6;
  return w;
}
function headWidth(step: Step, defs: Defs): number {
  const name = step.name ?? "";
  // An if or a switch asks in the decision under its head, not in the head.
  const summary = asksUnderHead(step) && !asksByName(step) ? "" : headSummary(step);
  let w = 12 + 15 + 8 + textWidth(typeTitle(step, defs.get(step.type)), 12.5) + 8 + 22 + 12;
  if (name && !asksByName(step)) w += 8 + textWidth(name, 12.5);
  if (summary) w += 8 + 12 + textWidth(summary, 11.5);
  if (step.type === SWITCH) w += 8 + 80;
  if (OPTIONAL_BLOCKS[step.type] && !step.blocks?.[OPTIONAL_BLOCKS[step.type]!]?.length) w += 8 + 110;
  return Math.ceil(Math.min(w, HEAD_MAX));
}

function measureList(steps: Step[], defs: Defs, extra: Extra, collapsed: Collapsed, tail = false): Size {
  if (steps.length === 0) return SLOT;
  let w = 0;
  let h = 0;
  for (const s of steps) {
    const m = measure(s, defs, extra, collapsed);
    w = Math.max(w, m.w);
    h += m.h;
  }
  h += GAP_Y * (steps.length - 1);
  return tail ? { w: Math.max(w, TAIL_W), h: h + tailGap(steps) + TAIL_SIZE } : { w, h };
}

/** Between a block's last node and its "+": room for the line out of a loop there to say when it leaves. */
function tailGap(steps: Step[]): number {
  return CIRCLING.has(steps.at(-1)?.type ?? "") ? GAP_Y : TAIL_GAP;
}

/**
 * How a frame's blocks are laid out: side by side as columns, and, for a try
 * with a "finally", that block after the columns have met again, since it
 * runs after whichever of them ran.
 */
function frameParts(step: Step, ls: Lane[]): { columns: Lane[]; after: Lane | null } {
  if (step.type !== TRY) return { columns: ls, after: null };
  const after = ls.find((l) => l.name === "finally") ?? null;
  return { columns: after ? ls.filter((l) => l !== after) : ls, after };
}

/** To read: between the bracket down the side of a try's steps and its "失敗したとき". */
const BRACKET_GAP = 56;
/** To read: where the line leaves that bracket, under its top. */
export const BRACKET_OUT = 20;

/**
 * A try as it is read (lib/reading.ts): not a frame. Its steps stay on the
 * line they are on, since they are the work itself; "最後に必ず" follows on
 * the same line, since it always runs; and "失敗したとき" stands to their
 * right, reached from a bracket down the side of the steps it covers.
 */
function readTryParts(ls: Lane[], defs: Defs, extra: Extra, collapsed: Collapsed) {
  const size = (l: Lane | undefined) => (l && l.steps.length > 0 ? measureList(l.steps, defs, extra, collapsed) : null);
  const attempt = ls.find((l) => l.name === "try");
  const caught = ls.find((l) => l.name === "catch");
  const after = ls.find((l) => l.name === "finally");
  const ts = attempt ? measureList(attempt.steps, defs, extra, collapsed) : SLOT;
  const cs = size(caught);
  const as = size(after);
  const side = cs ? FAIL_X + BRACKET_GAP + cs.w : 0;
  const columnsH = Math.max(ts.h, cs ? CATCH_DROP + cs.h : 0);
  const w = Math.max(ts.w, as?.w ?? 0) + 2 * side;
  const h = columnsH + JOIN_GAP + JOIN_SIZE + (as ? GAP_Y + as.h + JOIN_GAP + JOIN_SIZE : 0);
  return { attempt, caught: cs ? caught : undefined, after: as ? after : undefined, ts, cs, as, columnsH, w, h };
}

function measure(step: Step, defs: Defs, extra: Extra, collapsed: Collapsed): Size {
  const ls = lanes(step, defs, collapsed);
  const own = nodeSize(step, defs, extra);
  if (ls.length === 0) return own;
  if (READING && step.type === TRY) {
    const { w, h } = readTryParts(ls, defs, extra, collapsed);
    return { w, h };
  }
  const { columns, after } = frameParts(step, ls);
  const ms = columns.map((l) => {
    const m = measureList(l.steps, defs, extra, collapsed, l.tail);
    return catches(step, l) ? { w: m.w, h: m.h + CATCH_DROP } : m;
  });
  let w = ms.reduce((acc, m) => acc + m.w, 0) + GAP_X * (ms.length - 1);
  let inner = Math.max(...ms.map((m) => m.h));
  if (UNFRAMED.has(step.type)) return { w: Math.max(own.w, w), h: inner };
  if (after) {
    const m = measureList(after.steps, defs, extra, collapsed, after.tail);
    w = Math.max(w, m.w);
    inner += JOIN_GAP + JOIN_SIZE + GAP_Y + m.h;
  }
  const circling = CIRCLING.has(step.type);
  const h = !circling
    ? own.h + (asksUnderHead(step) ? DECIDE_GAP + DECIDE_H : 0) + GAP_Y + inner + JOIN_GAP + JOIN_SIZE / 2
    : CHECKS_AFTER.has(step.type)
      ? own.h + GAP_Y + inner + DECIDE_GAP + DECIDE_H + WAIT_BOTTOM
      : own.h + DECIDE_GAP + DECIDE_H + GAP_Y + inner + LOOP_BOTTOM + FOOT_H;
  const room = (circling ? 32 : BLOCK_ROOM) * 2;
  // The frame is drawn wider than this by its sides (less the room counted here).
  const side = circling ? LOOP_FRAME : BLOCK_FRAME;
  const overhang = side.left + side.right - room;
  return { w: Math.max(own.w, w + room, headWidth(step, defs) - overhang), h };
}

class Builder {
  nodes: LayoutNode[] = [];
  edges: LayoutEdge[] = [];
  frames: LayoutFrame[] = [];
  private depth = 0;
  /** What the line out of a loop says ("すべて終わったら"), by its join. */
  private exitLabels = new Map<string, string>();

  constructor(
    private defs: Defs,
    private extra: Extra,
    private collapsed: Collapsed,
  ) {}

  edge(
    source: string,
    target: string,
    label?: string,
    hidden?: boolean,
    split?: boolean,
    more?: Pick<LayoutEdge, "loop" | "detourX" | "fromDecide" | "intoDecide" | "railX" | "exit" | "answer" | "half" | "failure" | "bracket" | "owner" | "alt" | "thenFinally">,
  ) {
    // The line out of a loop says when it leaves; not into the join of a frame around it, where lines meet.
    if (label === undefined && !target.startsWith("join:")) label = this.exitLabels.get(source);
    this.edges.push({
      id: `${source}->${target}${label ? `:${label}` : ""}`,
      source,
      target,
      label,
      ...more,
      ...(hidden ? { hidden } : {}),
      ...(split ? { split } : {}),
    });
  }

  /** Places a list centred in [x, x + span); returns its entry node id and the ids that flow into the next step. */
  private readTry(id: string, y: number, cx: number, ls: Lane[]): { entry: string; exits: string[] } {
    const r = readTryParts(ls, this.defs, this.extra, this.collapsed);
    const before = this.nodes.length;
    const tried = this.list(r.attempt?.steps ?? [], y, cx - r.ts.w / 2, r.ts.w, id, "try", "");
    const meet = `join:${id}:then`;
    const meetY = y + r.columnsH + JOIN_GAP;
    this.nodes.push({ id: meet, type: "join", position: { x: cx - JOIN_SIZE / 2, y: meetY }, data: { kind: "join", parentId: id, shown: false, through: true } });
    for (const e of tried.exits) this.edge(e, meet);
    const endsIn = (lane: Lane | undefined, exits: string[]) => {
      for (const e of exits) this.edge(e, meet);
      const last = lane?.steps.at(-1);
      if (r.after && ends(last) && last?.id) {
        this.edge(last.id, meet, undefined, undefined, undefined, { thenFinally: true });
        const node = this.nodes.find((n) => n.id === last.id);
        if (node?.data.kind === "step") node.data.thenFinally = true;
      }
    };
    endsIn(r.attempt, []);
    if (r.caught && r.cs) {
      // Clear of the widest thing among the steps: the frame of a loop reaches further right than a node.
      const rights = this.nodes.slice(before).flatMap((n) => {
        if (n.data.kind !== "step" || n.data.parentId !== id) return [];
        return [n.position.x + (n.data.head ? n.data.head.width : NODE_W)];
      });
      const railX = Math.max(cx + r.ts.w / 2, ...rights) + FAIL_X;
      const fail = `join:${id}:fail`;
      const caught = this.list(r.caught.steps, y + CATCH_DROP, railX + BRACKET_GAP, r.cs.w, id, "catch", r.caught.label);
      this.nodes.push({ id: fail, type: "join", position: { x: railX - JOIN_SIZE / 2, y: y + BRACKET_OUT - JOIN_SIZE / 2 }, data: { kind: "join", parentId: id, shown: false, failTo: caught.entry } });
      this.edge(fail, caught.entry, r.caught.label || undefined, undefined, undefined, { failure: true, bracket: { x: railX, ticks: [], span: { top: y, bottom: y + r.ts.h } } });
      endsIn(r.caught, caught.exits);
      const joined = this.nodes.find((n) => n.id === meet);
      if (joined?.data.kind === "join" && caught.exits.length > 0) joined.data = { ...joined.data, shown: true, through: false };
    }
    if (!r.after || !r.as) return { entry: tried.entry, exits: [meet] };
    const always = this.list(r.after.steps, meetY + JOIN_SIZE + GAP_Y, cx - r.as.w / 2, r.as.w, id, "finally", r.after.label);
    this.edge(meet, always.entry, r.after.label || undefined);
    const join = `join:${id}`;
    this.nodes.push({ id: join, type: "join", position: { x: cx - JOIN_SIZE / 2, y: y + r.h - JOIN_SIZE }, data: { kind: "join", parentId: id, shown: false, through: true } });
    for (const e of always.exits) this.edge(e, join);
    return { entry: tried.entry, exits: [join] };
  }

  list(
    steps: Step[],
    y: number,
    x: number,
    span: number,
    parentId: string | null,
    block: string | null,
    slotLabel: string,
    start = 0,
    tail = false,
  ): { entry: string; exits: string[] } {
    if (steps.length === 0) {
      const id = `slot:${parentId ?? "root"}:${block ?? ""}`;
      this.nodes.push({
        id,
        type: "slot",
        position: { x: x + (span - SLOT.w) / 2, y },
        data: { kind: "slot", parentId, block, label: slotLabel },
      });
      return { entry: id, exits: [id] };
    }
    let cursor = y;
    let entry = "";
    let previous: string[] = [];
    steps.forEach((step, index) => {
      const placed = this.step(step, cursor, x, span, parentId, block, start + index);
      if (index === 0) entry = placed.entry;
      for (const p of previous) this.edge(p, placed.entry);
      previous = placed.exits;
      cursor += measure(step, this.defs, this.extra, this.collapsed).h + GAP_Y;
    });
    if (tail) {
      const id = `end:${parentId ?? "root"}:${block ?? ""}`;
      this.nodes.push({
        id,
        type: "slot",
        position: { x: x + (span - TAIL_W) / 2, y: cursor - GAP_Y + tailGap(steps) },
        data: { kind: "slot", parentId, block, label: slotLabel, tail: true },
      });
      for (const p of previous) this.edge(p, id);
      previous = [id];
    }
    return { entry, exits: previous };
  }

  step(
    step: Step,
    y: number,
    x: number,
    span: number,
    parentId: string | null,
    block: string | null,
    index: number,
  ): { entry: string; exits: string[] } {
    const id = step.id ?? `anon-${this.nodes.length}`;
    const def = this.defs.get(step.type);
    const own = nodeSize(step, this.defs, this.extra);
    const base = { kind: "step", step, def, parentId, block, index } as const;
    const ls = lanes(step, this.defs, this.collapsed);
    const head = isHead(step, this.defs);
    const cx = x + span / 2;

    if (UNFRAMED.has(step.type)) {
      // A case: the tab over its column, its steps under it.
      this.nodes.push({ id, type: "step", position: { x: cx - NODE_W / 2, y: y - CASE_LIFT - CASE_H }, data: { ...base, tab: true } });
      const lane = ls[0];
      if (!lane) return { entry: id, exits: [id] };
      const size = measureList(lane.steps, this.defs, this.extra, this.collapsed, lane.tail);
      const placed = this.list(lane.steps, y, cx - size.w / 2, size.w, id, lane.name, lane.label, lane.start, lane.tail);
      this.edge(id, placed.entry);
      return { entry: id, exits: placed.exits };
    }
    if (!head) {
      this.nodes.push({ id, type: "step", position: { x: cx - own.w / 2, y }, data: base });
      // A break, continue or fail: the flow does not go on to the node under it.
      return { entry: id, exits: ends(step) ? [] : [id] };
    }
    const optional = OPTIONAL_BLOCKS[step.type];
    const extras = {
      ...(optional && !(step.blocks?.[optional]?.length) ? { addFinally: true } : {}),
      ...(step.type === SWITCH ? { addCase: true } : {}),
    };
    if (ls.length === 0) {
      // Folded: the head alone, saying how much is inside.
      this.nodes.push({
        id,
        type: "step",
        position: { x: cx - own.w / 2, y },
        data: { ...base, head: { width: own.w, lineX: own.w / 2, collapsed: true, count: countInside(step) } },
      });
      return { entry: id, exits: [id] };
    }

    if (READING && step.type === TRY) return this.readTry(id, y, cx, ls);

    const { columns, after } = frameParts(step, ls);
    const sizes = columns.map((l) => {
      const m = measureList(l.steps, this.defs, this.extra, this.collapsed, l.tail);
      return catches(step, l) ? { w: m.w, h: m.h + CATCH_DROP } : m;
    });
    const afterSize = after ? measureList(after.steps, this.defs, this.extra, this.collapsed, after.tail) : null;
    const isLoop = CIRCLING.has(step.type);
    const total = sizes.reduce((a, m) => a + m.w, 0) + GAP_X * (columns.length - 1);
    let laneX = x + (span - total) / 2;
    const side = isLoop ? LOOP_FRAME : BLOCK_FRAME;
    const inW = Math.max(total, afterSize?.w ?? 0);
    let left = Math.min(cx - inW / 2, cx - own.w / 2) - side.left;
    let right = Math.max(cx + inW / 2, cx + own.w / 2) + side.right;
    // Wide enough for the head to show its title, name and summary.
    const short = headWidth(step, this.defs) - (right - left);
    if (short > 0) {
      left -= short / 2;
      right += short / 2;
    }
    const height = measure(step, this.defs, this.extra, this.collapsed).h;
    this.nodes.push({
      id,
      type: "step",
      position: { x: left, y },
      data: { ...base, head: { width: right - left, lineX: cx - left, collapsed: false, count: countInside(step), ...extras } },
    });
    this.frames.push({ id, kind: frameKind(step.type), type: step.type, depth: this.depth, x: left, y: y - FRAME_TOP, width: right - left, height: height + FRAME_TOP });

    // Where the frame is left, on its bottom edge: a loop's only lets its line
    // out (its body goes round instead), a frame's columns meet there (a dot),
    // and a single column's line passes through it.
    const joinY = isLoop ? y + height - (CHECKS_AFTER.has(step.type) ? JOIN_SIZE : FOOT_H) : y + height - JOIN_SIZE / 2;
    const join = `join:${id}`;
    if (isLoop) return this.loop(step, id, y, cx, left, right, own.h, columns[0]!, sizes[0] ?? SLOT, joinY);
    // An if or a switch asks its question in a decision under its head, and its columns leave from there.
    const asks = asksUnderHead(step);
    const from = asks ? `join:${id}:decide` : id;
    if (asks) {
      const question = branchQuestion(step);
      // To read, the whole question shows: an if has two columns under it to be as wide as.
      const width = decideWidth(question, READING ? 2 * NODE_W - 20 : undefined);
      this.nodes.push({ id: from, type: "join", position: { x: cx - width / 2, y: y + own.h + DECIDE_GAP }, data: { kind: "join", parentId: id, shown: false, question, width } });
      this.edge(id, from);
    }
    const bodyY = y + own.h + (asks ? DECIDE_GAP + DECIDE_H : 0) + GAP_Y;
    const columnsH = Math.max(...sizes.map((m) => m.h));
    // A try's columns meet before its "finally", which runs after them.
    const meet = after ? `join:${id}:then` : join;
    this.nodes.push({
      id: join,
      type: "join",
      position: { x: cx - JOIN_SIZE / 2, y: joinY },
      data: { kind: "join", parentId: id, shown: !after && columns.length > 1, through: after !== null || columns.length === 1 },
    });
    if (after) {
      this.nodes.push({
        id: meet,
        type: "join",
        position: { x: cx - JOIN_SIZE / 2, y: bodyY + columnsH + JOIN_GAP },
        data: { kind: "join", parentId: id, shown: columns.length > 1, through: columns.length === 1 },
      });
    }

    this.depth += 1;
    // Where a try's "実行" is drawn: its steps' right edges, for the line its failures take.
    let attempt: { right: number; ticks: { x: number; y: number }[] } | null = null;
    columns.forEach((lane, i) => {
      const size = sizes[i] ?? SLOT;
      const fails = catches(step, lane);
      const before = this.nodes.length;
      const framesBefore = this.frames.length;
      const placed = this.list(lane.steps, bodyY + (fails ? CATCH_DROP : 0), laneX, size.w, id, lane.name, lane.label, lane.start, lane.tail);
      if (step.type === TRY && lane.name === "try") {
        // A tick off the side of each step in it (or its "+" when it is empty), at the height of the step's head.
        const ticks = this.nodes.slice(before).flatMap((n) => {
          if (n.data.kind === "join" || n.data.kind === "terminal" || n.data.parentId !== id || n.data.block !== lane.name) return [];
          if (n.data.kind === "slot" && n.data.tail) return [];
          const w = n.data.kind === "step" && n.data.head ? n.data.head.width : n.data.kind === "slot" ? SLOT.w : NODE_W;
          const h = n.data.kind === "slot" ? SLOT_H : n.data.kind === "step" && n.data.head ? HEAD_H : NODE_HEAD_H;
          return [{ x: n.position.x + w, y: n.position.y + h / 2 }];
        });
        attempt = { right: laneX + size.w, ticks };
      }
      if (fails && attempt) {
        const { right, ticks } = attempt as { right: number; ticks: { x: number; y: number }[] };
        const fail = `join:${id}:fail`;
        const top = ticks[0]?.y ?? bodyY;
        // Clear of the widest thing in "実行": the frame of a loop there reaches further right than a node.
        const railX = Math.max(right, ...ticks.map((t) => t.x)) + FAIL_X;
        this.nodes.push({ id: fail, type: "join", position: { x: railX - JOIN_SIZE / 2, y: top - JOIN_SIZE / 2 }, data: { kind: "join", parentId: id, shown: false, failTo: placed.entry } });
        this.edge(fail, placed.entry, lane.label || undefined, undefined, undefined, { failure: true, bracket: { x: railX, ticks } });
      } else {
        this.edge(from, placed.entry, lane.label || undefined, undefined, true, asks ? { owner: id, alt: { i, n: columns.length } } : undefined);
      }
      for (const e of placed.exits) this.edge(e, meet);
      // A column that ends in a fail (break, continue) stops there, but the "最後に必ず" still runs first.
      const last = lane.steps.at(-1);
      if (after && ends(last) && last?.id) {
        this.edge(last.id, meet, undefined, undefined, undefined, { thenFinally: true });
        const node = this.nodes.find((n) => n.id === last.id);
        if (node?.data.kind === "step") node.data.thenFinally = true;
      }
      if (asks) {
        // Everything in this column is one way out of the branch, which lights in turn with its line.
        const place = { owner: id, i };
        for (const n of this.nodes.slice(before)) n.branches = [place, ...(n.branches ?? [])];
        for (const f of this.frames.slice(framesBefore)) f.branches = [place, ...(f.branches ?? [])];
      }
      laneX += size.w + GAP_X;
    });
    if (after && afterSize) {
      const afterY = bodyY + columnsH + JOIN_GAP + JOIN_SIZE + GAP_Y;
      const placed = this.list(after.steps, afterY, cx - afterSize.w / 2, afterSize.w, id, after.name, after.label, after.start, after.tail);
      this.edge(meet, placed.entry, after.label || undefined);
      for (const e of placed.exits) this.edge(e, join);
    }
    this.depth -= 1;
    return { entry: id, exits: [join] };
  }

  /** A loop's body, its decision (see DECIDE_H), its line back and its way out on the frame's bottom edge. */
  private loop(
    step: Step,
    id: string,
    y: number,
    cx: number,
    left: number,
    right: number,
    headH: number,
    lane: Lane,
    size: Size,
    joinY: number,
  ): { entry: string; exits: string[] } {
    const join = `join:${id}`;
    const decide = `join:${id}:decide`;
    const asks = loopQuestion(step);
    const { yes, no } = asks;
    const width = decideWidth(asks.question);
    const half = width / 2;
    const after = CHECKS_AFTER.has(step.type);
    const bodyY = after ? y + headH + GAP_Y : y + headH + DECIDE_GAP + DECIDE_H + GAP_Y;
    const decideY = after ? bodyY + size.h + DECIDE_GAP : y + headH + DECIDE_GAP;
    if (after) {
      this.nodes.push({ id: join, type: "join", position: { x: cx - JOIN_SIZE / 2, y: joinY }, data: { kind: "join", parentId: id, shown: false, met: true } });
    } else {
      // The foot, across the frame's bottom: where the loop ends, however it ends.
      const foot: FootData = { width: right - left, lineX: cx - left, type: step.type, breaks: breaksIn(lane.steps) };
      this.nodes.push({ id: join, type: "join", position: { x: left, y: joinY }, data: { kind: "join", parentId: id, shown: false, foot } });
    }
    this.nodes.push({
      id: decide,
      type: "join",
      position: { x: cx - half, y: decideY },
      data: { kind: "join", parentId: id, shown: false, question: asks.question, width, after },
    });
    this.depth += 1;
    const placed = this.list(lane.steps, bodyY, cx - size.w / 2, size.w, id, lane.name, lane.label, lane.start, lane.tail);
    this.depth -= 1;
    const back = { loop: true, detourX: left + LOOP_LINE_X, owner: id };
    if (after) {
      // A wait: its block, then the decision; "いいえ" back up to the block, "はい" on out.
      this.edge(id, placed.entry, undefined, undefined, true);
      for (const e of placed.exits) this.edge(e, decide);
      this.edge(decide, placed.entry, loopBackLabel(step), undefined, undefined, { ...back, fromDecide: true, answer: no, half });
      this.edge(decide, join, yes);
    } else {
      // Decide first: "はい" into the body, its end back into the decision, "いいえ" down the right and out.
      this.edge(id, decide);
      this.edge(decide, placed.entry, yes, undefined, true);
      // An empty body has nothing to run again.
      if (lane.steps.length > 0) for (const e of placed.exits) this.edge(e, decide, loopBackLabel(step), undefined, undefined, { ...back, intoDecide: true, half });
      // A break comes out at the foot too: not drawn (it says where it goes), but a run that takes it passes the foot.
      for (const b of breaksIn(lane.steps)) this.edge(b, join, undefined, true);
      // "いいえ": all done. It says so beside the line, inside the frame, where it reaches the foot.
      this.edge(decide, join, no, undefined, undefined, { fromDecide: true, railX: right - LOOP_LINE_X, half, exit: loopExitLabel(step), owner: id });
      return { entry: id, exits: [join] };
    }
    this.exitLabels.set(join, loopExitLabel(step));
    return { entry: id, exits: [join] };
  }
}

/** The breaks in a loop's body that leave it: not those inside a loop in it, which leave that one. */
function breaksIn(steps: readonly Step[]): string[] {
  return steps.flatMap((s) => {
    if (s.type === BREAK) return s.disabled || !s.id ? [] : [s.id];
    if (LOOP_TYPES.has(s.type)) return [];
    return Object.values(s.blocks ?? {}).flatMap((b) => breaksIn(b));
  });
}

export function layoutFlow(steps: Step[], defs: Defs, extra: Extra = NO_EXTRA, collapsed: Collapsed = NONE): Layout {
  const builder = new Builder(defs, extra, collapsed);
  // A "+" at the end, on the line into the end, as at the end of a block; not after a step the flow stops at.
  const tail = steps.length > 0 && !ends(steps.at(-1));
  const size = measureList(steps, defs, extra, collapsed, tail);
  const top = TERMINAL_H + START_GAP;
  const placed = builder.list(steps, top, 0, size.w, null, null, "", 0, tail);
  const endY = top + size.h + END_GAP;
  const { nodes, edges, frames } = builder;
  nodes.unshift({ id: START_ID, type: "terminal", position: { x: size.w / 2, y: 0 }, data: { kind: "terminal", end: false } });
  nodes.push({ id: END_ID, type: "terminal", position: { x: size.w / 2, y: endY }, data: { kind: "terminal", end: true } });
  builder.edge(START_ID, placed.entry);
  for (const e of placed.exits) builder.edge(e, END_ID);
  return { nodes, edges, frames, width: size.w, height: endY + TERMINAL_H };
}
