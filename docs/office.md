# Office 操作（Excel・Word・Outlook）

Office の操作は「ファイルを直接読み書きする」を基本にし、Office アプリ本体（COM）はファイルだけではできないことにだけ使います。

## 方式

| | ファイル直接（既定） | Office アプリ（COM） |
|---|---|---|
| Office のインストール | 不要 | 必要 |
| 速さ・並列 | 速い。別のブックは同時に動く | 遅い。アプリ 1 つを順番に使う |
| 無人実行 | 安定（ダイアログが出ない） | ダイアログ・ライセンス画面で止まることがある |
| できること | セル・範囲・表・シートの読み書き | マクロ、数式の再計算、印刷、PDF 出力など |
| テスト | Linux の CI でも回る | Windows で Office がある環境だけ |

AI が覚える書き方を増やさないため、同じ操作を 2 通りで書けるようにはしません。セルの読み書きは常に `excel.*`（ファイル直接）で、COM のステップは「マクロを実行する」のようにファイル直接ではできない操作だけに用意します。Excel の画面を `desktop.*` で操作するのは最後の手段です。

## Excel（`excel.*`、実装済み）

クレート `crates/shikigami-excel`。`.xlsx` / `.xlsm` を直接読み書きします（`.xls` は `UNSUPPORTED_FORMAT`、Excel で `.xlsx` に保存し直してもらう）。

| type | 主な params | 出力 |
|---|---|---|
| `excel.readRows` | `path`, `sheet`, `headerRow`（既定 1） | 見出しをキーにしたレコードの配列。各レコードに行番号 `_row` |
| `excel.appendRows` | `path`, `sheet`, `rows`（レコードの配列）, `headerRow` | `{ firstRow, count }` |
| `excel.readCell` | `path`, `sheet`, `cell`（例 `B3`） | セルの値 |
| `excel.writeCell` | `path`, `sheet`, `cell`, `value` | – |
| `excel.readRange` | `path`, `sheet`, `range`（例 `A1:D20`、省略で使用範囲全体） | 行の配列（各行はセル値の配列） |
| `excel.writeRange` | `path`, `sheet`, `cell`（左上）, `values`（行の配列） | `{ range }` |
| `excel.listSheets` | `path` | シート名の配列 |
| `excel.addSheet` | `path`, `sheet` | –（同名があれば何もしない） |

- `sheet` を省略すると先頭のシート。名前違いは `SHEET_NOT_FOUND`（`details.sheets` にシート名の一覧）
- 書き込むステップは、ファイルがなければブックを作ります（フォルダーは作らない）。シートは作らないので、新しいシートは `excel.addSheet` で足します
- **よくある形**：`excel.readRows` → `control.forEach` → 行ごとに処理 → `excel.writeCell`（`cell: "F{{ row._row }}"`）で同じ行に結果を書く。結果を別のブックに貯めるときは `excel.appendRows`（空のシートなら見出し行もレコードのキーから書く）
- `excel.appendRows` のキーは見出しと完全一致。合わないキーは `UNKNOWN_COLUMN`（`details.columns` に見出しの一覧）。勝手に列は増やしません

### 値の決まり

| セル | 読んだ値 | 書くときの書き方 |
|---|---|---|
| 文字 | `"A-1"` | `"A-1"`（`"=1+1"` や `"007"` も文字のまま。数値や数式に化けない） |
| 数値 | `1200` / `980.5` | `1200` |
| 真偽 | `true` / `false` | `true` |
| 日付 | `"2026-10-28"`（時刻つきは `"2026-10-28T09:30:00"`、時刻だけは `"09:30:00"`） | `{ "date": "2026-10-28" }` |
| 数式 | Excel が最後に計算した結果 | `{ "formula": "SUM(B2:B9)" }` |
| エラー | `"#DIV/0!"` などの文字 | – |
| 空 | `null` | `null`（書式は残して値を消す） |

- 日付はセルの表示形式（`yyyy/mm/dd`、`ggge年m月d日` など）で判断します。書くときは、セルが日付の表示形式でなければ `yyyy/mm/dd` を付けます
- 書いた数式の結果は、次に Excel で開いたときに計算されます（Shikigami は計算しない）。その場で結果が要るときは COM の再計算ステップ（予定）を使います

### 排他と保存

- どのステップも `path` を資源にするので、同じブックへのステップは自動で 1 つずつ、別のブックは並行に動きます（`file:` キー、[ai-authoring.md](design/ai-authoring.md) B）。シナリオにロックは書きません
- 書き込みはステップごとに保存まで終えます。保存は同じフォルダーの一時ファイルに書いてから置き換えるので、失敗しても元のファイルは壊れません。「ブックを開く / 保存する / 閉じる」のステップはありません（離れたステップを名前でつなぐ書き方を作らないため）
- Excel でそのブックを開いているとき（`~$ブック名` があるとき）は書き込まずに `FILE_IN_USE`（再試行可）。読み込みはできます

### 制約

- ステップごとにブック全体を読み書きするので、大きなブックでは 1 ステップに時間がかかります。行ごとに `excel.writeCell` するより、結果を貯めて最後に `excel.appendRows` / `excel.writeRange` 1 回で書くほうが速い
- 書式・結合セル・条件付き書式・マクロ（`.xlsm`）は保ったまま保存するよう作っていますが、ピボットテーブルやグラフなど一部の要素はライブラリ（umya-spreadsheet）の対応範囲に依存します。大事なブックはコピーで確かめてから使ってください
- パスワード付きのブックは開けません（`WORKBOOK_UNREADABLE`）

### MCP

AI はブックの中身を `test_step`（`excel.listSheets` / `excel.readRange` など）で確かめてから書きます。`test_step` の `state` に、そのブックの全シートの使用範囲と先頭の数行が付きます。

## Excel のマクロ（`excel.runMacro`、実装済み）

ファイル直接ではできない「ブックの VBA マクロを動かす」だけを Excel 本体（COM）で行います。Windows と デスクトップ版 Excel が必要です（ほかは `PLATFORM_UNSUPPORTED`、Excel がなければ `EXCEL_NOT_INSTALLED`）。

```json
{ "type": "excel.runMacro", "params": { "path": "C:\\work\\集計.xlsm", "macro": "Module1.集計", "args": ["{{ month }}", 2026] }, "saveAs": "result" }
```

- `macro`：`集計` か `Module1.集計`（標準モジュールの Public な Sub / Function）。Function の戻り値が出力（文字・数値・true/false・日付は ISO の文字、それ以外は null）
- `args`：引数（文字・数値・true/false・null、最大 30 個）。`save`：実行後に保存するか（既定 true。false なら変更を捨てて閉じる）
- ステップごとに**見えない別の Excel** を起動し、開く → 実行 → 保存 → 閉じる → 終了まで行います。ユーザーが開いている Excel のウィンドウには触りません。警告ダイアログは出さない設定（`DisplayAlerts = false`）で、外部リンクの更新もしません
- 既定のタイムアウトは 5 分。MsgBox / InputBox を出すマクロは人を待って終わらないので、時間切れでその Excel を終了させ（保存しない）、`MACRO_TIMEOUT` を返します
- 同じブックへのほかの `excel.*` とは自動で順番待ち。ユーザーがそのブックを Excel で開いていると `FILE_IN_USE`
- インターネットから取得してブロックされたブック（ファイルのプロパティで「許可する」が未チェック）はマクロが動かず `MACRO_FAILED` になります
- 任意のコードが動くので、ステップのリスクは `Dangerous` です

## 次の段階（予定）

1. **Excel の再計算・PDF 出力**：`excel.runMacro` と同じ仕組みで足す
2. **Word（`word.*`、ファイル直接）**：`.docx` の差し込み（`word.fillTemplate`：`{{ 名前 }}` の置き換え、表への行の追加）と本文の読み取り（`word.readText`）。PDF 出力は COM
3. **メール（`mail.*`）**：アプリで分けず `mail.*` の 1 セットにし、送り方（Outlook の COM、のちに SMTP / Microsoft Graph）は設定で選ぶ。外にメッセージが出るので `mail.send` は `Dangerous`、まずは下書き作成（`mail.createDraft`）と受信メールの読み取り・添付保存（`mail.list` / `mail.saveAttachments`）から。宛先・本文の検証ヒントを厚くする
