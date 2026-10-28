# リリースとオンラインアップデート

インストール版の Studio は、起動時に新しいバージョンがないか確認し、右上のバージョン表示から「更新して再起動」で更新できます。仕組みは Tauri 公式の updater です。

- 配布先：このリポジトリの GitHub Releases（`latest.json` とインストーラー）
- 確認先：`https://github.com/d-shiina/shikigami/releases/latest/download/latest.json`
- 改ざん防止：インストーラーは専用の署名鍵で署名し、Studio はリリース時に埋め込んだ公開鍵で検証してから入れ替える
- インストーラー：NSIS（ユーザー単位、管理者権限不要）。MSI も Releases に置くが、自動更新は NSIS 版で行う
- 開発版（`pnpm studio:dev`）は確認しない

## CLI（MCP サーバー）も一緒に更新される

リリース版のインストーラーには `shikigami.exe`（CLI・MCP サーバー）が Studio と同じフォルダーに入ります。Claude Code にはこの `shikigami.exe` を登録しておけば、Studio を更新するたびに MCP サーバーも新しくなり、パスも変わりません。登録コマンドは Studio 右上のバージョン表示を開くとコピーできます。

```powershell
claude mcp add --scope user shikigami -- "<インストール先>\shikigami.exe" mcp
```

Claude Code が MCP サーバーを動かしている最中でも更新できます。Windows は実行中の exe を上書きできませんが名前の変更はできるので、Studio はインストーラーを起動する直前に `shikigami.exe` を `shikigami-<旧バージョン>.exe.old` に移します（同梱の `node\node.exe` も同じく `node-<旧バージョン>.exe.old` へ）。動いているサーバーは古いファイルのまま動き続け、次に起動したときから新しい版になります（Claude Code では `/mcp` から再接続）。残った `.old` は次回の Studio 起動時に消します。インストールが取り消された場合は元に戻します。

リポジトリから開発していて `target\debug\shikigami.exe` を登録している場合は、これまでどおり `cargo build -p shikigami-cli` で更新されます。

## 最初の準備（1 回だけ）

リポジトリのフォルダーで次を実行します。

```powershell
pnpm release:setup
```

署名鍵（パスワードなし）を `~\.tauri\shikigami.key` に作り、GitHub に登録します。

- 秘密鍵 → Actions Secret `TAURI_SIGNING_PRIVATE_KEY`
- 公開鍵 → Actions Variable `TAURI_UPDATER_PUBKEY`（リリースのワークフローがアプリに埋め込みます）

GitHub CLI（`gh`）にログイン済みなら自動で登録します。`gh` がなければ、値をクリップボードに入れて登録ページを開くので、貼り付けて保存するだけです（2 回）。

**秘密鍵をなくすと、インストール済みの Studio に更新を届けられなくなります。** `shikigami.key` はバックアップしておいてください。鍵にパスワードを付けたい場合は自分で作り、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` も Secret に登録します。

## リリースの手順

1. [CHANGELOG.md](../CHANGELOG.md) の「未リリース」を版番号と日付の見出しにする（破壊的変更・非推奨は [compatibility.md](compatibility.md) §9）
1. ルートの `Cargo.toml` の `[workspace.package]` の `version` を上げる（Studio・CLI・MCP サーバーはこの 1 か所でバージョンが決まります）。`cargo check` で `Cargo.lock` も更新してコミット
2. 同じバージョンのタグを push する

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. `Release` ワークフロー（`.github/workflows/release.yml`）が Windows でビルドし、Release を公開します。タグと `Cargo.toml` のバージョンが違うと止まります

公開した時点で、インストール済みの Studio は次の起動時に更新を見つけます。

## 手元でリリース版を作る

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $HOME\.tauri\shikigami.key
pnpm studio:release
```

公開鍵は `~\.tauri\shikigami.key.pub` から読みます。

`pnpm studio:build` は CLI・Node.js を同梱せず署名もしない、試し用のビルドです。

## Node.js とブラウザアダプターの同梱

ブラウザ操作と Node のプラグインが、Node.js を入れていない PC（入れられない会社の PC を含む）でも動くよう、インストーラーには次のものが Studio と同じフォルダーに入ります。

| フォルダー | 中身 |
|---|---|
| `node\` | `node.exe` と Node.js のライセンス（npm などは入れない） |
| `browser-adapter\` | ブラウザアダプター（`src\*.ts`）と `playwright-core` |

- `pnpm studio:bundle-node`（`apps/studio/scripts/bundle-node.mjs`）が nodejs.org から公式の Windows 版 zip を取り、スクリプトに書いた SHA-256 と照合してから `apps/studio/src-tauri/bundled/` に置きます。ダウンロードは `target/node-dist/` にキャッシュします。Windows では置いた Node.js でアダプターが起動することまで確かめます
- Node.js の版は LTS に固定しています（今は 24.22.1）。上げるときはスクリプトの `NODE_VERSION` と `NODE_SHA256`（その版の `SHASUMS256.txt` の `win-x64.zip` / `win-arm64.zip`）を一緒に書き換えます
- ブラウザ本体は同梱しません。Windows に最初から入っている Edge を Playwright が使います
- 使う Node.js の優先順は `SHIKIGAMI_NODE` → 実行ファイルの横の `node\node.exe` → PATH の `node`。開発版は横に `node\` がないので、これまでどおり PATH の Node.js を使います
- 配布サイズはインストーラーで数十 MB 増えます（`node.exe` が約 90 MB、圧縮後はその 1/3 程度）

## 注意

- インストーラーはコード署名（Authenticode）をしていないため、初回インストール時に SmartScreen の警告が出ます。更新は Studio 内で行うので警告は出ません
- 最初の 1 回（更新機能の入った版）は Releases からインストーラーを手で入れてください
