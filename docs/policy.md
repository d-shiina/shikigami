# 公開版と許可・承認

「AI が作り、AI なしで動く」を安心して使うための 2 つの決まりです。

1. **無人実行は、人が承認して公開した版だけを動かす。** AI が夜に編集した内容が、翌朝のスケジュール実行でそのまま本番システムを操作することはありません。
2. **シナリオが触れてよい先と、AI が人の承認なしにしてよいことを、ワークスペースの設定（`policy.json`）で決める。** 検査は Runtime と Core が一律に行うので、Studio・CLI・AI（MCP）のどこから動かしても同じ結果になります。

## 1. 公開版

### 何が動くか

| 動かし方 | 動く内容 |
|---|---|
| `shikigami run <id>`（タスクスケジューラー・バッチなどの無人実行） | **公開版**。呼び出すサブシナリオも、それぞれの公開版 |
| `shikigami run <id> --draft` | 作業中の内容（明示したときだけ） |
| `shikigami run <file>` | ファイルに書かれた内容（バンドルを含む） |
| Studio の「実行」 | 作業中の内容（目の前で試す） |
| MCP `run_scenario` | 作業中の内容（AI の試し実行）。`published: true` で公開版 |
| MCP `test_step` | その 1 ステップだけ |

公開版がないシナリオを `shikigami run <id>` すると `NOT_PUBLISHED`、呼び出し先に公開版がないと `SUBSCENARIO_NOT_PUBLISHED` で止まります。作業中の内容に黙って切り替えることはありません。実行レポートの `version` に動いた版の番号が残ります。

### 公開のしかた

- **Studio のレビュー台**：AI の変更を見て「✓ 承認して公開」。承認（レビューの記録）と公開を 1 回の操作で行います。現在の内容と同じ版がなければ版を作ってから公開します。
- **Studio の「版」タブ**：「現在の内容を公開」、または過去の版の「この版を公開」（前の版に戻すときも、作業中の内容を変えずに公開版だけを戻せます）。「公開をやめる」で無人実行を止めます。
- **CLI**：`shikigami version publish <id> [番号] [--name 名前] [--note メモ]`、`shikigami version unpublish <id>`。`shikigami version list <id>` は公開中の版に `published` を付けます。

公開できるのは人だけです（Studio・CLI）。AI クライアントが Core の公開を呼ぶと `PUBLISH_NOT_ALLOWED` になり、MCP には公開するツール自体がありません。AI は「レビュー台で承認して公開してください」と人に頼みます。

公開の前に、その版が検証を通ること・呼び出すシナリオがすべて公開済みであることを確かめます（呼ばれる側から順に公開します）。

### 記録

公開の記録は `versions/<scenario-id>/publish.jsonl` に追記します（ワークスペースの共有部分なので、同じワークスペースを使う全員が同じ公開版を見ます）。1 行が 1 回の公開・公開停止で、最後の行が今の状態です。

```json
{"version":3,"uid":"019a…","at":"2026-10-28T09:12:00Z","by":{"kind":"studio"},"note":"初回"}
{"version":null,"at":"2026-10-29T08:00:00Z","by":{"kind":"cli"},"note":"止める"}
```

版そのものは今までどおり不変です。シナリオをゴミ箱に移すと公開も止まります。

## 2. `policy.json`

ワークスペースのフォルダ直下に置きます（共有部分）。ファイルがなければ下の既定値です。Studio の「許可と承認」で編集できます。CLI は `shikigami policy show`（今効いている内容）、`shikigami policy check`（書き間違いの確認）、`shikigami policy init`（既定値で作る）。

```json
{
  "formatVersion": 1,
  "sites": ["https://order.example.co.jp", "https://*.corp.example"],
  "apps": ["C:\\Program Files\\Billing\\billing.exe", "notepad.exe"],
  "ai": {
    "runScenario": { "safe": "allow", "interactive": "allow", "dangerous": "ask" },
    "testStep": { "safe": "allow", "interactive": "allow", "dangerous": "ask" },
    "deleteScenario": "ask"
  },
  "scenarios": {
    "scn_01a1…": { "aiRun": "deny", "unattended": false }
  }
}
```

| 項目 | 既定 | 意味 |
|---|---|---|
| `sites` | 空（どこでも） | `browser.open`・`http.request`（と、`targets` で宣言したプラグインのステップ）が開いてよいサイト。オリジン（`https://example.com`、ポート付きも可）か、サブドメインすべての `https://*.example.com`。http と https は別。`about:blank` はいつでも可、`file:` などは不可 |
| `apps` | 空（どれでも） | `desktop.launch`・`process.run` が起動してよいプログラム。フォルダ付きならそのパスだけ、ファイル名だけならどのフォルダでも。大文字小文字・`/` と `\`・`.exe` の有無は区別しない |
| `ai.runScenario` | safe/interactive は allow、dangerous は ask | AI の `run_scenario`。実行しうるステップ（呼び出し先を含む）のいちばん高い危険度で決まる |
| `ai.testStep` | 同上 | AI の `test_step`。`scenario.call` は呼び出し先のいちばん高い危険度 |
| `ai.deleteScenario` | ask | AI の `delete_scenario` |
| `scenarios.<id>.aiRun` | なし | このシナリオ（と、これを呼ぶ実行・試行）だけ厳しくする。全体の規則より緩くはならない |
| `scenarios.<id>.unattended` | true | false なら `shikigami run` で動かさない（`UNATTENDED_NOT_ALLOWED`）。Studio からは動かせる |

`allow`＝そのまま、`ask`＝人が Studio で承認してから、`deny`＝させない。危険度はステップ型の `risk`（`safe`：変数・ログ・制御、`interactive`：画面の操作、`dangerous`：ファイルの削除・移動、外部への HTTP、プログラムの実行など）。登録されていないステップ型は `dangerous` 扱いです。

壊れた `policy.json`（JSON の誤り、知らない項目、オリジンでない `sites`）は「全部許可」にはせず、実行を `POLICY_INVALID` で止めます。設定は実行の開始時に読むので、変更は次の実行から効きます。

### サイト・アプリの検査

Runtime が、テンプレートを展開した後の params をステップの実行直前に調べます。許可されていなければそのステップは動かず `SITE_NOT_ALLOWED` / `APP_NOT_ALLOWED`（`details.allowed` に許可リスト）で失敗します。入力変数や前のステップの結果から URL を組み立てても、許可リストの外には出られません。MCP の `inspect_page` に渡した `url` も同じリストで調べます。

制約：ページの中のリンクをクリックした先や、リダイレクト先は調べていません（ステップが指定した行き先だけを見ます）。

## 3. AI の操作の承認

`ask` の操作を AI が呼ぶと、MCP サーバーは実行せずに承認の依頼を作り、`APPROVAL_REQUIRED`（`details.approvalId`）を返します。

1. Studio の上部に「✋ AI が承認を求めています：ステップを 1 つ試す（file.delete・危険な操作）」が出ます。「内容」で実際に動く内容（ステップ・入力・リビジョン。シークレットの値は伏せ字）、AI の理由（`approvalReason`）を見て「許可する」か「断る」。CLI でも `shikigami approval list` / `approve <id>` / `deny <id>`。
2. AI は同じ呼び出しに `approvalId` を付けて呼び直します（`approvalWaitMs` で答えを待てます。最初の呼び出しに付けてもよい）。
3. 許可した内容とまったく同じ操作が **1 回だけ** 動きます。内容が違えば `APPROVAL_MISMATCH`、使用済みは `APPROVAL_USED`、断られたら `APPROVAL_DENIED`、`deny` の操作は `POLICY_DENIED`。

依頼は 30 分、許可は 10 分で失効します。依頼は PC ごとの領域（`approvals/`、MCP の監査ログの隣）に置きます。AI クライアント・MCP サーバー・答える Studio は同じ PC で動く前提です。AI は自分の依頼に答えられません（`APPROVAL_NOT_ALLOWED`）。

MCP の `get_policy` で AI は今の設定を読めます（書くツールはありません）。

## 4. プラグインのステップ

マニフェストの `steps[].targets` で、サイトやプログラムを指す param を宣言すると、組込と同じ検査を受けます（[plugins.md](design/plugins.md)）。

```json
"targets": [{ "kind": "site", "param": "baseUrl" }]
```

## 5. 守れないこと

- 人の操作は人を信用します。Studio・CLI から公開・承認・`policy.json` の編集ができます。AI クライアントに PC のシェル（ファイルの書き込みやコマンドの実行）まで許していると、AI がこれらを直接行うことは防げません。AI クライアントには Shikigami の MCP ツールだけを許してください（Studio の「AI と話す」はそう起動します）。
- ブラウザ内の遷移（リンク・リダイレクト・フォーム送信先）は `sites` の対象外です。
