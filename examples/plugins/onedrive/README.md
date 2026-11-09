# 見本のカスタム ノード `onedrive`（OneDrive・SharePoint）

OneDrive アプリで同期していない PC や、サーバーで無人実行する PC からでも、Microsoft Graph で OneDrive と SharePoint のファイルを扱うノードを追加します。Node.js、依存なし。Writer に同梱しています。

| ノード | すること |
|---|---|
| `onedrive.list`（OneDrive のフォルダーの一覧） | フォルダーのファイルとフォルダーを返します。`pattern`（`*.xlsx`）で絞り込めます |
| `onedrive.download`（OneDrive からダウンロード） | ファイルをこの PC に保存します |
| `onedrive.upload`（OneDrive にアップロード） | この PC のファイルをフォルダーに置きます。同じ名前があれば `overwrite: true` で置き換えます（前のものは版の履歴に残ります）。4 MB を超えるファイルは分けて送ります（50 MB まで） |

フォルダーとファイルは、サインインした人の OneDrive からのパス（`経理/受注/受注.xlsx`）か、OneDrive・SharePoint で「リンクのコピー」をしたリンクで指定します。SharePoint のドキュメント ライブラリは、リンクで指定します（ブラウザーで開いたときのアドレスでも動くことがあります）。

## 使う準備

1. Microsoft Entra 管理センターの「アプリの登録」でアプリを作ります。リダイレクト URI は「Web」として登録し、クライアント シークレットを作ります。API のアクセス許可に Microsoft Graph の委任されたアクセス許可 `Files.ReadWrite.All`・`Sites.ReadWrite.All`・`offline_access` を足し、必要なら管理者の同意を与えます
2. Writer の「シークレット」で、種類「OAuth」としてクライアント ID とクライアント シークレットを登録し、使ってよい先に `https://login.microsoftonline.com`・`https://graph.microsoft.com` と `plugin:onedrive` を入れます
3. フローの最初に「OAuth サインイン」（`oauth.signIn`）を置きます：`authorizeUrl: https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize`、`tokenUrl: https://login.microsoftonline.com/organizations/oauth2/v2.0/token`、`scope: offline_access Files.ReadWrite.All Sites.ReadWrite.All`（会社のテナントだけで使うなら `organizations` をテナント ID にします）
4. ノードの「Microsoft のアカウント」で、同じシークレットを選びます（`{ "secret": "Microsoft", "field": "accessToken" }`）

```powershell
spellsheet plugin check examples\plugins\onedrive
node --test examples\plugins\onedrive\test.mjs   # Graph の代わりのサーバーで動作を確認
```
