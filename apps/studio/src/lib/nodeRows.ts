// What a flow node shows, Blender-style: one "項目 : 値" row per parameter,
// plus output rows for the variables the step writes. Display only; the
// layout uses the same rows to size nodes, so both always agree.
import type { Step, StepTypeDef, VariableDef } from "@shikigami/schema";
import { formatValue } from "./changes";
import { targetText } from "./sentence";

export const NODE_HEAD_H = 58;
export const ROW_H = 26;
export const NODE_PAD_B = 8;
export const MAX_PARAM_ROWS = 5;

const PARAM_LABEL: Record<string, string> = {
  message: "メッセージ",
  level: "レベル",
  name: "変数",
  value: "値",
  expression: "式",
  condition: "条件",
  items: "リスト",
  itemVar: "要素",
  indexVar: "番号",
  count: "回数",
  ms: "待ち(ms)",
  url: "URL",
  target: "対象",
  key: "キー",
  path: "保存先",
  state: "状態",
  headless: "画面なし",
  all: "すべて",
  fullPage: "ページ全体",
};

export const paramLabel = (key: string) => PARAM_LABEL[key] ?? key;

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

function display(key: string, value: unknown): string {
  if (key === "target") return targetText(value);
  const text = formatValue(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** Keys in schema order, then any extra keys the step carries. */
function paramKeys(step: Step, def: StepTypeDef | undefined): string[] {
  const props = (def?.paramsSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const keys = Object.keys(props).filter((k) => step.params?.[k] !== undefined);
  for (const k of Object.keys(step.params ?? {})) if (!keys.includes(k)) keys.push(k);
  return keys;
}

/** Variables this step writes: its saveAs, `variable.set`'s name, a loop's element. */
export function outputs(step: Step): { label: string; variable: string }[] {
  const p = step.params ?? {};
  const out: { label: string; variable: string }[] = [];
  if (step.type === "variable.set" && typeof p.name === "string") out.push({ label: "書き込む", variable: p.name });
  if (step.type === "control.forEach") {
    out.push({ label: "要素", variable: typeof p.itemVar === "string" ? p.itemVar : "item" });
    if (typeof p.indexVar === "string") out.push({ label: "番号", variable: p.indexVar });
  }
  if (step.saveAs) out.push({ label: "結果", variable: step.saveAs });
  return out;
}

const OUTPUT_KEYS: Record<string, string[]> = {
  "variable.set": ["name"],
  "control.forEach": ["itemVar", "indexVar"],
};

export function nodeRows(step: Step, def: StepTypeDef | undefined, known: ReadonlySet<string> = new Set()): Row[] {
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

export const nodeHeight = (step: Step, def: StepTypeDef | undefined) =>
  NODE_HEAD_H + nodeRows(step, def).length * ROW_H + NODE_PAD_B;

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
  string: "#12a7b4",
  number: "#3f9a5a",
  boolean: "#f5872a",
  array: "#0a6fa8",
  object: "#e0301e",
  any: "#94a3b8",
};
