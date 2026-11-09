# リリースとオンラインアップデート

[English](../release.md) | 日本語

インストール版の Writer は VS Code と同じように更新されます。起動時（または設定の「もう一度確認」）に新しいバージョンを確認し、裏でダウンロードしておき、インストーラーの画面を出さずに入れます。入るのは、設定の「再起動して更新」を押したとき（数秒で新しい版の Writer が開き直す）か、Writer を閉じたとき（次に開くと新しい版）です。更新が待っている間は、サイドバーの「設定」に点が付きます。仕組みは Tauri 公式の updater（`installMode: quiet`）です。

- 配布先：このリポジトリの GitHub Releases（`latest.json` とインストーラー）
- 確認先：`https://github.com/spellsheet/spellsheet/releases/latest/download/latest.json`
- 0.1.20 までの版は以前の場所 `https://github.com/d-shiina/spellsheet/...` を確認し、GitHub の移管後の転送で新しい場所に届きます。`d-shiina` の下に `spellsheet` という名前のリポジトリを作らないでください。転送が止まり、それらの版が更新できなくなります
- 改ざん防止：インストーラーは専用の署名鍵で署名し、Writer はリリース時に埋め込んだ公開鍵で検証してから入れ替える
- インストーラー：NSIS（ユーザー単位、管理者権限不要）
- 開発版（`pnpm studio:dev`）は確認しない

## CLI（MCP サーバー）も一緒に更新される

リリース版のインストーラーには `spellsheet.exe`（CLI・MCP サーバー）が Writer と同じフォルダーに入ります。Claude Code にはこの `spellsheet.exe` を登録しておけば、Writer を更新するたびに MCP サーバーも新しくなり、パスも変わりません。登録コマンドは Writer の「設定」→「AI」の「MCP サーバーの登録」でコピーできます。

```powershell
claude mcp add --scope user spellsheet -- "<インストール先>\spellsheet.exe" mcp
```

Claude Code が MCP サーバーを動かしている最中でも更新できます。Windows は実行中の exe を上書きできませんが名前の変更はできるので、Writer はインストーラーを起動する直前に `spellsheet.exe` を `spellsheet-<旧バージョン>.exe.old` に移します（同梱の `node\node.exe` も同じく `node-<旧バージョン>.exe.old` へ）。動いているサーバーは古いファイルのまま動き続け、次に起動したときから新しい版になります（Claude Code では `/mcp` から再接続）。残った `.old` は次回の Writer 起動時に消します。インストールが取り消された場合は元に戻します。

リポジトリから開発していて `target\debug\spellsheet.exe` を登録している場合は、これまでどおり `cargo build -p spellsheet-cli` で更新されます。

## 最初の準備（1 回だけ）

リポジトリのフォルダーで次を実行します。

```powershell
pnpm release:setup
```

署名鍵（パスワードなし）を `~\.tauri\spellsheet.key` に作り、GitHub に登録します。

- 秘密鍵 → Actions Secret `TAURI_SIGNING_PRIVATE_KEY`
- 公開鍵 → Actions Variable `TAURI_UPDATER_PUBKEY`（リリースのワークフローがアプリに埋め込みます）

GitHub CLI（`gh`）にログイン済みなら自動で登録します。`gh` がなければ、値をクリップボードに入れて登録ページを開くので、貼り付けて保存するだけです（2 回）。

**秘密鍵をなくすと、インストール済みの Writer に更新を届けられなくなります。** `spellsheet.key` はバックアップしておいてください。鍵にパスワードを付けたい場合は自分で作り、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` も Secret に登録します。

## リリースの手順

1. [CHANGELOG.md](../../CHANGELOG.md) の「未リリース」を版番号と日付の見出しにする（破壊的変更・非推奨は [compatibility.md](compatibility.md) §9）
1. ルートの `Cargo.toml` の `[workspace.package]` の `version` を上げる（Writer・CLI・MCP サーバーはこの 1 か所でバージョンが決まります）。`cargo check` で `Cargo.lock` も更新してコミット
2. 同じバージョンのタグを push する

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

   ターミナルを使わずに出すなら、GitHub の **Actions → Release → Run workflow**（ブランチは `main`）を押します。今の `main` に `Cargo.toml` のバージョンのタグを付けて公開します。そのタグがすでに別のコミットにあれば止まります
3. `Release` ワークフロー（`.github/workflows/release.yml`）が Windows でビルドし、Release を公開します。タグと `Cargo.toml` のバージョンが違うとき、署名鍵が登録されていないとき（上の「最初の準備」）は止まります
   - リリースノートは `CHANGELOG.md` のうち、見出しにそのバージョンがある節（例：`## [0.2.0] - 2026-11-06`）です。なければ `CHANGELOG.md` へのリンクになります
   - ハイフン付きのバージョン（`0.2.0-beta.1`）はプレリリースになり、インストール済みの Writer は更新しません
   - リリースには `spellsheet.mcpb`（MCP サーバーの [MCP Bundle](https://github.com/modelcontextprotocol/mcpb)。`spellsheet.exe` と、インストーラーと同じ `node\`・`browser-adapter\`・`ocr\` フォルダー）と、[MCP Registry](https://registry.modelcontextprotocol.io/) に載せるための `server.json`（Bundle の SHA-256 入り）も付きます（`scripts/build-mcpb.mjs`）
   - インストーラーは実行結果のページにも `installers-<バージョン>` として 14 日間残ります
4. MCP Registry に載せるには、リリースから `server.json` をダウンロードし、[`mcp-publisher`](https://github.com/modelcontextprotocol/registry/releases) で `mcp-publisher login github` のあと、`server.json` のあるフォルダーで `mcp-publisher publish` を実行します。名前 `io.github.<持ち主>/spellsheet` はリポジトリの持ち主で決まるため、サインインするアカウントはその GitHub Organization の公開メンバーである必要があります

リリースのビルドを変える Pull Request（ワークフロー・`apps/studio/scripts/`・Tauri の設定）では、同じビルドを試しに走らせます。何も公開せず、インストーラーを実行結果のページに残すので、タグを付ける前に手で入れて確かめられます。署名鍵がなければ使い捨ての鍵で署名します。

公開した時点で、インストール済みの Writer は次の起動時に更新を見つけます。

## 製品サイト（GitHub Pages）

`site/` が製品紹介ページとダウンロードページです（日本語、ビルド不要のふつうの HTML）。https://spellsheet.github.io/ で、[spellsheet/spellsheet.github.io](https://github.com/spellsheet/spellsheet.github.io) リポジトリが配信します。そちらのワークフローが 15 分ごとにこのリポジトリを見て、`site/`・マニュアル・最新のリリースのどれかが変わっていれば配信し直します（すぐ出したいときはその Deploy を手で走らせます）。そのとき `release.json` に最新のインストーラーを書くので、ダウンロードボタンはその `SpellSheet.Writer_<版>_x64-setup.exe` を直接指します。ページは GitHub の API でも最新版を確かめ、どちらも取れないときはリリースのページへつなぎます。このリポジトリ自身のページ（以前のアドレス https://spellsheet.github.io/spellsheet/）は、新しいアドレスへ飛ばすだけです（`.github/workflows/pages.yml`・`site-moved/`）。

## 手元でリリース版を作る

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $HOME\.tauri\spellsheet.key
pnpm studio:release
```

公開鍵は `~\.tauri\spellsheet.key.pub` から読みます。

`pnpm studio:build` は CLI・Node.js を同梱せず署名もしない、試し用のビルドです。

## Node.js とブラウザアダプターの同梱

ブラウザ操作と Node のプラグインが、Node.js を入れていない PC（入れられない会社の PC を含む）でも動くよう、インストーラーには次のものが Writer と同じフォルダーに入ります。

| フォルダー | 中身 |
|---|---|
| `node\` | `node.exe` と Node.js のライセンス（npm などは入れない） |
| `browser-adapter\` | ブラウザアダプター（`src\*.ts`）と `playwright-core` |

- `pnpm studio:bundle-node`（`apps/studio/scripts/bundle-node.mjs`）が nodejs.org から公式の Windows 版 zip を取り、スクリプトに書いた SHA-256 と照合してから `apps/studio/src-tauri/bundled/` に置きます。ダウンロードは `target/node-dist/` にキャッシュします。Windows では置いた Node.js でアダプターが起動することまで確かめます
- Node.js の版は LTS に固定しています（今は 24.22.1）。上げるときはスクリプトの `NODE_VERSION` と `NODE_SHA256`（その版の `SHASUMS256.txt` の `win-x64.zip` / `win-arm64.zip`）を一緒に書き換えます
- ブラウザ本体は同梱しません。Windows に最初から入っている Edge を Playwright が使います
- 使う Node.js の優先順は `SPELLSHEET_NODE` → 実行ファイルの横の `node\node.exe` → PATH の `node`。開発版は横に `node\` がないので、これまでどおり PATH の Node.js を使います
- 配布サイズはインストーラーで数十 MB 増えます（`node.exe` が約 90 MB、圧縮後はその 1/3 程度）

## 注意

- インストーラーはコード署名（Authenticode）をしていないため、初回インストール時に SmartScreen の警告が出ます。更新は Writer 内で行うので警告は出ません
- 最初の 1 回（更新機能の入った版）は Releases からインストーラーを手で入れてください
