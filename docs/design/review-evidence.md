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

Studio 用の Tauri コマンド：`review_timeline(id, since?)`、`submit_review(id, input: NewReview)`、`get_observation(id)`（ツリー本文と、スクリーンショットを data URL で返す）。型は `@spellsheet/schema` の `ReviewTimeline` / `Evidence` / `NewReview` / `ObservationContent`。

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

## 確認の画面（Studio）

2026-11-09：画面の言葉を「約束→期待する結果」「守れています→期待どおり」「外への影響→このフローが変えるもの」に変えた（Daiki「よくわからん」）。テストの欄の「期待どおり／期待と違う」とそろえる。設計の文では「約束」を AI が書くテストケースの意味で残している。

2026-11-05 版（#69）は「何が変わったか」をノードの前後の文で見せていたが、業務の人はフローを頭の中で動かさないと判断できず、「どう確認していいか分からない」となった（2026-11-08）。人が判断できるのは「業務として正しい結果か」で、「毎回その結果になるか」は機械に確かめさせる、という役割分担に組み替えた（案 B「こうなれば正しい」）。

- AI は変更する振る舞いごとに、テストケースを 1 つ書く。`description` は業務の言葉の約束（「返品の行は合計に入れない」）、`inputs` は見本データ、`expect` は出てほしい値。書いたら `run_tests` で通るまで直す（MCP の説明と Studio の AI への指示に書いた）。ケースにできないこと（どの画面・どのボタンか、メールの文面）は従来どおり `checks`。
- MCP は保存を `testCase`（名前・`description`・置き換えたか）、実行を `testCases`（ケースごとの合否・runId・違い）として証跡に残す。AI はケースを編集の前に書くことが多く、その時点のリビジョンは承認済みのものなので、`review_timeline` は承認より後の時刻の `testCase`・`testCases` を承認済みリビジョンのものでも含める。

### 紙のレポート（2026-11-08）

右の欄（420px）に収まる量ではなかった（Daiki）ので、確認待ちでフローを開くと、手順書と同じ「机の上の白い紙 1 枚」のレポートが作業面いっぱいに出る形にした。比べた案：右の欄を 640px に広げる（図が狭くなり、約束はカードのまま見比べられない）、紙とフロー図を左右に並べる（両方とも窮屈）。試作画像は Project files の `spellsheet/review-paper/`。

- タイトルバーの表示切り替えに、確認待ちのときだけ「確認」が先頭に付く（`lib/reviewView.ts`、エディターで覚えている表示とは別）。一覧からフローを開くと必ず「確認」から始まる。「フロー図」「手順書」「変数」に切り替えても、下に判断の帯（守れていない約束・未確認の数、「確認に戻る」、取り消す・差し戻す・変更を承諾）が残る。図ではノードを選ぶと右の欄が開く（エディターと同じ）。
- 小さな変更も同じ紙で出す（中身が少なく短くなるだけ）。出し方が 2 通りあると迷うため。
- AI の作業が終わっても自動では開かない（組み上がる様子を見ている途中で画面が変わるため）。AI 欄の最後に「変更の確認ができます」と「確認のレポートを開く」を出す。

紙は上から（`components/ReviewDesk.tsx`・`components/ReviewResult.tsx`・`components/Masthead.tsx`・`lib/reviewFiles.ts`）。フローを読まない人が、実物で判断できる順に並べる：

| 節 | 何を見せるか | 元のデータ |
| --- | --- | --- |
| 紙の頭 | 手順書と同じ形（上端に 4 色の細い帯、「AI の変更の確認」、題＝フロー名＋「新規作成／変更」の札、紺の線、AI・日時・内容・試し実行） | ジャーナル、証跡 |
| AI からの説明 | 未確認の編集の `summary` を引用として。AI には「〜を作成しました」の調子で書かせる | ジャーナル |
| 実行結果 | AI の最後の試し実行（`run_flow`）が出したもの：出力ファイルのいまの中身（シートはタブ、「アプリで開く」）、出力項目の値、たたんだ「元のデータ」（入力ファイル・入力フォルダーの中身）、自動チェック（AI が書いたテストケースが期待どおりかの札。「詳細」で表と「実行して確認」）、最後に「この結果で合っていますか」（合っている／違う…）。試し実行が無ければ AI に依頼できる | `testRun`、`run_record`、`preview_file`、`tests/` |
| AI の判断 | AI の `checks`。指示になかったので AI が決めたこと。1 行目が決めた内容、2 行目以降が「今回の例」。右に「はい／いいえ…」 | ジャーナル |
| 使用するファイルとシステム | 種類（入力フォルダー・入力ファイル・出力フォルダー・出力ファイル・Web サイト・外部サービス・その他）、対象、実行のたびに（読み取りのみ／ノードの名前。危険度 `dangerous` は朱）。変更のときは追加・変更・削除の札 | `lib/effects.ts` → `lib/reviewFiles.ts` |
| 変更箇所 | 既存フローの変更のときだけ。ノードごとに前と後の文を左右に並べ、違う語に印 | ops と inverse |
| フローの内容 | たたんである。入力・出力と、番号付きのノード一覧 | フロー |
| AI の試し実行 | たたんである。実行の一覧、ログ、見た画面 | `testRun`・`observation` |

試し実行も `checks` もない小さな変更では、「変更箇所」を先頭の節にする。

答えるのは「実行結果が合っているか」1 件と、AI の判断 1 件ずつ。紙の下（机の下端）に判断のボタンと、答えた数（n 件のうち m 件に回答）をいつも出す。「変更を承諾」の「（未確認 n）」は答えていない数。期待と違う自動チェックがあるときは、左に朱で知らせる（押せなくはしない）。答えはこの画面の間だけ覚える。

結果の値が入力のどの行からできたかを線で結ぶ表示（元のデータとの照合）は、実行時に行の対応を記録していないのでまだ無い。AI に書かせると証拠にならないので、入れるなら Runtime が記録する形にする。

ボタンと意味：

- **変更を承諾**：見たことを Core に記録し（`submit_review` approved）、その内容を確定版にする（[policy.md](../policy.md)）。AI の編集は作業中の内容に入った時点で、Studio の実行と AI の試し実行ではもう動く。無人実行（`spellsheet run`・スケジュール）は確定版だけを動かすので、ここで確定するまで変わらない。ボタンの左に、いま無人実行で動く版を出す。未回答の確かめがあれば「（未確認 n）」と添えるが、押せなくはしない。
- **差し戻す…**：理由とノードへの指摘を AI に送る。変更は直るまで残る。
- **変更を取り消す**：AI が変える前の内容に戻す（新しい編集として記録）。

ボタンにポインターを乗せると、その意味の一文を左に出す。「本番」という言葉は使わない（作業中と確定版で呼ぶ）。

`checks` の決まり：前後の空白を除き、空と重複を捨て、1 問 500 文字・1 編集 10 問まで。

## やらないこと（今回）

- デスクトップアプリのスクリーンショット（UIA の部品ツリーのみ。Win32 の画面取得は Windows 実機で確かめてから追加する）。
- レビューの共有（共有ワークスペースで別の人のレビューを見る）。証跡と同じく PC ごと。
- Studio・CLI で始めた実行の証跡化。
