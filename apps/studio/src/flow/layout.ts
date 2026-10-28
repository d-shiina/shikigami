// Derives a flowchart from the step tree. This is a pure *view* of the
// scenario: positions are computed, never stored, so AI edits and GUI edits
// always render identically and no layout data leaks into scenario files.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { nodeHeight } from "../lib/nodeRows";

export const NODE_W = 260;
export const SLOT_H = 40;
const GAP_X = 48;
const GAP_Y = 36;

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

export type Layout = { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number };

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

function measureList(steps: Step[], defs: Defs): { w: number; h: number } {
  if (steps.length === 0) return { w: NODE_W, h: SLOT_H };
  let w = 0;
  let h = 0;
  for (const s of steps) {
    const m = measure(s, defs);
    w = Math.max(w, m.w);
    h += m.h;
  }
  return { w, h: h + GAP_Y * (steps.length - 1) };
}

function measure(step: Step, defs: Defs): { w: number; h: number } {
  const ls = lanes(step, defs);
  const own = nodeHeight(step, defs.get(step.type));
  if (ls.length === 0) return { w: NODE_W, h: own };
  const ms = ls.map((l) => measureList(l.steps, defs));
  const w = ms.reduce((acc, m) => acc + m.w, 0) + GAP_X * (ms.length - 1);
  const h = own + GAP_Y + Math.max(...ms.map((m) => m.h));
  return { w: Math.max(NODE_W, w), h };
}

class Builder {
  nodes: LayoutNode[] = [];
  edges: LayoutEdge[] = [];
  private defs: Defs;

  constructor(defs: Defs) {
    this.defs = defs;
  }

  edge(source: string, target: string, label?: string, loop?: boolean) {
    this.edges.push({ id: `${source}->${target}${label ? `:${label}` : ""}`, source, target, label, loop });
  }

  /** Places a list; returns entry node id and ids that flow into the next step. */
  list(
    steps: Step[],
    x: number,
    y: number,
    width: number,
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
        position: { x: x + (width - NODE_W) / 2, y },
        data: { kind: "slot", parentId, block, label: slotLabel },
      });
      return { entry: id, exits: [id] };
    }
    let cursor = y;
    let entry = "";
    let previous: string[] = [];
    steps.forEach((step, index) => {
      const placed = this.step(step, x, cursor, width, parentId, block, start + index);
      if (index === 0) entry = placed.entry;
      for (const p of previous) this.edge(p, placed.entry);
      previous = placed.exits;
      cursor += measure(step, this.defs).h + GAP_Y;
    });
    return { entry, exits: previous };
  }

  step(
    step: Step,
    x: number,
    y: number,
    width: number,
    parentId: string | null,
    block: string | null,
    index: number,
  ): { entry: string; exits: string[] } {
    const id = step.id ?? `anon-${this.nodes.length}`;
    const def = this.defs.get(step.type);
    this.nodes.push({
      id,
      type: "step",
      position: { x: x + (width - NODE_W) / 2, y },
      data: { kind: "step", step, def, parentId, block, index },
    });
    const ls = lanes(step, this.defs);
    if (ls.length === 0) return { entry: id, exits: [id] };

    const sizes = ls.map((l) => measureList(l.steps, this.defs));
    const total = sizes.reduce((a, m) => a + m.w, 0) + GAP_X * (ls.length - 1);
    let laneX = x + (width - total) / 2;
    const exits: string[] = [];
    const isLoop = LOOP_TYPES.has(step.type);
    ls.forEach((lane, i) => {
      const size = sizes[i] ?? { w: NODE_W, h: SLOT_H };
      const placed = this.list(lane.steps, laneX, y + nodeHeight(step, def) + GAP_Y, size.w, id, lane.name, lane.label, lane.start);
      this.edge(id, placed.entry, lane.label);
      if (isLoop) {
        for (const e of placed.exits) this.edge(e, id, undefined, true);
      } else {
        exits.push(...placed.exits);
      }
      laneX += size.w + GAP_X;
    });
    return { entry: id, exits: isLoop ? [id] : exits };
  }
}

export function layoutScenario(steps: Step[], defs: Defs): Layout {
  const builder = new Builder(defs);
  const size = measureList(steps, defs);
  builder.list(steps, 0, 0, size.w, null, null, "");
  return { nodes: builder.nodes, edges: builder.edges, width: size.w, height: size.h };
}
