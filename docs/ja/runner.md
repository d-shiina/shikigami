# SpellSheet Runner

[English](../runner.md) | 日本語

Writer はフローを作る人の道具です。動かすだけの人には、小さな別のウィンドウ **SpellSheet Runner** があります。確定されたフローを選び、入力を埋めて「実行」を押し、結果を見ます。

- スタートメニューの「SpellSheet Runner」から開くと、この画面だけが開きます（編集しない人向け。中身は Writer と同じアプリを `--runner` を付けて起動したものです）。Writer の左上の「SpellSheet Writer」のメニューの「Runner」や、タスクトレイのアイコンからも開けます。SpellSheet がもう動いているときは、新しく起動せずにその中で開きます
- 並ぶのは確定されたフローだけで、動くのはいつも確定版です。確定は Writer の「確認待ち」でします（[policy.md](policy.md)）
- 人が起動して見ているので、Writer の「実行」と同じく、無人実行の決まり（`policy.json` の `unattended`）は当てはまりません。実行の記録はほかと同じに残ります（`origin.trigger` は `studio`、`requestedBy` は `runner`）
- 処理していないエラーで実行は終わります。ここでは止めて直すことはせず、何が起きてどうすればよいかを Writer と同じ言葉で出します

## 入力のフォーム

フォームはフローの入力変数（`direction` が `input` か `inOut`）から作るので、作る人も AI もフォームのために何も書きません。

| 変数 | 入力欄 |
|---|---|
| `description` | 項目名（1 行目）。なければ変数名 |
| `type: "string"` | 文字の欄 |
| `type: "number"` | 数の欄（`120,000` のようにカンマ付きでもよい） |
| `type: "boolean"` | チェックボックス |
| `type: "array"` | 1 行に 1 つ（JSON の配列でもよい） |
| `type: "object"` | JSON |
| `secret: true` | パスワードの欄 |
| `format: "file"` / `"folder"` | パスの欄と「参照…」（ファイル・フォルダーを選択するダイアログ） |
| `format: "date"` / `"month"` | カレンダー。値は `2026-11-06` / `2026-11` |
| `choices: [...]` | 選択肢から選ぶ一覧（`type` は `string` か `number`） |
| `default` | 欄の最初の値。初期値がない欄は必ず埋めます。初期値があれば、空のままで初期値が使われます |

`format` と `choices` は実行画面のための任意の印です（フロー形式 6）。実行や `spellsheet run` では確かめません。検査では、`format` は `string` の変数だけ、`date` / `month` の初期値はその形、選択肢は変数の型で重複なし、`default` は選択肢のどれか、を確かめます。

```json
{ "name": "book", "type": "string", "direction": "input", "format": "file", "description": "売上のブック" },
{ "name": "month", "type": "string", "direction": "input", "format": "month", "description": "対象の月" },
{ "name": "branch", "type": "string", "direction": "input", "choices": ["東京", "大阪", "名古屋"], "description": "支店" }
```

## 実行中と、終わったとき

実行中は、フローの一番上の段のノードを並べ、通ったものに印を付け、今のノードを出します。終わると、出力変数（説明を項目名に）と、その実行が `output/` に書いたファイル（「開く」と「フォルダーを開く」）を出します。失敗したときは、エラーのコードとどうすればよいかを出します。

## タスクトレイ

SpellSheet が動いているあいだ、タスクトレイ（通知領域）にアイコンが出ます。クリックで Runner が開き、右クリックで「Runner を開く」「Writer を開く」「終了」を選べます。

`--runner` で起動したときは、Runner を閉じてもタスクトレイに残り、一日中すぐ使えます。終えるときはトレイのメニューの「終了」です。`--tray` で起動すると、トレイのアイコンだけで始まります（スタートアップのフォルダー `shell:startup` に置くショートカット向け）。どちらも付けずに起動したときは、これまでどおり最後のウィンドウを閉じると終わります。

SpellSheet は Windows のサインイン 1 つにつき 1 つだけ動きます。動いている間にもう一度起動しても（スタートメニューの Writer・Runner、ショートカット）2 つ目は開かず、動いている SpellSheet が前面に出ます。開くのは Writer で、`--runner` を付けたとき（スタートメニューの「SpellSheet Runner」）は Runner です（`--tray` のときは何も開きません）。開発用のビルド（`pnpm studio:dev`）はこの制限を受けないので、インストールした SpellSheet と並べて動かせます。
