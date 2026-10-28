# AI の変更の証跡とレビュー（設計メモ）

目的：Studio の「レビュー台」で、AI が **何を・なぜ変え・どう確かめたか** を手順の横で確かめ、承認するか理由を付けて差し戻す。差し戻しの理由は AI が MCP で読み、そのまま直しに使う。

## 記録するもの

| 種類 | いつ記録されるか | 置き場所 |
|---|---|---|
| 変更の説明（`summary`）と触ったステップ（`stepIds`） | 編集ツールの呼び出しごと | `history/<scenario-id>/journal.jsonl`（従来のジャーナルに欄を追加） |
| テスト実行（`testRun`） | MCP の `run_scenario` が終わったとき | `history/<scenario-id>/evidence.jsonl` |
| 画面の証跡（`observation`） | `inspect_page` / `inspect_ui`（ウィンドウ指定時）/ `test_step` のたびに保存し、編集が `observations` で名指ししたときにその版と手順に紐づける | 本体：`observations/<obs-id>/`（`observation.json`・`tree.txt`・`screenshot.jpg`）。紐づけ：`evidence.jsonl` |
| レビュー（`review`） | Studio で承認・差し戻ししたとき | `history/<scenario-id>/evidence.jsonl` |

- すべて PC ごとの部分（[sharing-versioning.md](sharing-versioning.md)）に置く。ジャーナル・実行記録と同じ扱いで、共有ワークスペースでも同期されない。
- 各レコードは `revision`（どのリビジョンに対するものか）・`at`・`actor`（Studio / MCP クライアント名）を持つ。

## データ形式

ジャーナル（`HistoryEntry`）に追加した欄：

```json
{ "kind": "edit", "revision": 5, "actor": { "kind": "mcp", "name": "claude-code" }, "at": "…",
  "label": "add step browser.getTable",
  "summary": "受注一覧の読み取りを追加。表の名前は『受注』だった",
  "stepIds": ["stp_…"], "ops": […], "inverse": […] }
```

`evidence.jsonl` の 1 行（`Evidence`。`kind` で 3 種類）：

```json
{ "revision": 5, "at": "…", "actor": {…}, "kind": "observation",
  "observationId": "obs_…", "source": "inspectPage", "title": "受注一覧 (https://…)",
  "stepIds": ["stp_…"], "hasScreenshot": true }
{ "revision": 5, "at": "…", "actor": {…}, "kind": "testRun",
  "runId": "run_…", "status": "failed", "errorCode": "ELEMENT_NOT_FOUND", "errorMessage": "…",
  "stepId": "stp_…", "version": 2, "startedAt": "…", "finishedAt": "…" }
{ "revision": 5, "at": "…", "actor": { "kind": "studio" }, "kind": "review",
  "verdict": "rejected", "reason": "…", "steps": [{ "stepId": "stp_…", "note": "…" }] }
```

`observations/<obs-id>/observation.json`（`Observation`）：

```json
{ "id": "obs_…", "source": "testStep", "at": "…", "actor": {…}, "title": "browser.click: ログイン",
  "request": { "type": "browser.click", "params": {…} }, "status": "succeeded", "output": null,
  "treeFile": "tree.txt", "screenshotFile": "screenshot.jpg",
  "notes": ["UI tree cut at 256 KB"],
  "linked": [{ "scenarioId": "scn_…", "revision": 5 }] }
```

## 読み出し

`review_timeline(id, since?)` → `ReviewTimeline`（MCP `get_review`、Studio `review_timeline`）：

- `sinceRevision` より後の `changes`（ジャーナルから ops を除いたもの）と `evidence`。既定の `since` は最後に承認されたリビジョン（なければ 0）なので、「まだレビューしていない分」がそのまま出る。
- `lastApproval`：最後の承認。`openFeedback`：最新のレビューが差し戻しなら、それ（承認されると消える）。
- MCP の `get_scenario` は `openFeedback` があるとき `feedback` として付ける。AI は読み直すたびに差し戻しに気づける。

Studio 用の Tauri コマンド：`review_timeline(id, since?)`、`submit_review(id, input: NewReview)`、`get_observation(id)`（ツリー本文と、スクリーンショットを data URL で返す）。型は `@shikigami/schema` の `ReviewTimeline` / `Evidence` / `NewReview` / `ObservationContent`。

## 規則

- `summary` は前後の空白を除き、2000 文字で切る。空なら記録しない。
- `observations` に存在しない ID があれば編集全体を `OBSERVATION_NOT_FOUND` で拒否する（何も変わらない）。紐づけは編集の確定後に行う。
- 差し戻し（`rejected`）には理由かステップへの指摘が 1 つ以上必要（`INVALID_EDIT`）。レビューは現在のリビジョンに対してだけ受け付ける（古ければ `REVISION_CONFLICT`）。指摘先のステップが無ければ `STEP_NOT_FOUND`。
- テスト実行の記録は MCP から始めた実行だけ（Studio・CLI の実行は従来どおり `runs/` のみ）。

## サイズとシークレット

- UI ツリーは 256 KB で切り、`notes` に残す。スクリーンショットは 2 MB を超えたら保存しない（ブラウザは JPEG 品質 70・表示範囲のみなので通常は数百 KB 以下）。
- どの編集にも使われなかった証跡は 3 日で削除する（次に証跡を保存するときに掃除）。紐づいた証跡は消さない。
- マスキング：
  - スクリーンショットは browser.screenshot と同じく、パスワード欄とシークレットを入力した欄を黒塗りする。
  - ツリー・タイトル・`test_step` の出力は、保存前に登録済みシークレットのパスワードと TOTP 鍵（4 文字以上）を `***` に置き換える（`Vault::mask`）。ブラウザのツリーはもともとアダプターが入力値を隠している。
  - スクリーンショットの画像は AI には返さない（Studio だけが見る）。

## やらないこと（今回）

- デスクトップアプリのスクリーンショット（UIA の部品ツリーのみ。Win32 の画面取得は Windows 実機で確かめてから追加する）。
- レビューの共有（共有ワークスペースで別の人のレビューを見る）。証跡と同じく PC ごと。
- Studio・CLI で始めた実行の証跡化。
