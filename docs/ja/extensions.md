# カスタム ノード

[English](../extensions.md) | 日本語

カスタム ノードは、SpellSheet に後からノードを追加する仕組みです。クラウド型 AI-OCR、社内システム、業務 SaaS の API など、使う人が限られる連携を、本体を作り直さずに追加できます。VS Code の拡張機能のように、入れたものだけがパレットに並び、要らなくなれば無効にしたり削除したりできます。

- カスタム ノードは **別のプログラム** として動きます（Node.js・Python・.NET・PowerShell など、標準入出力が使えれば言語は自由）。不具合があっても Writer や実行は落ちず、そのノードがエラーになるだけです。
- 追加したノードは組込のノードと同じく、パレットに並び、設定欄はカスタム ノードが宣言した内容から作られ、検証・再試行・タイムアウト・シークレットの伏せ字も同じように扱われます。
- AI にも自動で渡ります。MCP の `list_step_types` / `get_step_schema`、Writer の「仕様書を保存」にカスタム ノードが載ります。

仕組みの設計は [design/plugins.md](design/plugins.md) にあります（コード上の名前は「plugin」です）。

## 使う

### Writer の「カスタム ノード」画面

設定の「カスタム ノード」の「管理」、またはノードを探すパレットの左下「カスタム ノードを追加」で開きます。インストール済みの一覧（有効・無効、更新の確認、アンインストール）と、「一覧」タブ（下のレジストリ）を扱います。「インストール」で入手先を指定すると、内容（追加されるノード・外部へ送信するデータ・必要なシークレット・起動するプログラム）を表示し、確認してからインストールします。変更は Writer の再起動後に反映されます（画面の「再起動」）。

カスタム ノードは、パレットにその名前の分類で並び、ノード名の前に札（例「AI-OCR」）が付きます。設定欄はマニフェストの JSON Schema から作られます。

### インストール

| 入手先 | 書き方 |
|---|---|
| 手元の zip ファイル・フォルダー | `C:\Downloads\azureocr-0.1.0.zip` |
| GitHub のリポジトリ（最新のリリース） | `https://github.com/<owner>/<repo>` |
| zip の URL（https のみ） | `https://example.com/azureocr-0.1.0.zip` |

GitHub のリポジトリを指定すると、最新のリリースに添付された最初の `.zip` を使います（添付がなければリリースのソースの zip）。

```powershell
spellsheet plugin install https://github.com/<owner>/<repo>        # 中身を表示するだけ
spellsheet plugin install https://github.com/<owner>/<repo> --yes  # インストールする
```

インストールの前に、カスタム ノードの名前・発行元・追加されるノード・**外部へ送るデータ**・必要なシークレット・起動するプログラムを表示します。カスタム ノードはこの PC でプログラムとして動くため、発行元を信頼できるものだけをインストールしてください。

インストール先は `%LOCALAPPDATA%\SpellSheet\plugins\<名前>\` です。ワークスペースのフォルダーには置きません（共有ワークスペースに置かれたプログラムが、全員の PC で勝手に動かないようにするため）。インストール・更新・無効化のあとは、Writer と AI クライアントを再起動すると反映されます。

### 一覧・有効と無効・更新・削除

```powershell
spellsheet plugin list              # 読み込んだもの・無効のもの・読み込めなかったものと理由
spellsheet plugin disable azureocr  # 無効（フォルダーは残し、ノードを読み込まない）
spellsheet plugin enable azureocr
spellsheet plugin update azureocr   # インストールした入手先から新しい版を取得（--yes で更新）
spellsheet plugin remove azureocr
```

無効にしたカスタム ノードを使うフローは、インストールされていないときと同じく、実行前の検証で `PLUGIN_NOT_INSTALLED` になります（フローの中身はそのまま残ります）。フローは使っているカスタム ノードと版を `requires`（`{ "plugin:azureocr": "^0.1.0" }`）に記録するので、別の PC で足りないカスタム ノードが分かります。

### 一覧（レジストリ）

組織やコミュニティで使うカスタム ノードの一覧を、JSON の索引ファイル 1 つで配れます。サーバーは不要で、Git リポジトリに置いたファイルの raw URL などで構いません。

```powershell
spellsheet plugin registry --set https://example.com/spellsheet-extensions.json
spellsheet plugin registry          # 一覧を表示
```

```json
{
  "extensions": [
    {
      "name": "azureocr",
      "label": "Azure AI-OCR",
      "description": "Azure AI Document Intelligence で画像・PDF を読み取ります",
      "version": "0.1.0",
      "publisher": "SpellSheet 見本",
      "homepage": "https://github.com/<owner>/<repo>",
      "source": "https://github.com/<owner>/<repo>"
    }
  ]
}
```

`source` はインストールの入手先（GitHub のリポジトリか zip の URL）です。索引の URL はユーザーの設定ファイル（`%APPDATA%\SpellSheet\config.json` の `extensions.registry`）に保存します。

### 外部へ送るデータと実行の許可

クラウドのサービスへデータを送るノードは、マニフェストの `external` にその旨を宣言します。

- Writer の確認パネル（公開の前）の「外への影響」に「Azure AI Document Intelligence へ送信：読み取るファイル（画像・PDF）」のように表示します。
- 送り先のアドレスを持つ設定（`targets` に `site` として宣言したもの）は、ワークスペースの `policy.json` の `sites` で検査します。`sites` に `https://<リソース名>.cognitiveservices.azure.com` だけを書けば、それ以外へは送れません（[policy.md](policy.md)）。
- カスタム ノードの `risk` は、AI がそのノードを動かすときの承認（`policy.json` の `ai.runFlow` / `ai.testStep`）に使います。外部へファイルを送るノードは `interactive` 以上にして、AI が人の承認なしに試せないようにしてください。

### シークレット

API キーなどは Writer の「シークレット」に登録し、ノードの設定では名前で選びます。値はフローに書かれず、AI にも渡りません。

- カスタム ノードが受け取れるのは `secretParams` に挙げた設定だけです。
- シークレットの「使ってよい先」に `plugin:<名前>`（例 `plugin:azureocr`）を登録したものだけが、そのカスタム ノードに渡ります。登録がなければ `SECRET_PLUGIN_NOT_ALLOWED` で止まります。
- マニフェストの `credentials` に種類（`login` / `apiKey` / `oauth`）を書くと、Writer はその種類のシークレットを選択肢に出し、新規登録の画面もその種類で開きます。

## 作る

### フォルダーの形

```text
azureocr/
├─ spellsheet-plugin.json   … マニフェスト（ノードの宣言）
├─ main.mjs                … 本体（標準入出力で JSON-RPC を受ける）
└─ README.md
```

配るときは、このフォルダーを zip にします（フォルダーごと zip にしても、中身だけを zip にしても構いません）。GitHub のリリースに zip を添付すれば、リポジトリの URL でインストールできます。

見本は 2 つあります。

| 見本 | 内容 |
|---|---|
| [examples/plugins/azure-ocr](../../examples/plugins/azure-ocr) | クラウド型 AI-OCR（Azure AI Document Intelligence）。外部送信・API キー・ファイルの設定・設定欄の名前の付け方の例 |
| [examples/plugins/hello](../../examples/plugins/hello) | 最小の例。ファイルの排他（`resources`） |

### マニフェスト

```json
{
  "manifestVersion": 1,
  "name": "azureocr",
  "version": "0.1.0",
  "label": "Azure AI-OCR",
  "description": "Azure AI Document Intelligence で画像・PDF を読み取ります",
  "publisher": "SpellSheet 見本",
  "homepage": "https://github.com/<owner>/<repo>",
  "tag": "AI-OCR",
  "icon": "scan-text",
  "command": { "program": "node", "args": ["main.mjs"] },
  "credentials": [
    { "kind": "apiKey", "label": "Azure AI Document Intelligence のキー", "params": ["key"] }
  ],
  "steps": [ … ]
}
```

| 項目 | 必須 | 意味 |
|---|---|---|
| `manifestVersion` | ○ | いまは `1` |
| `name` | ○ | ノードの種類の接頭辞（`azureocr` → `azureocr.readDocument`）。英小文字で始まる英小文字・数字、32 文字まで。組込の名前（`browser`・`excel`・`http` など）は使えません |
| `version` | ○ | semver（`0.1.0`）。設定の形を互換でなく変えたらメジャー版（0.x ならマイナー版）を上げる |
| `label` | ○ | 表示名。パレットの分類名にもなります |
| `description` | - | カスタム ノードの一覧に出す説明 |
| `publisher` / `homepage` | - | 発行元と説明のページ（https） |
| `tag` | - | ノード名の前に出す「どこで」の札（例 `AI-OCR` →「［AI-OCR］AI-OCR の読み取り」）。省略時は `label` |
| `icon` | - | ノードのアイコン。[Lucide](https://lucide.dev/icons) の名前（`scan-text`・`file-search`・`cloud` など）。知らない名前はパズルのアイコン |
| `command.program` / `args` | ○ / - | 起動するプログラム。`./bin/x.exe` のように区切りを含むとカスタム ノードのフォルダーからの相対、`node` は SpellSheet に同梱の Node.js を使います（利用者の PC に Node.js がなくても動く） |
| `credentials` | - | 受け取るシークレットの種類：`kind`（`login` / `apiKey` / `oauth`）・`label`（登録するもの）・`description`・`params`（受け取る `secretParams`） |
| `inspect` | - | `true` なら AI の単体実行のあとに `inspect` を呼び、アプリの状態を AI に返す |
| `steps` | ○ | ノードの宣言（下の表） |

`steps[]` の項目：

| 項目 | 必須 | 意味 |
|---|---|---|
| `action` | ○ | 操作名（`readDocument`）。JSON-RPC のメソッド名にもなる |
| `label` | ○ | ノードの名前。**名詞**にします（「AI-OCR の読み取り」。「読み取る」にしない。[design/wording.md](design/wording.md)） |
| `description` | ○ | AI が読む説明（英語でよい）。何を受け取り、何を返すかを書く |
| `summary` | - | 人が読む一文。Writer のパレットと設定画面でノード名の下に出る（省略時は `description` の最初の一文） |
| `params` | ○ | 設定の JSON Schema（`"type": "object"`）。Writer の設定欄はここから作られます |
| `examples` | ○ | そのまま使えるノードの記述例（1 つ以上）。読み込み時に検証し、通らなければカスタム ノードごと読み込みません |
| `hasOutput` | - | 結果を返すか（`saveAs` で受け取れる） |
| `risk` | - | `safe`（影響なし）/ `interactive`（既定）/ `dangerous`（外部に影響する操作）。AI の承認に使う |
| `secretParams` | - | 登録済みのシークレットを受け取れる設定 |
| `pathParams` | - | ファイル・フォルダーの設定。相対パスはフローのフォルダーから解決し、カスタム ノードには絶対パスで渡す |
| `targets` | - | サイト・プログラムを指す設定（`[{ "kind": "site", "param": "endpoint" }]`）。`policy.json` の `sites` / `apps` で検査 |
| `external` | - | 外部へ送るデータ：`service`（送り先のサービス）・`data`（送るもの）・`param`（送り先のアドレスの設定） |
| `resources` | - | 排他する資源（ファイル・ウィンドウ・マウスとキーボード・カスタム ノード全体） |
| `defaultTimeoutMs` | - | 時間制限の既定値 |
| `deprecated` | - | 使うのをやめてほしいノード：`{ "note", "replacement" }` |

マニフェストの不明な項目はエラーになります（書き間違いに気づけるように）。

#### 設定欄の名前と選択肢

設定欄の名前は JSON Schema の `title`、下に出る説明は `description` です（日本語で書くと Writer にそのまま出ます）。選択肢（`enum`）の表示名は `x-enumLabels` に書きます。

```json
"model": {
  "type": "string",
  "enum": ["prebuilt-read", "prebuilt-invoice"],
  "default": "prebuilt-read",
  "title": "読み取りの種類",
  "x-enumLabels": { "prebuilt-read": "文字", "prebuilt-invoice": "請求書の項目" }
}
```

文字の設定はすべてテンプレート（`{{ 変数 }}` が使える）として扱います。

### 本体（プロトコル）

本体は 1 行に 1 つの JSON-RPC 2.0 メッセージを標準入力で受け、標準出力に返します。

```json
{"jsonrpc":"2.0","id":1,"method":"readDocument","params":{"endpoint":"https://…","key":"…","path":"C:\\flows\\請求\\input\\invoice.pdf","runId":"…","timeoutMs":119500}}
```

```json
{"jsonrpc":"2.0","id":1,"result":{"text":"…","pages":[…],"fields":{…}}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"…","data":{"code":"AZURE_AUTH_FAILED","retryable":false,"details":{"hint":"…"}}}}
```

- `method` はノードの `action`、`params` はテンプレート展開済みの設定に `runId` と `timeoutMs` を足したもの。`timeoutMs` までに処理を止めてください
- エラーの `data.code` がノードのエラーコード、`retryable` が再試行してよいか、`details.hint` が直し方（人にも AI にも見える）
- 実行の終わりに `closeRun`（`{ "runId" }`）が来ます。後片付けがなければ `null` を返す
- 呼び出しは同時に複数来ることがあります（並列実行）。順番に処理したいときは `resources` に `{ "kind": "plugin" }`
- 標準出力は応答だけ。ログは標準エラーへ（SpellSheet のログに入り、シークレットの値は伏せ字になる）
- 標準入力が閉じたら終了する

### 確かめる

```powershell
spellsheet plugin check examples\plugins\azure-ocr   # マニフェスト・スキーマ・記述例の検査
$env:SPELLSHEET_PLUGINS = "$PWD\examples\plugins"     # インストールせずに読み込む（開発用）
spellsheet step-types                                  # azureocr.readDocument が出る
node --test examples\plugins\azure-ocr\test.mjs      # Azure の代わりのサーバーで動作を確認
```

`SPELLSHEET_PLUGINS` で読み込んだカスタム ノードは一覧に出ますが、無効化・更新・削除はできません（開発中のフォルダーを壊さないため）。

## 見本：Azure AI-OCR

[examples/plugins/azure-ocr](../../examples/plugins/azure-ocr) は、Azure AI Document Intelligence で画像・PDF の文字・表・請求書や領収書の項目を読み取るノード「AI-OCR の読み取り」を追加します。

1. Azure ポータルで Document Intelligence のリソースを作り、「キーとエンドポイント」を開く
2. Writer の「シークレット」で種類「API キー」を選んでキーを登録し、使ってよい先に `plugin:azureocr` を追加する
3. ノードの設定で、エンドポイント・API キー（登録した名前）・ファイル・読み取りの種類を選ぶ
4. 結果を `saveAs` で受け取り、`{{ invoice.fields.InvoiceTotal }}` や `{{ invoice.text }}` のように使う

ほかのクラウド型 AI-OCR（Google Document AI、国内の AI-OCR サービスなど）も、同じ形で `main.mjs` の送受信の部分を書き換えれば作れます。
