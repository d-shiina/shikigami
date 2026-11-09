# 見本のカスタム ノード `googledrive`（Google ドライブ）

パソコン版 Google ドライブを入れていない PC や、サーバーで無人実行する PC からでも、Drive API で Google ドライブのファイルを扱うノードを追加します。Node.js、依存なし。Writer に同梱しています。

| ノード | すること |
|---|---|
| `googledrive.list`（Google ドライブのフォルダーの一覧） | フォルダーのファイルとフォルダーを返します。`pattern`（`*.xlsx`）で絞り込めます |
| `googledrive.download`（Google ドライブからダウンロード） | ファイルをこの PC に保存します。Google スプレッドシート・ドキュメント・スライドは Excel・Word・PowerPoint のファイルにします |
| `googledrive.downloadFolder`（Google ドライブのフォルダーをダウンロード） | フォルダーの直下にあるファイルを、この PC のフォルダーに保存します（例：`input`）。フローのフォルダーの入力を Google ドライブにしたとき、実行の前に使われます |
| `googledrive.upload`（Google ドライブにアップロード） | この PC のファイルをフォルダーに置きます。同じ名前があれば `overwrite: true` で中身を置き換えます（前の中身は版の履歴に残ります。50 MB まで） |

フォルダーとファイルは、「マイドライブ」からのパス（`経理/受注/受注.xlsx`）、ID、または Google ドライブで開いたときのアドレスで指定します。共有ドライブはアドレスか ID で指定します。

## 使う準備

1. Google Cloud コンソールでプロジェクトを作り、Google Drive API を有効にします。OAuth 同意画面を設定し、「認証情報」で OAuth クライアント ID（ウェブ アプリケーション）を作って、承認済みのリダイレクト URI を登録します
2. Writer の「シークレット」で、種類「OAuth」としてクライアント ID とクライアント シークレットを登録し、使ってよい先に `https://oauth2.googleapis.com`・`https://www.googleapis.com` と `plugin:googledrive` を入れます
3. フローの最初に「OAuth サインイン」（`oauth.signIn`）を置きます：`authorizeUrl: https://accounts.google.com/o/oauth2/v2/auth`、`tokenUrl: https://oauth2.googleapis.com/token`、`scope: https://www.googleapis.com/auth/drive`、`authorizeParams: { "access_type": "offline", "prompt": "consent" }`（これが無いとリフレッシュ トークンがもらえず、1 時間ごとにサインインが要ります）
4. ノードの「Google ドライブ のアカウント」で、同じシークレットを選びます（`{ "secret": "Google", "field": "accessToken" }`）

```powershell
spellsheet plugin check examples\plugins\googledrive
node --test examples\plugins\googledrive\test.mjs   # Drive API の代わりのサーバーで動作を確認
```
