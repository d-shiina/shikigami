# 式の関数

[English](../expressions.md) | 日本語

シナリオの式（`expressionParams` の値、`{{ }}` の中）で使える関数の一覧です。AI クライアントには MCP の `list_step_types` が同じ一覧（`functions`：シグネチャ・説明・例）を返します。元データは `crates/shikigami-core/src/expr/functions.rs` の `FUNCTION_DOCS` で、この表と食い違わないようテストで確認しています。

関数は外部に影響しません（ファイル・画面・ネットワークには触れない）。`now()` / `today()` / `env()` だけは時計と環境変数を読みます。

## 書き方の基本

- 連結は関数ではなく `+` かテンプレート：`sei + mei`、`sei + '様'`、`"{{ sei }} {{ mei }} 様"`。数値と文字列を `+` すると文字列になる
- 表は「オブジェクトの配列」。`browser.getTable`・`excel.readRows`・`file.readCsv` が返す形と同じ
- `map` / `filter` / `find` / `some` / `every` / `sortBy` / `groupBy` の 2 番目の引数は `r => 式`（`r` は各要素）。それ以外の場所には書けない
- オブジェクトは `{ name: r.氏名, amount: num(r.金額) }` のように作れる。キーに空白や記号を含むときは `'キー'` と引用する
- 日付は文字列 `2026-10-28`（日付だけ）か `2026-10-28T09:30:00`（ローカル時刻）で持つ。日付だけの値に日・月・年を足しても日付だけのまま
- テンプレートの中で `}}` が続くと式の終わりと見なされる。オブジェクトを閉じるときは `} }` と空白を入れる

## 文字列

| 関数 | 説明 | 例 |
|---|---|---|
| `len(x)` | 文字数・要素数・キー数（null は 0） | `len('東京都') → 3` |
| `trim(s)` | 前後の空白を除く（全角空白も） | `trim('  山田 ') → '山田'` |
| `trimStart(s)` | 先頭の空白を除く | `trimStart('  a ') → 'a '` |
| `trimEnd(s)` | 末尾の空白を除く | `trimEnd('  a ') → '  a'` |
| `lower(s)` | 小文字に | `lower('ABC') → 'abc'` |
| `upper(s)` | 大文字に | `upper('abc') → 'ABC'` |
| `replace(s, find, with)` | 文字列をすべて置換（パターンではない。正規表現は regexReplace） | `replace('2026/10/28', '/', '-') → '2026-10-28'` |
| `slice(x, start, end?)` | 部分を切り出す（文字単位。end は含まない。負数は末尾から）。リストにも使える | `slice('ABC-123', 4) → '123', slice('ABC-123', 0, 3) → 'ABC', slice(code, -2) → last 2 characters` |
| `indexOf(x, find)` | 位置（見つからなければ -1） | `indexOf('ABC-123', '-') → 3` |
| `padStart(x, length, fill?)` | 先頭を埋めて指定の長さに（ゼロ埋め） | `padStart(7, 3, '0') → '007'` |
| `padEnd(x, length, fill?)` | 末尾を埋めて指定の長さに | `padEnd('A', 3, '*') → 'A**'` |
| `contains(x, find)` | 含むか（文字列・リスト・オブジェクトのキー） | `contains('株式会社ABC', '株式会社') → true` |
| `startsWith(s, prefix)` | で始まるか | `startsWith('INV-001', 'INV') → true` |
| `endsWith(s, suffix)` | で終わるか | `endsWith('a.xlsx', '.xlsx') → true` |
| `split(s, separator)` | 区切って配列に | `split('a,b,c', ',') → ['a', 'b', 'c']` |
| `lines(s)` | 行に分ける（\r\n・\n・\r。最後の改行で空行は増えない） | `lines('a\r\nb\n') → ['a', 'b']` |
| `join(list, separator)` | 配列を区切り文字でつなぐ | `join(['a', 'b'], '、') → 'a、b'` |
| `toHalfWidth(s)` | 全角→半角（英数字・記号・空白・カタカナ） | `toHalfWidth('ＡＢＣ１２３　カナ') → 'ABC123 ｶﾅ'` |
| `toFullWidth(s)` | 半角→全角（英数字・記号・空白・カタカナ） | `toFullWidth('ABC123 ｶﾞ') → 'ＡＢＣ１２３　ガ'` |
| `str(x)` | 文字列に変換（null は空文字） | `str(1200) → '1200'` |
| `formatNumber(n, decimals?)` | 3 桁区切りの文字列に（小数桁を指定、四捨五入） | `formatNumber(1234567.891, 2) → '1,234,567.89'` |

## 正規表現

構文は Rust の regex（バックトラックなし、どのパターンも入力長に比例する時間で終わる）。式の文字列の中では `\` を `\\` と書く。

| 関数 | 説明 | 例 |
|---|---|---|
| `regexTest(s, pattern)` | パターンに一致するか | `regexTest(code, '^[A-Z]{3}-\\d+$') → true` |
| `regexFind(s, pattern, group?)` | 最初の一致（またはそのグループ）。なければ null | `regexFind('請求番号: INV-0042', 'INV-(\\d+)', 1) → '0042'` |
| `regexFindAll(s, pattern, group?)` | すべての一致を配列で | `regexFindAll('a1 b22 c333', '\\d+') → ['1', '22', '333']` |
| `regexReplace(s, pattern, with)` | 一致をすべて置換（$1・${name} でグループを参照） | `regexReplace('090-1234-5678', '\\D', '') → '09012345678'` |

## 数値

| 関数 | 説明 | 例 |
|---|---|---|
| `num(x)` | 数値に変換（カンマ・前後の空白・全角数字を許す） | `num('1,234') → 1234` |
| `round(x, digits?)` | 四捨五入（小数桁 0〜10） | `round(2.345, 2) → 2.35` |
| `floor(x)` | 切り捨て | `floor(2.7) → 2` |
| `ceil(x)` | 切り上げ | `ceil(2.1) → 3` |
| `abs(x)` | 絶対値 | `abs(-5) → 5` |
| `min(list) / min(a, b, …)` | 最小値（null は無視） | `min([3, 1, 2]) → 1` |
| `max(list) / max(a, b, …)` | 最大値（null は無視） | `max(price, 1000) → the larger` |
| `sum(list)` | 合計（null は 0） | `sum(map(rows, r => r.amount)) → total` |
| `avg(list)` | 平均（null は無視。空なら null） | `avg([1, 2, 6]) → 3` |

## リスト（表）

| 関数 | 説明 | 例 |
|---|---|---|
| `map(list, x => value)` | 各要素を変換した配列 | `map(rows, r => r.name) → ['A', 'B']` |
| `filter(list, x => condition)` | 条件に合う要素だけの配列 | `filter(rows, r => num(r.amount) >= 10000)` |
| `find(list, x => condition)` | 条件に合う最初の要素（なければ null） | `find(customers, c => c.code == code)` |
| `some(list, x => condition)` | 条件に合う要素があるか | `some(rows, r => r.status == 'エラー') → true` |
| `every(list, x => condition)` | すべての要素が条件に合うか | `every(rows, r => r.checked)` |
| `sortBy(list, x => key)` | キーで昇順に並べ替え（降順は reverse で包む） | `reverse(sortBy(rows, r => num(r.amount)))` |
| `groupBy(list, x => key)` | キーごとに分けたオブジェクト | `groupBy(rows, r => r.dept) → { '営業': [...], '経理': [...] }` |
| `sort(list)` | 数値・文字列を昇順に | `sort([3, 1, 2]) → [1, 2, 3]` |
| `reverse(x)` | 逆順（文字列にも使える） | `reverse([1, 2, 3]) → [3, 2, 1]` |
| `unique(list)` | 重複を除く（最初を残す） | `unique(['a', 'b', 'a']) → ['a', 'b']` |
| `range(count) / range(start, end)` | 連番の配列（最大 10 万） | `range(3) → [0, 1, 2]` |

## オブジェクト（レコード）

| 関数 | 説明 | 例 |
|---|---|---|
| `keys(object)` | キーの配列 | `keys({ a: 1, b: 2 }) → ['a', 'b']` |
| `values(object)` | 値の配列 | `values({ a: 1, b: 2 }) → [1, 2]` |
| `merge(a, b, …)` | オブジェクトを合成（後ろが優先）。レコードの項目追加・変更に使う | `merge(row, { status: '済' })` |

## 日付

書式の記号：`yyyy`（2026）`yy`（26）`MM`（09）`M`（9）`dd`・`d`（日）`HH`・`H`（時）`mm`（分）`ss`（秒）`ddd`（水）`dddd`（水曜日）`gg`（令和）`ee`（08）・`e`（8）（和暦の年）。それ以外の文字はそのまま出る。単位は `year` `month` `week` `day` `hour` `minute` `second`。

| 関数 | 説明 | 例 |
|---|---|---|
| `now()` | 現在の日時 | `formatDate(now(), 'HHmmss')` |
| `today()` | 今日の日付 | `formatDate(today(), 'yyyyMMdd') → '20261028'` |
| `formatDate(date, pattern)` | 日付を書式で文字列に | `formatDate('2026-10-28', 'gge年M月d日(ddd)') → '令和8年10月28日(水)'` |
| `parseDate(text, pattern?)` | 文字列を日付に（書式省略時は 2026-10-28・2026/10/28 9:30・2026年10月28日） | `parseDate('令和8年10月28日', 'gge年M月d日') → '2026-10-28'` |
| `dateAdd(date, amount, unit)` | 日時を足す・引く（月末は丸める：1/31 + 1 か月 = 2/28） | `dateAdd(today(), -1, 'day') → yesterday` |
| `dateDiff(from, to, unit)` | 2 つの日時の差（単位ごと、0 方向に切り捨て） | `dateDiff('2026-01-01', '2026-03-01', 'day') → 59` |
| `endOfMonth(date)` | 月末日 | `endOfMonth('2028-02-10') → '2028-02-29'` |

## パス（文字列だけを扱い、ディスクは見ない）

| 関数 | 説明 | 例 |
|---|---|---|
| `pathJoin(folder, name, …)` | パスをつなぐ | `pathJoin(outDir, '請求書.xlsx')` |
| `dirName(path)` | フォルダー部分 | `dirName('C:\\data\\a.csv') → 'C:\\data'` |
| `fileName(path)` | ファイル名（拡張子付き） | `fileName('C:\\data\\a.csv') → 'a.csv'` |
| `baseName(path)` | ファイル名（拡張子なし） | `baseName('C:\\data\\a.csv') → 'a'` |
| `extName(path)` | 拡張子（ドット付き） | `extName('C:\\data\\a.csv') → '.csv'` |

## JSON

| 関数 | 説明 | 例 |
|---|---|---|
| `parseJson(text)` | JSON 文字列を値に | `parseJson('{"a": 1}').a → 1` |
| `toJson(value, pretty?)` | 値を JSON 文字列に（pretty で字下げ） | `toJson({ a: 1 }) → '{"a":1}'` |

## その他

| 関数 | 説明 | 例 |
|---|---|---|
| `isEmpty(x)` | null・空文字・空配列・空オブジェクトか | `isEmpty(trim(name)) → true for blank names` |
| `coalesce(a, b, …)` | 最初の null でない値 | `coalesce(row.memo, '') → '' when memo is missing` |
| `env(name)` | 実行 PC の環境変数（なければ null） | `pathJoin(env('USERPROFILE'), 'Desktop')` |
