# Security Policy / セキュリティポリシー

## 報告のしかた

脆弱性は公開の Issue・Pull Request・Discussions には書かず、GitHub の [Report a vulnerability](https://github.com/d-shiina/shikigami/security/advisories/new)（非公開の報告）から送ってください。

*English: Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/d-shiina/shikigami/security/advisories/new), not in public issues. Japanese or English is fine.*

書いていただきたいこと：

- 影響を受けるバージョン（Studio の右上、または `shikigami --version`）
- 再現手順と、何ができてしまうか
- 回避策があればその内容

日本語・英語のどちらでも構いません。数日以内に受け取りの返信をし、修正の見込みをお知らせします。修正版を出すまでは内容を公開しないでください。

## 対象

最新のリリースだけを修正の対象にします（0.x の間は古い版への修正版は出しません）。

特に重要な領域：

- シークレット（資格情報）の保存と受け渡し、ログ・画面・AI への漏えい（[docs/secrets.md](docs/secrets.md)）
- MCP サーバーの許可レベル（`--allow`）の回避
- 自動更新（署名の検証）
- シナリオ・バンドル・プラグインのマニフェストを読み込んだだけで任意のコードが動くこと、ワークスペースの外のファイルに触れること

シナリオに書いた操作がそのまま実行されること自体（シナリオで `process.start` を使うなど）は脆弱性ではありません。他人から受け取ったシナリオは、実行前に中身を確認してください。
