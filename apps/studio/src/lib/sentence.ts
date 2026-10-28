// Reads a step as a sentence for the 手順書 view, in Japanese or English.
// Display only: it looks at a step's type and params and never changes or
// interprets them beyond choosing words, so an unknown type still reads as
// its label. Word order differs between the languages, so each has its own
// builders rather than dictionary entries.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { locale, stepLabel } from "./i18n";

/** Plain words, or a value shown as a code chip (expressions, variables). */
export type Part = { text: string } | { code: string };

const w = (text: string): Part => ({ text });

const PATH = String.raw`([A-Za-z_][\w.]*(?:\[\d+\])?)`;
/** Built-in functions that read better as words. The scenario keeps the expression as written. */
const fn = (name: string) => new RegExp(String.raw`\b${name}\(${PATH}\)`, "g");
const SYMBOLS: [RegExp, string][] = [
  [/\s*>=\s*/g, " ≥ "],
  [/\s*<=\s*/g, " ≤ "],
  [/\s*!=\s*/g, " ≠ "],
  [/\s*==\s*/g, " = "],
];
const WORDS: Record<"ja" | "en", [RegExp, string][]> = {
  ja: [
    [fn("len"), "$1の件数"],
    [fn("sum"), "$1の合計"],
    [new RegExp(String.raw`!isEmpty\(${PATH}\)`, "g"), "$1が空でない"],
    [fn("isEmpty"), "$1が空"],
    [/\s*&&\s*/g, " かつ "],
    [/\s*\|\|\s*/g, " または "],
    ...SYMBOLS,
  ],
  en: [
    [fn("len"), "count of $1"],
    [fn("sum"), "sum of $1"],
    [new RegExp(String.raw`!isEmpty\(${PATH}\)`, "g"), "$1 is not empty"],
    [fn("isEmpty"), "$1 is empty"],
    [/\s*&&\s*/g, " and "],
    [/\s*\|\|\s*/g, " or "],
    ...SYMBOLS,
  ],
};

/** An expression as it reads on screen: `len(invoices)` becomes `invoicesの件数` (`count of invoices`). */
export function readable(expr: string): string {
  return WORDS[locale].reduce((text, [pattern, words]) => text.replace(pattern, words), expr);
}

function code(value: unknown): Part {
  if (value === undefined || value === null || value === "") return { text: locale === "ja" ? "（未設定）" : "(not set)" };
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
  return locale === "ja" ? targetJa(target) : targetEn(target);
}

function targetJa(target: unknown): string {
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

function targetEn(target: unknown): string {
  if (!target || typeof target !== "object") return "(no element set)";
  const t = target as Record<string, unknown>;
  const nth = typeof t.nth === "number" ? ` #${t.nth + 1}` : "";
  const role = (r: unknown) => ROLE_EN[String(r)] ?? String(r);
  if (t.label) return `the "${t.label}" field${nth}`;
  if (t.role && t.name) return `the "${t.name}" ${role(t.role)}${nth}`;
  if (t.text) return `"${t.text}"${nth}`;
  if (t.placeholder) return `the "${t.placeholder}" field${nth}`;
  if (t.role) return `the ${role(t.role)}${nth}`;
  if (t.testId) return `[${t.testId}]${nth}`;
  if (t.css) return `${t.css}${nth}`;
  return "(no element set)";
}

const ROLE_EN: Record<string, string> = {
  textbox: "field",
  combobox: "drop-down",
};

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

/**
 * Names of the workspace's scenarios by id, so a call reads as the scenario
 * it runs. Studio keeps it in step with the scenario list.
 */
let scenarioNames: ReadonlyMap<string, string> = new Map();

export function setScenarioNames(names: ReadonlyMap<string, string>) {
  scenarioNames = names;
}

/** What a call's target reads as: its name, or its id when it is not in this workspace. */
export function calledName(id: unknown): string | null {
  if (typeof id !== "string" || id === "") return null;
  return scenarioNames.get(id) ?? id;
}

type Builder = (p: Record<string, unknown>, step: Step) => Part[];

const BUILDERS: Record<string, Builder> = {
  "log.message": (p) => [w("「"), ...template(p.message), w(`」と${p.level === "warn" ? "警告を" : p.level === "error" ? "エラーを" : "ログに"}書く`)],
  "variable.set": (p) => [code(p.name), w(" に "), code(p.expression ?? p.value), w(" を入れる")],
  "control.if": (p) => [w("もし "), code(p.condition), w(" なら")],
  "control.while": (p) => [code(p.condition), w(" の間、繰り返す")],
  "control.repeat": (p) => [code(p.count), w(" 回繰り返す")],
  "control.forEach": (p) => [code(p.items), w(" を1件ずつ "), code(p.itemVar ?? "item"), w(" として繰り返す")],
  "control.try": () => [w("失敗したら catch、最後に finally")],
  "control.break": () => [w("繰り返しを抜ける")],
  "control.continue": () => [w("次の繰り返しへ進む")],
  "control.fail": (p) => [w("「"), ...template(p.message), w("」として失敗させる")],
  "flow.delay": (p) => [code(p.ms), w(" ミリ秒待つ")],
  "scenario.call": (p) => {
    const name = calledName(p.scenario);
    return name ? [w(`サブシナリオ「${name}」を呼ぶ`)] : [w("サブシナリオを呼ぶ（呼ぶシナリオが未設定）")];
  },
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

const BUILDERS_EN: Record<string, Builder> = {
  "log.message": (p) => [w(p.level === "warn" ? "Warn " : p.level === "error" ? "Log error " : "Log "), w("\""), ...template(p.message), w("\"")],
  "variable.set": (p) => [w("Set "), code(p.name), w(" to "), code(p.expression ?? p.value)],
  "control.if": (p) => [w("If "), code(p.condition)],
  "control.while": (p) => [w("Repeat while "), code(p.condition)],
  "control.repeat": (p) => [w("Repeat "), code(p.count), w(" times")],
  "control.forEach": (p) => [w("For each "), code(p.itemVar ?? "item"), w(" in "), code(p.items)],
  "control.try": () => [w("Try, catch on failure, finally at the end")],
  "control.break": () => [w("Exit the loop")],
  "control.continue": () => [w("Go to the next iteration")],
  "control.fail": (p) => [w("Fail with \""), ...template(p.message), w("\"")],
  "flow.delay": (p) => [w("Wait "), code(p.ms), w(" ms")],
  "scenario.call": (p) => {
    const name = calledName(p.scenario);
    return name ? [w(`Call the subscenario "${name}"`)] : [w("Call a subscenario (none chosen)")];
  },
  "browser.open": (p) => [w("Open "), ...template(p.url), w(" in the browser")],
  "browser.click": (p) => [w(`Click ${targetText(p.target)}`)],
  "browser.fill": (p) => [w("Fill "), ...template(p.value), w(` into ${targetText(p.target)}`)],
  "browser.select": (p) => [w("Select "), code(p.value), w(` in ${targetText(p.target)}`)],
  "browser.press": (p) => [w("Press "), code(p.key), w(p.target ? ` on ${targetText(p.target)}` : "")],
  "browser.getText": (p, s) => [w(`Read the text of ${targetText(p.target)}`), ...saveAs(s)],
  "browser.getTable": (p, s) => [w(`Read ${targetText(p.target)} as a table`), ...saveAs(s)],
  "browser.waitFor": (p) => [
    w(`Wait until ${targetText(p.target)} ${p.state === "hidden" || p.state === "detached" ? "disappears" : "appears"}`),
  ],
  "browser.screenshot": (p) => [w("Save the screen to "), code(p.path)],
  "browser.close": () => [w("Close the browser")],
};

function saveAs(step: Step): Part[] {
  if (!step.saveAs) return [];
  return locale === "ja" ? [w("（→ "), code(step.saveAs), w("）")] : [w(" (→ "), code(step.saveAs), w(")")];
}

export function sentence(step: Step, def: StepTypeDef | undefined): Part[] {
  const build = (locale === "ja" ? BUILDERS : BUILDERS_EN)[step.type];
  if (build) return build(step.params ?? {}, step);
  // Unknown or adapter-provided types: the registry label, then its params.
  const parts: Part[] = [w(stepLabel(step.type, def?.label))];
  for (const [key, value] of Object.entries(step.params ?? {}).slice(0, 3)) {
    parts.push(w(` ${key} `), code(value));
  }
  return [...parts, ...saveAs(step)];
}

/** The sentence as plain text, e.g. for tooltips and tests. */
export const plain = (parts: Part[]) => parts.map((p) => ("text" in p ? p.text : p.code)).join("");
