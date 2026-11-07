// Copying and pasting nodes. What goes on the clipboard is plain JSON in the
// flow's own shape (`steps`, and the named parts they use), so it pastes into
// another flow or another Studio window, and an AI can read it as it is.
import type { EditOp, Part, Step } from "@shikigami/schema";
import { partRef } from "./parts";

export const CLIPBOARD_FORMAT = "shikigami.steps";

export type Copied = { steps: Step[]; parts: Record<string, Part> };

function* walk(steps: readonly Step[]): Generator<Step> {
  for (const step of steps) {
    yield step;
    for (const children of Object.values(step.blocks ?? {})) yield* walk(children);
  }
}

/** The clipboard text for `steps`, with the parts they name. */
export function copyText(steps: readonly Step[], parts: Record<string, Part> | undefined): string {
  const used: Record<string, Part> = {};
  for (const step of walk(steps)) {
    const name = partRef(step.params?.target);
    if (name && parts?.[name]) used[name] = parts[name];
  }
  const body: Record<string, unknown> = { format: CLIPBOARD_FORMAT, steps };
  if (Object.keys(used).length > 0) body.parts = used;
  return JSON.stringify(body, null, 2);
}

const isStep = (v: unknown): v is Step =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

/**
 * Reads nodes from clipboard text: what `copyText` wrote, a list of steps, a
 * single step, or a whole flow (its `steps`). Anything else is `null`, so
 * ordinary text never turns into nodes.
 */
export function readCopied(text: string): Copied | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  let steps: unknown = null;
  let parts: unknown = undefined;
  if (Array.isArray(value)) steps = value;
  else if (isStep(value)) steps = [value];
  else if (value && typeof value === "object") {
    steps = (value as { steps?: unknown }).steps;
    parts = (value as { parts?: unknown }).parts;
  }
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every(isStep)) return null;
  const known = parts && typeof parts === "object" && !Array.isArray(parts) ? (parts as Record<string, Part>) : {};
  return { steps: steps as Step[], parts: known };
}

/** A deep copy with every node (children too) under a new ID. */
export function withNewIds(step: Step, newId: () => string): Step {
  const copy: Step = { ...structuredClone(step), id: newId() };
  if (step.blocks) {
    copy.blocks = Object.fromEntries(
      Object.entries(step.blocks).map(([name, children]) => [name, children.map((c) => withNewIds(c, newId))]),
    );
  }
  return copy;
}

/**
 * The parts to add for a paste: those the flow lacks. A part of the same name
 * that differs is left as the flow has it (the flow's own screens win).
 */
export function partOps(copied: Copied, existing: Record<string, Part> | undefined): EditOp[] {
  return Object.entries(copied.parts)
    .filter(([name]) => !existing?.[name])
    .map(([name, part]) => ({ op: "setPart", name, part }) as EditOp);
}

type Location = { parentId: string | null; block: string | null; index: number };

/**
 * The run of sibling nodes from `from` to `to` (both included, in flow order),
 * or `null` when they are not in the same block.
 */
export function siblingRange(steps: readonly Step[], from: string, to: string): string[] | null {
  const a = place(steps, from);
  const b = place(steps, to);
  if (!a || !b || a.loc.parentId !== b.loc.parentId || a.loc.block !== b.loc.block) return null;
  const [lo, hi] = a.loc.index <= b.loc.index ? [a.loc.index, b.loc.index] : [b.loc.index, a.loc.index];
  return a.siblings.slice(lo, hi + 1).map((s) => s.id ?? "");
}

function place(
  steps: readonly Step[],
  id: string,
  parentId: string | null = null,
  block: string | null = null,
): { loc: Location; siblings: readonly Step[] } | null {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.id === id) return { loc: { parentId, block, index }, siblings: steps };
    for (const [name, children] of Object.entries(step.blocks ?? {})) {
      const found = place(children, id, step.id ?? null, name);
      if (found) return found;
    }
  }
  return null;
}
