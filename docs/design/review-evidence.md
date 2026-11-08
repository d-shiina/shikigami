# AI の変更の証跡とレビュー（設計メモ）

目的：Studio の「レビュー台」で、AI が **何を・なぜ変え・どう確かめたか** を手順の横で確かめ、承認するか理由を付けて差し戻す。差し戻しの理由は AI が MCP で読み、そのまま直しに使う。

## 記録するもの

| 種類 | いつ記録されるか | 置き場所 |
|---|---|---|
| 変更の説明（`summary`）、人に確かめてほしいこと（`checks`）と触ったノード（`stepIds`） | 編集ツールの呼び出しごと | `history/<flow-id>/journal.jsonl`（従来のジャーナルに欄を追加） |
| テスト実行（`testRun`） | MCP の `run_flow` が終わったとき | `history/<flow-id>/evidence.jsonl` |
| 約束（`testCase`）とその結果（`testCases`） | MCP の `save_test_case` で保存したとき／`run_tests` が終わったとき | `history/<flow-id>/evidence.jsonl`（ケース本体はフローのフォルダーの `tests/`） |
| 画面の証跡（`observation`） | `inspect_page` / `inspect_ui`（ウィンドウ指定時）/ `test_step` のたびに保存し、編集が `observations` で名指ししたときにその版と手順に紐づける | 本体：`observations/<obs-id>/`（`observation.json`・`tree.txt`・`screenshot.jpg`）。紐づけ：`evidence.jsonl` |
| レビュー（`review`） | Studio で承認・差し戻ししたとき | `history/<flow-id>/evidence.jsonl` |

- すべて PC ごとの部分（[sharing-versioning.md](sharing-versioning.md)）に置く。ジャーナル・実行記録と同じ扱いで、共有ワークスペースでも同期されない。
- 各レコードは `revision`（どのリビジョンに対するものか）・`at`・`actor`（Studio / MCP クライアント名）を持つ。

## データ形式

ジャーナル（`HistoryEntry`）に追加した欄：

```json
{ "kind": "edit", "revision": 5, "actor": { "kind": "mcp", "name": "claude-code" }, "at": "…",
  "label": "add step browser.getTable",
  "summary": "受注一覧を読むようにする\n表の名前は『受注』だった",
  "checks": ["『受注』の表だけでよいですか？（『返品』の表は読んでいません）"],
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
  "linked": [{ "flowId": "scn_…", "revision": 5 }] }
```

## 読み出し

`review_timeline(id, since?)` → `ReviewTimeline`（MCP `get_review`、Studio `review_timeline`）：

- `sinceRevision` より後の `changes`（ジャーナルから ops を除いたもの）と `evidence`。既定の `since` は最後に承認されたリビジョン（なければ 0）なので、「まだレビューしていない分」がそのまま出る。
- `lastApproval`：最後の承認。`openFeedback`：最新のレビューが差し戻しなら、それ（承認されると消える）。
- MCP の `get_flow` は `openFeedback` があるとき `feedback` として付ける。AI は読み直すたびに差し戻しに気づける。

Studio 用の Tauri コマンド：`review_timeline(id, since?)`、`submit_review(id, input: NewReview)`、`get_observation(id)`（ツリー本文と、スクリーンショットを data URL で返す）。型は `@shikigami/schema` の `ReviewTimeline` / `Evidence` / `NewReview` / `ObservationContent`。

## 規則

- `summary` は前後の空白を除き、2000 文字で切る。空なら記録しない。
- `observations` に存在しない ID があれば編集全体を `OBSERVATION_NOT_FOUND` で拒否する（何も変わらない）。紐づけは編集の確定後に行う。
- 差し戻し（`rejected`）には理由かノードへの指摘が 1 つ以上必要（`INVALID_EDIT`）。レビューは現在のリビジョンに対してだけ受け付ける（古ければ `REVISION_CONFLICT`）。指摘先のノードが無ければ `STEP_NOT_FOUND`。
- テスト実行の記録は MCP から始めた実行だけ（Studio・CLI の実行は従来どおり `runs/` のみ）。

## サイズとシークレット

- UI ツリーは 256 KB で切り、`notes` に残す。スクリーンショットは 2 MB を超えたら保存しない（ブラウザは JPEG 品質 70・表示範囲のみなので通常は数百 KB 以下）。
- どの編集にも使われなかった証跡は 3 日で削除する（次に証跡を保存するときに掃除）。紐づいた証跡は消さない。
- マスキング：
  - スクリーンショットは browser.screenshot と同じく、パスワード欄とシークレットを入力した欄を黒塗りする。
  - ツリー・タイトル・`test_step` の出力は、保存前に登録済みシークレットのパスワードと TOTP 鍵（4 文字以上）を `***` に置き換える（`Vault::mask`）。ブラウザのツリーはもともとアダプターが入力値を隠している。
  - スクリーンショットの画像は AI には返さない（Studio だけが見る）。

## 確認のパネル（Studio）

2026-11-05 版（#69）は「何が変わったか」をノードの前後の文で見せていたが、業務の人はフローを頭の中で動かさないと判断できず、「どう確認していいか分からない」となった（2026-11-08）。人が判断できるのは「業務として正しい結果か」で、「毎回その結果になるか」は機械に確かめさせる、という役割分担に組み替えた（案 B「こうなれば正しい」）。

- AI は変更する振る舞いごとに、テストケースを 1 つ書く。`description` は業務の言葉の約束（「返品の行は合計に入れない」）、`inputs` は見本データ、`expect` は出てほしい値。書いたら `run_tests` で通るまで直す（MCP の説明と Studio の AI への指示に書いた）。ケースにできないこと（どの画面・どのボタンか、メールの文面）は従来どおり `checks`。
- MCP は保存を `testCase`（名前・`description`・置き換えたか）、実行を `testCases`（ケースごとの合否・runId・違い）として証跡に残す。AI はケースを編集の前に書くことが多く、その時点のリビジョンは承認済みのものなので、`review_timeline` は承認より後の時刻の `testCase`・`testCases` を承認済みリビジョンのものでも含める。

パネルは上から（`components/ReviewDesk.tsx`・`components/Promises.tsx`・`lib/promises.ts`）：

| 節 | 何を見せるか | 元のデータ |
| --- | --- | --- |
| 見出し | 何のための変更か。いちばん古い未確認の編集の `summary` の 1 行目 | ジャーナル |
| 1 こうなれば正しい | 今回 AI が書いた約束を先に、カードごとに約束の文・入力・結果（期待する値）・守れているか（✓ 守れています／× 守れていません＋違うところ／まだ確かめていません、誰が確かめたか、前の内容で確かめた結果なら橙で添える）。各カードに「この約束で合っていますか？ 合っている／違う…」。「違う…」は約束を引用した差し戻しのフォームを開く。前からの約束は件数（守れていない数）だけ出して畳む。「実行して確認」は約束を作業中の内容で全部流す（テストの「すべて実行」と同じ。ブラウザ・アプリは実際に動く）。約束が 1 つもなければ、AI に約束を書いてもらう依頼文を入れた差し戻しのフォームを開ける | `tests/`（`list_test_cases`）、証跡の `testCase`・`testCases`、この画面で流した結果 |
| 2 あなたにしか分からないこと | AI の `checks`。「問題なし／問題あり…」 | ジャーナル |
| 3 外への影響 | 新しく・変わって・なくなる外への影響を上に、危険度 `dangerous` は朱、変わらないものは畳む | `lib/effects.ts` |
| 詳しく見る | ノードごとの前後の文の比較（見たカードを数える）、そのほかの変更、AI の試し実行（`run_flow`）と見た画面。今回の約束があるときは畳み、ないときは開いておく | ops と inverse、`testRun`・`observation` |

「確認して公開」の「（未確認 n）」は、答えていない約束と `checks` の数。守れていない約束があるときは、ボタンの上に朱で知らせる（押せなくはしない）。約束への答えは `checks` と同じく、この画面の間だけ覚える。

下端のボタンと意味：

- **確認して公開**：見たことを Core に記録し（`submit_review` approved）、その内容を公開版にする（[policy.md](../policy.md)）。AI の編集は作業中の内容に入った時点で、Studio の実行と AI の試し実行ではもう動く。無人実行（`shikigami run`・スケジュール）は公開版だけを動かすので、ここで公開するまで変わらない。ボタンの下に、いま無人実行で動く版を出す。未回答の確かめがあれば「（未確認 n）」と添えるが、押せなくはしない。
- **差し戻す…**：理由とノードへの指摘を AI に送る。変更は直るまで残る。
- **変更を取り消す**：AI が変える前の内容に戻す（新しい編集として記録）。

ボタンにポインターを乗せると、その意味の一文を上に出す。「本番」という言葉は使わない（作業中と公開版で呼ぶ）。

`checks` の決まり：前後の空白を除き、空と重複を捨て、1 問 500 文字・1 編集 10 問まで。

## やらないこと（今回）

- デスクトップアプリのスクリーンショット（UIA の部品ツリーのみ。Win32 の画面取得は Windows 実機で確かめてから追加する）。
- レビューの共有（共有ワークスペースで別の人のレビューを見る）。証跡と同じく PC ごと。
- Studio・CLI で始めた実行の証跡化。
