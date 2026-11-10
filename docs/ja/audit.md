# 監査の記録

英語版：[../audit.md](../audit.md)

`spellsheet audit` は、この PC で誰がどのフローを変更・確定・実行したかを 1 つの一覧で表示します。Writer の人、CLI、MCP 経由の AI、スケジュール、管理サーバーのどれからの操作かも分かります。

```powershell
spellsheet audit                              # すべて（古い順）
spellsheet audit --since 2026-11-01           # その日から（RFC 3339 の時刻も可）
spellsheet audit --flow scn_01a1… --json      # 1 つのフローだけ、1 行に 1 つの JSON
```

```text
2026-11-06T08:00:01Z  schedule (毎朝)  run  scn_01a1… FAILED ELEMENT_NOT_FOUND  secrets: 受注システム
2026-11-06T09:12:40Z  mcp (claude-code)  update_step  scn_01a1…  保存ダイアログを待つ
2026-11-06T09:15:02Z  studio  publish  scn_01a1…  v4
```

同じことを二重に書くことはありません。各部分がすでに残している記録から読むので、食い違いが起きません。

| 種類 | 内容 | 場所 |
|---|---|---|
| `change` | フローの変更すべて（作成・編集・元に戻す・やり直す・削除）。誰が変更したかと、AI の要約 | `history/<flow-id>/journal.jsonl`（PC ごと） |
| `publish` | 確定と確定の取り消しすべて。誰がしたかとメモ | `versions/<flow-id>/publish.jsonl`（ワークスペースで共有） |
| `mcp` | MCP のツール呼び出しすべて。読み取りと、拒否された呼び出し（`ok: false`、`errorCode`）も含む | `audit/mcp.jsonl`（PC ごと） |
| `run` | 実行すべて。どこから始まったか（`studio`・`cli`・`mcp`・`schedule`・`remote`）、依頼した人、結果 | `runs/<run-id>/report.json`（PC ごと） |

`--json` の項目：`at`、`source`、`actor`、`who`（クライアント・スケジュール名・管理サーバーで依頼した人）、`action`、`flowId`、`revision`、`version`、`runId`、`ok`、`errorCode`、`detail`、`secrets`（実行のみ。その実行が使ったシークレットの名前。入力したパスワード・API キー・保存したログイン状態・OAuth のトークンを含み、値は記録しません。実行の `report.json` にも `secretsUsed` として残ります）。

### 実行が操作したもの

実行の `report.json` には、その実行が外に対して何をしたかも残ります。Writer の「実行結果」は、これを紙の形で見せます（どこから実行したものも、フローの「実行結果」の左の「実行の履歴」から遡れます）。

- `touched`：実行が操作したもの。最初に操作した順に 1 件ずつ、ノードが実行したときの値（式を埋め、相対パスは絶対パスにし、シークレットは隠す）で残します。`target`（ファイル・フォルダー・URL・プログラム・メールの宛先）、`stepTypes`（操作したノードの種類）、`stepId`・`callPath`（最初に操作したノード）、`reads`（読み取りだけ）、`count`（回数）、`at`（最初の時刻）。
  - 書き込んだファイルは、実行が終わったときの `file`（`size` と `sha256`）を残します。あとで中身が変わったかを確かめられます。実行が終わったときに無かったものは `gone: true`（削除・移動）。
  - ページや画面でクリック・入力・選択した要素は `screen: true` で、`target` にその要素の指定（JSON）を残します。入力した値は残しません。
- `lastScreen`：ブラウザーを使った実行で、最後に表示されていたページの画像（`runs/<run-id>/last-screen.png`）。`browser.close` の直前と、ブラウザーを開いたまま実行が終わったときに撮ります。パスワード欄とシークレットを入れた欄は黒く塗ります。

## 保存期間

実行記録、各フローの `logs/` の実行ログ、MCP の呼び出しは 90 日残します。それより古いものは、各 PC で実行が終わったときに削除します。日数は `policy.json` の `records.keepDays`（[policy.md](policy.md)）で変えられ、`0` にするとずっと残します。変更の記録は残します（元に戻す操作とフローの履歴に必要なため）。確定の記録は版と一緒に保存され、版と同じだけ残ります。

共有ワークスペースでは、変更・MCP の呼び出し・実行は PC ごと、確定は共有です。管理サーバー（[remote.md](remote.md)）は、渡したジョブをイベントとレポートごと、すべての PC の分を保存します。
