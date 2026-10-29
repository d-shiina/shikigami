# Web API・プログラム・クリップボード・ダイアログ

[English](../system.md) | 日本語

クレート `shikigami-system`。アプリの画面ではなく、その外にあるものを扱う組込ノードです。値の加工は式の関数で書きます（[expressions.md](expressions.md)）。

| ノード | 内容 | 出力 | リスク |
|---|---|---|---|
| `http.request` | Web API を呼ぶ | `{ status, headers, body }` | dangerous |
| `process.run` | コマンドラインのプログラムを実行して終わるまで待つ | `{ exitCode, stdout, stderr }` | dangerous |
| `clipboard.get` / `clipboard.set` | クリップボードのテキストを読む / 入れる（Windows） | テキスト | safe / interactive |
| `dialog.message` | メッセージを出して押されたボタンを返す（Windows） | `ok` `cancel` `yes` `no` | interactive |
| `dialog.input` | 1 行入力してもらう（Windows。キャンセルは空文字） | テキスト | interactive |
| `dialog.selectFile` | ファイル・複数ファイル・フォルダー・保存先を選んでもらう（Windows） | パス（`files` は配列）、キャンセルは null | interactive |

## `http.request`

- 送るデータは `json`（値）・`form`（フォーム）・`body`（テキスト）のどれか 1 つ。URL のパラメーターは `query` に書けば符号化される。
- 応答が JSON なら `body` は値になる（`res.body.items` のように使える）。それ以外はテキスト（charset を見て、なければ UTF-8 / Shift_JIS を判定）。`saveTo` を付けるとファイルに保存し、`body` は保存先のパス。
- 状態コード 400 以上は `HTTP_ERROR`（`details.status` と `details.body`）。5xx・429・408 は `retry` で再試行される。404 を「無い」として扱うなら `control.try` で包む。
- 認証：`auth` に登録済みのシークレット `{ "secret": "受注API", "field": "password" }`。`authType` は `bearer`（既定。`Authorization: Bearer …`）、`basic`（シークレットのユーザー名とパスワード）、`header`（`authHeader` の名前のヘッダーに入れる。API キー向け）。シークレットに登録したサイト（`https://api.example.com` の形）以外には送らない（`SECRET_SITE_MISMATCH`）。
- OAuth（Box など人がサインインする API）：`oauth.signIn` ノードのあとで `auth: { "secret": "Box", "field": "accessToken" }`。期限が近ければ更新してから送る（[oauth.md](oauth.md)）。
- シークレットを付けた要求は、別のサイトへのリダイレクトをたどらない（3xx の応答をそのまま返す）。キーが別サイトに渡らないようにするため。
- プロキシは OS の設定に従う。証明書は Windows の証明書ストアで検証する（社内 CA もそのまま使える）。

## `process.run`

- `args` は配列で渡す（シェルを通さないので引用符は不要。パスに空白があってもそのまま）。`cmd` の組込コマンドは `program: "cmd"`, `args: ["/c", "…"]`。
- 終了コードが `okExitCodes`（既定 `[0]`）にないと `PROCESS_FAILED`（`details` に終了コードと出力の末尾）。robocopy のように 1〜7 が成功のものは `okExitCodes` に並べる。
- コンソールは表示しない。ノードの `timeoutMs` を過ぎるとプログラムを終了させる。
- ノードが終わる（完了・停止・タイムアウト）と、そのプログラムが起動した子プロセスもまとめて終了させる（Windows はジョブオブジェクト）。再試行中に前の試行の残りが動き続けることはない。
- 画面のあるアプリを開いたまま残すときは `desktop.launch` を使う（`cmd /c start …` で開いたアプリもノード終了時に閉じる）。

## クリップボードとダイアログ

- Windows のみ。ほかの OS では `PLATFORM_UNSUPPORTED`（定義と検証はどこでも使える）。
- ダイアログは 1 つずつ別の PowerShell プロセス（Windows フォーム）で出す。止めたり時間切れになったりするとプロセスごと閉じる。
- ダイアログは人が見ている実行でだけ使う。既定で 10 分待ち（`timeoutMs` で変更）、無人実行ではタイムアウトまで止まる。待っている間は Studio に「ダイアログに答えてください」と出る。
- パスワードを `dialog.input` で聞かない（シークレットを使う）。
