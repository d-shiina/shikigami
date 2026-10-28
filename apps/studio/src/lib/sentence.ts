// Reads a step as a Japanese sentence for the 手順書 view. Display only: it
// looks at a step's type and params and never changes or interprets them
// beyond choosing words, so an unknown type still reads as its label.
import type { Step, StepTypeDef } from "@shikigami/schema";

/** Plain words, or a value shown as a code chip (expressions, variables). */
export type Part = { text: string } | { code: string };

const w = (text: string): Part => ({ text });

const PATH = String.raw`([A-Za-z_][\w.]*(?:\[\d+\])?)`;
/** Built-in functions that read better as words. The scenario keeps the expression as written. */
const WORDS: [RegExp, string][] = [
  [new RegExp(String.raw`\blen\(${PATH}\)`, "g"), "$1の件数"],
  [new RegExp(String.raw`\bsum\(${PATH}\)`, "g"), "$1の合計"],
  [new RegExp(String.raw`!isEmpty\(${PATH}\)`, "g"), "$1が空でない"],
  [new RegExp(String.raw`\bisEmpty\(${PATH}\)`, "g"), "$1が空"],
  [/\s*&&\s*/g, " かつ "],
  [/\s*\|\|\s*/g, " または "],
  [/\s*>=\s*/g, " ≥ "],
  [/\s*<=\s*/g, " ≤ "],
  [/\s*!=\s*/g, " ≠ "],
  [/\s*==\s*/g, " = "],
];

/** An expression as it reads on screen: `len(invoices)` becomes `invoicesの件数`. */
export function readable(expr: string): string {
  return WORDS.reduce((text, [pattern, words]) => text.replace(pattern, words), expr);
}

function code(value: unknown): Part {
  if (value === undefined || value === null || value === "") return { text: "（未設定）" };
  return { code: typeof value === "string" ? readable(value) : JSON.stringify(value) };
}

/** A literal with `{{ expr }}` holes: the words stay words, the holes become chips. */
function template(value: unknown): Part[] {
  if (typeof value !== "string" || !value.includes("{{")) return [code(value)];
  return value
    .split(/(\{\{.*?\}\})/)
    .filter((piece) => piece !== "")
    .map((piece) => (piece.startsWith("{{") ? { code: readable(piece.slice(2, -2).trim()) } : w(piece)));
}

/** A browser target such as { role: "button", name: "ログイン" } in words. */
export function targetText(target: unknown): string {
  if (!target || typeof target !== "object") return "（要素未設定）";
  const t = target as Record<string, unknown>;
  const nth = typeof t.nth === "number" ? `の${t.nth + 1}番目` : "";
  if (t.label) return `「${t.label}」欄${nth}`;
  if (t.role && t.name) return `「${t.name}」${ROLE[String(t.role)] ?? String(t.role)}${nth}`;
  if (t.text) return `「${t.text}」${nth}`;
  if (t.placeholder) return `「${t.placeholder}」欄${nth}`;
  if (t.role) return `${ROLE[String(t.role)] ?? String(t.role)}${nth}`;
  if (t.testId) return `[${t.testId}]${nth}`;
  if (t.css) return `${t.css}${nth}`;
  return "（要素未設定）";
}

const ROLE: Record<string, string> = {
  button: "ボタン",
  link: "リンク",
  textbox: "欄",
  heading: "見出し",
  table: "表",
  cell: "セル",
  row: "行",
  checkbox: "チェックボックス",
  combobox: "選択欄",
};

type Builder = (p: Record<string, unknown>, step: Step) => Part[];

const BUILDERS: Record<string, Builder> = {
  "log.message": (p) => [w("「"), ...template(p.message), w(`」と${p.level === "warn" ? "警告を" : p.level === "error" ? "エラーを" : "ログに"}書く`)],
  "variable.set": (p) => [code(p.name), w(" に "), code(p.expression ?? p.value), w(" を入れる")],
  "control.if": (p) => [w("もし "), code(p.condition), w(" なら")],
  "control.while": (p) => [code(p.condition), w(" の間、繰り返す")],
  "control.repeat": (p) => [code(p.count), w(" 回繰り返す")],
  "control.forEach": (p) => [code(p.items), w(" を1件ずつ "), code(p.itemVar ?? "item"), w(" として繰り返す")],
  "control.try": () => [w("次の手順を試し、失敗したら備えの手順を行う")],
  "control.break": () => [w("繰り返しを抜ける")],
  "control.continue": () => [w("次の繰り返しへ進む")],
  "control.fail": (p) => [w("「"), ...template(p.message), w("」として失敗させる")],
  "flow.delay": (p) => [code(p.ms), w(" ミリ秒待つ")],
  "browser.open": (p) => [...template(p.url), w(" をブラウザで開く")],
  "browser.click": (p) => [w(`${targetText(p.target)}を押す`)],
  "browser.fill": (p) => [w(`${targetText(p.target)}に `), ...template(p.value), w(" を入れる")],
  "browser.select": (p) => [w(`${targetText(p.target)}で `), code(p.value), w(" を選ぶ")],
  "browser.press": (p) => [w(p.target ? `${targetText(p.target)}で ` : ""), code(p.key), w(" キーを押す")],
  "browser.getText": (p, s) => [w(`${targetText(p.target)}の文字を読む`), ...saveAs(s)],
  "browser.getTable": (p, s) => [w(`${targetText(p.target)}を表として読む`), ...saveAs(s)],
  "browser.waitFor": (p) => [w(`${targetText(p.target)}が${p.state === "hidden" || p.state === "detached" ? "消える" : "出る"}まで待つ`)],
  "browser.screenshot": (p) => [w("画面を "), code(p.path), w(" に保存する")],
  "browser.close": () => [w("ブラウザを閉じる")],
};

function saveAs(step: Step): Part[] {
  return step.saveAs ? [w("（→ "), code(step.saveAs), w("）")] : [];
}

export function sentence(step: Step, def: StepTypeDef | undefined): Part[] {
  const build = BUILDERS[step.type];
  if (build) return build(step.params ?? {}, step);
  // Unknown or adapter-provided types: the registry label, then its params.
  const parts: Part[] = [w(def?.label ?? step.type)];
  for (const [key, value] of Object.entries(step.params ?? {}).slice(0, 3)) {
    parts.push(w(` ${key} `), code(value));
  }
  return [...parts, ...saveAs(step)];
}

/** The sentence as plain text, e.g. for tooltips and tests. */
export const plain = (parts: Part[]) => parts.map((p) => ("text" in p ? p.text : p.code)).join("");
