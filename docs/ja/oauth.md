# OAuth でサインインする Web API

[English](../oauth.md) | 日本語

Web API の多く（Box・Google・Microsoft 365・Salesforce など）は固定のキーではなく、人が一度サインインしてアプリにアクセスを許可し（OAuth 2.0 の認可コードフロー）、アプリがトークンを受け取る方式です。Shikigami では 2 つのノードで書きます。

| ノード | 内容 | 出力 |
|---|---|---|
| `oauth.signIn` | シークレットのサインインを使える状態にする。保存済みのトークンを使うか更新し、なければブラウザで人にサインインしてもらう | `{ secret, signedIn, via, expiresAt, scope }`（トークンそのものは出さない） |
| `http.request` に `auth: { "secret": "<名前>", "field": "accessToken" }` | アクセストークンで API を呼ぶ。期限が近ければ先に更新する | いつもどおり（[system.md](system.md)） |

## リダイレクト URL はどんな固定 URL でもよい

プロバイダは、**アプリに登録したリダイレクト URL** にコードを付けて（`…?code=…&state=…`）ブラウザを戻します。ふつうはプログラムがその宛先（`http://localhost:…`）で待ち受ける必要があり、リダイレクト URL に自社サイト（例：`https://www.example.com/`）しか登録できない・させてもらえない場合に困ります。

`oauth.signIn` はどこでも待ち受けません。サインインは Shikigami のブラウザの中で進み、リダイレクト URL への要求を **PC の外に出る前に** ブラウザ自身が受け止めて、代わりに「サインインが終わりました」と表示します。そのため、

- リダイレクト URL は、プロバイダに登録した固定のアドレスなら何でもかまいません（会社のトップページ、存在しないページなど）。登録したものと完全に同じにするだけです。
- リダイレクト URL の先のサイトは読み込まれず、コードも届きません。
- 要求に付けた `state` がそのまま戻ってこなければ止めます（`OAUTH_STATE_MISMATCH`）。コードは PKCE でこの試行に結び付いているので、ほかで手に入れたコードは使えません。

## 準備（Box の例）

1. プロバイダでアプリを作り（Box：開発者コンソール → Platform App の作成 → ユーザー認証（OAuth 2.0））、**リダイレクト URL**（例：`https://www.example.com/`）を登録します。Client ID と Client secret を控え、必要なスコープを付けます。
2. Studio の 🔑 シークレット → 新しく登録：

   | 項目 | 内容 |
   |---|---|
   | 名前 | 例：`Box` |
   | ユーザー名 | **Client ID** |
   | パスワード | **Client secret**（ないパブリッククライアントは空） |
   | サイト | Client secret とトークンを送ってよい先：トークン URL のサイトと API のサイト（Box は `https://api.box.com`） |

   AI からは `request_secret` に `name: "Box"`、`sites: ["https://api.box.com"]`、理由に「ユーザー名に Client ID、パスワードに Client secret を」と書いて頼みます。
3. シナリオ：

```jsonc
{ "type": "oauth.signIn", "params": {
    "secret": "Box",
    "authorizeUrl": "https://account.box.com/api/oauth2/authorize",
    "tokenUrl": "https://api.box.com/oauth2/token",
    "redirectUrl": "https://www.example.com/"
} },
{ "type": "http.request", "params": {
    "url": "https://api.box.com/2.0/folders/0/items",
    "auth": { "secret": "Box", "field": "accessToken" }
  }, "saveAs": "res" },
{ "type": "log.message", "params": { "message": "{{ join(map(res.body.entries, e => e.name), ', ') }}" } }
```

初回は Box のサインイン画面が開きます。人がサインインして「アクセスを許可」を押すまで、Studio には「操作を待っています」と出ます。2 回目からは `oauth.signIn` が人なしですぐ終わります（`via: "saved"` か `"refreshed"`）。

## `oauth.signIn` のパラメーター

| パラメーター | 意味 |
|---|---|
| `secret` | クライアントを登録したシークレット（ユーザー名 = Client ID、パスワード = Client secret） |
| `authorizeUrl` | プロバイダの認可ページ |
| `tokenUrl` | プロバイダのトークンの URL。そのサイトをシークレットのサイトに登録しておく |
| `redirectUrl` | アプリに登録したリダイレクト URL（登録どおりに） |
| `scope` | 空白区切りのスコープ（プロバイダが求めるとき） |
| `authorizeParams` | 認可ページに付ける追加のパラメーター。例：`{ "prompt": "consent", "access_type": "offline" }`（Google でリフレッシュトークンをもらうとき） |
| `pkce` | PKCE を受け付けないプロバイダのときだけ `false`（既定 `true`） |
| `message` | Studio で人に頼む文 |
| `context` | ブラウザの作業領域（既定 `default`） |

人を待つのは既定で 5 分です（`timeoutMs`）。Client secret はトークン要求の本文で送ります（`client_secret_post`）。

## トークン

- ワークスペースに暗号化して保存します（`secrets/oauth/`。鍵はシークレットと同じ。[secrets.md](secrets.md)）。出力・ログ・MCP の結果には出ず、アクセストークンはパスワードと同じく伏せ字になります。
- `http.request` は、アクセストークンの残りが 2 分を切っていれば更新してから使います（更新できないトークンは本当に切れるまで使います）。更新は同じワークスペースの Studio・CLI・MCP サーバーをまたいで 1 つずつ行うので、更新のたびにリフレッシュトークンが変わるプロバイダ（Box など）でも失いません。
- 保存したトークンを使い回すのは、Client ID・`tokenUrl` が同じで、`scope` が許可済みの範囲に収まるときだけです。スコープを増やすともう一度サインインします。
- リフレッシュトークンが受け付けられなくなると、`http.request` は `OAUTH_SIGN_IN_REQUIRED` で止まり、次の `oauth.signIn` で人がもう一度サインインします。シナリオの最初に `oauth.signIn` を置いておけば、そこでサインインできます。
- Studio のシークレットに「OAuth サインイン済み」と「サインアウト」が出ます。CLI は `shikigami secret logout <名前>`。Client ID を変えると古いトークンは使われず、シークレットを削除するとトークンも消えます。
- `list_secrets` では、トークンが保存されているシークレットに `signedIn: true` が付きます。

## 無人実行

画面なしの実行は人を待てません。まだ誰もサインインしていない（またはリフレッシュトークンが切れた）ときは、`oauth.signIn` が `HUMAN_REQUIRED` で止まります。一度だけ画面ありでサインインしておけば、無人実行はトークンを使い回し、更新します。

## エラーコード

| コード | 意味と直し方 |
|---|---|
| `OAUTH_SIGN_IN_REQUIRED` | そのシークレットに使えるトークンがない。要求の前に `oauth.signIn` を置く |
| `OAUTH_DENIED` | プロバイダがエラーを返した（`access_denied` は人が許可しなかった）。それ以外は Client ID・`redirectUrl`・`scope` をアプリの設定と見比べる |
| `OAUTH_STATE_MISMATCH` | この要求への答えではなかった。もう一度実行する |
| `OAUTH_TOKEN_FAILED` | トークンの URL が拒否した（`details.error`・`details.errorDescription`）。Client ID / secret・`tokenUrl`・`redirectUrl` を確かめる |
| `SECRET_SITE_NOT_SET` / `SECRET_SITE_MISMATCH` | トークンの URL や API がシークレットのサイトにない |
| `HUMAN_REQUIRED` / `HUMAN_TIMEOUT` | 人が必要だが画面がない / 時間内に終わらなかった |
