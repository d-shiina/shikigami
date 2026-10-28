# アプリを追加する（アダプター）

[English](../adapters.md) | 日本語

Shikigami が操作できるアプリは「アダプター」単位で増やします。いまはブラウザ（`browser.*`、[browser.md](browser.md)）、Windows のデスクトップアプリ（`desktop.*`、[desktop.md](desktop.md)）、ファイル・フォルダー（`file.*`、[files.md](files.md)）、Excel のブック（`excel.*`、[office.md](office.md)）、Web API・プログラム・クリップボード・ダイアログ（`http.*` / `process.*` / `clipboard.*` / `dialog.*`、[system.md](system.md)）があります。

本体を作り直さずに足したいとき（社内システムや個別の SaaS など）は、組込のアダプターではなく**プラグイン**にします。フォルダにマニフェスト（`shikigami-plugin.json`）とプログラムを置くだけで、言語は自由です。仕組みは [design/plugins.md](../design/plugins.md)、例は `examples/plugins/hello`。

アダプターは「操作の対象」ごとに作り、アプリの作りの違い（Win32 / WPF / SAP GUI / Java など）では分けません。デスクトップアプリは `desktop.*` の 1 セットで書き、どの技術でアプリの中を見るかはアダプターの中で対象のウィンドウから決めます（`crates/shikigami-desktop/src/engine.rs`）。AI が覚える書き方を増やさないためです。

## アダプターが用意するもの

1. **ステップ型の定義**（`StepTypeDef`）：型名は `<アダプター名>.<操作>`（例 `excel.writeCell`）。
   - params の JSON Schema と説明（AI が読む英語の説明でよい）
   - コピーして使える記述例（`examples`）
   - 資源の宣言（`resources`）：どの params がファイル・ウィンドウ・ブラウザの作業領域を指すか。たとえば `ResourceDef::file("path")` と書けば、同じブックへの操作は自動で 1 つずつになり、別のブックは並行に動く
2. **ハンドラー**（`ActionHandler`）：テンプレート展開済みの params を受け取って操作し、値を返すだけ。タイムアウト・リトライ・キャンセル・`onError` は Runtime が一律に処理する。失敗は `StepError`（コード・再試行可否・`details` に直し方のヒント）で返す
3. **`Adapter` の実装**（`crates/shikigami-runtime/src/adapter.rs`）
   - `name()`：型名の接頭辞
   - `install()`：ステップ型とハンドラーの登録、実行終了時の後片付け（`on_run_finished`）
   - `inspect()`（任意）：いまアプリに何が映っているかを AI 向けに返す。MCP の `test_step` は実行後にこれを付けて返す
4. **一覧への登録**：`crates/shikigami-adapters/src/lib.rs` の `all()` に 1 行足す。CLI・MCP サーバー・Studio はすべてここから Runtime を作るので、ほかに触る場所はない

これだけで、検証とヒント、`list_step_types` / `get_step_schema`（AI 向けの一覧と記述例）、`test_step`、Studio の入力フォームが自動で付きます。

## 別の言語のライブラリを使う（サイドカー）

Playwright（Node.js）のように Rust 以外のライブラリを使うときは、子プロセスとして動かして改行区切りの JSON-RPC 2.0 で話します。通信・異常終了の検知・自動再起動は `shikigami_runtime::sidecar::SidecarClient` が持っているので、アダプター側は起動方法（`SidecarConfig`）とメソッドの対応を書くだけです。エラーは `error.data = { code, retryable, details }` で返すと、そのままステップのエラーになります。

例：`crates/shikigami-browser`（Rust 側、約 400 行）と `packages/browser-adapter`（Node.js 側）。

## Office（Excel など）

Excel は `excel.*`（`crates/shikigami-excel`）で、xlsx を直接読み書きします。Excel 不要で速く、並列・無人実行向きです。ブックのパスを資源にするので同じブックは自動で順番待ちになります。マクロの実行など Excel 本体が要る操作だけを COM で足します。方式と予定（Word・メール）は [office.md](office.md)。

## Windows API を使うアダプター

ワークスペースは `unsafe` を禁止しています。Windows API を呼ぶクレートは Cargo.toml の `[lints]` を自前で持ち（`unsafe_code = "deny"`）、API を呼ぶ 1 つのモジュールだけで `#![allow(unsafe_code)]` にします（例：`shikigami-desktop` の `uia.rs`）。Windows 以外ではそのモジュールを `#[cfg(windows)]` で外し、ステップは `PLATFORM_UNSUPPORTED` を返すようにして、定義・検証・テストは Linux の CI でも回します。
