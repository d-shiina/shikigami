# スケジュールとエージェント

[English](../schedules.md) | 日本語

Shikigami は、決まった時刻やきっかけでフローを自分で始めます。毎朝 8 時、毎月 25 日、勤務時間中の 30 分ごと、フォルダーにファイルが置かれたとき。Windows のタスク スケジューラーを設定する必要はありません。

## エージェント

**エージェント**は PC ごと（Windows のユーザーとワークスペースごと）に 1 つ動くプロセスで、スケジュールの時刻が来たら実行します。Studio も AI も要りません。

```powershell
shikigami agent install     # Windows にサインインするたびに起動する（今も起動する）
shikigami agent status      # 動いているか、何を実行中か、次はいつか
shikigami agent stop
shikigami agent run         # このウィンドウで動かす（Ctrl+C で止める）
shikigami agent uninstall
```

`agent install` は自分のユーザーのタスク スケジューラーに `Shikigami\Agent`（ログオン時）を登録します。エージェントはサインイン中のデスクトップで動くので、マウスとキーボードを使えます。同じワークスペースのエージェントは 2 つ目を起動できません。

- エージェントが始める実行は**無人実行**です。`shikigami run <id>` と同じく公開版を動かし、`policy.json` の `flows.<id>.unattended: false` なら動かしません。公開していないフローは `NOT_PUBLISHED` で失敗します。
- ほかの実行と同じく記録に残り、`origin.trigger` は `"schedule"`、`origin.requestedBy` はスケジュールの名前、`origin.jobId` はその ID です。
- マウスとキーボードは Studio・CLI・MCP サーバーと共有し、使うノードはプロセスをまたいで順番に動きます。画面ロック中は `DESKTOP_UNAVAILABLE` で止まります（ブラウザやファイルの処理は動きます）。デスクトップのフローは、PC をサインインしたまま・ロックしないで動かしてください。
- ほかのプロセスとは、自分のユーザーだけが書き込める名前付きパイプ（`\\.\pipe\shikigami-agent-…`）でやり取りします。

## スケジュール

スケジュールは、それを動かす PC のものです（ワークスペースの PC ごとの領域、実行記録の隣の `schedules.json`）。共有フォルダーのワークスペースを複数の PC で使っても、スケジュールを作った PC だけが動かします。

```powershell
shikigami schedule add scn_01a1… --name "毎朝の受注取り込み" --daily 08:00 --days mon,tue,wed,thu,fri
shikigami schedule add scn_01a1… --monthly 25@09:00          # -1@18:00 で月末
shikigami schedule add scn_01a1… --every 30 --from 09:00 --to 18:00
shikigami schedule add scn_01a1… --once 2026-11-07T08:00
shikigami schedule add scn_01a1… --file-added input --pattern "*.xlsx" --file-input file
shikigami schedule list
shikigami schedule disable sch_…   # enable / remove
```

`-i 名前=値` で入力変数を渡せます（`shikigami run` と同じ）。

| `when.kind` | 項目 | 動くとき |
|---|---|---|
| `daily` | `at`（"08:00"）、`days`（任意："mon" … "sun" か 月 … 日） | 毎日（またはその曜日）のその時刻 |
| `monthly` | `day`（1〜31、-1 は月末）、`at` | 毎月。その月にない日（6 月の 31 日）は月末 |
| `every` | `minutes`、`from` / `to`（任意）、`days`（任意） | `from`、`from` + `minutes`、… `to` まで（なければ一日中） |
| `once` | `at`（"2026-11-07T08:00"） | 1 回だけ |
| `fileAdded` | `folder`（フローのフォルダーからの相対パスか絶対パス）、`pattern`（"*.xlsx"）、`input`（任意） | 名前が合う新しいファイル 1 つにつき 1 回。大きさが変わらなくなってから始め、そのフルパスを入力変数 `input` に入れる。エージェントの起動時からあるファイル、Office のロックファイル（`~$…`）、ダウンロード途中のファイルは数えない |

時刻は PC の時刻です。ファイルが変わるとエージェントが読み直します。壊れたファイルは推測で読まず、`agent status` に問題を出し、直るまでどのスケジュールも動きません（`SCHEDULE_INVALID`）。

- **逃した時刻は取り戻しません。** エージェントが止まっている間（PC の電源が切れていた、誰もサインインしていなかった）に過ぎた時刻は飛ばし、次の時刻に動きます。
- **同時には 1 つ。** 前の実行がまだ続いているうちに次の時刻が来たら、その回は飛ばします。ファイルのきっかけは、ファイル 1 つにつき 1 回動きます。
- 始められなかったスケジュール（公開していない、ポリシーで止められた）は、通知では失敗した実行として扱います。

## 通知

`policy.json` の `notify` で、無人実行の終わりを知らせます。対象はエージェントが始める実行と `shikigami run`（タスク スケジューラー・バッチファイル）です。Studio の実行と AI の試し実行は人が見ているので知らせません。フローの `catch` でメールを送る必要はありません。

```json
"notify": [
  { "webhook": "https://….logic.azure.com/workflows/…", "format": "teams" },
  { "webhook": "https://hooks.slack.com/services/…", "format": "slack", "on": ["failed", "succeeded"], "flows": ["scn_01a1…"] }
]
```

| 項目 | 既定 | 意味 |
|---|---|---|
| `webhook` | （必須） | 送り先。`https://`（`http://` は `localhost` だけ）。URL を知っていれば誰でも投稿できるので、パスワードと同じように扱う |
| `on` | `["failed"]` | どの終わり方を知らせるか：`failed`・`succeeded`・`cancelled` |
| `format` | `teams` | `teams`：Teams の「ワークフロー」の Webhook 向けのカード（Power Automate の「HTTP 要求の受信時」でも受けられ、メールにもできる）。`slack`：Slack などの `{ "text": … }`。`json`：自社のシステム向けの実行の要約 |
| `flows` | すべて | このフロー ID だけ |

知らせる内容は、フロー、エラー（コード・メッセージ・ノード）、きっかけ（スケジュールの名前）、PC、時刻、版、実行 ID です。出力の値は送りません。始められなかったスケジュール（公開していない、ポリシーで止められた）は失敗として知らせます。送れなかった通知はログに残すだけで、実行の結果は変わりません。
