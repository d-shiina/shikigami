# Contributing / 貢献のしかた

Shikigami は [Apache License 2.0](LICENSE) で公開している OSS です。Issue・Pull Request を歓迎します。

*English summary: Shikigami is licensed under Apache-2.0. Contributions are accepted under the same license, and every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`). Read [docs/compatibility.md](docs/compatibility.md) before changing a public contract, and add an entry to [CHANGELOG.md](CHANGELOG.md) for user-visible changes.*

## ライセンスと DCO

送っていただいた変更は、このリポジトリと同じ Apache License 2.0 で公開されます（ライセンス §5）。別途の契約書（CLA）はありません。その代わり、各コミットに [Developer Certificate of Origin 1.1](https://developercertificate.org/) への同意を示す行を付けてください。

```text
Signed-off-by: 山田 太郎 <taro@example.com>
```

`git commit -s` で自動的に付きます。名前とメールはコミットの作者と同じものにしてください。付け忘れたときは `git commit --amend -s`（複数なら `git rebase --signoff main`）で付け直して push し直します。外部からの Pull Request は CI（DCO）で確認します。

DCO の要点は「この変更を自分が書いた、または OSS として出してよい権利があり、Apache-2.0 で公開されることに同意する」ことです。会社の業務として書いたコードを送るときは、会社の許可を確認してください。

## 変更の前に

- **公開している約束を変えるとき**（シナリオのファイル形式、ステップ型の params、MCP のツール、CLI のコマンド・終了コード・`--json` の出力）は [docs/compatibility.md](docs/compatibility.md) に従ってください。`schemas/` の生成物が変わる Pull Request は、[CHANGELOG.md](CHANGELOG.md) の「未リリース」にも書く必要があります（CI で確認します）
- 仕様は「AI が組みやすいこと」を最優先にしています（[docs/design/ai-authoring.md](docs/design/ai-authoring.md)）
- 対象 OS は Windows 10/11 です。macOS / Linux 対応の変更は受け付けていません（Linux の CI はコアのテスト用です）
- 大きな変更は、先に Issue で相談してください

## 開発

```powershell
pnpm install
pnpm studio:dev          # Studio
cargo test --workspace   # Rust のテスト
pnpm -r test             # TypeScript のテスト
pnpm schema:generate     # Rust の型を変えたら JSON Schema と TypeScript の型を作り直す
```

CI では `cargo fmt --check`、`cargo clippy -- -D warnings`、テスト、生成物のズレの確認を行います。

## 脆弱性の報告

公開の Issue には書かず、[SECURITY.md](SECURITY.md) の方法で連絡してください。
