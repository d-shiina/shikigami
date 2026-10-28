// Derives a flowchart from the step tree. This is a pure *view* of the
// scenario: positions are computed, never stored, so AI edits and GUI edits
// always render identically and no layout data leaks into scenario files.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { nodeHeight } from "../lib/nodeRows";

export const NODE_W = 260;
export const SLOT_H = 40;
const GAP_X = 48;
const GAP_Y = 36;
/** Room between steps left to right, for edge labels and value tags. */
const GAP_MAIN_H = 72;
/** How far a block's steps start to the right of the step that owns them. */
const LANE_INDENT = 48;

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

export type LayoutNode = {
  id: string;
  type: "step" | "slot";
  position: { x: number; y: number };
  data: StepNodeData | SlotNodeData;
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

function measure(step: Step, axes: Axes, defs: Defs): Size {
  const ls = lanes(step, defs);
  const own = axes.node(step);
  if (ls.length === 0) return own;
  const ms = ls.map((l) => measureList(l.steps, axes, defs));
  if (axes.dir === "horizontal") {
    // Blocks hang below their step, side by side, so the top row reads as
    // the scenario's main line and nesting grows downwards.
    const lanesMain = LANE_INDENT + ms.reduce((acc, m) => acc + m.main, 0) + axes.mainGap * (ms.length - 1);
    return { main: Math.max(own.main, lanesMain), cross: own.cross + GAP_Y + Math.max(...ms.map((m) => m.cross)) };
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
      if (isLoop) {
        for (const e of placed.exits) this.edge(e, id, undefined, true);
      } else {
        exits.push(...placed.exits);
      }
    };
    if (this.axes.dir === "horizontal") {
      let laneMain = main + LANE_INDENT;
      const laneCross = cross + own.cross + GAP_Y;
      ls.forEach((lane, i) => {
        const size = sizes[i] ?? this.axes.slot;
        attach(this.list(lane.steps, laneMain, laneCross, size.cross, id, lane.name, lane.label, lane.start), lane);
        laneMain += size.main + this.axes.mainGap;
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
