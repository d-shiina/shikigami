# アプリを追加する（アダプター）

Shikigami が操作できるアプリは「アダプター」単位で増やします。ブラウザ（`browser.*`）が最初の 1 つで、Excel や業務アプリも同じ形で足します。

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

## Excel の予定

- **ファイル操作**（`excel.*`、Excel 不要）：xlsx を直接読み書き。速く、並列・無人実行向き。ブックのパスを資源にするので同じブックは自動で順番待ち
- **Excel アプリ操作**（COM）：マクロや既存の数式をそのまま使いたい場合。Windows 操作（Phase 4）と同じ専用スレッドの設計で作る
