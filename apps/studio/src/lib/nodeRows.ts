// What a flow node shows, Blender-style: one "項目 : 値" row per parameter,
// plus output rows for the variables the step writes. Display only; the
// layout uses the same rows to size nodes, so both always agree.
import { READING } from "./reading";
import { extensionChoiceLabel, extensionParamTitle } from "./extensions";
import type { Step, StepTypeDef, VariableDef } from "@spellsheet/schema";
import { BINDS, CALL, FOR_EACH, REPEAT, TRY, VARIABLE_SET } from "./stepTypes";
import { formatValue } from "./changes";
import { listToText } from "./listText";
import { readable, secretName, targetText } from "./sentence";
import { locale, t } from "./i18n";

export const NODE_HEAD_H = 38;
export const ROW_H = 28;
export const NODE_PAD_B = 8;
export const MAX_PARAM_ROWS = READING ? 99 : 5;

/** A node setting's name for people; `type` picks the node's own name for it (a `path` saved to or read from). */
export const paramLabel = (key: string, type?: string) =>
  (type ? (t.paramNames.for[type]?.[key] ?? extensionParamTitle(type, key)) : undefined) ?? t.paramNames.labels[key] ?? key;

/** A choice of a setting in words (`visible` → 表示されている); unknown values stay as they are. */
export const choiceLabel = (key: string, value: unknown, type?: string) => {
  const text = String(value);
  return (type ? extensionChoiceLabel(type, key, text) : undefined) ?? t.paramNames.choices[key]?.[text] ?? text;
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
      /** A required setting still empty: shown as "未設定", not as a value. */
      unset?: boolean;
      /** The setting as stored, for the hover preview (a picture's path, a place given by a picture). */
      raw?: unknown;
      /** The whole text when `value` was cut short. */
      full?: string;
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
    for (const word of text.match(/[\p{Alphabetic}_][\p{Alphabetic}\p{N}_]*/gu) ?? []) if (known.has(word)) found.add(word);
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

/** A setting as one line, whole. */
function fullText(key: string, value: unknown, type?: string): string {
  const secret = secretName(value);
  // The chart puts a key icon before it (`FlowCanvas`).
  if (secret) return secret;
  if (typeof value === "string" && type && extensionChoiceLabel(type, key, value)) return choiceLabel(key, value, type);
  if (typeof value === "string" && t.paramNames.choices[key]?.[value]) return choiceLabel(key, value);
  if (key === "target" || key === "to") return targetText(value);
  // A case's values read as a list, the way they are typed in.
  if (key === "values" && Array.isArray(value)) return listToText(value);
  return typeof value !== "string"
    ? formatValue(value)
    : EXPRESSION_KEYS.has(key)
      ? readable(value)
      : value.replace(/\{\{(.*?)\}\}/g, (_, expr: string) => `{{ ${readable(expr.trim())} }}`);
}

function display(key: string, value: unknown, type?: string): string {
  const text = fullText(key, value, type);
  // A place in words is never cut: it is what the node is about.
  return key === "target" || key === "to" ? text : truncate(text);
}

/** The display text of a setting, with the whole of it when it was cut short. */
function shown(key: string, value: unknown, type?: string): { value: string; full?: string; raw: unknown } {
  const text = display(key, value, type);
  const full = fullText(key, value, type);
  return { value: text, raw: value, ...(full !== text ? { full } : {}) };
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

export { CALL } from "./stepTypes";

/** A call's `inputs` / `outputs` map, keyed by the called flow's variables. */
export function callMap(step: Step, key: "inputs" | "outputs"): Record<string, unknown> {
  const value = (step.params ?? {})[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Variables this step writes: its saveAs, `variable.set`'s name, a loop's element, a call's outputs. */
export function outputs(step: Step): { label: string; variable: string }[] {
  const p = step.params ?? {};
  const out: { label: string; variable: string }[] = [];
  if (step.type === VARIABLE_SET && typeof p.name === "string") out.push({ label: t.outputLabels.writes, variable: p.name });
  if (step.type === CALL) {
    for (const [name, target] of Object.entries(callMap(step, "outputs"))) {
      if (typeof target === "string" && target) out.push({ label: name, variable: target });
    }
  }
  if (step.type === FOR_EACH) out.push({ label: t.outputLabels.item, variable: typeof p.itemVar === "string" ? p.itemVar : "item" });
  if ((step.type === FOR_EACH || step.type === REPEAT) && typeof p.indexVar === "string") out.push({ label: t.outputLabels.index, variable: p.indexVar });
  if (step.type === TRY && typeof p.errorVar === "string") out.push({ label: t.outputLabels.error, variable: p.errorVar });
  if (step.saveAs) out.push({ label: t.outputLabels.result, variable: step.saveAs });
  return out;
}

/** Params shown as outputs (the variables a node binds), not as rows of their own. */
const OUTPUT_KEYS = BINDS;

/** A call shows one row per input it passes, labelled with the called flow's variable. */
function callInputRows(step: Step, known: ReadonlySet<string>): Extract<Row, { kind: "param" }>[] {
  return Object.entries(callMap(step, "inputs")).map(([name, value]) => ({
    kind: "param",
    key: `inputs.${name}`,
    label: name,
    ...shown(name, value),
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
      ...shown(key, step.params?.[key], step.type),
      refs: referencedVariables(step.params?.[key], known),
      ...(projectFile(key, step.params?.[key], def) ? { file: projectFile(key, step.params?.[key], def) } : {}),
    }));
}

/** Whether a setting holds nothing yet: blank text, the "https://" a new page starts with, or a target naming nothing. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "" || value.trim() === "https://";
  if (Array.isArray(value)) return value.every(isBlank);
  if (typeof value === "object") return Object.entries(value).every(([k, v]) => k === "role" || isBlank(v));
  return false;
}

/**
 * The required settings of a node that are still empty, in schema order:
 * what a node just added has. Shown as "未設定" (amber), never as an error.
 */
export function unsetParams(step: Step, def: StepTypeDef | undefined): string[] {
  if (step.type === CALL || step.disabled) return [];
  const required = (def?.paramsSchema as { required?: string[] } | undefined)?.required ?? [];
  return required.filter((key) => !BINDS[step.type]?.includes(key) && isBlank(step.params?.[key]));
}

export function nodeRows(step: Step, def: StepTypeDef | undefined, known: ReadonlySet<string> = new Set()): Row[] {
  if (step.type === CALL) return callRows(step, known);
  const unset = unsetParams(step, def);
  const shown = paramRows(step, def, known).map((r) => (unset.includes(r.key) ? { ...r, unset: true } : r));
  // A required setting not written at all still gets its row, to be filled in.
  const missing = unset
    .filter((key) => !shown.some((r) => r.key === key))
    .map((key): Extract<Row, { kind: "param" }> => ({ kind: "param", key, label: paramLabel(key, step.type), value: "", refs: [], unset: true }));
  const params = [...shown, ...missing];
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

/** Room for a setting's value beside its label, in a node as wide as the chart's (NODE_W). */
const VALUE_W = 180;
/** A wrapped line of a value, when it takes more than one. */
export const VALUE_LINE_H = 20;
const textWidth = (s: string, px: number) => [...s].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? px : px * 0.6), 0);

/** To read, a value shows whole: how many lines it takes. Otherwise one, cut short. */
export function rowLines(row: Row): number {
  if (!READING || row.kind !== "param" || row.unset) return 1;
  const text = row.file ? row.file.path : (row.full ?? row.value);
  // Each variable in it is a chip, a little wider than its name.
  const room = textWidth(text, 12.5) * 1.1 + row.refs.length * 24 + (row.file ? 14 : 0);
  return Math.min(10, Math.max(1, Math.ceil(room / VALUE_W)));
}
export const rowHeight = (row: Row): number => {
  const lines = rowLines(row);
  return lines === 1 ? ROW_H : lines * VALUE_LINE_H + (ROW_H - VALUE_LINE_H);
};

/** `extra` is room the node needs beyond its rows (a call's unfolded steps). */
export const nodeHeight = (step: Step, def: StepTypeDef | undefined, extra = 0) =>
  NODE_HEAD_H + (step.type === CALL ? CALL_BAR_H : 0) + nodeRows(step, def).reduce((h, row) => h + rowHeight(row), 0) + NODE_PAD_B + extra;

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

/** The variable of `refs` an expression like "row.金額" or "items[0]" starts with. */
export function rootOf(expr: string, refs: readonly string[]): string | undefined {
  return refs.find((r) => expr === r || expr.startsWith(`${r}.`) || expr.startsWith(`${r}[`));
}

/**
 * An expression cut around the variables of `refs` it uses, each with its
 * fields: odd pieces are the uses ("response.rows"), even ones the text between.
 */
export function splitRefs(expr: string, refs: readonly string[]): string[] {
  if (refs.length === 0) return [expr];
  const names = [...refs].sort((a, b) => b.length - a.length).map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const id = "\\p{L}\\p{N}_$";
  return expr.split(new RegExp(`(?<![${id}.])((?:${names.join("|")})(?:\\.[${id}]+|\\[[^\\]]*\\])*)(?![${id}])`, "u"));
}
