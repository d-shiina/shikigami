// Ready-made "変数に代入" steps for everyday data handling: trimming, joining,
// replacing, dates, tables. Each is one variable.set with an expression, so
// the scenario has a single way to say it (the AI writes the same thing) and
// the person only renames the variables. Function names: docs/expressions.md.
// Labels and descriptions come from the dictionary (`t.presets`, keyed by
// the function), as do expressions whose example column names are words.
import { t } from "./i18n";

export type Preset = {
  key: string;
  /** Palette category id; labels live with the step categories. */
  category: "text" | "number" | "date" | "list";
  label: string;
  /** The function it shows off, for searching and the keyword hint. */
  keyword: string;
  description: string;
  /** The variable written, and the expression written to it. */
  name: string;
  expression: string;
};

type Base = [category: Preset["category"], keyword: string, name: string, expression: string];

const BASE: Base[] = [
  ["text", "+", "fullName", "sei + ' ' + mei"],
  ["text", "trim", "text", "trim(text)"],
  ["text", "replace", "text", "replace(text, '/', '-')"],
  ["text", "slice", "code", "slice(text, 0, 3)"],
  ["text", "padStart", "no", "padStart(no, 3, '0')"],
  ["text", "toHalfWidth", "text", "toHalfWidth(text)"],
  ["text", "toFullWidth", "text", "toFullWidth(text)"],
  ["text", "split", "parts", "split(text, ',')"],
  ["text", "lines", "rows", "lines(text)"],
  ["text", "regexFind", "found", "regexFind(text, 'INV-(\\\\d+)', 1)"],
  ["text", "regexReplace", "digits", "regexReplace(text, '\\\\D', '')"],
  ["number", "num", "amount", "num(text)"],
  ["number", "round", "amount", "round(amount, 0)"],
  ["number", "formatNumber", "amountText", "formatNumber(amount)"],
  ["date", "today", "dateText", "formatDate(today(), 'yyyy/MM/dd')"],
  ["date", "formatDate", "dateText", "formatDate(date, 'gge年M月d日(ddd)')"],
  ["date", "parseDate", "date", "parseDate(text)"],
  ["date", "dateAdd", "date", "dateAdd(today(), -1, 'day')"],
  ["date", "dateDiff", "days", "dateDiff(from, to, 'day')"],
  ["date", "endOfMonth", "date", "endOfMonth(today())"],
  ["list", "filter", "rows", "filter(rows, r => num(r.金額) >= 10000)"],
  ["list", "map", "names", "map(rows, r => r.氏名)"],
  ["list", "find", "row", "find(rows, r => r.コード == code)"],
  ["list", "sortBy", "rows", "sortBy(rows, r => num(r.金額))"],
  ["list", "sum", "total", "sum(map(rows, r => num(r.金額)))"],
  ["list", "len", "count", "len(rows)"],
  ["list", "join", "text", "join(names, '、')"],
]

/** The presets in the current language. */
export function presets(): Preset[] {
  return BASE.map(([category, keyword, name, expression]) => {
    const words = t.presets[keyword];
    return {
      key: `preset:${category}:${keyword}`,
      category,
      label: words?.label ?? keyword,
      keyword,
      description: words?.description ?? "",
      name,
      expression: words?.expression ?? expression,
    };
  });
}
