# 確定版と許可・承認

[English](../policy.md) | 日本語

「AI が作り、AI なしで動く」を安心して使うための 2 つの決まりです。

1. **無人実行は、人が承認して確定した版だけを動かす。** AI が夜に編集した内容が、翌朝のスケジュール実行でそのまま本番システムを操作することはありません。
2. **フローが触れてよい先と、AI が人の承認なしにしてよいことを、ワークスペースの設定（`policy.json`）で決める。** 検査は Runtime と Core が一律に行うので、Writer・CLI・AI（MCP）のどこから動かしても同じ結果になります。

## 1. 確定版

### 何が動くか

| 動かし方 | 動く内容 |
|---|---|
| `spellsheet run <id>`（タスクスケジューラー・バッチなどの無人実行） | **確定版**。呼び出すサブフローも、それぞれの確定版 |
| `spellsheet run <id> --draft` | 作業中の内容（明示したときだけ） |
| `spellsheet run <file>` | ファイルに書かれた内容（バンドルを含む） |
| Writer の「実行」 | 作業中の内容（目の前で試す） |
| MCP `run_flow` | 作業中の内容（AI の試し実行）。`published: true` で確定版 |
| MCP `test_step` | その 1 ステップだけ |

確定版がないフローを `spellsheet run <id>` すると `NOT_PUBLISHED`、呼び出し先に確定版がないと `SUBFLOW_NOT_PUBLISHED` で止まります。作業中の内容に黙って切り替えることはありません。実行レポートの `version` に動いた版の番号が残ります。

### 確定のしかた

- **Writer のレビュー台**：AI の変更を見て「✓ 変更を承諾」。承認（レビューの記録）と確定を 1 回の操作で行います。現在の内容と同じ版がなければ版を作ってから確定します。
- **Writer の「版」タブ**：「現在の内容を確定」、または過去の版の「この版を確定」（前の版に戻すときも、作業中の内容を変えずに確定版だけを戻せます）。「確定を取り消す」で無人実行を止めます。
- **CLI**：`spellsheet version publish <id> [番号] [--name 名前] [--note メモ]`、`spellsheet version unpublish <id>`。`spellsheet version list <id>` は確定版に `published` を付けます。

確定できるのは人だけです（Writer・CLI）。AI クライアントが Core の確定を呼ぶと `PUBLISH_NOT_ALLOWED` になり、MCP には確定するツール自体がありません。AI は「レビュー台で変更を承諾してください」と人に頼みます。

確定の前に、その版が検証を通ること・呼び出すフローがすべて確定済みであることを確かめます（呼ばれる側から順に確定します）。

### 記録

確定の記録は `versions/<flow-id>/publish.jsonl` に追記します（ワークスペースの共有部分なので、同じワークスペースを使う全員が同じ確定版を見ます）。1 行が 1 回の確定・確定の取り消しで、最後の行が今の状態です。

```json
{"version":3,"uid":"019a…","at":"2026-10-28T09:12:00Z","by":{"kind":"studio"},"note":"初回"}
{"version":null,"at":"2026-10-29T08:00:00Z","by":{"kind":"cli"},"note":"止める"}
```

版そのものは今までどおり不変です。フローをゴミ箱に移すと確定も取り消されます。

## 2. `policy.json`

ワークスペースのフォルダ直下に置きます（共有部分）。ファイルがなければ下の既定値です。Writer の設定「実行の許可」で編集できます。CLI は `spellsheet policy show`（今効いている内容）、`spellsheet policy check`（書き間違いの確認）、`spellsheet policy init`（既定値で作る）。

```json
{
  "formatVersion": 1,
  "sites": ["https://order.example.co.jp", "https://*.corp.example"],
  "apps": ["C:\\Program Files\\Billing\\billing.exe", "notepad.exe"],
  "ai": {
    "runFlow": { "safe": "allow", "interactive": "allow", "dangerous": "ask" },
    "testStep": { "safe": "allow", "interactive": "allow", "dangerous": "ask" },
    "deleteFlow": "ask"
  },
  "flows": {
    "scn_01a1…": { "aiRun": "deny", "unattended": false }
  }
}
```

| 項目 | 既定 | 意味 |
|---|---|---|
| `sites` | 空（どこでも） | `browser.open`・`oauth.signIn`（`authorizeUrl` と `tokenUrl`）・`http.request`（と、`targets` で宣言したプラグインのステップ）が開いてよいサイト。オリジン（`https://example.com`、ポート付きも可）か、サブドメインすべての `https://*.example.com`。http と https は別。`about:blank` はいつでも可、`file:` などは不可 |
| `apps` | 空（どれでも） | `desktop.launch`・`process.run` が起動してよい、`process.kill` が終了させてよいプログラム。フォルダ付きならそのパスだけ、ファイル名だけならどのフォルダでも。大文字小文字・`/` と `\`・`.exe` の有無は区別しない |
| `ai.runFlow` | safe/interactive は allow、dangerous は ask | AI の `run_flow`。実行しうるステップ（呼び出し先を含む）のいちばん高い危険度で決まる |
| `ai.testStep` | 同上 | AI の `test_step`。ブロックの中のステップと、`flow.call` の呼び出し先を含めたいちばん高い危険度 |
| `ai.deleteFlow` | ask | AI の `delete_flow` |
| `flows.<id>.aiRun` | なし | このフロー（と、これを呼ぶ実行・試行）だけ厳しくする。全体の規則より緩くはならない |
| `flows.<id>.unattended` | true | false なら `spellsheet run` で動かさない。これを呼ぶフローも動かさない（`UNATTENDED_NOT_ALLOWED`）。Writer からは動かせる |
| `records.keepDays` | 90 | 各 PC が、この日数より古い実行記録（`runs/<run-id>/`）、各フローの `logs/` の実行ログと失敗時の画面、MCP の呼び出し（`audit/mcp.jsonl`）を消す（[audit.md](audit.md)）。実行が終わったときに適用し、実行中のものは消さない。`0` にするとずっと残す |
| `records.keepRuns` | なし（残す） | 各 PC が残す実行記録の数（新しいものから） |
| `records.failureScreenshots` | `true` | フロー全体の実行がブラウザ・デスクトップのノードで失敗したとき、そのページ・ウィンドウの画面をフローのフォルダーの実行ログの隣に保存する（`logs/<時刻>_failed.png`、ログと一緒に消える）。エラーの `details.screenshot` にその場所が入る。画面に個人情報が出るなどで残したくないときは `false` |
| `remote.enabled` | false | 管理サーバーからジョブを受けるか（[remote.md](remote.md)）。PC の登録（`spellsheet worker enroll`）も要る |
| `remote.manager` | なし | 管理サーバーの URL。`https://`（`http://` は `localhost` だけ） |
| `remote.flows` | 空（なし） | 管理サーバーが始めてよいフローの ID。`"*"` ですべて。`flows.<id>.unattended: false` のものはここで許しても動かない |
| `remote.acceptBundles` | false | このワークスペースの確定版だけでなく、管理サーバーがバンドルで送るフローも動かすか。枠の予約で、バンドルを送ることはまだできない |
| `notify` | 空 | 無人実行（Worker のスケジュールと `spellsheet run`）の終わりを知らせる先：`{ "webhook", "on", "format", "flows" }` の並び。[schedules.md](schedules.md#通知) |
| `desktop.waitUnlockedMinutes` | なし（すぐ止まる） | 画面ロック中、マウス・キーボードを使うノードは、だれかがロックを解くまでこの分数まで待ち、それでも解かれなければ `DESKTOP_UNAVAILABLE` で止まります。待ち始めたことを実行のログに一度書きます。人のいる PC 向けです（[schedules.md](schedules.md)） |

`allow`＝承認なしで許可、`ask`＝承認が必要（人が Writer で承認してから実行）、`deny`＝禁止。危険度はステップ型の `risk`（`safe`：変数・ログ・制御、`interactive`：画面の操作、`dangerous`：ファイルの削除・移動、外部への HTTP、プログラムの実行など）。登録されていないステップ型は `dangerous` 扱いです。

壊れた `policy.json`（JSON の誤り、知らない項目、オリジンでない `sites`）は「全部許可」にはせず、実行を `POLICY_INVALID` で止めます。設定は実行の開始時に読むので、変更は次の実行から効きます。

### サイト・アプリの検査

Runtime が、テンプレートを展開した後の params をステップの実行直前に調べます。許可されていなければそのステップは動かず `SITE_NOT_ALLOWED` / `APP_NOT_ALLOWED`（`details.allowed` に許可リスト）で失敗します。入力変数や前のステップの結果から URL を組み立てても、許可リストの外には出られません。MCP の `inspect_page` に渡した `url` も同じリストで調べます。

`sites` を書いているあいだ、`http.request` は送った先と同じオリジンの中だけリダイレクトをたどります。ほかのオリジンへのリダイレクトは 3xx の応答として返ります。

制約：ブラウザのページの中でリンクをクリックした先や、リダイレクト先は調べていません（ステップが指定した行き先だけを見ます）。

## 3. AI の操作の承認

`ask` の操作を AI が呼ぶと、MCP サーバーは実行せずに承認の依頼を作り、`APPROVAL_REQUIRED`（`details.approvalId`）を返します。

1. Writer の上部に「✋ AI が承認を求めています：ステップを 1 つ試す（file.delete・危険な操作）」が出ます。「内容」で実際に動く内容（ステップ・入力・リビジョン。シークレットの値は伏せ字）、AI の理由（`approvalReason`）を見て「許可する」か「断る」。CLI でも `spellsheet approval list` / `approve <id>` / `deny <id>`。
2. AI は同じ呼び出しに `approvalId` を付けて呼び直します（`approvalWaitMs` で答えを待てます。最初の呼び出しに付けてもよい）。
3. 許可した内容とまったく同じ操作が **1 回だけ** 動きます。内容が違えば（呼び出し先のフローが後から変わった場合も）`APPROVAL_MISMATCH`、使用済みは `APPROVAL_USED`、断られたら `APPROVAL_DENIED`、`deny` の操作は `POLICY_DENIED`。

依頼は 30 分、許可は 10 分で失効します。依頼は PC ごとの領域（`approvals/`、MCP の監査ログの隣）に置きます。AI クライアント・MCP サーバー・答える Writer は同じ PC で動く前提です。AI は自分の依頼に答えられません（`APPROVAL_NOT_ALLOWED`）。

MCP の `get_policy` で AI は今の設定を読めます（書くツールはありません）。

## 4. プラグインのステップ

マニフェストの `steps[].targets` で、サイトやプログラムを指す param を宣言すると、組込と同じ検査を受けます（[plugins.md](../design/plugins.md)）。

```json
"targets": [{ "kind": "site", "param": "baseUrl" }]
```

## 5. 守れないこと

- 人の操作は人を信用します。Writer・CLI から確定・承認・`policy.json` の編集ができます。AI クライアントに PC のシェル（ファイルの書き込みやコマンドの実行）まで許していると、AI がこれらを直接行うことは防げません。AI クライアントには SpellSheet の MCP ツールだけを許してください（Writer の「AI と話す」はそう起動します）。
- ブラウザ内の遷移（リンク・リダイレクト・フォーム送信先）は `sites` の対象外です。
