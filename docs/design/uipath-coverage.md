# UiPath の組込アクティビティとの対応表（ギャップ分析）

目的：UiPath Studio の標準パッケージ（UiPath.System.Activities・UiPath.WebAPI.Activities・UiPath.Excel/Mail/PDF.Activities など）で日常的に使われるアクティビティを、Shikigami で同じことができるか洗い出し、足りないものを埋める。

## 方針：アクティビティの数ではなく「書けること」で負けない

UiPath は 1 つの操作に 1 つのアクティビティを用意する（「文字列を置換」「左から n 文字」「変数を連結」…）。Shikigami は AI が組む前提の仕様（[ai-authoring.md](ai-authoring.md)）なので、同じことを 1 通りで書けるように次の 3 層に分ける。

| 層 | 何を置くか | 例 |
|---|---|---|
| **式の関数**（Core、副作用なし） | 値の計算・加工すべて。文字列・数値・日付・リスト・JSON・パス | `trim`、`replace`、`slice`、`formatDate`、`filter`、`sum` |
| **組込ステップ**（Runtime / アダプター） | 外部に触れる操作だけ。ファイル・ネットワーク・プロセス・クリップボード・ダイアログ | `file.readCsv`、`http.request`、`process.run` |
| **プラグイン** | 社内システム・個別 SaaS など | [plugins.md](plugins.md) |

文字の加工のためにステップを増やさない理由：

- 「連結」「トリミング」「置換」をステップにすると、AI は `variable.set` の式で書くかステップで書くかを毎回選ぶことになり、出力がぶれる（原則 1）。
- 式なら `trim(replace(name, '　', ' '))` のように 1 行で組み合わせられ、Studio の手順書でも 1 行で読める。UiPath でも上級者は Assign + VB.NET 式で書いており、アクティビティを並べるのは入門向け。
- Studio のパレットには「文字」カテゴリの**プリセット**（中身は式を入れた `variable.set`）を置き、UiPath の「アクティビティを探して置く」体験は残す（Studio 側で対応）。

## 対応表

状態：✅ 対応済み／🆕 今回追加／🔜 予定（担当）／➖ 不要（別の書き方）

### 制御・変数・ログ（UiPath.System.Activities）

| UiPath | Shikigami | 状態 |
|---|---|---|
| Assign / Multiple Assign | `variable.set`（`expression`）。複数は並べる | ✅ |
| If / Else If | `control.if`（else に `control.if`） | ✅ |
| Switch | `control.if` の連鎖。値の対応表なら `{ A: 'x', B: 'y' }[code]` | ➖（Studio 表示を見て再検討） |
| While / Do While | `control.while` | ✅ |
| For Each / For Each Row | `control.forEach`（表は配列なので行もこれ） | ✅ |
| Repeat Number of Times | `control.repeat` | ✅ |
| Break / Continue | `control.break` / `control.continue` | ✅ |
| Parallel / Parallel For Each | `control.parallel` / `control.forEach` の `concurrency` | ✅ |
| Try Catch / Throw / Rethrow | `control.try` / `control.fail`（catch 内で `control.fail` に `error.message`） | ✅ |
| Retry Scope | ステップ共通の `retry`、状態待ちは `wait.until` | ✅ |
| Delay | `flow.delay` | ✅ |
| Element Exists 待ち / Check App State | `wait.until`、`browser.waitFor`、`desktop.waitFor` | ✅ |
| Log Message / Write Line | `log.message` | ✅ |
| Sequence / Flowchart | `control.group`（フロー図は Studio の表示） | ✅ |
| Invoke Workflow File | サブシナリオ（別スレッドで実装中） | 🔜 |
| Comment | ステップの `name`・メモ | ✅ |
| Get Credential / Get Asset | シークレット（`{ "secret": … }`） | ✅ |
| Invoke Code / Invoke VBA / Invoke PowerShell | 任意コードは実行しない方針。外部プログラムは `process.run`、マクロは `excel.runMacro`（Office スレッド） | ✅ / 🔜 |

### 文字列（Text / String 系アクティビティと VB.NET の String メソッド）

| UiPath | Shikigami | 状態 |
|---|---|---|
| 変数の連結・固定値との連結（`a + b`、`String.Concat`、Combine Text） | `a + b`、`a + '様'`、テンプレート `"{{ a }}{{ b }}"` | ✅ |
| Trim / TrimStart / TrimEnd | `trim` / `trimStart` / `trimEnd`（全角空白も対象） | ✅ / 🆕 |
| Replace（文字列） | `replace(s, find, with)` | 🆕 |
| Substring / Text to Left/Right | `slice(s, start, end?)`（負数で右から） | 🆕 |
| IndexOf / Contains / StartsWith / EndsWith | `indexOf` / `contains` / `startsWith` / `endsWith` | 🆕 / ✅ |
| PadLeft / PadRight（ゼロ埋め） | `padStart` / `padEnd` | 🆕 |
| ToUpper / ToLower | `upper` / `lower` | ✅ |
| Split / Join / 改行で分割 | `split` / `join` / `lines` | ✅ / 🆕 |
| Matches / Is Match / Replace（Regex） | `regexFindAll` / `regexTest` / `regexReplace`、1 件だけなら `regexFind` | 🆕 |
| String.Format / ToString("N0") | テンプレート、`formatNumber(n, 桁)` | ✅ / 🆕 |
| 全角・半角変換（StrConv。UiPath には専用アクティビティなし） | `toHalfWidth` / `toFullWidth`（カタカナの濁点も） | 🆕（UiPath にない強み） |
| Change Case / Modify Text | `upper` / `lower` / `replace` の組み合わせ | ✅ |

### 数値

| UiPath | Shikigami | 状態 |
|---|---|---|
| CInt / CDbl / Parse | `num`（カンマ・全角数字を許す） | ✅ / 🆕 |
| Math.Round / Floor / Ceiling / Abs / Min / Max | `round` / `floor` / `ceil` / `abs` / `min` / `max` | ✅ / 🆕 |
| 合計・平均（Sum / Average） | `sum` / `avg` | ✅ / 🆕 |
| Generate Random Number | なし（結果が実行ごとに変わり、テスト・レビューしにくい） | ➖ |

### 日付・時刻

| UiPath | Shikigami | 状態 |
|---|---|---|
| Now / Today | `now()` / `today()` | 🆕 |
| ToString("yyyy/MM/dd") / Format Date | `formatDate(d, 'yyyy/MM/dd')`、和暦 `gge年`、曜日 `ddd` | 🆕 |
| DateTime.ParseExact / Parse | `parseDate(text, pattern?)`（和暦も読む） | 🆕 |
| AddDays / AddMonths / Modify Date | `dateAdd(d, n, 'day' \| 'month' \| …)` | 🆕 |
| DateDiff / Subtract | `dateDiff(a, b, unit)` | 🆕 |
| 月末（DateSerial 等で自作） | `endOfMonth(d)` | 🆕 |

### コレクション・データテーブル

Shikigami の表は「オブジェクトの配列」1 種類で、DataTable 型はない（AI が型の違いを覚えなくてよい。JSON でそのまま見える）。

| UiPath | Shikigami | 状態 |
|---|---|---|
| Build Data Table / Add Data Row | `variable.set` に配列・オブジェクト、`items + [row]` | ✅ |
| Add / Remove / Exists in Collection | `items + [x]`、`filter(items, x => x != y)`、`contains` | ✅ / 🆕 |
| Filter Data Table / Select | `filter(rows, r => …)` | 🆕 |
| Sort Data Table | `sortBy(rows, r => …)`、降順は `reverse` | 🆕 |
| Lookup Data Table | `find(rows, r => r.code == code)` | 🆕 |
| Remove Duplicate Rows | `unique`（値）／`groupBy` で先頭を取る | 🆕 |
| Join / Merge Data Table | `map(a, r => merge(r, find(b, x => x.id == r.id)))` | 🆕 |
| Group By（LINQ） | `groupBy(rows, r => r.dept)` | 🆕 |
| Output Data Table（文字列化） | `toJson`、`join(map(…))` | 🆕 |
| 列の追加・計算列 | `map(rows, r => merge(r, { tax: round(r.amount * 0.1) }))` | 🆕 |
| Dictionary の Keys / Values | `keys` / `values` / `obj['キー']` | 🆕 / ✅ |

### ファイル・フォルダー（System > File）

| UiPath | Shikigami | 状態 |
|---|---|---|
| Read Text File / Write Text File / Append Line | `file.readText` / `file.writeText`（`append`）。Shift_JIS 指定可 | ✅ |
| Read CSV / Write CSV / Append To CSV | `file.readCsv` / `file.writeCsv`（Shift_JIS・BOM 付き UTF-8） | ✅ |
| Copy File / Move File / Rename / Delete | `file.copy` / `file.move` / `file.delete` | ✅ |
| Create Folder / Path Exists / Get Files | `file.createFolder` / `file.exists` / `file.list` | ✅ |
| Compress / Extract Files | `file.zip` / `file.unzip` | ✅ |
| Wait for Download / File Change Trigger | `wait.until` + `file.list` | ✅ |
| Path.Combine / GetFileName / GetExtension | `pathJoin` / `fileName` / `baseName` / `extName` / `dirName` | 🆕 |
| Get Environment Variable / Environment.SpecialFolder | `env('USERPROFILE')` | 🆕 |

### Excel・Word・メール（Office スレッドが担当）

| UiPath | Shikigami | 状態 |
|---|---|---|
| Read Range / Write Range / Read Cell / Write Cell / Append Range | `excel.readRows` / `readRange` / `readCell` / `writeCell` / `writeRange` / `appendRows` | 🔜（PR #25） |
| Get Workbook Sheets / Add Sheet | `excel.listSheets` / `excel.addSheet` | 🔜（PR #25） |
| Execute Macro | `excel.runMacro`（COM） | 🔜（Office） |
| Word Replace Text / Read Text | `word.*` | 🔜（Office） |
| Send SMTP / Outlook Mail、Get Mail、Save Attachments | `mail.*`（Outlook から） | 🔜（Office） |

### Web API・JSON（UiPath.WebAPI.Activities）

| UiPath | Shikigami | 状態 |
|---|---|---|
| HTTP Request | `http.request`（メソッド・ヘッダー・クエリ・JSON / フォーム本文、トークンはシークレット） | ✅ |
| Deserialize JSON / Serialize JSON | `parseJson` / `toJson`。`http.request` は JSON を自動で値にする | 🆕 |
| Deserialize XML / Execute XPath | 需要を見て関数で追加 | 🔜（未定） |

### システム・ユーザー対話

| UiPath | Shikigami | 状態 |
|---|---|---|
| Start Process / Kill Process | アプリは `desktop.launch` / `desktop.closeWindow`。コマンドは `process.run`（終了コード・標準出力を返す） | ✅ |
| Get / Set From Clipboard | `clipboard.get` / `clipboard.set` | ✅ |
| Message Box / Input Dialog / Select File | `dialog.message` / `dialog.input` / `dialog.selectFile` | ✅ |
| Take Screenshot | `browser.screenshot`（デスクトップは未定） | ✅ / 🔜 |
| Send Hotkey / Type Into | `desktop.press` / `desktop.type` / `desktop.setValue` | ✅ |

### PDF（UiPath.PDF.Activities）

| UiPath | Shikigami | 状態 |
|---|---|---|
| Read PDF Text | `pdf.readText`（テキスト層のある PDF。パスワード付きも可） | ✅ |
| Read PDF With OCR | OCR エンジンの選定が要る。プラグイン候補 | 🔜（未定） |
| Join / Extract PDF Page Range | 需要を見て | 🔜（未定） |

## 実装順

1. **式の関数**（この PR）：文字列・正規表現・全角半角・数値・リスト（`x => …`）・オブジェクト・日付（和暦）・パス・JSON・`env`。MCP `list_step_types` が `functions` で一覧と例を返す。一覧：[../expressions.md](../expressions.md)
2. **`file.*`**（[../files.md](../files.md)）：テキスト・CSV（Shift_JIS）・コピー/移動/削除・一覧・フォルダー作成・zip。ファイルのパスを資源キーにして同じファイルへの操作は自動で順番待ち
3. **`http.request`・`process.run`・`clipboard.*`・`dialog.*`**（[../system.md](../system.md)）
4. **`pdf.readText`**（[../pdf.md](../pdf.md)）

## 式の言語に入れた拡張

- オブジェクトリテラル `{ name: r.氏名, 'key 2': 1 }`
- `x => …`（ラムダ）。`map` / `filter` / `find` / `some` / `every` / `sortBy` / `groupBy` の 2 番目の引数にだけ書ける（それ以外は解析時にエラー）。引数名は外の変数を隠す。変数の参照チェック（`UNDEFINED_VARIABLE`）は引数名を除いて行う
- 文字列のエスケープに `\r` を追加

任意コードを実行しない方針は変えない。どの関数も入力に比例した時間で終わる（正規表現はバックトラックなしのエンジン、`range` は 10 万件まで）。
