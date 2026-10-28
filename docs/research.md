# 技術調査（2026-10-28 時点）

公式レジストリ（crates.io / npm）と公式ドキュメントで確認した内容のみを記載する。確認できなかった事項は「未確認」と明記し、推測で補完しない。

## 1. 採用ライブラリのバージョンとライセンス

### Rust（crates.io で確認）

| クレート | バージョン | ライセンス | MSRV | 用途 / 備考 |
|---|---|---|---|---|
| tauri | 2.12.5 | Apache-2.0 OR MIT | 1.90 | Desktop Framework |
| tauri-build | 2.7.4 | Apache-2.0 OR MIT | 1.90 | |
| rmcp | 3.8.0 | Apache-2.0 | 1.88 | **公式** Rust MCP SDK（modelcontextprotocol/rust-sdk）。Phase 2 で使用 |
| windows | 0.62.2 | MIT OR Apache-2.0 | 1.82 | Microsoft 公式 windows-rs。Phase 4 で使用 |
| uiautomation | 0.25.1 | Apache-2.0 | 未記載 | 個人メンテの UIA ラッパー。参考実装として扱い、直接依存はしない（後述） |
| tokio | 1.54.1 | MIT | 1.85 | Async Runtime |
| tokio-util | 0.7.20 | MIT | 1.85 | CancellationToken |
| serde / serde_json | 1.0.229 / 1.0.154 | MIT OR Apache-2.0 | | |
| schemars | 1.2.3 | MIT | 1.74 | Rust 型 → JSON Schema 生成 |
| jsonschema | 0.60.2 | MIT | 1.85 | パラメーターの JSON Schema 検証 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | | |
| tracing / tracing-subscriber | 0.1.44 / 0.3.23 | MIT | | |
| notify | 8.2.1 | CC0-1.0 | 1.85 | Studio のファイル監視 |
| uuid | 1.29.0 | Apache-2.0 OR MIT | 1.89 | UUIDv7 による ID |
| time | 0.3.55 | MIT OR Apache-2.0 | 1.88 | |
| clap | 4.6.7 | MIT OR Apache-2.0 | 1.85 | CLI |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | | アトミック書き込み |
| dirs | 7.0.0 | MIT OR Apache-2.0 | | 既定ワークスペースの場所 |
| rusqlite | 0.41.0 | MIT | 1.89 | SQLite（Phase 2 以降で導入予定、Phase 1 では未使用） |

ワークスペースの MSRV は Tauri に合わせて **Rust 1.90**。ファイルロックは Rust 1.89 で安定化した `std::fs::File::lock` を使用し、追加クレート（fs4 等）を不要にした。

### npm（npm registry で確認）

| パッケージ | バージョン | ライセンス | Node 要件 |
|---|---|---|---|
| @tauri-apps/api / @tauri-apps/cli | 2.12.4 | Apache-2.0 OR MIT | |
| react / react-dom | 19.3.1 | MIT | |
| @xyflow/react | 12.12.0 | MIT | |
| zustand | 5.0.16 | MIT | |
| tailwindcss / @tailwindcss/vite | 4.3.3 | MIT | |
| vite | 8.3.5 | MIT | ^20.19 または >=22.12 |
| @vitejs/plugin-react | 6.1.2 | MIT | 同上 |
| typescript | 7.0.2 | Apache-2.0 | ネイティブ実装版 tsc |
| vitest | 5.0.5 | MIT | ^22.12 / ^24 / >=26 |
| playwright / @playwright/test | 1.64.1 | Apache-2.0 | >=20（Phase 3） |
| @modelcontextprotocol/sdk | 1.32.2 | MIT | 参考（MCP サーバーは Rust で実装） |
| json-schema-to-typescript | 16.0.0 | MIT | JSON Schema → TS 型生成 |

開発環境の Node は **22 LTS** を前提とする（Vite 8 / Vitest 5 の要件を満たす）。

## 2. ライセンス上の注意点

- **evalexpr（式評価クレート）は 13.x で AGPL-3.0-only に変更されている。** 商用製品に組み込むとソース開示義務が生じ得るため採用しない。代わりに自前の小さな式言語（`shikigami-core::expr`）を実装した。
- React Flow（@xyflow/react）は MIT。キャンバス右下の「React Flow」表記は法的義務ではないが、開発元は Pro 契約なしでの非表示を推奨していないため、Phase 1 では表示したままにしている。商用リリース前に方針を決める。
- notify は CC0-1.0（パブリックドメイン相当）で問題なし。
- 依存ライセンスの自動監査（cargo-deny / license-checker）は Phase 2 で CI に追加する。

## 3. Windows 対応状況

製品の対象 OS は Windows 10/11（x64）のみ（[architecture.md 判断9](architecture.md#判断9windows-特化os-の抽象化レイヤーは作らない)）。

### Tauri 2 の Windows 前提条件（公式 Prerequisites ページで確認）

- **Microsoft C++ Build Tools**（ワークロード「Desktop development with C++」）。Visual Studio IDE 本体は不要。
- **WebView2**：Windows 10 1803 以降および Windows 11 には標準搭載。無い場合は Evergreen Bootstrapper で導入。
- **Rust MSVC ツールチェーン**：`x86_64-pc-windows-msvc` 等を既定にする（`rustup default stable-msvc`）。
- MSI を作る場合のみ VBSCRIPT のオプション機能が必要（`light.exe` 失敗時）。

Windows SDK は C++ Build Tools の「Desktop development with C++」ワークロードに既定で含まれるが、個別に外した場合は `windows` クレートのリンクで失敗するため、セットアップ手順で明示する。

### UI Automation のスレッドモデル（Microsoft Learn「Understanding Threading Issues」で確認）

- UIA クライアントは **ウィンドウを持たない専用スレッド** から呼び出し、そのスレッドは `CoInitializeEx(COINIT_MULTITHREADED)` で **MTA** に参加させる。
- 自プロセスの UI スレッドから UIA を呼ぶと、極端な遅延や応答停止が起きうる（Studio 自身の画面も検査対象になるため重要）。
- イベントハンドラーの登録・解除は同じ MTA スレッドで行う。複数スレッドから同時に登録・解除しない。
- 64bit 環境で他スレッドへマーシャリングした要素は、元のアパートメント終了で無効化されうるため、エラーを前提に扱う。

→ Phase 4 の Windows Adapter は「専用 MTA ワーカースレッド＋要求キュー」方式とする（[architecture.md](architecture.md#41-windows-adapter)）。

### Playwright

- Node.js 版 1.64.1、Node 20 以上が必要。Windows / macOS / Linux を公式サポート。
- 製品配布：Node.js の実行ファイルとアダプターをインストーラーに同梱し、ブラウザは Windows の Edge を使う（同梱しない）と決定。詳細は [release.md](release.md#nodejs-とブラウザアダプターの同梱)。

## 4. MCP

- 公式 Rust SDK `rmcp` 3.8.0 は MCP 仕様 **2026-07-28** を実装し、2025-11-25 以前とも互換（README で確認）。
- トランスポート：stdio（`transport-io`）、Streamable HTTP サーバー（`transport-streamable-http-server`）等。旧 HTTP+SSE（2024-11-05）は提供されない。
- `#[tool_router]` / `#[tool]` マクロと schemars によりツールの入力スキーマを自動生成できる。
- Phase 2 で確認：rmcp 3.8.0 のクライアントからの全ツール呼び出し（自動テスト）、Claude Code CLI 2.1.312 での `claude mcp add` 登録と接続ヘルスチェック成功（プロトコル 2025-06-18 で初期化）。Codex / Cursor からの接続は未確認。
- Claude Code プラグインの形式（`.claude-plugin/plugin.json`、`.mcp.json`、`skills/<name>/SKILL.md`、マーケットプレイスの `.claude-plugin/marketplace.json`）は `claude plugin validate` で検証済み。

## 5. 名前の衝突確認

- crates.io / npm の素の `shikigami` は小規模な個人プロジェクトが使用中（crates.io: Jujutsu 用 TUI、npm: AI エージェントツール）。著名プロジェクトとの衝突は見つからなかった。
- 本プロジェクトのクレートは `shikigami-*`、npm パッケージは `@shikigami/*`（private）とする。
