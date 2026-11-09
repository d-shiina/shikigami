# 見本の拡張機能 `box`（Box）

Box Drive を入れていない PC や、サーバーで無人実行する PC からでも、Box API で Box のファイルを扱うノードを追加します。Node.js、依存なし。

| ノード | すること |
|---|---|
| `box.list`（Box のフォルダーの一覧） | フォルダーのファイルとフォルダーを返します。`pattern`（`*.xlsx`）で絞り込めます |
| `box.download`（Box からダウンロード） | ファイルをこの PC に保存します（例：`input/受注.xlsx`） |
| `box.downloadFolder`（Box のフォルダーをダウンロード） | フォルダーの直下にあるファイルを、この PC のフォルダーに保存します（例：`input`）。フローのフォルダーの入力を Box にしたとき、実行の前に使われます |
| `box.upload`（Box にアップロード） | この PC のファイルを Box のフォルダーに置きます。同じ名前があれば `overwrite: true` で新しい版にします（50 MB まで） |

フォルダーとファイルは、ID か「すべてのファイル」からのパス（`経理/受注/受注.xlsx`）で指定します。

## 使う準備

1. Box の開発者コンソールでアプリ（ユーザー認証 OAuth 2.0）を作り、リダイレクト URL を登録します。スコープは「すべてのファイルとフォルダーの読み取り・書き込み」です
2. Writer の「シークレット」で、種類「OAuth」としてクライアント ID とクライアント シークレットを登録し、使ってよい先に `https://api.box.com` と `plugin:box` を入れます
3. フローの最初に「OAuth サインイン」（`oauth.signIn`、`authorizeUrl: https://account.box.com/api/oauth2/authorize`、`tokenUrl: https://api.box.com/oauth2/token`）を置きます。最初の 1 回だけ人がブラウザでサインインし、あとは自動で取り直します（[docs/ja/oauth.md](../../../docs/ja/oauth.md)）
4. Box のノードの「Box のアカウント」で、同じシークレットを選びます（`{ "secret": "Box", "field": "accessToken" }`）

アクセストークンは SpellSheet が期限の前に取り直してからノードに渡します。このノードはクライアント シークレットもリフレッシュ トークンも受け取りません。トークンは PC ごとに持つので、無人実行する PC でも最初に 1 回サインインしてください。

```powershell
spellsheet plugin check examples\plugins\box
spellsheet plugin install examples\plugins\box --yes
node --test examples\plugins\box\test.mjs   # Box の代わりのサーバーで動作を確認
```

- `spellsheet-plugin.json`：ノードの宣言（OAuth のシークレット `credentials`、ファイル `pathParams`、外部送信 `external`）
- `main.mjs`：Box API への要求（パスから ID を引く、ダウンロードは丸ごと書いてから置き換え、同じ名前のときは新しい版）
- `test.mjs`：Box の代わりのサーバーを立てて動作を確認するテスト
