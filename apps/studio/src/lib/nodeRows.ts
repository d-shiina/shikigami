// What a flow node shows, Blender-style: one "項目 : 値" row per parameter,
// plus output rows for the variables the step writes. Display only; the
// layout uses the same rows to size nodes, so both always agree.
import type { Step, StepTypeDef, VariableDef } from "@shikigami/schema";
import { formatValue } from "./changes";
import { readable, targetText } from "./sentence";
import { t } from "./i18n";

export const NODE_HEAD_H = 58;
export const ROW_H = 26;
export const NODE_PAD_B = 8;
export const MAX_PARAM_ROWS = 5;

export const paramLabel = (key: string) => (t.paramLabels as Record<string, string>)[key] ?? key;

export type Row =
  | { kind: "param"; key: string; label: string; value: string; refs: string[] }
  | { kind: "more"; count: number }
  | { kind: "output"; label: string; variable: string };

/** Variable names a value mentions, among the ones we know about. */
export function referencedVariables(value: unknown, known: ReadonlySet<string>): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const found = new Set<string>();
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (known.has(word)) found.add(word);
  return [...found];
}

/** Params that hold a bare expression rather than text with `{{ }}` holes. */
const EXPRESSION_KEYS = new Set(["condition", "expression", "items", "count"]);

function display(key: string, value: unknown): string {
  if (key === "target") return targetText(value);
  const text =
    typeof value !== "string"
      ? formatValue(value)
      : EXPRESSION_KEYS.has(key)
        ? readable(value)
        : value.replace(/\{\{(.*?)\}\}/g, (_, expr: string) => `{{ ${readable(expr.trim())} }}`);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** Keys in schema order, then any extra keys the step carries. */
function paramKeys(step: Step, def: StepTypeDef | undefined): string[] {
  const props = (def?.paramsSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const keys = Object.keys(props).filter((k) => step.params?.[k] !== undefined);
  for (const k of Object.keys(step.params ?? {})) if (!keys.includes(k)) keys.push(k);
  return keys;
}

export const CALL = "scenario.call";

/** A call's `inputs` / `outputs` map, keyed by the called scenario's variables. */
export function callMap(step: Step, key: "inputs" | "outputs"): Record<string, unknown> {
  const value = (step.params ?? {})[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Variables this step writes: its saveAs, `variable.set`'s name, a loop's element, a call's outputs. */
export function outputs(step: Step): { label: string; variable: string }[] {
  const p = step.params ?? {};
  const out: { label: string; variable: string }[] = [];
  if (step.type === "variable.set" && typeof p.name === "string") out.push({ label: t.outputLabels.writes, variable: p.name });
  if (step.type === CALL) {
    for (const [name, target] of Object.entries(callMap(step, "outputs"))) {
      if (typeof target === "string" && target) out.push({ label: name, variable: target });
    }
  }
  if (step.type === "control.forEach") {
    out.push({ label: t.outputLabels.item, variable: typeof p.itemVar === "string" ? p.itemVar : "item" });
    if (typeof p.indexVar === "string") out.push({ label: t.outputLabels.index, variable: p.indexVar });
  }
  if (step.saveAs) out.push({ label: t.outputLabels.result, variable: step.saveAs });
  return out;
}

const OUTPUT_KEYS: Record<string, string[]> = {
  "variable.set": ["name"],
  "control.forEach": ["itemVar", "indexVar"],
};

/** A call shows one row per input it passes, labelled with the called scenario's variable. */
function callRows(step: Step, known: ReadonlySet<string>): Row[] {
  const inputs = Object.entries(callMap(step, "inputs"));
  const rows: Row[] = inputs.slice(0, MAX_PARAM_ROWS).map(([name, value]) => ({
    kind: "param",
    key: `inputs.${name}`,
    label: name,
    value: display(name, value),
    refs: referencedVariables(value, known),
  }));
  if (inputs.length > MAX_PARAM_ROWS) rows.push({ kind: "more", count: inputs.length - MAX_PARAM_ROWS });
  for (const o of outputs(step)) rows.push({ kind: "output", ...o });
  return rows;
}

export function nodeRows(step: Step, def: StepTypeDef | undefined, known: ReadonlySet<string> = new Set()): Row[] {
  if (step.type === CALL) return callRows(step, known);
  const skip = new Set(OUTPUT_KEYS[step.type] ?? []);
  const params = paramKeys(step, def).filter((k) => !skip.has(k));
  const rows: Row[] = params.slice(0, MAX_PARAM_ROWS).map((key) => ({
    kind: "param",
    key,
    label: paramLabel(key),
    value: display(key, step.params?.[key]),
    refs: referencedVariables(step.params?.[key], known),
  }));
  if (params.length > MAX_PARAM_ROWS) rows.push({ kind: "more", count: params.length - MAX_PARAM_ROWS });
  for (const o of outputs(step)) rows.push({ kind: "output", ...o });
  return rows;
}

/** The strip under a call's head with its 中を見る / 開く buttons. */
export const CALL_BAR_H = 26;
/** One line of a call's unfolded steps, and the padding around them. */
export const INNER_LINE_H = 22;
export const INNER_PAD = 8;

/** Height of a call's unfolded list of `lines` steps. */
export const innerHeight = (lines: number) => (lines > 0 ? lines * INNER_LINE_H + INNER_PAD * 2 : 0);

/** `extra` is room the node needs beyond its rows (a call's unfolded steps). */
export const nodeHeight = (step: Step, def: StepTypeDef | undefined, extra = 0) =>
  NODE_HEAD_H + (step.type === CALL ? CALL_BAR_H : 0) + nodeRows(step, def).length * ROW_H + NODE_PAD_B + extra;

/** Every variable name a scenario can mention: declared ones and loop elements. */
export function knownVariables(variables: VariableDef[] | undefined, steps: Step[]): Map<string, VariableDef["type"]> {
  const map = new Map<string, VariableDef["type"]>();
  for (const v of variables ?? []) map.set(v.name, v.type ?? "any");
  const walk = (list: Step[]) => {
    for (const s of list) {
      for (const o of outputs(s)) if (!map.has(o.variable)) map.set(o.variable, "any");
      for (const children of Object.values(s.blocks ?? {})) walk(children);
    }
  };
  walk(steps);
  return map;
}

/** Socket colour per variable type, from the logo's swirl. */
export const TYPE_COLOR: Record<string, string> = {
  string: "var(--cat-log)",
  number: "var(--cat-variable)",
  boolean: "var(--cat-flow)",
  array: "var(--cat-browser)",
  object: "var(--cat-windows)",
  any: "var(--cat-other)",
};
