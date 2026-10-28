# Adding apps (adapters)

English | [日本語](ja/adapters.md)

The apps Shikigami can drive grow by "adapter". Today there are browsers (`browser.*`, [browser.md](browser.md)), Windows desktop apps (`desktop.*`, [desktop.md](desktop.md)), files and folders (`file.*`, [files.md](files.md)), Excel workbooks, Word documents and mail (`excel.*` / `word.*` / `mail.*`, [office.md](office.md)), web APIs, programs, the clipboard and dialogs (`http.*` / `process.*` / `clipboard.*` / `dialog.*`, [system.md](system.md)), and reading the text of PDFs (`pdf.*`, [pdf.md](pdf.md)).

To add steps without rebuilding Shikigami (in-house systems, a particular SaaS…), write a **plugin** instead of a built-in adapter: a folder with a manifest (`shikigami-plugin.json`) and a program, in any language. How it works: [design/plugins.md](design/plugins.md) (Japanese); example: `examples/plugins/hello`.

Adapters are made per thing being operated, not per app technology (Win32 / WPF / SAP GUI / Java…). Desktop apps are written with one set of `desktop.*` steps, and the adapter decides from the target window which technology to look inside it with (`crates/shikigami-desktop/src/engine.rs`). That keeps the number of ways the AI has to learn small.

## What an adapter provides

1. **Step type definitions** (`StepTypeDef`): type names are `<adapter>.<action>` (e.g. `excel.writeCell`).
   - The JSON Schema of the params, with descriptions (English the AI reads is fine)
   - Examples to copy (`examples`)
   - Resource declarations (`resources`): which params point at a file, a window or a browser context. For example `ResourceDef::file("path")` makes actions on the same workbook run one at a time while different workbooks run in parallel
2. **A handler** (`ActionHandler`): receives the params with templates expanded, does the work, and returns a value. Timeouts, retries, cancellation and `onError` are handled uniformly by the Runtime. Failures are returned as a `StepError` (code, whether it is retryable, hints for fixing it in `details`)
3. **An `Adapter` implementation** (`crates/shikigami-runtime/src/adapter.rs`)
   - `name()`: the type name prefix
   - `install()`: registers the step types and handlers, and cleanup when a run ends (`on_run_finished`)
   - `inspect()` (optional): what the app shows right now, for the AI. MCP's `test_step` attaches it after running a step
4. **Registration**: add one line to `all()` in `crates/shikigami-adapters/src/lib.rs`. The CLI, the MCP server and Studio all build their Runtime from there, so nothing else needs touching

With that, validation and hints, `list_step_types` / `get_step_schema` (the list and examples for the AI), `test_step` and Studio's input forms come for free.

## Using a library in another language (sidecar)

For non-Rust libraries such as Playwright (Node.js), run them as a child process and talk newline-delimited JSON-RPC 2.0. `shikigami_runtime::sidecar::SidecarClient` handles the transport, crash detection and automatic restarts, so the adapter only describes how to start it (`SidecarConfig`) and maps the methods. Errors returned as `error.data = { code, retryable, details }` become step errors as they are.

Example: `crates/shikigami-browser` (the Rust side, about 400 lines) and `packages/browser-adapter` (the Node.js side).

## Office (Excel and others)

Excel is `excel.*` (`crates/shikigami-excel`), which reads and writes xlsx directly: no Excel needed, fast, and suited to parallel and unattended runs. The workbook path is a resource, so the same workbook queues up automatically. Only what needs Excel itself, such as running macros, goes through COM. Approach and plans (Word, mail): [office.md](office.md).

## Adapters that call Windows APIs

The workspace forbids `unsafe`. A crate that calls Windows APIs carries its own `[lints]` in Cargo.toml (`unsafe_code = "deny"`) and allows `#![allow(unsafe_code)]` in the single module that calls the API (e.g. `uia.rs` in `shikigami-desktop`). Off Windows that module is left out with `#[cfg(windows)]` and the steps return `PLATFORM_UNSUPPORTED`, so definitions, validation and tests still run in Linux CI.
