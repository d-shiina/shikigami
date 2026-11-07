// What a flow node shows, Blender-style: one "項目 : 値" row per parameter,
// plus output rows for the variables the step writes. Display only; the
// layout uses the same rows to size nodes, so both always agree.
import type { Step, StepTypeDef, VariableDef } from "@shikigami/schema";
import { formatValue } from "./changes";
import { listToText } from "./listText";
import { readable, targetText } from "./sentence";
import { locale, t } from "./i18n";

export const NODE_HEAD_H = 58;
export const ROW_H = 26;
export const NODE_PAD_B = 8;
export const MAX_PARAM_ROWS = 5;

/** A node setting's name for people; `type` picks the node's own name for it (a `path` saved to or read from). */
export const paramLabel = (key: string, type?: string) => (type ? t.paramNames.for[type]?.[key] : undefined) ?? t.paramNames.labels[key] ?? key;

/** A choice of a setting in words (`visible` → 表示されている); unknown values stay as they are. */
export const choiceLabel = (key: string, value: unknown) => {
  const text = String(value);
  return t.paramNames.choices[key]?.[text] ?? text;
};

/**
 * The registry's descriptions are written for the AI, in Japanese, and often
 * show the stored form (`{ "secret": … }`, `true`, `{{ }}`). Under a field only
 * a plain sentence helps a person; the full text stays in the tooltip.
 */
export function plainHint(description: string | undefined): string | undefined {
  // Only a Japanese sentence: a hint still in English (from a plugin, say) goes to the tooltip.
  if (!description || locale !== "ja" || !/[ぁ-んァ-ン一-龯]/.test(description)) return undefined;
  return /[{}"`]|\btrue\b|\bfalse\b|\bnull\b|&&|==|既定 \w/.test(description) ? undefined : description;
}

export type Row =
  | {
      kind: "param";
      key: string;
      label: string;
      value: string;
      refs: string[];
      /** A file of the flow's folder (`input/orders.xlsx`) in a path param: shown in its shelf's colour. */
      file?: { path: string; role: "input" | "config" | "templates" | "output" | "work" | "logs" };
    }
  | { kind: "more"; count: number }
  | { kind: "output"; label: string; variable: string };

/**
 * Variable names a value mentions, among the ones we know about. A string is
 * an expression, or text whose `{{ }}` holes are; inside an object or list
 * (a click target, headers…) only the holes count, so "billing.exe" in a
 * target is not the variable `billing`.
 */
export function referencedVariables(value: unknown, known: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const scan = (text: string) => {
    for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (known.has(word)) found.add(word);
  };
  const holes = (text: string) => {
    for (const [, expr] of text.matchAll(/\{\{(.*?)\}\}/g)) scan(expr ?? "");
  };
  const walk = (v: unknown) => {
    if (typeof v === "string") holes(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  if (typeof value === "string") (value.includes("{{") ? holes : scan)(value);
  else walk(value);
  return [...found];
}

/** Params that hold a bare expression rather than text with `{{ }}` holes. */
const EXPRESSION_KEYS = new Set(["condition", "expression", "items", "count"]);

function display(key: string, value: unknown): string {
  if (typeof value === "string" && t.paramNames.choices[key]?.[value]) return choiceLabel(key, value);
  if (key === "target" || key === "to") return targetText(value);
  // A case's values read as a list, the way they are typed in.
  if (key === "values" && Array.isArray(value)) return truncate(listToText(value));
  const text =
    typeof value !== "string"
      ? formatValue(value)
      : EXPRESSION_KEYS.has(key)
        ? readable(value)
        : value.replace(/\{\{(.*?)\}\}/g, (_, expr: string) => `{{ ${readable(expr.trim())} }}`);
  return truncate(text);
}

function truncate(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** Keys in schema order, then any extra keys the step carries. */
function paramKeys(step: Step, def: StepTypeDef | undefined): string[] {
  const props = (def?.paramsSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const keys = Object.keys(props).filter((k) => step.params?.[k] !== undefined);
  for (const k of Object.keys(step.params ?? {})) if (!keys.includes(k)) keys.push(k);
  return keys;
}

export const CALL = "flow.call";

/** A call's `inputs` / `outputs` map, keyed by the called flow's variables. */
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

/** A call shows one row per input it passes, labelled with the called flow's variable. */
function callInputRows(step: Step, known: ReadonlySet<string>): Extract<Row, { kind: "param" }>[] {
  return Object.entries(callMap(step, "inputs")).map(([name, value]) => ({
    kind: "param",
    key: `inputs.${name}`,
    label: name,
    value: display(name, value),
    refs: referencedVariables(value, known),
  }));
}

function callRows(step: Step, known: ReadonlySet<string>): Row[] {
  const inputs = callInputRows(step, known);
  const rows: Row[] = inputs.slice(0, MAX_PARAM_ROWS);
  if (inputs.length > MAX_PARAM_ROWS) rows.push({ kind: "more", count: inputs.length - MAX_PARAM_ROWS });
  for (const o of outputs(step)) rows.push({ kind: "output", ...o });
  return rows;
}

const FOLDERS = new Set(["input", "config", "templates", "output", "work", "logs"]);

/** The flow-folder file a path param names, when it names one. */
function projectFile(key: string, value: unknown, def: StepTypeDef | undefined): Extract<Row, { kind: "param" }>["file"] {
  if (typeof value !== "string" || !def?.pathParams?.includes(key)) return undefined;
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const role = path.split("/")[0] ?? "";
  return FOLDERS.has(role) && path.includes("/") ? { path, role: role as "input" } : undefined;
}

/** Every set param of a node as a line (label: value), for the chart and the right pane's summary. */
export function paramRows(step: Step, def: StepTypeDef | undefined, known: ReadonlySet<string> = new Set()): Extract<Row, { kind: "param" }>[] {
  if (step.type === CALL) return callInputRows(step, known);
  const skip = new Set(OUTPUT_KEYS[step.type] ?? []);
  return paramKeys(step, def)
    .filter((k) => !skip.has(k))
    .map((key) => ({
      kind: "param",
      key,
      label: paramLabel(key, step.type),
      value: display(key, step.params?.[key]),
      refs: referencedVariables(step.params?.[key], known),
      ...(projectFile(key, step.params?.[key], def) ? { file: projectFile(key, step.params?.[key], def) } : {}),
    }));
}

export function nodeRows(step: Step, def: StepTypeDef | undefined, known: ReadonlySet<string> = new Set()): Row[] {
  if (step.type === CALL) return callRows(step, known);
  const params = paramRows(step, def, known);
  const rows: Row[] = params.slice(0, MAX_PARAM_ROWS);
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

/** Every variable name a flow can mention: declared ones and loop elements. */
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
