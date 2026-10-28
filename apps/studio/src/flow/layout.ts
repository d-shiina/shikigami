// Derives a flowchart from the step tree. This is a pure *view* of the
// scenario: positions are computed, never stored, so AI edits and GUI edits
// always render identically and no layout data leaks into scenario files.
//
// Steps run top to bottom; a step's blocks sit side by side below it, and
// loops draw a back-edge from the end of their body.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { blockLabel } from "../lib/keywords";
import { nodeHeight } from "../lib/nodeRows";

export const NODE_W = 290;
export const SLOT_H = 40;
/** Room above a step for the flow edge, its label and the review toolbar. */
const GAP_Y = 56;
/**
 * Room beside a step for its variable chips: the ones it reads sit off its
 * left edge, the ones it writes off its right.
 */
export const CHIP_ROOM = 96;
/**
 * Beside a loop's body, on each side: room for the line that returns to the
 * loop (right) and the line that leaves it for the next step (left), outside
 * the body's value chips so the lines never run through steps or chips.
 */
const LOOP_ROOM = 24;
/** How far outside a loop body's steps its detour lines run. */
export const DETOUR = CHIP_ROOM + 12;
/** Between side-by-side lanes: one lane's write chips, a loop's detour, the next one's read chips. */
const GAP_X = CHIP_ROOM * 2 + LOOP_ROOM;

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
  /**
   * For a loop's back edge and the edge leaving a loop: the x the line runs
   * down or up at, beside the loop's body instead of through it.
   */
  detourX?: number;
};

export type Layout = { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number };

type Defs = ReadonlyMap<string, StepTypeDef>;

/** Extra height a step's node needs (a call shown unfolded), by step id. */
export type Extra = ReadonlyMap<string, number>;
const NO_EXTRA: Extra = new Map();

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
    label: blockLabel(step, b.name, b.label),
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

type Size = { w: number; h: number };

const SLOT: Size = { w: NODE_W, h: SLOT_H };

function nodeSize(step: Step, defs: Defs, extra: Extra): Size {
  return { w: NODE_W, h: nodeHeight(step, defs.get(step.type), extra.get(step.id ?? "") ?? 0) };
}

function measureList(steps: Step[], defs: Defs, extra: Extra): Size {
  if (steps.length === 0) return SLOT;
  let w = 0;
  let h = 0;
  for (const s of steps) {
    const m = measure(s, defs, extra);
    w = Math.max(w, m.w);
    h += m.h;
  }
  return { w, h: h + GAP_Y * (steps.length - 1) };
}

function measure(step: Step, defs: Defs, extra: Extra): Size {
  const ls = lanes(step, defs);
  const own = nodeSize(step, defs, extra);
  if (ls.length === 0) return own;
  const ms = ls.map((l) => measureList(l.steps, defs, extra));
  const w = ms.reduce((acc, m) => acc + m.w, 0) + GAP_X * (ms.length - 1);
  const h = own.h + GAP_Y + Math.max(...ms.map((m) => m.h));
  const room = LOOP_TYPES.has(step.type) ? LOOP_ROOM * 2 : 0;
  return { w: Math.max(own.w, w + room), h };
}

class Builder {
  nodes: LayoutNode[] = [];
  edges: LayoutEdge[] = [];

  constructor(
    private defs: Defs,
    private extra: Extra,
  ) {}

  /** Left and right edges of each loop's body, by loop step id. */
  bodies = new Map<string, { left: number; right: number }>();

  edge(source: string, target: string, label?: string, loop?: boolean, detourX?: number) {
    this.edges.push({ id: `${source}->${target}${label ? `:${label}` : ""}`, source, target, label, loop, detourX });
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
      for (const p of previous) {
        // Leaving a loop: down its body's left side, not through the body.
        const body = this.bodies.get(p);
        this.edge(p, placed.entry, undefined, undefined, body ? body.left - DETOUR : undefined);
      }
      previous = placed.exits;
      cursor += measure(step, this.defs, this.extra).h + GAP_Y;
    });
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
    this.nodes.push({
      id,
      type: "step",
      position: { x: x + (span - own.w) / 2, y },
      data: { kind: "step", step, def, parentId, block, index },
    });
    const ls = lanes(step, this.defs);
    if (ls.length === 0) return { entry: id, exits: [id] };

    const sizes = ls.map((l) => measureList(l.steps, this.defs, this.extra));
    const isLoop = LOOP_TYPES.has(step.type);
    const exits: string[] = [];
    const total = sizes.reduce((a, m) => a + m.w, 0) + GAP_X * (ls.length - 1);
    let laneX = x + (span - total) / 2;
    if (isLoop) this.bodies.set(id, { left: laneX, right: laneX + total });
    ls.forEach((lane, i) => {
      const size = sizes[i] ?? SLOT;
      const placed = this.list(lane.steps, y + own.h + GAP_Y, laneX, size.w, id, lane.name, lane.label, lane.start);
      this.edge(id, placed.entry, lane.label);
      if (isLoop) {
        for (const e of placed.exits) this.edge(e, id, undefined, true, laneX + size.w + DETOUR);
      } else {
        exits.push(...placed.exits);
      }
      laneX += size.w + GAP_X;
    });
    return { entry: id, exits: isLoop ? [id] : exits };
  }
}

export function layoutScenario(steps: Step[], defs: Defs, extra: Extra = NO_EXTRA): Layout {
  const builder = new Builder(defs, extra);
  const size = measureList(steps, defs, extra);
  builder.list(steps, 0, 0, size.w, null, null, "");
  return { nodes: builder.nodes, edges: builder.edges, width: size.w, height: size.h };
}
