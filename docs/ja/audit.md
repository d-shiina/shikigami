# 監査の記録

英語版：[../audit.md](../audit.md)

`spellsheet audit` は、この PC で誰がどのフローを変更・公開・実行したかを 1 つの一覧で表示します。Writer の人、CLI、MCP 経由の AI、スケジュール、管理サーバーのどれからの操作かも分かります。

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
| `publish` | 公開と公開の取り下げすべて。誰がしたかとメモ | `versions/<flow-id>/publish.jsonl`（ワークスペースで共有） |
| `mcp` | MCP のツール呼び出しすべて。読み取りと、拒否された呼び出し（`ok: false`、`errorCode`）も含む | `audit/mcp.jsonl`（PC ごと） |
| `run` | 実行すべて。どこから始まったか（`studio`・`cli`・`mcp`・`schedule`・`remote`）、依頼した人、結果 | `runs/<run-id>/report.json`（PC ごと） |

`--json` の項目：`at`、`source`、`actor`、`who`（クライアント・スケジュール名・管理サーバーで依頼した人）、`action`、`flowId`、`revision`、`version`、`runId`、`ok`、`errorCode`、`detail`、`secrets`（実行のみ。その実行が使ったシークレットの名前。入力したパスワード・API キー・保存したログイン状態・OAuth のトークンを含み、値は記録しません。実行の `report.json` にも `secretsUsed` として残ります）。

## 保存期間

`policy.json` の `records.keepDays`（[policy.md](policy.md)）を設定すると、各 PC で実行が終わったときに、その日数より古い実行記録と MCP の呼び出しを削除します。変更の記録は残します（元に戻す操作とフローの履歴に必要なため）。公開の記録は版と一緒に保存され、版と同じだけ残ります。

共有ワークスペースでは、変更・MCP の呼び出し・実行は PC ごと、公開は共有です。管理サーバー（[remote.md](remote.md)）は、渡したジョブをイベントとレポートごと、すべての PC の分を保存します。
