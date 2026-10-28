# ノードのプラグイン（設計メモ）

方針：「よく使うものは組込、それ以外はプラグイン」。社内システムや個別の SaaS 向けのノードを、本体を作り直さずにコミュニティや各社が足せるようにする。

## 1. 何を組込にして、何をプラグインにするか

| 区分 | 例 | 理由 |
|---|---|---|
| 組込（本体に同梱） | `control.*` `variable.*` `log.*` `flow.*` `wait.until`、`browser.*`、`desktop.*`、Office（`excel.*` など） | ほぼ全員が使う。シークレットの入力先チェックなど本体と深く結びつく |
| プラグイン | 社内システム、kintone・freee などの業務 SaaS の API、特定の業務アプリ専用の操作 | 使う人が限られる。作る人が本体の開発者とは別 |

SAP GUI や Java アプリは `desktop.*` のバックエンドとして組込で扱う（[adapters.md](../adapters.md)）。プラグインは「新しい操作の対象」を足すもので、`desktop.*` の書き方を変えるものではない。

## 2. 方式：別プロセス + JSON-RPC

プラグインは子プロセスとして動き、改行区切りの JSON-RPC 2.0 で本体と話す。ブラウザ操作（`packages/browser-adapter`）と同じ仕組み（`shikigami_runtime::sidecar`）をそのまま使う。

- **言語は自由**：Node.js、Python、.NET、PowerShell、Go など、標準入出力が使えれば何でもよい
- **壊れても本体は落ちない**：プラグインが異常終了しても、そのステップが `ADAPTER_CRASHED`（再試行可）で失敗するだけ。次の呼び出しで自動的に起動し直す
- **DLL を本体に読み込む方式は採らない**：Rust には安定した ABI がなく、プラグインの不具合で本体ごと落ちる。ワークスペースは `unsafe` を禁止している（[判断9](../architecture.md) と同じく、仕組みを増やさない）
- WASM は将来の選択肢として残す（Windows の COM や業務アプリのライブラリが使えないため、最初の方式にはしない）

## 3. プラグインの形

1 つのフォルダに `shikigami-plugin.json`（マニフェスト）と実行するプログラムを置く。

```text
hello/
├─ shikigami-plugin.json
└─ main.mjs
```

```json
{
  "manifestVersion": 1,
  "name": "hello",
  "version": "0.1.0",
  "label": "サンプル",
  "description": "プラグインの書き方を示すサンプル",
  "command": { "program": "node", "args": ["main.mjs"] },
  "steps": [
    {
      "action": "greet",
      "label": "あいさつ文を作る",
      "description": "Returns a greeting for `name`.",
      "params": {
        "type": "object",
        "properties": { "name": { "type": "string", "minLength": 1 } },
        "required": ["name"],
        "additionalProperties": false
      },
      "hasOutput": true,
      "risk": "safe",
      "examples": [
        { "type": "hello.greet", "params": { "name": "{{ customer }}" }, "saveAs": "greeting" }
      ]
    }
  ]
}
```

### マニフェストの項目

| 項目 | 必須 | 意味 |
|---|---|---|
| `manifestVersion` | ○ | いまは `1` |
| `name` | ○ | ステップ型の接頭辞（`hello` → `hello.greet`）。英小文字で始まる英小文字・数字（`^[a-z][a-z0-9]*$`、32 文字まで） |
| `version` | ○ | プラグインのバージョン（表示用） |
| `label` / `description` | ○ / - | 表示名と説明 |
| `command.program` | ○ | 起動するプログラム。`./` や `bin\` のように区切りを含むときはプラグインのフォルダからの相対、それ以外は PATH から探す。`node` はインストーラーに同梱の Node.js を優先するので、利用者の PC に Node.js がなくても動く |
| `command.args` | - | 引数。作業フォルダはプラグインのフォルダ |
| `inspect` | - | `true` なら MCP の `test_step` が実行後に `inspect` を呼び、アプリの状態を AI に返す |
| `steps[].action` | ○ | 操作名（`^[a-z][A-Za-z0-9]*$`）。JSON-RPC のメソッド名にもなる |
| `steps[].label` / `description` | ○ | 表示名と、AI が読む説明（英語でよい） |
| `steps[].params` | ○ | params の JSON Schema（`"type": "object"`） |
| `steps[].examples` | ○ | コピーして使える記述例を 1 つ以上。読み込み時に検証し、通らなければプラグインごと読み込まない |
| `steps[].hasOutput` | - | `saveAs` で受け取れる値を返すか（既定 false） |
| `steps[].risk` | - | `safe` / `interactive`（既定）/ `dangerous`。MCP の許可レベルに使う |
| `steps[].secretParams` | - | 登録済みシークレットを受け取れる param（§5） |
| `steps[].resources` | - | 排他する資源（§4） |
| `steps[].defaultTimeoutMs` | - | `timeoutMs` 省略時の時間制限 |

不明な項目はエラーにする（書き間違いに気づけるように）。

### AI が組みやすい仕様との関係（[ai-authoring.md](ai-authoring.md)）

- プラグインのステップも組込と同じく `list_step_types` / `get_step_schema` に出る。AI はプラグインかどうかを区別しない
- 記述例は必須で、読み込み時に検証する（原則 4）
- 式として扱う param（`expressionParams`）はプラグインには持たせない。文字列はすべてテンプレート（原則 1）
- 排他は `resources` で宣言し、シナリオには書かせない（原則 3）

## 4. 排他（`resources`）

| 書き方 | 意味 |
|---|---|
| `{ "kind": "file", "param": "path" }` | `path` が指すファイル。同じファイルへの操作は 1 つずつ、別のファイルは並行 |
| `{ "kind": "window", "param": "target" }` | ウィンドウ（`desktop.*` と同じキー） |
| `{ "kind": "desktopInput" }` | マウス・キーボード（`desktop.*` の入力操作と順番待ち） |
| `{ "kind": "plugin" }` | このプラグイン全体で 1 つずつ（並行に呼ばれると困るプラグイン向け） |

キーは組込と同じ形（`file:c:\data\a.xlsx` など）なので、組込のステップとプラグインのステップが同じファイルを触っても順番待ちになる。

## 5. 本体が守ること

プラグインに任せず、本体が一律に処理する。

- **params の検証**：マニフェストの JSON Schema で検証し、エラーには直し方のヒントを付ける
- **タイムアウト・リトライ・キャンセル・`onError`**：Runtime が処理する。プラグインには `timeoutMs`（ステップの制限より 0.5 秒短い値）を渡すので、それまでに処理を止める
- **シークレット**：`secretParams` に挙げた param だけが `{ "secret": "<名前>", "field": "password" }` を受け取れる（それ以外は検証エラー）。本体が値を取り出し、シークレットの「使ってよい先」に `plugin:<name>`（例 `plugin:hello`）が登録されているときだけ、文字列にしてプラグインに渡す。登録がなければ `SECRET_PLUGIN_NOT_ALLOWED`。渡した値はログ・エラー・結果、プラグインの標準エラー出力から自動で伏せ字になる
- **許可レベル**：`risk` を MCP の承認に使う

プラグイン自身はシナリオの変数を読み書きできない。データは params で入り、戻り値（`saveAs`）で出る。

## 6. 通信の約束（プロトコル）

本体 → プラグイン（1 行 1 メッセージ）：

```json
{"jsonrpc":"2.0","id":1,"method":"greet","params":{"name":"佐藤","runId":"…","timeoutMs":29500}}
```

- `method` はステップの `action`。`params` はテンプレート展開済みの params に `runId`（実行ごとの ID。プラグインが実行単位で状態を持つときのキー）と `timeoutMs` を足したもの
- 実行が終わると `closeRun`（`{ "runId": "…" }`）を呼ぶ。後片付けがなければ `null` かエラーを返せばよい。5 秒待って応答がなければ本体は先に進む
- `inspect: true` のプラグインには `inspect`（`{ "runId": "…", … }`）を呼ぶ
- 標準入力が閉じたら終了する

プラグイン → 本体：

```json
{"jsonrpc":"2.0","id":1,"result":"こんにちは、佐藤さん"}
{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"not found","data":{"code":"ORDER_NOT_FOUND","retryable":false,"details":{"hint":"…"}}}}
```

- `error.data.code` がステップのエラーコード、`retryable` が再試行するか、`details.hint` が直し方（AI にも人にも見える）
- 複数の呼び出しが同時に来ることがある（並行ブランチ）。順番に処理したいなら `resources` に `plugin` を書く
- 標準出力は応答専用。ログは標準エラーへ（本体のログに入る）

## 7. 置き場所と読み込み

起動時（CLI・MCP サーバー・Studio）に次の場所を探す。

1. 環境変数 `SHIKIGAMI_PLUGINS`（`;` 区切り）：プラグインのフォルダ、またはプラグインのフォルダを並べたフォルダ
2. `%LOCALAPPDATA%\Shikigami\plugins\<名前>\`

ワークスペースのフォルダからは読み込まない。共有ワークスペースに置かれたプログラムが、全員の PC で勝手に動くのを避けるため（将来、シナリオが使うプラグインを記録し、足りないものを Studio が案内する）。

読み込めなかったプラグイン（マニフェストの誤り、組込や他のプラグインと名前が重なる、記述例が通らない）は飛ばして、理由を残す。`shikigami plugin list` で読み込んだものと問題を、`shikigami plugin check <フォルダ>` で作成中のプラグインの検査ができる。

予約済みの名前（プラグインに使えない）：`control` `variable` `log` `flow` `scenario` `wait` `browser` `desktop` `excel` `word` `outlook` `office` `file` `sap` `shikigami`、および組込アダプターの名前。

## 8. まだやらないこと（順に検討）

1. シナリオが使うプラグインと版の記録、足りないときの案内（Studio・`validate_scenario` のヒント）
2. `shikigami plugin install <zip / Git URL>` と一覧（カタログ）
3. 署名・発行元の確認、`dangerous` なプラグインを初回に人が許可する仕組み
4. Studio でのプラグイン一覧画面
5. 各言語向けの小さな SDK（Node.js / Python / .NET）

## 9. 最初の実装（このPR）

- `crates/shikigami-plugins`：マニフェストの読込と検査、`Adapter` としての登録、シークレットの受け渡し
- `shikigami_adapters::all()` が組込に加えて見つかったプラグインを返す（CLI・MCP・Studio すべてに出る）
- `Adapter::name()` を `&'static str` から `&str` に（プラグインの名前は実行時に決まるため）
- シークレットの「使ってよい先」に `plugin:<name>` を追加
- CLI：`shikigami plugin list` / `shikigami plugin check <dir>`
- サンプル：`examples/plugins/hello`（Node.js、依存なし）
