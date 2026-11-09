// How a desktop node finds its window again (`target.window`), shown and
// chosen in words: the picker ("画面から選ぶ") offers the ways it can be
// found (`windowChoices`), the node's settings show them as choices, and
// the other nodes on the same app can be set to the same way at once.
import type { EditOp, Part, Step } from "@spellsheet/schema";
import { appOf, partRef, walk } from "./parts";

export type WindowQuery = Record<string, unknown>;

/** One way to find the window, as the picker offers it. */
export interface WindowChoice {
  kind: "any" | "steady" | "contains" | "exact";
  title?: string;
  window: WindowQuery;
  /** How many of the windows open when it was picked it finds. */
  finds: number;
}

/** What the picker answered about the window, kept for the node's settings. */
export interface PickedWindow {
  app?: string;
  title?: string;
  choices: WindowChoice[];
}

/** The picker's answer, as far as the window goes. */
export function pickedWindow(result: Record<string, unknown>): PickedWindow | undefined {
  const choices = Array.isArray(result.windowChoices) ? (result.windowChoices as WindowChoice[]) : [];
  if (choices.length === 0) return undefined;
  const window = (result.window ?? {}) as { title?: string };
  return { app: typeof result.app === "string" ? result.app : undefined, title: window.title, choices };
}

/** `exact: true` is the older way to write `match: "exact"`; contains is the default. */
export function normalWindow(w: WindowQuery | undefined): WindowQuery {
  if (!w) return {};
  const { exact, match, ...rest } = w;
  const how = match ?? (exact === true ? "exact" : undefined);
  return rest.title === undefined ? rest : { ...rest, match: how ?? "contains" };
}

export function sameWindow(a: WindowQuery | undefined, b: WindowQuery | undefined): boolean {
  const x = normalWindow(a);
  const y = normalWindow(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((k) => x[k] === y[k]);
}

/** The app's name for people when nothing better is known: the exe without `.exe`. */
export function exeName(process: unknown): string {
  const name = String(process ?? "").split(/[\\/]/).pop() ?? "";
  return name.replace(/\.exe$/i, "");
}

/** The process a window query names, for comparing (case does not matter). */
const processKey = (w: unknown): string =>
  w && typeof w === "object" ? String((w as WindowQuery).process ?? "").toLowerCase().replace(/\.exe$/, "") : "";

/**
 * The choices to show: the picker's when they are for this window (same
 * exe), else "any of its windows" and the current way. `on` marks the one
 * in use; a current way none of them is comes last, on.
 */
export function windowChips(current: WindowQuery, picked: PickedWindow | undefined): { choice: WindowChoice; on: boolean }[] {
  const ofThis = picked && picked.choices.some((c) => processKey(c.window) === processKey(current)) ? picked.choices : [];
  const base: WindowChoice[] =
    ofThis.length > 0 ? ofThis : current.process ? [{ kind: "any", window: { process: current.process }, finds: 0 }] : [];
  const chips: { choice: WindowChoice; on: boolean }[] = [];
  for (const choice of base) {
    if (chips.some((c) => sameWindow(c.choice.window, choice.window))) continue;
    chips.push({ choice, on: sameWindow(choice.window, current) });
  }
  if (!chips.some((c) => c.on) && Object.keys(current).length > 0) {
    const title = typeof current.title === "string" ? current.title : undefined;
    chips.push({ choice: { kind: normalWindow(current).match === "exact" ? "exact" : "contains", title, window: current, finds: 0 }, on: true });
  }
  return chips;
}

/** Whether the window in use is the picked title without its date or number. */
export function droppedDate(current: WindowQuery, picked: PickedWindow | undefined): string | undefined {
  const steady = picked?.choices.find((c) => c.kind === "steady");
  return steady && sameWindow(steady.window, current) ? steady.title : undefined;
}

/** A node or part on the same app whose window is found another way. */
export interface Other {
  step?: Step;
  part?: string;
}

/** The other nodes (and parts) on the same app as `window` that find it another way. */
export function othersOnApp(steps: readonly Step[], parts: Record<string, Part>, self: Step, window: WindowQuery): Other[] {
  const key = processKey(window);
  if (!key) return [];
  const differs = (target: unknown) => {
    const w = target && typeof target === "object" ? (target as { window?: WindowQuery }).window : undefined;
    return !!w && processKey(w) === key && !sameWindow(w, window);
  };
  const out: Other[] = [];
  for (const s of walk(steps)) {
    if (s.id === self.id || appOf(s.type) !== "desktop" || partRef(s.params?.target)) continue;
    if (differs(s.params?.target)) out.push({ step: s });
  }
  for (const [name, part] of Object.entries(parts)) {
    if (part.app === "desktop" && differs(part.target)) out.push({ part: name });
  }
  return out;
}

/** The edits that make `others` find their window as `window` does (the rest of each target stays). */
export function alignOps(others: readonly Other[], parts: Record<string, Part>, window: WindowQuery): EditOp[] {
  const ops: EditOp[] = [];
  for (const o of others) {
    if (o.step?.id) {
      const target = o.step.params?.target as Record<string, unknown>;
      ops.push({ op: "updateStep", stepId: o.step.id, patch: { replaceParams: { ...o.step.params, target: { ...target, window } } } });
    } else if (o.part && parts[o.part]) {
      const part = parts[o.part]!;
      ops.push({ op: "setPart", name: o.part, part: { ...part, target: { ...(part.target as Record<string, unknown>), window } as Part["target"] } });
    }
  }
  return ops;
}
