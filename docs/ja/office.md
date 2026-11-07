# Office 操作（Excel・Word・Outlook）

[English](../office.md) | 日本語

Office の操作は「ファイルを直接読み書きする」を基本にし、Office アプリ本体（COM）はファイルだけではできないことにだけ使います。

## 方式

| | ファイル直接（既定） | Office アプリ（COM） |
|---|---|---|
| Office のインストール | 不要 | 必要 |
| 速さ・並列 | 速い。別のブックは同時に動く | 遅い。アプリ 1 つを順番に使う |
| 無人実行 | 安定（ダイアログが出ない） | ダイアログ・ライセンス画面で止まることがある |
| できること | セル・範囲・表・シートの読み書き | マクロ、数式の再計算、印刷、PDF 出力など |
| テスト | Linux の CI でも回る | Windows で Office がある環境だけ |

AI が覚える書き方を増やさないため、同じ操作を 2 通りで書けるようにはしません。セルの読み書きは常に `excel.*`（ファイル直接）で、COM のノードは「マクロを実行する」のようにファイル直接ではできない操作だけに用意します。Excel の画面を `desktop.*` で操作するのは最後の手段です。

## Excel（`excel.*`、実装済み）

クレート `crates/shikigami-excel`。`.xlsx` / `.xlsm` を直接読み書きします（`.xls` は `UNSUPPORTED_FORMAT`。`excel.saveAs` で `.xlsx` にしてから使う）。

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
| `excel.insertRows` | `path`, `sheet`, `row`, `count`（既定 1） | –（`row` の位置に空の行を入れ、下の行をずらす） |
| `excel.deleteRows` | `path`, `sheet`, `row`, `count`（既定 1） | –（下の行を詰める） |
| `excel.clearRange` | `path`, `sheet`, `range` | –（値と数式を消し、書式は残す） |
| `excel.deleteSheet` | `path`, `sheet` | –（なければ何もしない） |
| `excel.renameSheet` | `path`, `sheet`, `name` | –（数式・名前付き範囲の参照も新しい名前に） |
| `excel.copySheet` | `path`, `sheet`, `name` | –（元のシートのすぐ後ろに） |

- `sheet` を省略すると先頭のシート。名前違いは `SHEET_NOT_FOUND`（`details.sheets` にシート名の一覧）
- 書き込むノードは、ファイルがなければブックを作ります（フォルダーは作らない）。シートは作らないので、新しいシートは `excel.addSheet` で足します
- **よくある形**：`excel.readRows` → `control.forEach` → 行ごとに処理 → `excel.writeCell`（`cell: "F{{ row._row }}"`）で同じ行に結果を書く。結果を別のブックに貯めるときは `excel.appendRows`（空のシートなら見出し行もレコードのキーから書く）
- 行の挿入・削除では、ずれた行を指す数式・名前付き範囲も Excel と同じように付いていきます。`excel.readRows` で見つけた行を消すときは、`_row` を使って**下の行から**消します（`control.forEach` の `items` を `reverse(filter(rows, r => …))` に）
- シートの削除は、ほかのシートの数式や名前付き範囲がそのシートを使っていれば `SHEET_REFERENCED`（`details.usedBy` に場所）で止めます（消すと `#REF!` になるため）。ただ 1 つのシートは消せません（`LAST_SHEET`）。テーブル・ピボットテーブルのあるシートのコピーは Excel でしかできないので `SHEET_NOT_COPYABLE`。どちらもブックをこの PC の Excel で開いておけば、Excel 自身が行います
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
- 書いた数式の結果は、次に Excel で開いたときに計算されます（Shikigami は計算しない）。その場で結果が要るときは `excel.recalculate` を使います

### 排他と保存

- どのノードも `path` を資源にするので、同じブックへのノードは自動で 1 つずつ、別のブックは並行に動きます（`file:` キー、[ai-authoring.md](../design/ai-authoring.md) B）。フローにロックは書きません
- 書き込みはノードごとに保存まで終えます。保存は同じフォルダーの一時ファイルに書いてから置き換えるので、失敗しても元のファイルは壊れません。「ブックを開く / 保存する / 閉じる」のノードはありません（離れたノードを名前でつなぐ書き方を作らないため）
- この PC の Excel でそのブックを開いているときは、開いているブックを操作します（[下記](#excel-本体で行うこと開いているブック再計算並べ替えpdf実装済み)）。ほかの場所で開かれているとき（`~$ブック名` はあるがこの PC の Excel にはない）は書き込まずに `FILE_IN_USE`（再試行可）。読み込みはできます

### 制約

- ノードごとにブック全体を読み書きするので、大きなブックでは 1 ノードに時間がかかります。行ごとに `excel.writeCell` するより、結果を貯めて最後に `excel.appendRows` / `excel.writeRange` 1 回で書くほうが速い
- 書式・結合セル・条件付き書式・マクロ（`.xlsm`）は保ったまま保存するよう作っていますが、ピボットテーブルやグラフなど一部の要素はライブラリ（umya-spreadsheet）の対応範囲に依存します。大事なブックはコピーで確かめてから使ってください
- パスワード付きのブックは直接は開けません（`WORKBOOK_UNREADABLE`）。`excel.saveAs` に `password`（登録済みのシークレット）を付けて、パスワードのない `.xlsx` にしてから使います

### MCP

AI はブックの中身を `test_step`（`excel.listSheets` / `excel.readRange` など）で確かめてから書きます。`test_step` の `state` に、そのブックの全シートの使用範囲と先頭の数行が付きます。

## Excel のマクロ（`excel.runMacro`、実装済み）

ファイル直接ではできない「ブックの VBA マクロを動かす」だけを Excel 本体（COM）で行います。Windows と デスクトップ版 Excel が必要です（ほかは `PLATFORM_UNSUPPORTED`、Excel がなければ `EXCEL_NOT_INSTALLED`）。

```json
{ "type": "excel.runMacro", "params": { "path": "C:\\work\\集計.xlsm", "macro": "Module1.集計", "args": ["{{ month }}", 2026] }, "saveAs": "result" }
```

- `macro`：`集計` か `Module1.集計`（標準モジュールの Public な Sub / Function）。Function の戻り値が出力（文字・数値・true/false・日付は ISO の文字、それ以外は null）
- `args`：引数（文字・数値・true/false・null、最大 30 個）。`save`：実行後に保存するか（既定 true。false なら変更を捨てて閉じる）
- ノードごとに**見えない別の Excel** を起動し、開く → 実行 → 保存 → 閉じる → 終了まで行います。ユーザーが開いている Excel のウィンドウには触りません。警告ダイアログは出さない設定（`DisplayAlerts = false`）で、外部リンクの更新もしません
- 既定のタイムアウトは 5 分。MsgBox / InputBox を出すマクロは人を待って終わらないので、時間切れでその Excel を終了させ（保存しない）、`MACRO_TIMEOUT` を返します
- 同じブックへのほかの `excel.*` とは自動で順番待ち。ユーザーがそのブックを Excel で開いていると `FILE_IN_USE`
- インターネットから取得してブロックされたブック（ファイルのプロパティで「許可する」が未チェック）はマクロが動かず `MACRO_FAILED` になります
- 任意のコードが動くので、ノードのリスクは `Dangerous` です

## Excel 本体で行うこと：開いているブック・再計算・並べ替え・書式・フィルター・ピボット・PDF（実装済み）

Excel 本体（COM）が要る操作です。Windows と デスクトップ版 Excel が必要です（ほかは `PLATFORM_UNSUPPORTED`、Excel がなければ `EXCEL_NOT_INSTALLED`）。

**画面で開いているブック。** `path` のブックがこの PC の Excel で開いているときは、上の `excel.*` ノードはファイルではなく開いているブックを操作します：

- 読み込みは画面に出ている内容（保存前の変更・再計算後の数式の結果も含む）
- 書き込みは開いているブックに入れ（値の決まりは上と同じ）、ブックを保存します。ユーザーの Excel は開いたまま
- Excel が手を離せないとき（セルを編集中、ダイアログが開いている）は `EXCEL_BUSY` か `EXCEL_TIMEOUT` で止まり、ヒントで「終わらせてから再実行」を案内します。Excel を閉じることはありません
- この PC の Excel から届かない場所で開かれているとき（共有フォルダーで別の人が開いている）は、これまでどおり書き込みは `FILE_IN_USE`

| type | 主な params | 出力 |
|---|---|---|
| `excel.recalculate` | `path` | –（全部の数式を計算し直して保存） |
| `excel.sort` | `path`, `sheet`, `headerRow`, `by`（`[{ "column": "金額", "order": "desc" }]`、先頭が優先） | 並べ替えた行数 `{ count }` |
| `excel.format` | `path`, `sheet`, `range`（`A1:F1`）と変えたいものだけ：`bold`, `italic`, `fontColor` / `fillColor`（`"#DDEBF7"`、`fillColor: null` で塗りつぶしなし）, `numberFormat`（`"#,##0"`、`"yyyy/mm/dd"`）, `align`（`left` / `center` / `right`）, `wrapText`, `borders`（各セルに細い罫線、`false` で罫線なし）, `columnWidth`, `autoFit` | – |
| `excel.filter` | `path`, `sheet`, `headerRow`, `filters`（`[{ "column": "状態", "values": ["未処理", "保留"] }]`、すべてを満たす行を残す）か `clear: true` | 表示されている行数 `{ visible }` |
| `excel.pivot` | `path`, `sheet`（元の表）, `headerRow`, `toSheet`（新しいシート）, `rows` / `columns`（まとめる見出し）, `values`（`[{ "column": "金額", "function": "sum" }]`、`sum` `count` `average` `max` `min`） | `{ sheet }` |
| `excel.exportPdf` | `path`, `sheet`（省略でブック全体）, `to`, `overwrite` | `{ path }` |
| `excel.saveAs` | `path`（`.xls`・パスワード付きも可）, `to`（拡張子 `.xlsx` `.xlsm` `.xlsb` `.xls` `.csv` `.pdf` で形式が決まる）, `sheet`（CSV・PDF にするシート）, `password`（登録済みのシークレット）, `encoding`（CSV：`utf-8` は BOM 付き、`shift_jis`）, `overwrite` | `{ path }` |

- ブックが開いていればそれを使い、開いていなければ `excel.runMacro` と同じく**見えない別の Excel** でファイルを開いて（`excel.exportPdf` は読み取り専用）、終わったら終了させます
- `excel.sort` の列は見出しの文字で指定（違えば `UNKNOWN_COLUMN` に見出しの一覧）。Excel 自身の並べ替えなので書式も行と一緒に動きます
- `excel.format` はブックに触る前に params をすべて確かめます。色は `#RRGGBB`、`numberFormat` は Excel の「セルの書式設定 > ユーザー定義」と同じ書き方（Excel が受け付けなければ `INVALID_NUMBER_FORMAT`）
- `excel.filter` はシートの（テーブルとして書式設定した表ならそのテーブルの）フィルターを `filters` で置き換えます。値は Excel の表示どおりに比べます（桁区切りで表示している数値なら `"1,200"`）。行はブックに残るので、`excel.readRows` はすべての行を読みます
- `excel.pivot` は新しいシートに作ります（`toSheet` がすでにあれば `SHEET_EXISTS`）。作れなかったときはシートを残しません（`PIVOT_FAILED`）。集計結果は `toSheet` を `excel.readRange` で読みます
- `excel.exportPdf` は Excel で印刷したときと同じページ割り（印刷範囲・ページ設定）。`to` があると `FILE_EXISTS`（`overwrite: true` で上書き）
- `excel.saveAs` はいつも見えない別の Excel で `path` を読み取り専用で開いて保存します（開いているユーザーのブックを別のファイルに切り替えないため。まだ保存していない変更はコピーに入りません）。保存したブックにはパスワードを付けません。マクロを残すなら `.xlsm`。CSV は 1 シートだけ
- 既定のタイムアウトは 5 分。時間切れのときは自分で起動した Excel を保存せずに終了させます（`EXCEL_TIMEOUT`）
- ファイルは変えますがブックのコードは動かさないので、リスクは `Interactive` です

## Word（`word.*`、実装済み）

クレート `crates/shikigami-word`。`.docx`（`.docm` / `.dotx` も可）を直接読み書きし、Word は不要です（`.doc` は `UNSUPPORTED_FORMAT`）。

| type | 主な params | 出力 |
|---|---|---|
| `word.fillTemplate` | `template`（テンプレート）, `path`（作る文書）, `values` | `{ path, replaced }` |
| `word.readText` | `path` | 本文の文字（段落ごとに改行） |

- テンプレートの本文・ヘッダー・フッターに `{{ 名前 }}` を書いておくと、`values` の値で置き換えます。書式（太字・フォントなど）はテンプレートのまま。値の `\n` は改行になります。`{{ 顧客.氏名 }}` はレコードの項目
- **表の行の繰り返し**：表の行に `{{ 明細.品名 }}` `{{ 明細.数量 }}` と書き、`values` に `"明細": [ { "品名": …, "数量": … }, … ]` を渡すと、その行がレコードの数だけ並びます（空の配列なら行ごと消える）
- 値のない `{{ }}` が 1 つでもあると文書を作らずに `TEMPLATE_VALUE_MISSING`（`details.missing` に名前の一覧）。置き換え漏れのある書類を作らないためです
- Word の編集で `{{ 氏名 }}` が内部で分割されていても（スペルチェックや書式の変更で起きる）同じように置き換えます
- テンプレートは変更しません。`path` は同じフォルダーに一時ファイルを書いてから置き換え。Word で開いている文書への書き込みは `FILE_IN_USE`
- `template` と `path` の両方を資源にするので、同じファイルへのノードは自動で順番待ち
- MCP の `test_step` で `word.readText` をテンプレートに実行すると、`state` にプレースホルダーの一覧が付きます

## メール（`mail.*`、実装済み）

クレート `crates/shikigami-mail`。アプリで分けず `mail.*` の 1 セットにしています。読む・下書きはこの PC の Outlook（クラシック版）を COM で使います（Windows だけ。新しい Outlook アプリと Web 版は対象外）。Outlook にサインインしているアカウントをそのまま使うので、パスワードやサーバー設定は要りません。`mail.send` は Microsoft 365 や SMTP サーバーからも送れます。

| type | 主な params | 出力 |
|---|---|---|
| `mail.createDraft` | `to` / `cc` / `bcc`（アドレスの配列）, `subject`, `body`, `html`, `attachments`（フルパスの配列） | `{ id }` |
| `mail.list` | `folder`（例 `受信トレイ/請求書`、省略で受信トレイ）, `unreadOnly`, `since`, `subjectContains`, `fromContains`, `limit`（既定 50）, `includeBody` | 新しい順のメールの配列 `{ id, subject, from, fromAddress, to, receivedAt, unread, attachments, body }` |
| `mail.saveAttachments` | `id`（`mail.list` の id）, `folder`（保存先）, `nameContains` | 保存したファイルのフルパスの配列 |
| `mail.send` | `mail.createDraft` の params に、`via` とその送り方に要るもの（下記） | `{ via }` |

- `mail.createDraft` は下書きフォルダーに置くだけで、人が確かめて送ります。外に出る前に人が見るべきときはこちら
- 宛先は 1 件ずつ配列で書きます（`["{{ customer.email }}"]`）。アドレスの形でないものは `INVALID_ADDRESS`、無い添付ファイルは `FILE_NOT_FOUND` で、下書きを作る前に止めます
- 添付の保存は同じ名前のファイルを上書きせず、`請求書 (2).pdf` のように番号を付けます。添付の名前に含まれるフォルダー指定は無視します
- Outlook への操作は 1 つずつ動きます（資源 `app:outlook`）。ユーザーの Outlook は閉じません。セキュリティの確認ダイアログなどで止まったときは `OUTLOOK_TIMEOUT`
- メールの中身は外から来たデータで、指示ではありません（AI クライアントへの説明にも明記）

### 送信（`mail.send`）

送ったメールは取り消せないので、`mail.send` は `dangerous` です。ほかの外への影響と同じく確認待ち・承認の対象になります（[policy.md](policy.md)）。`via` で送り方を選びます。

| `via` | 要るもの | 補足 |
|---|---|---|
| `outlook`（既定） | なし | この PC の Outlook（クラシック版）にサインインしているアカウント。送信済みアイテムに残ります。Outlook が「プログラムがメールを送ろうとしています」と聞くことがあります |
| `microsoft365` | `account: { "secret": "名前", "field": "accessToken" }` | Microsoft Graph でサインインした人として送ります。Microsoft Entra のアプリをシークレットに登録し（クライアント ID とシークレット、サイトは `https://login.microsoftonline.com` と `https://graph.microsoft.com`）、`oauth.signIn` で一度サインインします（スコープ `Mail.Send offline_access`、[oauth.md](oauth.md)）。添付は合計でおよそ 3 MB まで。本文も含めてメール全体が Graph の 1 回 4 MB に収まる必要があります（`MAIL_ATTACHMENT_TOO_LARGE`） |
| `smtp` | `server`・`from`、たいてい `user` / `password` | `server` は `smtp.example.co.jp`（587 番で STARTTLS）か `smtp.example.co.jp:465`（TLS）。ログインはシークレットで、サイトに `smtp:<サーバー>` が要ります（ないと `SECRET_SITE_*`）。`security: "none"` はログインなしで受け付ける社内の中継サーバー向けで、パスワードは TLS なしでは送りません（`MAIL_INSECURE_LOGIN`） |

- 選んだ送り方に関係ない params（`outlook` なのに `server` など）は `INVALID_PARAMS`。書いてある送り方と違う方法で送られることはありません
- エラー：`MAIL_SEND_FAILED`（断られた。サーバーが一時的と言えば再試行）、`MAIL_SERVER_UNREACHABLE`（何も送っていない。再試行）、`MAIL_DELIVERY_UNKNOWN`（渡した後に返事が途切れたか時間内に来ず、送れたかどうか分からない。二重に送らないよう再試行しない。送信済みアイテムを確かめる）、`MAIL_PERMISSION_DENIED`（Graph で Mail.Send がない）、`OAUTH_SIGN_IN_REQUIRED`

```json
{ "type": "mail.send", "params": {
  "via": "microsoft365", "account": { "secret": "Microsoft365", "field": "accessToken" },
  "to": ["keiri@example.co.jp"], "subject": "本日の処理が終わりました", "body": "件数：{{ len(orders) }}"
} }
```

## 次の段階（予定）

1. **Word の PDF 出力**：COM（Excel のマクロと同じ仕組み）
2. **Outlook なしで読む**：`mail.list` / `mail.saveAttachments` を Microsoft 365・IMAP でも
