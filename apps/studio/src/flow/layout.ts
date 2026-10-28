// Derives a flowchart from the step tree. This is a pure *view* of the
// scenario: positions are computed, never stored, so AI edits and GUI edits
// always render identically and no layout data leaks into scenario files.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { nodeHeight } from "../lib/nodeRows";

export const NODE_W = 290;
export const SLOT_H = 40;
const GAP_X = 48;
const GAP_Y = 36;
/** Room between steps left to right, for edge labels and value tags. */
const GAP_MAIN_H = 72;
/** How far a block's steps start to the right of the step that owns them. */
const LANE_INDENT = 48;
/** Space inside a block's frame around its steps, and the frame's title strip. */
const FRAME_PAD = 14;
const FRAME_LABEL = 20;

export type StepNodeData = {
  kind: "step";
  step: Step;
  def: StepTypeDef | undefined;
  parentId: string | null;
  block: string | null;
  index: number;
};

export type SlotNodeData = {
  kind: "slot";
  parentId: string | null;
  block: string | null;
  label: string;
};

/** A labelled box drawn behind one block of a step, e.g. "条件が真" or a loop body. */
export type FrameNodeData = {
  kind: "frame";
  label: string;
  width: number;
  height: number;
  /** How deep the block is nested, for shading. */
  depth: number;
  /** The block repeats (a loop body). */
  loop: boolean;
};

export type LayoutNode = {
  id: string;
  type: "step" | "slot" | "frame";
  position: { x: number; y: number };
  data: StepNodeData | SlotNodeData | FrameNodeData;
};

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  loop?: boolean;
};

export type Layout = { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number; direction: Direction };

type Defs = ReadonlyMap<string, StepTypeDef>;

const LOOP_TYPES = new Set(["control.while", "control.repeat", "control.forEach"]);
/** Blocks whose children run at the same time: each child gets its own lane. */
const FAN_OUT_BLOCKS: Record<string, string> = { "control.parallel": "branches" };

type Lane = { name: string; label: string; steps: Step[]; start: number };

/** Block lanes of a step: declared blocks in registry order, then unknown ones. */
function lanes(step: Step, defs: Defs): Lane[] {
  const def = defs.get(step.type);
  const declared = def?.blocks ?? [];
  const result: Lane[] = declared.map((b) => ({
    name: b.name,
    label: b.label,
    steps: step.blocks?.[b.name] ?? [],
    start: 0,
  }));
  for (const [name, steps] of Object.entries(step.blocks ?? {})) {
    if (!declared.some((b) => b.name === name)) result.push({ name, label: name, steps, start: 0 });
  }
  const fanOut = FAN_OUT_BLOCKS[step.type];
  return result.flatMap((lane) =>
    lane.name === fanOut && lane.steps.length > 0
      ? lane.steps.map((child, i) => ({ ...lane, steps: [child], start: i }))
      : [lane],
  );
}

/**
 * Which way steps follow each other. Horizontal (left to right) is the
 * default, so variable links run forward from an output socket on a node's
 * right edge to an input socket on a later node's left edge.
 */
export type Direction = "horizontal" | "vertical";

/**
 * Sizes and gaps along the flow ("main") and across it ("cross"), so one
 * algorithm serves both directions. Positions are converted back to x/y
 * only when a node is placed.
 */
class Axes {
  constructor(
    readonly dir: Direction,
    private defs: Defs,
  ) {}
  get mainGap() {
    return this.dir === "vertical" ? GAP_Y : GAP_MAIN_H;
  }
  get crossGap() {
    return this.dir === "vertical" ? GAP_X : GAP_Y;
  }
  node(step: Step) {
    const h = nodeHeight(step, this.defs.get(step.type));
    return this.dir === "vertical" ? { main: h, cross: NODE_W } : { main: NODE_W, cross: h };
  }
  get slot() {
    return this.dir === "vertical" ? { main: SLOT_H, cross: NODE_W } : { main: NODE_W, cross: SLOT_H };
  }
  /** Vertical flows centre steps in their lane; left to right keeps them on one top line. */
  centre(cross: number, span: number, size: number) {
    return this.dir === "vertical" ? cross + (span - size) / 2 : cross;
  }
  point(main: number, cross: number) {
    return this.dir === "vertical" ? { x: cross, y: main } : { x: main, y: cross };
  }
}

type Size = { main: number; cross: number };

function measureList(steps: Step[], axes: Axes, defs: Defs): Size {
  if (steps.length === 0) return axes.slot;
  let main = 0;
  let cross = 0;
  for (const s of steps) {
    const m = measure(s, axes, defs);
    cross = Math.max(cross, m.cross);
    main += m.main;
  }
  return { main: main + axes.mainGap * (steps.length - 1), cross };
}

/** A lane's contents plus the frame drawn around them. */
const frameBox = (m: Size): Size => ({ main: m.main + FRAME_PAD * 2, cross: m.cross + FRAME_PAD * 2 + FRAME_LABEL });

function measure(step: Step, axes: Axes, defs: Defs): Size {
  const ls = lanes(step, defs);
  const own = axes.node(step);
  if (ls.length === 0) return own;
  const ms = ls.map((l) => measureList(l.steps, axes, defs));
  if (axes.dir === "horizontal") {
    // Blocks hang below their step, one under another, so the top row reads
    // as the scenario's main line, nesting grows downwards, and each lane's
    // exit runs right on its own row instead of through a sibling lane.
    const boxes = ms.map(frameBox);
    const lanesCross = boxes.reduce((acc, m) => acc + m.cross, 0) + axes.crossGap * (boxes.length - 1);
    return {
      main: Math.max(own.main, LANE_INDENT + Math.max(...boxes.map((m) => m.main))),
      cross: own.cross + axes.crossGap + lanesCross,
    };
  }
  const cross = ms.reduce((acc, m) => acc + m.cross, 0) + axes.crossGap * (ms.length - 1);
  const main = own.main + axes.mainGap + Math.max(...ms.map((m) => m.main));
  return { main, cross: Math.max(own.cross, cross) };
}

class Builder {
  nodes: LayoutNode[] = [];
  edges: LayoutEdge[] = [];
  private defs: Defs;
  private axes: Axes;
  private depth = 0;

  constructor(defs: Defs, axes: Axes) {
    this.defs = defs;
    this.axes = axes;
  }

  edge(source: string, target: string, label?: string, loop?: boolean) {
    this.edges.push({ id: `${source}->${target}${label ? `:${label}` : ""}`, source, target, label, loop });
  }

  /** Places a list; returns entry node id and ids that flow into the next step. */
  list(
    steps: Step[],
    main: number,
    cross: number,
    span: number,
    parentId: string | null,
    block: string | null,
    slotLabel: string,
    start = 0,
  ): { entry: string; exits: string[] } {
    if (steps.length === 0) {
      const id = `slot:${parentId ?? "root"}:${block ?? ""}`;
      this.nodes.push({
        id,
        type: "slot",
        position: this.axes.point(main, this.axes.centre(cross, span, this.axes.slot.cross)),
        data: { kind: "slot", parentId, block, label: slotLabel },
      });
      return { entry: id, exits: [id] };
    }
    let cursor = main;
    let entry = "";
    let previous: string[] = [];
    steps.forEach((step, index) => {
      const placed = this.step(step, cursor, cross, span, parentId, block, start + index);
      if (index === 0) entry = placed.entry;
      for (const p of previous) this.edge(p, placed.entry);
      previous = placed.exits;
      cursor += measure(step, this.axes, this.defs).main + this.axes.mainGap;
    });
    return { entry, exits: previous };
  }

  step(
    step: Step,
    main: number,
    cross: number,
    span: number,
    parentId: string | null,
    block: string | null,
    index: number,
  ): { entry: string; exits: string[] } {
    const id = step.id ?? `anon-${this.nodes.length}`;
    const def = this.defs.get(step.type);
    const own = this.axes.node(step);
    this.nodes.push({
      id,
      type: "step",
      position: this.axes.point(main, this.axes.centre(cross, span, own.cross)),
      data: { kind: "step", step, def, parentId, block, index },
    });
    const ls = lanes(step, this.defs);
    if (ls.length === 0) return { entry: id, exits: [id] };

    const sizes = ls.map((l) => measureList(l.steps, this.axes, this.defs));
    const isLoop = LOOP_TYPES.has(step.type);
    const exits: string[] = [];
    const attach = (placed: { entry: string; exits: string[] }, lane: Lane) => {
      this.edge(id, placed.entry, lane.label);
      // Left to right, a loop's frame says it repeats; back-edges would only
      // wrap the frame in a second outline.
      if (isLoop && this.axes.dir === "horizontal") return;
      if (isLoop) {
        for (const e of placed.exits) this.edge(e, id, undefined, true);
      } else {
        exits.push(...placed.exits);
      }
    };
    if (this.axes.dir === "horizontal") {
      let laneCross = cross + own.cross + this.axes.crossGap;
      ls.forEach((lane, i) => {
        const size = sizes[i] ?? this.axes.slot;
        const box = frameBox(size);
        const laneMain = main + LANE_INDENT;
        this.nodes.push({
          id: `frame:${id}:${lane.name}:${lane.start}`,
          type: "frame",
          position: this.axes.point(laneMain, laneCross),
          data: { kind: "frame", label: lane.label, width: box.main, height: box.cross, depth: this.depth, loop: isLoop },
        });
        this.depth++;
        const placed = this.list(
          lane.steps,
          laneMain + FRAME_PAD,
          laneCross + FRAME_PAD + FRAME_LABEL,
          size.cross,
          id,
          lane.name,
          lane.label,
          lane.start,
        );
        this.depth--;
        attach(placed, lane);
        laneCross += box.cross + this.axes.crossGap;
      });
      return { entry: id, exits: isLoop ? [id] : exits };
    }
    const total = sizes.reduce((a, m) => a + m.cross, 0) + this.axes.crossGap * (ls.length - 1);
    let laneCross = cross + (span - total) / 2;
    ls.forEach((lane, i) => {
      const size = sizes[i] ?? this.axes.slot;
      attach(this.list(lane.steps, main + own.main + this.axes.mainGap, laneCross, size.cross, id, lane.name, lane.label, lane.start), lane);
      laneCross += size.cross + this.axes.crossGap;
    });
    return { entry: id, exits: isLoop ? [id] : exits };
  }
}

export function layoutScenario(steps: Step[], defs: Defs, dir: Direction = "horizontal"): Layout {
  const axes = new Axes(dir, defs);
  const builder = new Builder(defs, axes);
  const size = measureList(steps, axes, defs);
  builder.list(steps, 0, 0, size.cross, null, null, "");
  const { x: width, y: height } = axes.point(size.main, size.cross);
  return { nodes: builder.nodes, edges: builder.edges, width, height, direction: dir };
}
