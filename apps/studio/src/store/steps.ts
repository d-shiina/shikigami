// Finding steps in a flow and where a new one goes.
import type { Step } from "@spellsheet/schema";
import { CASE } from "../lib/stepTypes";
import { t } from "../lib/i18n";
import type { Selection, InsertAt, StudioState } from "./index";

/** Where a step lives in the tree. */
export type Location = { parentId: string | null; block: string | null; index: number; siblings: number };

export function locate(steps: Step[], id: string, parentId: string | null = null, block: string | null = null): Location | null {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.id === id) return { parentId, block, index, siblings: steps.length };
    for (const [name, children] of Object.entries(step.blocks ?? {})) {
      const found = locate(children, id, step.id ?? null, name);
      if (found) return found;
    }
  }
  return null;
}

export type Position = { parentId?: string | null; block?: string | null; index?: number | null };

/**
 * Where a new node goes, and which node it goes next to: at the "+" it was
 * asked for, else after the selected node, else at the end of the selected
 * empty block, else at the end of the flow.
 */
export function insertPlace(
  steps: Step[],
  selection: Selection,
  at: InsertAt | null,
): { position: Position; before?: Step; after?: Step; into?: { parent: Step; block: string }; prev?: Step } {
  if (at) {
    const siblings = at.parentId === null ? steps : (findStep(steps, at.parentId)?.blocks?.[at.block ?? ""] ?? []);
    const before = siblings[at.index];
    const after = siblings[at.index - 1];
    const parent = at.parentId === null ? null : findStep(steps, at.parentId);
    return {
      position: { parentId: at.parentId, block: at.block, index: at.index },
      ...(before ? { before } : after ? { after } : parent && at.block ? { into: { parent, block: at.block } } : {}),
      // The step the new one follows, when adding on a line between two (the palette offers what usually comes next).
      ...(before && after ? { prev: after } : {}),
    };
  }
  if (selection?.kind === "slot") {
    const parent = selection.parentId === null ? null : findStep(steps, selection.parentId);
    return {
      position: { parentId: selection.parentId, block: selection.block },
      ...(parent && selection.block ? { into: { parent, block: selection.block } } : {}),
    };
  }
  if (selection?.kind === "step") {
    const loc = locate(steps, selection.stepId);
    const step = findStep(steps, selection.stepId);
    if (loc && step) return { position: { parentId: loc.parentId, block: loc.block, index: loc.index + 1 }, after: step };
  }
  return { position: {} };
}

export function findStep(steps: Step[], id: string): Step | null {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const children of Object.values(step.blocks ?? {})) {
      const found = findStep(children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Sensible starting params so a freshly added step is close to runnable. */
export const DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  "control.if": { condition: "true" },
  "control.switch": { value: "''" },
  "control.case": { values: [""] },
  "control.while": { condition: "false" },
  "control.repeat": { count: 1 },
  "control.forEach": { itemVar: "item" },
  get "control.fail"() {
    return { message: t.severity.error };
  },
  "variable.set": { name: "value", value: "" },
  "log.message": { message: "" },
  "flow.delay": { ms: 1000 },
  "wait.until": { condition: "true" },
  "flow.call": { flow: "" },
  "browser.open": { url: "https://" },
  "browser.click": { target: { role: "button", name: "" } },
  "browser.fill": { target: { label: "" }, value: "" },
  "browser.waitFor": { target: { text: "" } },
  "browser.getText": { target: { text: "" } },
  "browser.press": { key: "Enter" },
};

/**
 * The nodes the person has selected, in flow order: the Shift+click range when
 * there is one for the selected node, else the selected node alone.
 */
export function selectedIds(state: Pick<StudioState, "selection" | "range">): string[] {
  const { selection, range } = state;
  if (selection?.kind !== "step") return [];
  if (range && range.focus === selection.stepId) return range.ids;
  return [selection.stepId];
}

/**
 * What "サブフローにまとめる" offers for the selection. Several picked nodes
 * (Shift+click) are taken as they are; one node offers itself and the nodes
 * after it in the same block, to choose how many.
 */
export function extractChoices(steps: Step[], state: Pick<StudioState, "selection" | "range">): { picked: Step[] } | { from: Step[] } | null {
  const ids = selectedIds(state);
  if (ids.length === 0) return null;
  const found = ids.map((id) => findStep(steps, id)).filter((s): s is Step => !!s);
  if (found.length !== ids.length) return null;
  if (ids.length > 1) return { picked: found };
  return { from: siblingsAfter(steps, ids[0]!) ?? found };
}

/** The step and the ones after it, in its block. */
export function siblingsAfter(steps: Step[], id: string): Step[] | null {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) return steps.slice(i);
  for (const step of steps) {
    for (const children of Object.values(step.blocks ?? {})) {
      const found = siblingsAfter(children, id);
      if (found) return found;
    }
  }
  return null;
}

/** A case of a switch, with nothing to compare to yet. */
export function newCase(body: Step[] = []): Step {
  return { id: newStepId(), type: CASE, params: { ...(DEFAULT_PARAMS[CASE] ?? {}) }, ...(body.length > 0 ? { blocks: { body } } : {}) };
}

/** The control nodes selected nodes can be put inside, and the block they go into. */
export const WRAP_BLOCK: Record<string, string> = {
  "control.forEach": "body",
  "control.repeat": "body",
  "control.if": "then",
  "control.try": "try",
  "control.group": "body",
};

export function newStepId(): string {
  return `stp_${crypto.randomUUID().replaceAll("-", "")}`;
}
