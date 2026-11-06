// Everyday value handling as forms: "表の列を合計" with 表・列 to choose,
// instead of `sum(map(rows, r => num(r.金額)))` typed by hand.
//
// A transform is only a way of showing and editing a `variable.set`
// expression. The flow keeps the expression (the one way to write it, which
// the AI writes too); Studio recognises the shapes below and shows a form,
// and the form writes the expression back. An expression of any other shape
// stays an expression field. Function names: docs/expressions.md.
//
// Templates are expressions with slots `{name:kind}`. Each slot holds a
// piece of expression source, so recognising is matching tokens and building
// is putting the pieces back:
//   var    a variable or a path (`rows`, `row.金額`)
//   value  a variable, text ('…') or a number
//   date   `today()`, `now()`, a variable or text
//   text   text ('…')
//   num    a number (`3`, `-1`)
//   col    a field of a row: `.金額` or `['税込 金額']`
//   param  the name of a `r =>` parameter (the same name each time it appears)
//   choice one of the transform's `choices` (a function name, operator or unit)
//   parts  `a + ' ' + b`: values joined with `+` (the whole expression)
import { type Token, fieldAccess, quote, solid, tokenize } from "./expr";
import { t } from "./i18n";

export type SlotKind = "var" | "value" | "date" | "text" | "num" | "col" | "param" | "choice" | "parts";

export type Category = "text" | "number" | "date" | "list";

type Variant = {
  template: string;
  /** Choices this variant writes: the variant is used only for these values. */
  only?: Record<string, string[]>;
};

export type TransformDef = {
  key: string;
  category: Category;
  /** The function it is about, for searching (and the palette's keyword). */
  keyword: string;
  variants: Variant[];
  /** Options of each `choice` slot, as written in the expression. */
  choices?: Record<string, string[]>;
  /** Values for a new node: the variable written and each slot's source. */
  name: string;
  defaults: Record<string, string>;
};

/** Slot values: each a piece of expression source. */
export type Slots = Record<string, string>;

const LIST_PARAM = { r: "r" };

export const TRANSFORMS: TransformDef[] = [
  // Text
  { key: "concat", category: "text", keyword: "+", variants: [{ template: "{parts:parts}" }], name: "fullName", defaults: { parts: "sei + ' ' + mei" } },
  { key: "trim", category: "text", keyword: "trim", variants: [{ template: "trim({text:var})" }], name: "text", defaults: { text: "text" } },
  { key: "replace", category: "text", keyword: "replace", variants: [{ template: "replace({text:var}, {find:text}, {with:text})" }], name: "text", defaults: { text: "text", find: "'/'", with: "'-'" } },
  {
    key: "slice",
    category: "text",
    keyword: "slice",
    variants: [{ template: "slice({text:var}, {start:num}, {end:num})" }, { template: "slice({text:var}, {start:num})" }],
    name: "code",
    defaults: { text: "text", start: "0", end: "3" },
  },
  { key: "padStart", category: "text", keyword: "padStart", variants: [{ template: "padStart({text:value}, {length:num}, {fill:text})" }], name: "no", defaults: { text: "no", length: "3", fill: "'0'" } },
  {
    key: "width",
    category: "text",
    keyword: "toHalfWidth",
    variants: [{ template: "{fn:choice}({text:var})" }],
    choices: { fn: ["toHalfWidth", "toFullWidth", "upper", "lower"] },
    name: "text",
    defaults: { fn: "toHalfWidth", text: "text" },
  },
  { key: "split", category: "text", keyword: "split", variants: [{ template: "split({text:var}, {sep:text})" }], name: "parts", defaults: { text: "text", sep: "','" } },
  { key: "lines", category: "text", keyword: "lines", variants: [{ template: "lines({text:var})" }], name: "rows", defaults: { text: "text" } },
  {
    key: "regexFind",
    category: "text",
    keyword: "regexFind",
    variants: [{ template: "regexFind({text:var}, {pattern:text}, {group:num})" }, { template: "regexFind({text:var}, {pattern:text})" }],
    name: "found",
    defaults: { text: "text", pattern: "'INV-(\\\\d+)'", group: "1" },
  },
  {
    key: "regexReplace",
    category: "text",
    keyword: "regexReplace",
    variants: [{ template: "regexReplace({text:var}, {pattern:text}, {with:text})" }],
    name: "digits",
    defaults: { text: "text", pattern: "'\\\\D'", with: "''" },
  },
  // Numbers
  {
    key: "calc",
    category: "number",
    keyword: "+",
    variants: [{ template: "{a:value} {op:choice} {b:value}" }],
    choices: { op: ["+", "-", "*", "/"] },
    name: "count",
    defaults: { a: "count", op: "+", b: "1" },
  },
  { key: "num", category: "number", keyword: "num", variants: [{ template: "num({text:var})" }], name: "amount", defaults: { text: "text" } },
  {
    key: "round",
    category: "number",
    keyword: "round",
    variants: [{ template: "round({x:var}, {digits:num})", only: { mode: ["round"] } }, { template: "{mode:choice}({x:var})" }],
    choices: { mode: ["round", "floor", "ceil"] },
    name: "amount",
    defaults: { mode: "round", x: "amount", digits: "0" },
  },
  {
    key: "formatNumber",
    category: "number",
    keyword: "formatNumber",
    variants: [{ template: "formatNumber({x:var}, {decimals:num})" }, { template: "formatNumber({x:var})" }],
    name: "amountText",
    defaults: { x: "amount" },
  },
  // Dates
  { key: "formatDate", category: "date", keyword: "formatDate", variants: [{ template: "formatDate({date:date}, {pattern:text})" }], name: "dateText", defaults: { date: "today()", pattern: "'yyyy/MM/dd'" } },
  {
    key: "parseDate",
    category: "date",
    keyword: "parseDate",
    variants: [{ template: "parseDate({text:var}, {pattern:text})" }, { template: "parseDate({text:var})" }],
    name: "date",
    defaults: { text: "text" },
  },
  {
    key: "dateAdd",
    category: "date",
    keyword: "dateAdd",
    variants: [{ template: "dateAdd({date:date}, {amount:num}, {unit:choice})" }],
    choices: { unit: ["'day'", "'month'", "'year'", "'hour'", "'minute'"] },
    name: "date",
    defaults: { date: "today()", amount: "-1", unit: "'day'" },
  },
  {
    key: "dateDiff",
    category: "date",
    keyword: "dateDiff",
    variants: [{ template: "dateDiff({from:date}, {to:date}, {unit:choice})" }],
    choices: { unit: ["'day'", "'month'", "'year'", "'hour'", "'minute'"] },
    name: "days",
    defaults: { from: "from", to: "to", unit: "'day'" },
  },
  { key: "endOfMonth", category: "date", keyword: "endOfMonth", variants: [{ template: "endOfMonth({date:date})" }], name: "date", defaults: { date: "today()" } },
  // Tables and lists
  {
    key: "aggregate",
    category: "list",
    keyword: "sum",
    variants: [{ template: "{agg:choice}(map({table:var}, {r:param} => num({r:param}{col:col})))" }],
    choices: { agg: ["sum", "avg", "max", "min"] },
    name: "total",
    defaults: { agg: "sum", table: "rows", ...LIST_PARAM, col: ".金額" },
  },
  { key: "count", category: "list", keyword: "len", variants: [{ template: "len({table:var})" }], name: "count", defaults: { table: "rows" } },
  {
    key: "filter",
    category: "list",
    keyword: "filter",
    variants: [
      { template: "filter({table:var}, {r:param} => num({r:param}{col:col}) {op:choice} {value:value})", only: { op: [">=", ">", "<=", "<"] } },
      { template: "filter({table:var}, {r:param} => {r:param}{col:col} {op:choice} {value:value})", only: { op: ["==", "!="] } },
      { template: "filter({table:var}, {r:param} => contains({r:param}{col:col}, {value:value}))", only: { op: ["contains"] } },
    ],
    choices: { op: ["==", "!=", ">=", ">", "<=", "<", "contains"] },
    name: "rows",
    defaults: { table: "rows", ...LIST_PARAM, col: ".金額", op: ">=", value: "10000" },
  },
  {
    key: "find",
    category: "list",
    keyword: "find",
    variants: [{ template: "find({table:var}, {r:param} => {r:param}{col:col} == {value:value})" }],
    name: "row",
    defaults: { table: "rows", ...LIST_PARAM, col: ".コード", value: "code" },
  },
  {
    key: "pluck",
    category: "list",
    keyword: "map",
    variants: [{ template: "map({table:var}, {r:param} => {r:param}{col:col})" }],
    name: "names",
    defaults: { table: "rows", ...LIST_PARAM, col: ".氏名" },
  },
  {
    key: "sort",
    category: "list",
    keyword: "sortBy",
    variants: [
      { template: "reverse(sortBy({table:var}, {r:param} => num({r:param}{col:col})))", only: { order: ["desc"], as: ["number"] } },
      { template: "sortBy({table:var}, {r:param} => num({r:param}{col:col}))", only: { order: ["asc"], as: ["number"] } },
      { template: "reverse(sortBy({table:var}, {r:param} => {r:param}{col:col}))", only: { order: ["desc"], as: ["text"] } },
      { template: "sortBy({table:var}, {r:param} => {r:param}{col:col})", only: { order: ["asc"], as: ["text"] } },
    ],
    choices: { order: ["asc", "desc"], as: ["number", "text"] },
    name: "rows",
    defaults: { table: "rows", ...LIST_PARAM, col: ".金額", order: "asc", as: "number" },
  },
  { key: "unique", category: "list", keyword: "unique", variants: [{ template: "unique({list:var})" }], name: "list", defaults: { list: "list" } },
  { key: "join", category: "list", keyword: "join", variants: [{ template: "join({list:var}, {sep:text})" }], name: "text", defaults: { list: "names", sep: "'、'" } },
];

export const transformByKey = new Map(TRANSFORMS.map((d) => [d.key, d]));

// ---------------------------------------------------------------------------
// Templates

type Pattern = ({ lit: string } | { slot: string; kind: SlotKind })[];

const patterns = new Map<string, Pattern>();

function pattern(template: string): Pattern {
  let p = patterns.get(template);
  if (p) return p;
  p = [];
  for (const piece of template.split(/(\{\w+:\w+\})/)) {
    const m = /^\{(\w+):(\w+)\}$/.exec(piece);
    if (m) p.push({ slot: m[1]!, kind: m[2] as SlotKind });
    else for (const tok of solid(tokenize(piece))) p.push({ lit: tok.text });
  }
  patterns.set(template, p);
  return p;
}

/** The slots a transform has, in the order they first appear, with their kinds. */
export function slotsOf(def: TransformDef): { name: string; kind: SlotKind }[] {
  const seen = new Map<string, SlotKind>();
  for (const v of def.variants) for (const p of pattern(v.template)) if ("slot" in p && !seen.has(p.slot)) seen.set(p.slot, p.kind);
  for (const name of Object.keys(def.choices ?? {})) if (!seen.has(name)) seen.set(name, "choice");
  return [...seen].map(([name, kind]) => ({ name, kind }));
}

/** Slots some variant can leave out (`end` of slice): the form marks the others required. */
export function optionalSlots(def: TransformDef): Set<string> {
  const all = slotsOf(def).map((s) => s.name);
  const out = new Set<string>();
  for (const name of all) if (def.variants.some((v) => !pattern(v.template).some((p) => "slot" in p && p.slot === name) && !(v.only && name in v.only))) out.add(name);
  return out;
}

// ---------------------------------------------------------------------------
// Matching: tokens of the expression against a template

type Cursor = { toks: Token[]; i: number };

const at = (c: Cursor, k = 0) => c.toks[c.i + k];
const isFn = (c: Cursor) => at(c)?.kind === "ident" && at(c, 1)?.text === "(";

function takeVar(c: Cursor): boolean {
  const first = at(c);
  if (first?.kind !== "ident" || isFn(c) || ["true", "false", "null"].includes(first.text)) return false;
  c.i++;
  for (;;) {
    if (at(c)?.text === "." && at(c, 1)?.kind === "ident") c.i += 2;
    else if (at(c)?.text === "[" && (at(c, 1)?.kind === "number" || at(c, 1)?.kind === "string") && at(c, 2)?.text === "]") c.i += 3;
    else return true;
  }
}

function takeNum(c: Cursor): boolean {
  if (at(c)?.text === "-" && at(c, 1)?.kind === "number") {
    c.i += 2;
    return true;
  }
  if (at(c)?.kind === "number") {
    c.i++;
    return true;
  }
  return false;
}

function takeText(c: Cursor): boolean {
  if (at(c)?.kind !== "string") return false;
  c.i++;
  return true;
}

const takeValue = (c: Cursor) => takeText(c) || takeNum(c) || takeVar(c);

function takeDate(c: Cursor): boolean {
  if ((at(c)?.text === "today" || at(c)?.text === "now") && at(c, 1)?.text === "(" && at(c, 2)?.text === ")") {
    c.i += 3;
    return true;
  }
  return takeText(c) || takeVar(c);
}

function takeCol(c: Cursor): boolean {
  if (at(c)?.text === "." && at(c, 1)?.kind === "ident") {
    c.i += 2;
    return true;
  }
  if (at(c)?.text === "[" && at(c, 1)?.kind === "string" && at(c, 2)?.text === "]") {
    c.i += 3;
    return true;
  }
  return false;
}

function takeParam(c: Cursor): boolean {
  if (at(c)?.kind !== "ident") return false;
  c.i++;
  return true;
}

function takeParts(c: Cursor): boolean {
  if (!takeValue(c)) return false;
  while (at(c)?.text === "+") {
    c.i++;
    if (!takeValue(c)) return false;
  }
  return true;
}

/** A choice's value as written: strings compared by their text, so "day" and 'day' are the same. */
function choiceOf(tok: Token | undefined, options: string[]): string | undefined {
  if (!tok) return undefined;
  if (tok.kind === "string") return options.find((o) => o.startsWith("'") && o.slice(1, -1) === tok.value);
  return options.find((o) => o === tok.text);
}

function matchVariant(source: string, toks: Token[], def: TransformDef, variant: Variant): Slots | null {
  const c: Cursor = { toks, i: 0 };
  const slots: Slots = {};
  for (const p of pattern(variant.template)) {
    if ("lit" in p) {
      if (at(c)?.text !== p.lit) return null;
      c.i++;
      continue;
    }
    const from = c.i;
    let value: string | undefined;
    if (p.kind === "choice") {
      value = choiceOf(at(c), def.choices?.[p.slot] ?? []);
      if (value === undefined) return null;
      c.i++;
    } else {
      const ok =
        p.kind === "var" ? takeVar(c)
        : p.kind === "value" ? takeValue(c)
        : p.kind === "date" ? takeDate(c)
        : p.kind === "text" ? takeText(c)
        : p.kind === "num" ? takeNum(c)
        : p.kind === "col" ? takeCol(c)
        : p.kind === "param" ? takeParam(c)
        : takeParts(c);
      if (!ok) return null;
      value = source.slice(toks[from]!.start, toks[c.i - 1]!.end);
    }
    if (p.slot in slots && slots[p.slot] !== value) return null;
    slots[p.slot] = value;
  }
  if (c.i !== toks.length) return null;
  for (const [slot, allowed] of Object.entries(variant.only ?? {})) {
    if (slot in slots) {
      if (!allowed.includes(slots[slot]!)) return null;
    } else slots[slot] = allowed[0]!;
  }
  return slots;
}

/** Splits `a + ' ' + b` into its values. */
export function splitParts(source: string): string[] {
  const toks = solid(tokenize(source));
  const out: string[] = [];
  const c: Cursor = { toks, i: 0 };
  while (c.i < toks.length) {
    const from = c.i;
    if (!takeValue(c)) return [source];
    out.push(source.slice(toks[from]!.start, toks[c.i - 1]!.end));
    if (at(c)?.text === "+") c.i++;
  }
  return out;
}

export type Match = { def: TransformDef; slots: Slots };

/** The transform an expression is written as, with its slot values; null for any other expression. */
export function recognize(expression: unknown): Match | null {
  if (typeof expression !== "string" || expression.trim() === "") return null;
  const toks = solid(tokenize(expression));
  if (toks.some((tok) => tok.kind === "error")) return null;
  for (const def of TRANSFORMS) {
    for (const variant of def.variants) {
      const slots = matchVariant(expression, toks, def, variant);
      if (!slots) continue;
      // `a + b` of two values is a calculation; joining text has some text, or more than two parts.
      if (def.key === "concat") {
        const parts = splitParts(slots.parts ?? "");
        if (parts.length < 2 || (parts.length === 2 && !parts.some((x) => x.startsWith("'") || x.startsWith('"')))) continue;
      }
      return { def, slots };
    }
  }
  return null;
}

/** Writes the expression for slot values: the first variant all of whose slots are filled. */
export function build(def: TransformDef, slots: Slots): string | null {
  for (const variant of def.variants) {
    if (variant.only && Object.entries(variant.only).some(([s, allowed]) => !allowed.includes(slots[s] ?? def.defaults[s] ?? ""))) continue;
    const p = pattern(variant.template);
    if (p.some((x) => "slot" in x && !(slots[x.slot] ?? "").trim())) continue;
    return variant.template.replace(/\{(\w+):\w+\}/g, (_, name: string) => (slots[name] ?? "").trim());
  }
  return null;
}

/** A new node's expression for a transform. */
export const defaultExpression = (def: TransformDef) => build(def, def.defaults) ?? "";

/**
 * Switching a form to another transform keeps the slots with the same name
 * and kind (the table, the text), and takes the rest from its defaults.
 */
export function carryOver(from: Match | null, to: TransformDef): Slots {
  const slots: Slots = { ...to.defaults };
  if (!from) return slots;
  const kinds = new Map(slotsOf(from.def).map((s) => [s.name, s.kind]));
  for (const s of slotsOf(to)) {
    if (s.kind === "choice") continue;
    const value = from.slots[s.name];
    if (value !== undefined && kinds.get(s.name) === s.kind) slots[s.name] = value;
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Slot values ⇄ what the form shows

/** The text of a `'…'` literal, or null when the source is not one. */
export function textOf(source: string): string | null {
  const toks = solid(tokenize(source));
  return toks.length === 1 && toks[0]!.kind === "string" ? (toks[0]!.value ?? "") : null;
}

export const textSource = (text: string) => quote(text);

/** The column name of `.金額` / `['税込 金額']`. */
export function columnOf(source: string): string {
  const toks = solid(tokenize(source));
  if (toks[0]?.text === "." && toks[1]) return toks[1].text;
  if (toks[0]?.text === "[" && toks[1]?.kind === "string") return toks[1].value ?? "";
  return source;
}

export const columnSource = (name: string) => fieldAccess(name);

/** What a `value` / `date` slot holds. */
export type ValueKind = "variable" | "text" | "number" | "today" | "now";

export function valueKind(source: string): ValueKind {
  const s = source.trim();
  if (s === "today()") return "today";
  if (s === "now()") return "now";
  if (textOf(s) !== null) return "text";
  if (/^-?\d+(\.\d+)?$/.test(s)) return "number";
  return "variable";
}

// ---------------------------------------------------------------------------
// Words

export type TransformWords = {
  label: string;
  description: string;
  /** What the value is, as a phrase with `{slot}` holes (the sentence adds "X に … を入れる"). */
  phrase: string;
  slots: Record<string, string>;
};

export function wordsOf(def: TransformDef): TransformWords {
  return t.transforms.items[def.key] ?? { label: def.key, description: "", phrase: def.key, slots: {} };
}

/** A choice's label (合計, 日, 以上 …). */
export function choiceLabel(slot: string, value: string): string {
  return t.transforms.choices[`${slot}:${value}`] ?? value;
}
