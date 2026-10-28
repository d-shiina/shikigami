# リリースとオンラインアップデート

[English](../release.md) | 日本語

インストール版の Studio は、起動時に新しいバージョンがないか確認し、右下のバージョン表示から「更新して再起動」で更新できます。仕組みは Tauri 公式の updater です。

- 配布先：このリポジトリの GitHub Releases（`latest.json` とインストーラー）
- 確認先：`https://github.com/d-shiina/shikigami/releases/latest/download/latest.json`
- 改ざん防止：インストーラーは専用の署名鍵で署名し、Studio はリリース時に埋め込んだ公開鍵で検証してから入れ替える
- インストーラー：NSIS（ユーザー単位、管理者権限不要）。MSI も Releases に置くが、自動更新は NSIS 版で行う
- 開発版（`pnpm studio:dev`）は確認しない

## CLI（MCP サーバー）も一緒に更新される

リリース版のインストーラーには `shikigami.exe`（CLI・MCP サーバー）が Studio と同じフォルダーに入ります。Claude Code にはこの `shikigami.exe` を登録しておけば、Studio を更新するたびに MCP サーバーも新しくなり、パスも変わりません。登録コマンドは Studio 右下のバージョン表示を開くとコピーできます。

```powershell
claude mcp add --scope user shikigami -- "<インストール先>\shikigami.exe" mcp
```

Claude Code が MCP サーバーを動かしている最中でも更新できます。Windows は実行中の exe を上書きできませんが名前の変更はできるので、Studio はインストーラーを起動する直前に `shikigami.exe` を `shikigami-<旧バージョン>.exe.old` に移します。動いているサーバーは古いファイルのまま動き続け、次に起動したときから新しい版になります（Claude Code では `/mcp` から再接続）。残った `.old` は次回の Studio 起動時に消します。インストールが取り消された場合は元に戻します。

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

`pnpm studio:build` は CLI を同梱せず署名もしない、試し用のビルドです。

## 注意

- インストーラーはコード署名（Authenticode）をしていないため、初回インストール時に SmartScreen の警告が出ます。更新は Studio 内で行うので警告は出ません
- 最初の 1 回（更新機能の入った版）は Releases からインストーラーを手で入れてください
