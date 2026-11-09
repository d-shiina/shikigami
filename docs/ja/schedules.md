# スケジュールと Worker

[English](../schedules.md) | 日本語

SpellSheet は、決まった時刻やきっかけでフローを自分で始めます。毎朝 8 時、毎月 25 日、勤務時間中の 30 分ごと、フォルダーにファイルが置かれたとき。Windows のタスク スケジューラーを設定する必要はありません。

## Worker

**Worker**は PC ごと（Windows のユーザーとワークスペースごと）に 1 つ動くプロセスで、スケジュールの時刻が来たら実行します。Writer も AI も要りません。

Writer では左の「自動実行」で、Worker が実行中か・実行中のフローを確認でき、「自動実行を開始」で起動できます（`worker install` と同じく、サインインのたびに起動するよう登録します）。スケジュールの追加・編集・有効と無効の切り替えも同じ画面です。フローのインスペクターの「スケジュール」には、そのフローのスケジュールが出ます。

```powershell
spellsheet worker install     # Windows にサインインするたびに起動する（今も起動する）
spellsheet worker status      # 動いているか、何を実行中か、次はいつか
spellsheet worker stop
spellsheet worker run         # このウィンドウで動かす（Ctrl+C で止める）
spellsheet worker uninstall
```

`worker install` は自分のユーザーのタスク スケジューラーに `SpellSheet\Worker`（ログオン時）を登録します。Worker はサインイン中のデスクトップで動くので、マウスとキーボードを使えます。同じワークスペースの Worker は 2 つ目を起動できません。

- Worker が始める実行は**無人実行**です。`spellsheet run <id>` と同じく公開版を動かし、`policy.json` の `flows.<id>.unattended: false` なら動かしません。公開していないフローは `NOT_PUBLISHED` で失敗します。
- ほかの実行と同じく記録に残り、`origin.trigger` は `"schedule"`、`origin.requestedBy` はスケジュールの名前、`origin.jobId` はその ID です。
- マウスとキーボードは Writer・CLI・MCP サーバーと共有し、使うノードはプロセスをまたいで順番に動きます。画面ロック中は `DESKTOP_UNAVAILABLE` で止まります（ブラウザやファイルの処理は動きます）。これらのノードがあるフローの実行中は、画面が消えたりスリープしたりしないようにします。ロックは止めません（パスワード付きのスクリーンセーバー、ポリシーで決まった時間でのロック、Win+L では止まります）。デスクトップのフローの予定の時刻には、PC をサインインしたまま・ロックしないで置いてください。Writer の「自動実行」では、マウス・キーボードを使うフローの予定に、この PC が操作のないまま何分でロックされるかを出します。
- ほかのプロセスとは、自分のユーザーだけが書き込める名前付きパイプ（`\\.\pipe\spellsheet-agent-…`）でやり取りします。

### 画面のロックとリモートデスクトップ

マウス・キーボードを使うノードは、画面がロックされていると動けません（Windows がロック中の画面への入力を許さないため）。ロックしないように置けない PC では、次のようにします（考え方は [design/locked-runs.md](../design/locked-runs.md)）。

- `spellsheet session status`：いま画面が使えるか、リモートデスクトップか、操作がないと何分でロックされるか。
- **リモートデスクトップで見に行く VM・PC**：窓を閉じて切断するとロックされます。かわりに Writer の「自動実行」の「画面を残して切断」か、`spellsheet session release` で切断すると、ロックしないまま切断でき、デスクトップのフローが動き続けます（`tscon` を使い、管理者の確認が出ることがあります）。PC にモニターがつながっていれば、前にいる人に画面が見えます。
- **リモートデスクトップの窓を最小化すると描画が止まる**：つなぎに行く側の PC で、`reg add "HKCU\Software\Microsoft\Terminal Server Client" /v RemoteDesktop_SuppressWhenMinimized /t REG_DWORD /d 2 /f` を一度実行すると、最小化しても止まりません。

## スケジュール

スケジュールは、それを動かす PC のものです（ワークスペースの PC ごとの領域、実行記録の隣の `schedules.json`）。共有フォルダーのワークスペースを複数の PC で使っても、スケジュールを作った PC だけが動かします。

```powershell
spellsheet schedule add scn_01a1… --name "毎朝の受注取り込み" --daily 08:00 --days mon,tue,wed,thu,fri
spellsheet schedule add scn_01a1… --monthly 25@09:00          # -1@18:00 で月末
spellsheet schedule add scn_01a1… --monthly 25@09:00 --on-holiday before   # 休日なら前の営業日
spellsheet schedule add scn_01a1… --monthly 3@09:00 --business-day        # 第 3 営業日（-1 で最終営業日）
spellsheet schedule add scn_01a1… --daily 08:00 --days mon,tue,wed,thu,fri --skip-holidays
spellsheet schedule add scn_01a1… --every 30 --from 09:00 --to 18:00
spellsheet schedule add scn_01a1… --once 2026-11-07T08:00
spellsheet schedule add scn_01a1… --file-added input --pattern "*.xlsx" --file-input file
spellsheet schedule add scn_01a1… --mail-received 受信トレイ --subject-contains 請求書 --mail-input mail
spellsheet schedule list
spellsheet schedule disable sch_…   # enable / remove
```

`-i 名前=値` で入力変数を渡せます（`spellsheet run` と同じ）。

| `when.kind` | 項目 | 動くとき |
|---|---|---|
| `daily` | `at`（"08:00"）、`days`（任意："mon" … "sun" か 月 … 日）、`skipHolidays`（任意） | 毎日（またはその曜日）のその時刻 |
| `monthly` | `day`（1〜31、-1 は月末）、`at`、`businessDay`（任意）、`onHoliday`（任意） | 毎月。その月にない日（6 月の 31 日）は月末 |
| `every` | `minutes`、`from` / `to`（任意）、`days`（任意）、`skipHolidays`（任意） | `from`、`from` + `minutes`、… `to` まで（なければ一日中） |
| `once` | `at`（"2026-11-07T08:00"） | 1 回だけ |
| `fileAdded` | `folder`（フローのフォルダーからの相対パスか絶対パス）、`pattern`（"*.xlsx"）、`input`（任意） | 名前が合う新しいファイル 1 つにつき 1 回。大きさが変わらなくなってから始め、そのフルパスを入力変数 `input` に入れる。Worker の起動時からあるファイル、Office のロックファイル（`~$…`）、ダウンロード途中のファイルは数えない |
| `mailReceived` | `folder`（任意、既定は受信トレイ）、`subjectContains`・`fromContains`（任意）、`minutes`（確認の間隔、既定 5）、`via`・`account`（任意、`mail.list` と同じ）、`input`（任意） | 条件に合う新しいメール 1 通につき 1 回。そのメール（`{ id, subject, from, fromAddress, receivedAt, attachments }`）を入力変数 `input` に入れる。Worker の起動時からあるメールは数えない |

### メールが届いたら

`mailReceived` は `minutes` 分ごとに `mail.list` でフォルダーを見て、前に見たときになかったメールでフローを始めます。この PC の Outlook（クラシック版）を使うので、Outlook を起動してサインインしておきます。Outlook のない PC や業務用のメールボックスは `via: "microsoft365"` と `account`（[office.md](office.md) の「Outlook なしで Microsoft 365 のメールボックスを扱う」）で見ます。

- 入力変数に入ったメールの `id` で、フローの中で添付の保存（`mail.saveAttachments`）・移動（`mail.move`）・返信（`mail.reply`）ができます。処理したメールは移動するか既読にしておくと、受信トレイで見分けやすくなります
- 見られなかったとき（Outlook が起動していない、サインインが切れた）は `worker status` のそのスケジュールに理由を出し、次の確認でまた見ます
- Worker が止まっている間に届いたメールは、次に起動したときの「起動時からあるメール」になり、数えません

```json
{ "kind": "mailReceived", "folder": "受信トレイ", "subjectContains": "請求書", "minutes": 5, "input": "mail" }
```

### 祝日と営業日

- `skipHolidays: true`（`daily`・`every`）：日本の祝日（振替休日・国民の休日を含む）と会社の休日には動きません。会社の出勤日は、`days` にない曜日（土曜など）でも動きます
- `businessDay: true`（`monthly`）：`day` を営業日で数えます。`3` は第 3 営業日、`-1` は最終営業日（`-2` はその前）。営業日は、土日・祝日・会社の休日でない日と、会社の出勤日です
- `onHoliday`（`monthly`、暦日のとき）：その日が営業日でなければ、`before` は前の営業日、`after` は次の営業日、`skip` はその月は動きません。25 日の支払いを休日なら前の営業日に、といった使い方です

会社の休日と出勤日は、ワークスペースの `holidays.json` に書きます（共有フォルダーのワークスペースなら全部の PC で同じになります）。

```json
{
  "formatVersion": 1,
  "holidays": ["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-02", "2027-01-03"],
  "workdays": ["2026-11-28"]
}
```

日本の祝日は SpellSheet に入っています（2020 年以降の法律の決まり。春分・秋分の日は計算で出します）。読めない `holidays.json` は推測で読まず、直るまでどのスケジュールも動きません（`HOLIDAYS_INVALID`）。

時刻は PC の時刻です。ファイルが変わると Worker が読み直します。壊れたファイルは推測で読まず、`worker status` に問題を出し、直るまでどのスケジュールも動きません（`SCHEDULE_INVALID`）。

- **逃した時刻は取り戻しません。** Worker が止まっている間（PC の電源が切れていた、誰もサインインしていなかった）に過ぎた時刻は飛ばし、次の時刻に動きます。
- **同時には 1 つ。** 前の実行がまだ続いているうちに次の時刻が来たら、その回は飛ばします。ファイルのきっかけは、ファイル 1 つにつき 1 回動きます。
- 始められなかったスケジュール（公開していない、ポリシーで止められた）は、通知では失敗した実行として扱います。

## 通知

`policy.json` の `notify` で、無人実行の終わりを知らせます。対象は Worker が始める実行と `spellsheet run`（タスク スケジューラー・バッチファイル）です。Writer の実行と AI の試し実行は人が見ているので知らせません。フローの `catch` でメールを送る必要はありません。

```json
"notify": [
  { "webhook": "https://….logic.azure.com/workflows/…", "format": "teams" },
  { "webhook": "https://hooks.slack.com/services/…", "format": "slack", "on": ["failed", "succeeded"], "flows": ["scn_01a1…"] }
]
```

| 項目 | 既定 | 意味 |
|---|---|---|
| `webhook` | （必須） | 送り先。`https://`（`http://` は `localhost` だけ）。URL を知っていれば誰でも投稿できるので、パスワードと同じように扱う |
| `on` | `["failed"]` | どの終わり方を知らせるか：`failed`・`succeeded`・`cancelled`。`waiting` を入れると、ブラウザでのサインインやダイアログなど**人の操作を待ち始めたとき**にも知らせる（待つたびに 1 回。時間切れで止まれば `failed` として知らせる） |
| `format` | `teams` | `teams`：Teams の「ワークフロー」の Webhook 向けのカード（Power Automate の「HTTP 要求の受信時」でも受けられ、メールにもできる）。`slack`：Slack などの `{ "text": … }`。`json`：自社のシステム向けの実行の要約 |
| `flows` | すべて | このフロー ID だけ |

知らせる内容は、フロー、エラー（コード・メッセージ・ノード）、きっかけ（スケジュールの名前）、PC、時刻、版、実行 ID です。出力の値は送りません。始められなかったスケジュール（公開していない、ポリシーで止められた）は失敗として知らせます。送れなかった通知はログに残すだけで、実行の結果は変わりません。
