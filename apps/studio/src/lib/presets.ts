// Ready-made "変数に代入" steps for everyday data handling: trimming, joining,
// replacing, dates, tables. Each is one variable.set with an expression, so
// the scenario has a single way to say it (the AI writes the same thing) and
// the person only renames the variables. Function names: docs/expressions.md.

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

const p = (category: Preset["category"], label: string, keyword: string, description: string, name: string, expression: string): Preset => ({
  key: `preset:${category}:${keyword}:${label}`,
  category,
  label,
  keyword,
  description,
  name,
  expression,
});

export const PRESETS: Preset[] = [
  p("text", "文字をつなぐ", "+", "変数どうし、変数と固定の文字をつなぐ（例：姓 + 名、'ID-' + 番号）", "fullName", "sei + ' ' + mei"),
  p("text", "前後の空白を除く", "trim", "前後の空白（全角も）を取り除く", "text", "trim(text)"),
  p("text", "文字を置き換える", "replace", "決まった文字をすべて置き換える", "text", "replace(text, '/', '-')"),
  p("text", "一部を取り出す", "slice", "何文字目から何文字目までを取り出す（負数は末尾から）", "code", "slice(text, 0, 3)"),
  p("text", "ゼロで埋める", "padStart", "桁数をそろえる（7 → 007）", "no", "padStart(no, 3, '0')"),
  p("text", "半角にする", "toHalfWidth", "全角の英数字・カタカナを半角に", "text", "toHalfWidth(text)"),
  p("text", "全角にする", "toFullWidth", "半角の英数字・カタカナを全角に", "text", "toFullWidth(text)"),
  p("text", "区切って分ける", "split", "区切り文字で分けてリストに", "parts", "split(text, ',')"),
  p("text", "行に分ける", "lines", "改行ごとに分けてリストに", "rows", "lines(text)"),
  p("text", "パターンで取り出す", "regexFind", "正規表現で一致した部分を取り出す", "found", "regexFind(text, 'INV-(\\\\d+)', 1)"),
  p("text", "パターンで置き換える", "regexReplace", "正規表現で一致した部分を置き換える（例：数字以外を消す）", "digits", "regexReplace(text, '\\\\D', '')"),
  p("number", "数値にする", "num", "「1,234」や全角数字の文字を数値に", "amount", "num(text)"),
  p("number", "四捨五入する", "round", "小数点以下の桁数を指定して四捨五入", "amount", "round(amount, 0)"),
  p("number", "3桁区切りにする", "formatNumber", "1234567 → 1,234,567", "amountText", "formatNumber(amount)"),
  p("date", "今日の日付", "today", "今日の日付を書式付きの文字に", "dateText", "formatDate(today(), 'yyyy/MM/dd')"),
  p("date", "日付を書式にする", "formatDate", "和暦や曜日も（例：令和8年10月28日(水)）", "dateText", "formatDate(date, 'gge年M月d日(ddd)')"),
  p("date", "文字を日付にする", "parseDate", "「2026/10/28」「令和8年10月28日」などを日付に", "date", "parseDate(text)"),
  p("date", "日付を足し引きする", "dateAdd", "日・月・年を足す（負数で引く）", "date", "dateAdd(today(), -1, 'day')"),
  p("date", "日付の差", "dateDiff", "2 つの日付が何日（何か月）離れているか", "days", "dateDiff(from, to, 'day')"),
  p("date", "月末日", "endOfMonth", "その月の最終日", "date", "endOfMonth(today())"),
  p("list", "表を絞り込む", "filter", "条件に合う行だけにする", "rows", "filter(rows, r => num(r.金額) >= 10000)"),
  p("list", "列を取り出す", "map", "各行から 1 列（や新しい形）を作る", "names", "map(rows, r => r.氏名)"),
  p("list", "1 行を探す", "find", "条件に合う最初の行", "row", "find(rows, r => r.コード == code)"),
  p("list", "並べ替える", "sortBy", "列の値で昇順に（降順は reverse で包む）", "rows", "sortBy(rows, r => num(r.金額))"),
  p("list", "合計する", "sum", "列の値を合計", "total", "sum(map(rows, r => num(r.金額)))"),
  p("list", "件数を数える", "len", "リストの件数・文字数", "count", "len(rows)"),
  p("list", "まとめてつなぐ", "join", "リストを区切り文字でつないで 1 つの文字に", "text", "join(names, '、')"),
];
