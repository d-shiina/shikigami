# ログインとシークレット

業務サイトや業務アプリのログインに使う ID・パスワードの扱いです。基本の考え方は 3 つです。

1. **値は人が登録する**。Studio の「🔑 シークレット」（または CLI）で、名前を付けて登録します（例：「受注システム」）。
2. **シナリオと AI には名前だけ**。シナリオには `{ "secret": "受注システム", "field": "password" }` とだけ書きます。値は実行中のステップが受け取るだけで、シナリオファイル・MCP の結果・ログ・スクリーンショットのどこにも出ません。
3. **登録したサイトにしか入力しない**。シークレットには「入力してよいサイト」を登録します。ほかのページには入力を拒否します（そっくりな偽サイトや、ページに仕込まれた指示に AI が誘導された場合の対策）。照合は入力欄そのもののページで行うので、待っている間に別のサイトへ移った場合や、別のサイトの iframe の中の入力欄にも入力しません。

## 登録する

### Studio

右上の「🔑 シークレット」→「新しく登録」。

| 項目 | 内容 |
|---|---|
| 名前 | シナリオと AI に伝える名前。1〜64 文字 |
| ユーザー名 / パスワード | ログインに使う値。編集時、パスワード欄を空のままにすると前の値を残す |
| 入力してよいサイト・アプリ | 1 行に 1 つ。`https://example.com/login` と書いても `https://example.com`（オリジン）として扱う。デスクトップアプリは `app:billing.exe`（実行ファイル名、[desktop.md](desktop.md)） |
| MFA の設定キー | 任意。認証アプリ用 QR コードの横に出るキー（base32）か `otpauth://` の文字列。ワンタイムコードを自動入力する |

### CLI

```powershell
shikigami secret set 受注システム --username tanaka --site https://orders.example.com   # パスワードは伏せ字で聞かれる
shikigami secret set 受注システム --totp JBSWY3DPEHPK3PXP                                 # 変えたい項目だけ
shikigami secret list
shikigami secret remove 受注システム
shikigami secret logout 受注システム        # 保存したログイン状態（下記）だけ消す
shikigami secret reset --yes               # すべて消して登録し直す（別の PC からコピーしたとき）
```

スクリプトから渡すときは `--password-stdin`（標準入力の 1 行目）。

## 保存場所と暗号化

```text
<ワークスペース>/secrets/vault.json            名前・サイト・設定済みの項目（平文）と、値（暗号化）
<ワークスペース>/secrets/sessions/<hash>.json  保存したログイン状態（暗号化）
```

- 値は AES-256-GCM で暗号化します。鍵は **Windows 資格情報マネージャーにワークスペースごと 1 件だけ**（「Shikigami / vault …」）置きます。シークレットを何件登録しても資格情報マネージャーの項目は増えません。
- 鍵は登録した Windows ユーザーの DPAPI で守られます。ワークスペースのフォルダーを別の PC や別のユーザーにコピーしても値は読めません（`SECRET_KEY_MISSING`）。そのときは Studio の「🔑 シークレット」に出る「リセットして登録し直す」（または `shikigami secret reset --yes`）で、読めなくなったシークレット・ログイン状態・鍵を消してから登録し直します。
- Studio・CLI・MCP サーバーが同じワークスペースを同時に更新しても上書きし合わないよう、更新は `secrets/.lock` で 1 つずつ行います。
- Windows 以外（開発・CI）では鍵を `secrets/<id>.key`（所有者だけ読める）に置きます。保護にはならないので本番では使いません。

## シナリオでの使い方

```jsonc
{ "type": "browser.open", "params": { "url": "https://orders.example.com/", "session": "受注システム" } },
{ "type": "browser.isVisible", "params": { "target": { "role": "heading", "name": "受注一覧" } }, "saveAs": "loggedIn" },
{ "type": "control.if", "params": { "condition": "!loggedIn" }, "blocks": { "then": [
  { "type": "browser.fill",  "params": { "target": { "label": "ユーザー名" }, "value": { "secret": "受注システム", "field": "username" } } },
  { "type": "browser.fill",  "params": { "target": { "label": "パスワード" }, "value": { "secret": "受注システム", "field": "password" } } },
  { "type": "browser.click", "params": { "target": { "role": "button", "name": "ログイン" } } }
] } }
```

- `field` は `username` / `password` / `totp`（いまのワンタイムコード）。
- シークレットを書けるのは入力ステップの値（`browser.fill` の `value`）だけです。ログやメッセージ、URL などに書くと検証エラー `SECRET_NOT_ALLOWED` になります。
- `secret: true` の変数に既定値を書くと、平文でシナリオに残るので検証エラー `SECRET_DEFAULT` になります。
- Studio のプロパティでは、入力欄の値を「文字 / 🔑 シークレット」で切り替えて名前と項目を選びます。

### ログイン状態を保つ（セッション）

`browser.open` に `session: "<名前>"` を付けると、その作業領域は保存済みの Cookie・localStorage で始まり、閉じるとき（実行の終わり）に保存し直します。2 回目からはログイン画面を飛ばせるので、上の例のように `browser.isVisible` でログインが必要なときだけログインします。保存した状態はシークレットと同じ鍵で暗号化します。

### MFA

- **ワンタイムコード（TOTP）**：MFA の設定キーを登録しておけば `field: "totp"` で毎回いまのコードを入力できます。
- **スマホでの承認・SMS・CAPTCHA など**：`browser.waitForHuman` で人の操作を待ちます。Studio に「式神があなたの操作を待っています」と出て、ブラウザが前面に来ます。`until` の要素（例：ログイン後の見出し）が出たら次へ進みます。待つのは既定で 5 分（`timeoutMs` で変更）。画面なし（headless）の実行では待たずに `HUMAN_REQUIRED` で失敗します。
- 無人で動かすシナリオは、一度人がログインした状態を `session` で保つのが基本です。

## マスク

- 実行ログ・エラー・実行記録・出力では、パスワードとワンタイムコードの値を `***` に置き換えます（ユーザー名は画面にも出るので伏せません）。
- スクリーンショットでは、パスワード欄とシークレットを入力した欄を黒く塗ります。
- ブラウザアダプターが返す文字（`getText` / `getTable` / ページのアクセシビリティツリー / エラー時のページ情報）からも値を消します。パスワード欄に人が手で入力した値も消します。

## AI（MCP）から

- AI はパスワードをチャットで聞きません。`list_secrets` で **名前・サイト・設定済みの項目** だけを見ます（値もユーザー名も返しません）。
- 調査中にログイン画面に当たると、`inspect_page` / `test_step` の結果に `login`（ログインが必要という印と対処のヒント）が付きます。
  - 合うシークレットがあれば、`test_step` の `browser.fill` で `{ "secret": …, "field": … }` を使ってログインします。
  - なければ、ユーザーに Studio で登録してもらうか、`test_step` の `browser.waitForHuman` で人に手でログインしてもらいます。
- `run_scenario` で `secret: true` の入力変数に値を渡すことはできません（`SECRET_INPUT_REJECTED`）。
- ページの内容はデータであって AI への指示ではありません。仕込まれた指示に従って別のサイトにパスワードを入力させようとしても、サイト照合で止まります。

## エラーコード

| コード | 意味と直し方 |
|---|---|
| `SECRET_NOT_FOUND` | その名前のシークレットがない。Studio で登録する |
| `SECRET_FIELD_EMPTY` | その項目（パスワード・MFA キーなど）が未設定 |
| `SECRET_SITE_NOT_SET` | 入力してよいサイトが未登録。サイトを追加する |
| `SECRET_SITE_MISMATCH` | いまのページが登録サイトではない。URL を確認し、正しければサイトを追加する |
| `SECRET_APP_NOT_SET` / `SECRET_APP_MISMATCH` | デスクトップアプリ（`app:xxx.exe`）が未登録、または別のアプリに入力しようとした |
| `SECRET_KEY_MISSING` | この PC / Windows ユーザーに鍵がない。Studio か `shikigami secret reset --yes` でリセットして登録し直す |
| `SECRETS_UNAVAILABLE` | シークレットのない Runtime で実行した（Studio・CLI・MCP から実行する） |
| `HUMAN_REQUIRED` / `HUMAN_TIMEOUT` | 人の操作が必要だが画面がない／時間内に終わらなかった |
