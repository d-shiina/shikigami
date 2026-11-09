// Words for the 「テスト」 panel: what a test case expects and where a run
// differed from it, without codes or JSON paths on the screen.
import type { Mismatch, RunStatus } from "@spellsheet/schema";
import { explainError } from "./errorText";
import { t } from "./i18n";

/** A value in one line: text as it is, the rest as JSON, cut when long. */
export function shortValue(value: unknown, max = 80): string {
  if (value === null || value === undefined) return t.tests.none;
  const text = typeof value === "string" ? `「${value}」` : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const statusWord = (value: unknown) => t.tests.statusWord[value as RunStatus] ?? shortValue(value);
const errorWord = (value: unknown) =>
  typeof value === "string" ? explainError({ code: value, message: value }).what : shortValue(value);

/** Where it differs (`outputs.rows[2].金額` → 出力「rows」の 3 件目の「金額」) and how. */
export function mismatchText(m: Mismatch): { where: string; expected: string; actual: string } {
  if (m.at === "status") return { where: t.tests.at.status, expected: statusWord(m.expected), actual: statusWord(m.actual) };
  if (m.at === "errorCode") return { where: t.tests.at.errorCode, expected: errorWord(m.expected), actual: errorWord(m.actual) };
  if (m.at === "errorStep") return { where: t.tests.at.errorStep, expected: shortValue(m.expected), actual: shortValue(m.actual) };
  return { where: outputPlace(m.at.replace(/^outputs\./, "")), expected: shortValue(m.expected), actual: shortValue(m.actual) };
}

function outputPlace(path: string): string {
  const parts = path.match(/[^.[\]]+|\[\d+\]/g) ?? [path];
  const [head, ...rest] = parts;
  const words = rest.map((p) => (p.startsWith("[") ? t.tests.item(Number(p.slice(1, -1)) + 1) : t.tests.key(p)));
  return [t.tests.output(head ?? path), ...words].join(t.tests.joiner);
}

/** A name for a case saved from a run that is not taken yet: ケース 1, ケース 2, … */
export function freeName(taken: string[]): string {
  for (let n = taken.length + 1; ; n++) {
    const name = t.tests.defaultName(n);
    if (!taken.includes(name)) return name;
  }
}

/** Characters a file name on Windows cannot have. */
export const badName = (name: string) => !name.trim() || name.startsWith(".") || /[/\\:*?"<>|\p{Cc}]/u.test(name);
