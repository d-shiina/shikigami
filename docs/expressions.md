# Expression functions

English | [日本語](ja/expressions.md)

The functions available in scenario expressions (the values of `expressionParams`, and inside `{{ }}`). AI clients get the same list (`functions`: signature, description, examples) from MCP's `list_step_types`. The source is `FUNCTION_DOCS` in `crates/shikigami-core/src/expr/functions.rs`, and a test keeps it in node with these tables.

Functions have no side effects (they never touch files, the screen or the network). Only `now()` / `today()` / `env()` read the clock and environment variables.

## Basics

- Join text with `+` or a template, not a function: `sei + mei`, `sei + '様'`, `"{{ sei }} {{ mei }} 様"`. `+` on a number and a string gives a string
- A table is "a list of objects", the same shape `browser.getTable`, `excel.readRows` and `file.readCsv` return
- The second argument of `map` / `filter` / `find` / `some` / `every` / `sortBy` / `groupBy` is `r => expression` (`r` is each element). It cannot be written anywhere else
- Build objects like `{ name: r.氏名, amount: num(r.金額) }`. Quote keys with spaces or symbols as `'key'`
- Keep dates as strings: `2026-10-28` (date only) or `2026-10-28T09:30:00` (local time). Adding days, months or years to a date-only value keeps it date-only
- Inside a template, `}}` ends the expression. Close objects with `} }` (with a space)

## Text

| Function | Description | Example |
|---|---|---|
| `len(x)` | Number of characters, elements or keys (0 for null) | `len('東京都') → 3` |
| `trim(s)` | Removes leading and trailing spaces (full-width too) | `trim('  山田 ') → '山田'` |
| `trimStart(s)` | Removes leading spaces | `trimStart('  a ') → 'a '` |
| `trimEnd(s)` | Removes trailing spaces | `trimEnd('  a ') → '  a'` |
| `lower(s)` | To lower case | `lower('ABC') → 'abc'` |
| `upper(s)` | To upper case | `upper('abc') → 'ABC'` |
| `replace(s, find, with)` | Replaces every occurrence of a string (not a pattern; use regexReplace for regular expressions) | `replace('2026/10/28', '/', '-') → '2026-10-28'` |
| `slice(x, start, end?)` | A part, by character (end excluded; negative counts from the end). Works on lists too | `slice('ABC-123', 4) → '123', slice('ABC-123', 0, 3) → 'ABC', slice(code, -2) → last 2 characters` |
| `indexOf(x, find)` | Position (-1 when not found) | `indexOf('ABC-123', '-') → 3` |
| `padStart(x, length, fill?)` | Pads the start to a length (zero padding) | `padStart(7, 3, '0') → '007'` |
| `padEnd(x, length, fill?)` | Pads the end to a length | `padEnd('A', 3, '*') → 'A**'` |
| `contains(x, find)` | Whether it contains (strings, lists, object keys) | `contains('株式会社ABC', '株式会社') → true` |
| `startsWith(s, prefix)` | Whether it starts with | `startsWith('INV-001', 'INV') → true` |
| `endsWith(s, suffix)` | Whether it ends with | `endsWith('a.xlsx', '.xlsx') → true` |
| `split(s, separator)` | Splits into a list | `split('a,b,c', ',') → ['a', 'b', 'c']` |
| `lines(s)` | Splits into lines (\r\n, \n, \r; a final line break adds no empty line) | `lines('a\r\nb\n') → ['a', 'b']` |
| `join(list, separator)` | Joins a list with a separator | `join(['a', 'b'], '、') → 'a、b'` |
| `toHalfWidth(s)` | Full-width to half-width (letters, digits, symbols, spaces, katakana) | `toHalfWidth('ＡＢＣ１２３　カナ') → 'ABC123 ｶﾅ'` |
| `toFullWidth(s)` | Half-width to full-width (letters, digits, symbols, spaces, katakana) | `toFullWidth('ABC123 ｶﾞ') → 'ＡＢＣ１２３　ガ'` |
| `str(x)` | To a string (null gives an empty string) | `str(1200) → '1200'` |
| `formatNumber(n, decimals?)` | To a string with thousands separators (rounded to the given decimals) | `formatNumber(1234567.891, 2) → '1,234,567.89'` |

## Regular expressions

The syntax is Rust's regex (no backtracking; every pattern runs in time proportional to the input). Inside an expression string, write `\` as `\\`.

| Function | Description | Example |
|---|---|---|
| `regexTest(s, pattern)` | Whether the pattern matches | `regexTest(code, '^[A-Z]{3}-\\d+$') → true` |
| `regexFind(s, pattern, group?)` | The first match (or its group), or null | `regexFind('請求番号: INV-0042', 'INV-(\\d+)', 1) → '0042'` |
| `regexFindAll(s, pattern, group?)` | Every match, as a list | `regexFindAll('a1 b22 c333', '\\d+') → ['1', '22', '333']` |
| `regexReplace(s, pattern, with)` | Replaces every match ($1 and ${name} refer to groups) | `regexReplace('090-1234-5678', '\\D', '') → '09012345678'` |

## Numbers

| Function | Description | Example |
|---|---|---|
| `num(x)` | To a number (commas, surrounding spaces and full-width digits allowed) | `num('1,234') → 1234` |
| `round(x, digits?)` | Rounds half up (0–10 decimals) | `round(2.345, 2) → 2.35` |
| `floor(x)` | Rounds down | `floor(2.7) → 2` |
| `ceil(x)` | Rounds up | `ceil(2.1) → 3` |
| `abs(x)` | Absolute value | `abs(-5) → 5` |
| `min(list) / min(a, b, …)` | Smallest value (nulls ignored) | `min([3, 1, 2]) → 1` |
| `max(list) / max(a, b, …)` | Largest value (nulls ignored) | `max(price, 1000) → the larger` |
| `sum(list)` | Sum (null counts as 0) | `sum(map(rows, r => r.amount)) → total` |
| `avg(list)` | Average (nulls ignored; null when empty) | `avg([1, 2, 6]) → 3` |

## Lists (tables)

| Function | Description | Example |
|---|---|---|
| `map(list, x => value)` | A list of each element transformed | `map(rows, r => r.name) → ['A', 'B']` |
| `filter(list, x => condition)` | The elements that match | `filter(rows, r => num(r.amount) >= 10000)` |
| `find(list, x => condition)` | The first element that matches (or null) | `find(customers, c => c.code == code)` |
| `some(list, x => condition)` | Whether any element matches | `some(rows, r => r.status == 'エラー') → true` |
| `every(list, x => condition)` | Whether every element matches | `every(rows, r => r.checked)` |
| `sortBy(list, x => key)` | Sorts ascending by a key (wrap in reverse for descending) | `reverse(sortBy(rows, r => num(r.amount)))` |
| `groupBy(list, x => key)` | An object of lists, one per key | `groupBy(rows, r => r.dept) → { '営業': [...], '経理': [...] }` |
| `sort(list)` | Sorts numbers or strings ascending | `sort([3, 1, 2]) → [1, 2, 3]` |
| `reverse(x)` | Reverses (strings too) | `reverse([1, 2, 3]) → [3, 2, 1]` |
| `unique(list)` | Removes duplicates (keeps the first) | `unique(['a', 'b', 'a']) → ['a', 'b']` |
| `range(count) / range(start, end)` | A list of consecutive numbers (up to 100,000) | `range(3) → [0, 1, 2]` |

## Objects (records)

| Function | Description | Example |
|---|---|---|
| `keys(object)` | The keys, as a list | `keys({ a: 1, b: 2 }) → ['a', 'b']` |
| `values(object)` | The values, as a list | `values({ a: 1, b: 2 }) → [1, 2]` |
| `merge(a, b, …)` | Combines objects (later ones win). Use it to add or change fields of a record | `merge(row, { status: '済' })` |

## Dates

Format symbols: `yyyy` (2026) `yy` (26) `MM` (09) `M` (9) `dd`/`d` (day) `HH`/`H` (hour) `mm` (minute) `ss` (second) `ddd` (水) `dddd` (水曜日) `gg` (令和) `ee` (08) / `e` (8) (year of the Japanese era). Other characters are output as is. Units: `year` `month` `week` `day` `hour` `minute` `second`.

| Function | Description | Example |
|---|---|---|
| `now()` | The current date and time | `formatDate(now(), 'HHmmss')` |
| `today()` | Today's date | `formatDate(today(), 'yyyyMMdd') → '20261028'` |
| `formatDate(date, pattern)` | Formats a date as text | `formatDate('2026-10-28', 'gge年M月d日(ddd)') → '令和8年10月28日(水)'` |
| `parseDate(text, pattern?)` | Text to a date (without a pattern: 2026-10-28, 2026/10/28 9:30, 2026年10月28日) | `parseDate('令和8年10月28日', 'gge年M月d日') → '2026-10-28'` |
| `dateAdd(date, amount, unit)` | Adds to or subtracts from a date (clamps to the end of the month: 1/31 + 1 month = 2/28) | `dateAdd(today(), -1, 'day') → yesterday` |
| `dateDiff(from, to, unit)` | The difference between two dates, in a unit (truncated toward 0) | `dateDiff('2026-01-01', '2026-03-01', 'day') → 59` |
| `endOfMonth(date)` | The last day of the month | `endOfMonth('2028-02-10') → '2028-02-29'` |

## Paths (text only; the disk is never read)

| Function | Description | Example |
|---|---|---|
| `pathJoin(folder, name, …)` | Joins paths | `pathJoin(outDir, '請求書.xlsx')` |
| `dirName(path)` | The folder part | `dirName('C:\\data\\a.csv') → 'C:\\data'` |
| `fileName(path)` | The file name (with extension) | `fileName('C:\\data\\a.csv') → 'a.csv'` |
| `baseName(path)` | The file name (without extension) | `baseName('C:\\data\\a.csv') → 'a'` |
| `extName(path)` | The extension (with the dot) | `extName('C:\\data\\a.csv') → '.csv'` |

## JSON

| Function | Description | Example |
|---|---|---|
| `parseJson(text)` | A JSON string to a value | `parseJson('{"a": 1}').a → 1` |
| `toJson(value, pretty?)` | A value to a JSON string (indented with pretty) | `toJson({ a: 1 }) → '{"a":1}'` |

## Other

| Function | Description | Example |
|---|---|---|
| `isEmpty(x)` | Whether it is null, an empty string, an empty list or an empty object | `isEmpty(trim(name)) → true for blank names` |
| `coalesce(a, b, …)` | The first value that is not null | `coalesce(row.memo, '') → '' when memo is missing` |
| `env(name)` | An environment variable of the PC running it (or null) | `pathJoin(env('USERPROFILE'), 'Desktop')` |
