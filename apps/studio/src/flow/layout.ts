// Derives a flowchart from the step tree. This is a pure *view* of the
// flow: positions are computed, never stored, so AI edits and GUI edits
// always render identically and no layout data leaks into flow files.
//
// Steps run top to bottom; a step's blocks sit side by side below it, framed
// together with it (the step is the frame's head), and a loop draws a line
// from the end of its body back to where its body starts, inside its frame.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { CASE, IF, LOOP_TYPES, PARALLEL, SWITCH, TRY } from "../lib/stepTypes";
import { laneLabel, loopBackLabel, loopExitLabel } from "../lib/keywords";
import { nodeHeight } from "../lib/nodeRows";

export const NODE_W = 290;
export const SLOT_H = 40;
/** Room above a step for the flow edge, its label and the review toolbar. */
const GAP_Y = 56;
/** Between the last node and the "+" under it. */
const END_GAP = 24;
/**
 * The small "+" at the end of a block that has nodes (a branch, a loop's
 * body, …), on the line just under its last node: it adds a node there,
 * inside the block. The line runs through it on to what comes next.
 */
export const TAIL_SIZE = 24;
const TAIL_GAP = 16;
/**
 * Room beside a step for its variable chips: the ones it reads sit off its
 * left edge (up to two side by side), the ones it writes off its right (one
 * per row). A chip is at most 80px, after a 16px lead.
 */
export const READ_ROOM = 16 + 80 + 4 + 80;
export const WRITE_ROOM = 16 + 80;
/** Between side-by-side lanes: one lane's write chips, then the next one's read chips. */
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
/** Under the blocks: room for the lines to turn into the join, then the join, then the frame's edge. */
const JOIN_GAP = 28;
export const JOIN_SIZE = 8;
const JOIN_BELOW = 14;
/**
 * A loop's line back runs from the end of its body up the left of its frame,
 * LOOP_LINE_X in from the edge (outside the read chips and the frames of
 * steps inside), and back into the line that enters its body, just under the
 * head: the next item runs the body again from the top. It never leaves the
 * frame, and the line on to the next step leaves from the frame's bottom edge.
 */
export const LOOP_LINE_X = 14;
/** Under a loop's body: room for its line back to turn, then the frame's edge. */
const LOOP_BOTTOM = 36;
const LOOP_FRAME = { left: READ_ROOM + 12 + 24, right: WRITE_ROOM + 12 };
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
  /** The step is the head of a frame (a loop, if, …): drawn as the frame's top edge. */
  head?: HeadData;
  /** A case of a switch: drawn as the tab over its column. */
  tab?: boolean;
};

/** Where the blocks of a frame meet again, on its bottom edge (a loop's is only where its line leaves). */
export type JoinNodeData = { kind: "join"; parentId: string; shown: boolean };

export type SlotNodeData = {
  kind: "slot";
  parentId: string | null;
  block: string | null;
  label: string;
  /** The faint "+" under the flow's last node, to keep adding at the end. */
  end?: boolean;
  /** The small "+" under a block's last node, to add at the end of the block (see TAIL_SIZE). */
  tail?: boolean;
};

export type LayoutNode = {
  id: string;
  type: "step" | "slot" | "join";
  position: { x: number; y: number };
  data: StepNodeData | SlotNodeData | JoinNodeData;
};

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** A loop's line back from the end of its body to where its body starts (see LOOP_LINE_X). */
  loop?: boolean;
  /** For a loop's line back: the x it runs up at. */
  detourX?: number;
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
};

export type Layout = { nodes: LayoutNode[]; edges: LayoutEdge[]; frames: LayoutFrame[]; width: number; height: number };

type Defs = ReadonlyMap<string, StepTypeDef>;

/** Extra height a step's node needs (a call shown unfolded), by step id. */
export type Extra = ReadonlyMap<string, number>;
const NO_EXTRA: Extra = new Map();

function frameKind(type: string): FrameKind {
  if (LOOP_TYPES.has(type)) return "loop";
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
  return tail ? { w: Math.max(w, TAIL_SIZE), h: h + TAIL_GAP + TAIL_SIZE } : { w, h };
}

function measure(step: Step, defs: Defs, extra: Extra, collapsed: Collapsed): Size {
  const ls = lanes(step, defs, collapsed);
  const own = nodeSize(step, defs, extra);
  if (ls.length === 0) return own;
  const ms = ls.map((l) => measureList(l.steps, defs, extra, collapsed, l.tail));
  const w = ms.reduce((acc, m) => acc + m.w, 0) + GAP_X * (ms.length - 1);
  const inner = Math.max(...ms.map((m) => m.h));
  if (UNFRAMED.has(step.type)) return { w: Math.max(own.w, w), h: inner };
  const h = own.h + GAP_Y + inner + (LOOP_TYPES.has(step.type) ? LOOP_BOTTOM : JOIN_GAP + JOIN_SIZE + JOIN_BELOW);
  const room = (LOOP_TYPES.has(step.type) ? 32 : BLOCK_ROOM) * 2;
  return { w: Math.max(own.w, w + room), h };
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

  edge(source: string, target: string, label?: string, hidden?: boolean, split?: boolean, back?: { detourX: number }) {
    // The line out of a loop says when it leaves; not into the join of a frame around it, where lines meet.
    if (label === undefined && !target.startsWith("join:")) label = this.exitLabels.get(source);
    this.edges.push({
      id: `${source}->${target}${label ? `:${label}` : ""}`,
      source,
      target,
      label,
      ...(back ? { loop: true, detourX: back.detourX } : {}),
      ...(hidden ? { hidden } : {}),
      ...(split ? { split } : {}),
    });
  }

  /** Places a list centred in [x, x + span); returns its entry node id and the ids that flow into the next step. */
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
        position: { x: x + (span - TAIL_SIZE) / 2, y: cursor - GAP_Y + TAIL_GAP },
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
      return { entry: id, exits: [id] };
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

    const sizes = ls.map((l) => measureList(l.steps, this.defs, this.extra, this.collapsed, l.tail));
    const isLoop = LOOP_TYPES.has(step.type);
    const total = sizes.reduce((a, m) => a + m.w, 0) + GAP_X * (ls.length - 1);
    let laneX = x + (span - total) / 2;
    const side = isLoop ? LOOP_FRAME : BLOCK_FRAME;
    const left = Math.min(laneX, cx - own.w / 2) - side.left;
    const right = Math.max(laneX + total, cx + own.w / 2) + side.right;
    const height = measure(step, this.defs, this.extra, this.collapsed).h;
    this.nodes.push({
      id,
      type: "step",
      position: { x: left, y },
      data: { ...base, head: { width: right - left, lineX: cx - left, collapsed: false, count: countInside(step), ...extras } },
    });
    this.frames.push({ id, kind: frameKind(step.type), type: step.type, depth: this.depth, x: left, y: y - FRAME_TOP, width: right - left, height: height + FRAME_TOP });

    // A loop's join is only where its line leaves: on the frame's bottom edge, so the line starts outside the frame.
    const joinY = isLoop ? y + height - JOIN_SIZE : y + height - JOIN_BELOW - JOIN_SIZE;
    const join = `join:${id}`;
    this.nodes.push({ id: join, type: "join", position: { x: cx - JOIN_SIZE / 2, y: joinY }, data: { kind: "join", parentId: id, shown: !isLoop && ls.length > 1 } });

    this.depth += 1;
    ls.forEach((lane, i) => {
      const size = sizes[i] ?? SLOT;
      const placed = this.list(lane.steps, y + own.h + GAP_Y, laneX, size.w, id, lane.name, lane.label, lane.start, lane.tail);
      this.edge(id, placed.entry, lane.label || undefined, undefined, true);
      if (!isLoop) {
        for (const e of placed.exits) this.edge(e, join);
      } else if (lane.steps.length > 0) {
        // Back to where the body starts; an empty body has nothing to run again.
        for (const e of placed.exits) this.edge(e, placed.entry, loopBackLabel(step), undefined, undefined, { detourX: left + LOOP_LINE_X });
      }
      laneX += size.w + GAP_X;
    });
    this.depth -= 1;
    // A loop leaves from the bottom of its frame once it is done: no line through its body.
    if (isLoop) {
      this.edge(id, join, undefined, true);
      this.exitLabels.set(join, loopExitLabel(step));
    }
    return { entry: id, exits: [join] };
  }
}

export function layoutFlow(steps: Step[], defs: Defs, extra: Extra = NO_EXTRA, collapsed: Collapsed = NONE): Layout {
  const builder = new Builder(defs, extra, collapsed);
  const size = measureList(steps, defs, extra, collapsed);
  builder.list(steps, 0, 0, size.w, null, null, "");
  const { nodes, edges, frames } = builder;
  if (steps.length === 0) return { nodes, edges, frames, width: size.w, height: size.h };
  // Under the last node: a faint "+" to add the next one at the end.
  const y = size.h + END_GAP;
  nodes.push({
    id: "slot:end",
    type: "slot",
    position: { x: (size.w - SLOT.w) / 2, y },
    data: { kind: "slot", parentId: null, block: null, label: "", end: true },
  });
  return { nodes, edges, frames, width: size.w, height: y + SLOT.h };
}
