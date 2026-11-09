//! Steps that reach outside the flow but not into an application:
//! web APIs (`http.request`), command-line programs (`process.run`), the
//! clipboard (`clipboard.*`) and dialogs for the person at the PC
//! (`dialog.*`). See docs/system.md.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use serde_json::{Value, json};
use spellsheet_core::policy::TargetDef;
use spellsheet_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use spellsheet_core::resource::ResourceDef;
use spellsheet_core::secret::token_or_secret_schema;
use spellsheet_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};

mod desktop;
/// The clipboard's text, for Studio's own paste: reading it from Windows
/// avoids the WebView asking the person for clipboard access.
pub fn clipboard_text() -> Result<String, StepError> {
    desktop::clipboard_get().map(|v| v.as_str().unwrap_or_default().to_owned())
}
/// The file dialog of `dialog.selectFile`, for Studio's run window.
pub use desktop::select_file;
mod http;
pub mod oauth;
/// The HTTP client and the site check of `http.request`, for other steps that
/// call web APIs with a secret (`mail.send` through Microsoft 365).
pub use http::{check_site, client as http_client};
mod process;
mod procs;

#[cfg(test)]
mod tests;

pub mod types {
    pub const HTTP_REQUEST: &str = "http.request";
    pub const PROCESS_RUN: &str = "process.run";
    pub const PROCESS_LIST: &str = "process.list";
    pub const PROCESS_KILL: &str = "process.kill";
    pub const CLIPBOARD_GET: &str = "clipboard.get";
    pub const CLIPBOARD_SET: &str = "clipboard.set";
    pub const DIALOG_MESSAGE: &str = "dialog.message";
    pub const DIALOG_INPUT: &str = "dialog.input";
    pub const DIALOG_FORM: &str = "dialog.form";
    pub const DIALOG_SELECT_FILE: &str = "dialog.selectFile";
}

/// Time a dialog waits for the person when the step sets no timeout.
const DIALOG_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// The clipboard is one per desktop.
const CLIPBOARD: &str = "clipboard";

/// One adapter per step prefix.
pub struct SystemAdapter {
    name: &'static str,
}

/// The `http`, `process`, `clipboard` and `dialog` adapters.
pub fn adapters() -> Vec<Arc<dyn Adapter>> {
    ["http", "process", "clipboard", "dialog"]
        .into_iter()
        .map(|name| Arc::new(SystemAdapter { name }) as Arc<dyn Adapter>)
        .collect()
}

impl Adapter for SystemAdapter {
    fn name(&self) -> &str {
        self.name
    }

    fn install(&self, mut builder: RuntimeBuilder) -> RuntimeBuilder {
        let prefix = format!("{}.", self.name);
        for (def, kind) in step_defs() {
            if def.step_type.starts_with(&prefix) {
                builder = builder.register(def, SystemStep { kind });
            }
        }
        builder
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    HttpRequest,
    ProcessRun,
    ProcessList,
    ProcessKill,
    ClipboardGet,
    ClipboardSet,
    DialogMessage,
    DialogInput,
    DialogForm,
    DialogSelectFile,
}

struct SystemStep {
    kind: Kind,
}

async fn blocking(
    work: impl FnOnce() -> Result<Value, StepError> + Send + 'static,
) -> Result<Value, StepError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?
}

impl ActionHandler for SystemStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        let kind = self.kind;
        Box::pin(async move {
            let params = input.params.clone();
            match kind {
                Kind::HttpRequest => http::request(&input).await,
                Kind::ProcessRun => process::run(&input).await,
                Kind::ProcessList => blocking(move || procs::list(&params)).await,
                Kind::ProcessKill => blocking(move || procs::kill(&params)).await,
                Kind::ClipboardGet => blocking(desktop::clipboard_get).await,
                Kind::ClipboardSet => blocking(move || desktop::clipboard_set(&params)).await,
                Kind::DialogMessage
                | Kind::DialogInput
                | Kind::DialogForm
                | Kind::DialogSelectFile => {
                    input.request_human_in_dialog("SpellSheet のダイアログに答えてください");
                    // Each dialog is its own process: a stop or timeout kills
                    // it and closes the window.
                    match kind {
                        Kind::DialogMessage => desktop::message(&params).await,
                        Kind::DialogInput => desktop::input(&params).await,
                        Kind::DialogForm => desktop::form(&params).await,
                        _ => desktop::select_file(&params).await,
                    }
                }
            }
        })
    }
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

struct Def {
    step_type: &'static str,
    category: StepCategory,
    label: &'static str,
    description: &'static str,
    params_schema: Value,
    risk: RiskLevel,
    resources: Vec<ResourceDef>,
    secret_params: Vec<String>,
    default_timeout_ms: Option<u64>,
    examples: Vec<Value>,
}

impl From<Def> for StepTypeDef {
    fn from(d: Def) -> Self {
        let targets = match d.step_type {
            types::HTTP_REQUEST => vec![TargetDef::site("url")],
            types::PROCESS_RUN => vec![TargetDef::app("program")],
            types::PROCESS_KILL => vec![TargetDef::app("name")],
            _ => Vec::new(),
        };
        StepTypeDef {
            targets,
            step_type: d.step_type.into(),
            category: d.category,
            label: d.label.into(),
            description: d.description.into(),
            params_schema: d.params_schema,
            blocks: vec![],
            has_output: true,
            expression_params: vec![],
            binds_variables: vec![],
            risk: d.risk,
            examples: d.examples,
            resources: d.resources,
            secret_params: d.secret_params,
            default_timeout_ms: d.default_timeout_ms,
            deprecated: None,
            plugin: None,
            // A program name (`program`) may be on PATH: not resolved.
            path_params: match d.step_type {
                types::PROCESS_RUN => vec!["cwd".into()],
                types::DIALOG_SELECT_FILE => vec!["folder".into()],
                _ => vec![],
            },
        }
    }
}

#[allow(clippy::too_many_lines)]
fn step_defs() -> Vec<(StepTypeDef, Kind)> {
    let text = json!({ "type": "string" });
    let object = json!({ "type": "object" });
    let path = json!({ "type": "string", "minLength": 1, "description": "フローのフォルダーからの相対パス（例 output/data.json）か絶対パス" });
    let dialog = |step_type, label, description, params_schema, examples| Def {
        step_type,
        category: StepCategory::System,
        label,
        description,
        params_schema,
        risk: RiskLevel::Interactive,
        resources: vec![],
        secret_params: vec![],
        default_timeout_ms: Some(DIALOG_TIMEOUT_MS),
        examples,
    };
    vec![
        (
            Def {
                step_type: types::HTTP_REQUEST,
                category: StepCategory::Network,
                label: "Web API 呼び出し",
                description: "Sends an HTTP request and outputs { status, headers, body }. `body` is parsed into a value when the response is JSON, otherwise it is text (or, with `saveTo`, the response is saved to that file and body is the path). Send data as `json` (a value), `form` (fields) or `body` (text); add URL parameters with `query`. `auth` takes a registered secret (sent only to the sites registered with it), or { \"secret\": \"<name>\", \"field\": \"accessToken\" } for the OAuth access token oauth.signIn obtained (refreshed automatically when it expires): authType bearer (default, Authorization: Bearer), basic (the secret's username and password) or header (the value in the header named by authHeader). A status of 400 or more fails the step with HTTP_ERROR (details: status, body); 5xx and 429 are retried when the step has retry.",
                params_schema: json!({
                    "type": "object",
                    "properties": {
                        "method": { "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
                        "url": { "type": "string", "minLength": 1 },
                        "query": object,
                        "headers": object,
                        "json": {},
                        "form": object,
                        "body": text,
                        "auth": token_or_secret_schema("トークン。登録済みのシークレット { \"secret\": \"名前\", \"field\": \"password\" }、OAuth なら { \"secret\": \"名前\", \"field\": \"accessToken\" }"),
                        "authType": { "enum": ["bearer", "basic", "header"] },
                        "authHeader": { "type": "string", "minLength": 1 },
                        "saveTo": path,
                    },
                    "required": ["url"],
                    "additionalProperties": false,
                }),
                risk: RiskLevel::Dangerous,
                resources: vec![ResourceDef::file("saveTo")],
                secret_params: vec!["auth".into()],
                default_timeout_ms: None,
                examples: vec![
                    json!({ "type": types::HTTP_REQUEST, "params": { "url": "https://api.example.com/orders", "query": { "date": "{{ formatDate(today(), 'yyyy-MM-dd') }}" }, "auth": { "secret": "受注API", "field": "password" } }, "saveAs": "res" }),
                    json!({ "type": types::HTTP_REQUEST, "params": { "url": "https://api.box.com/2.0/folders/0/items", "auth": { "secret": "Box", "field": "accessToken" } }, "saveAs": "res" }),
                    json!({ "type": types::HTTP_REQUEST, "params": { "method": "POST", "url": "https://hooks.example.com/notify", "json": { "text": "{{ count }} 件を処理しました" } } }),
                    json!({ "type": types::HTTP_REQUEST, "params": { "url": "https://example.com/report.pdf", "saveTo": "C:\\work\\report.pdf" } }),
                ],
            },
            Kind::HttpRequest,
        ),
        (
            Def {
                step_type: types::PROCESS_RUN,
                category: StepCategory::System,
                label: "プログラム実行",
                description: "Runs a command-line program with `args` (a list; no shell, so no quoting needed), waits for it and outputs { exitCode, stdout, stderr } (text, UTF-8 or Shift_JIS detected). An exit code not in `okExitCodes` (default [0]) fails the step with PROCESS_FAILED. The step's timeoutMs stops the program. For shell built-ins use program \"cmd\" with args [\"/c\", ...]. To open an application window use desktop.launch instead.",
                params_schema: object_schema(
                    json!({
                        "program": { "type": "string", "minLength": 1 },
                        "args": { "type": "array" },
                        "cwd": path,
                        "env": object,
                        "stdin": text,
                        "okExitCodes": { "type": "array", "items": { "type": "integer" } },
                        "encoding": { "enum": ["auto", "utf-8", "shift_jis"] },
                    }),
                    &["program"],
                ),
                risk: RiskLevel::Dangerous,
                resources: vec![],
                secret_params: vec![],
                default_timeout_ms: None,
                examples: vec![json!({
                    "type": types::PROCESS_RUN,
                    "params": { "program": "robocopy", "args": ["C:\\work\\out", "\\\\server\\share\\out", "/E"], "okExitCodes": [0, 1, 2, 3] },
                    "saveAs": "copied"
                })],
            },
            Kind::ProcessRun,
        ),
        (
            Def {
                step_type: types::PROCESS_LIST,
                category: StepCategory::System,
                label: "プロセス一覧",
                description: "Outputs the programs running on this PC as [{ pid, name }]. With `name` (e.g. \"EXCEL\" or \"EXCEL.EXE\"; case and .exe do not matter) only that program's processes, so `length(list) > 0` tells whether it is running.",
                params_schema: object_schema(json!({ "name": text }), &[]),
                risk: RiskLevel::Safe,
                resources: vec![],
                secret_params: vec![],
                default_timeout_ms: None,
                examples: vec![json!({ "type": types::PROCESS_LIST, "params": { "name": "EXCEL" }, "saveAs": "excels" })],
            },
            Kind::ProcessList,
        ),
        (
            Def {
                step_type: types::PROCESS_KILL,
                category: StepCategory::System,
                label: "プロセス終了",
                description: "Ends every running process of the program `name` (e.g. \"sales.exe\"; case and .exe do not matter) with its child processes, without asking it to save. Use it to restart an application that hangs (then desktop.launch it again). Outputs { killed } (0 when it was not running, which is not an error). Unsaved work in that program is lost. A process of another user or of an administrator fails with PROCESS_KILL_FAILED.",
                params_schema: object_schema(
                    json!({ "name": { "type": "string", "minLength": 1 } }),
                    &["name"],
                ),
                risk: RiskLevel::Dangerous,
                resources: vec![],
                secret_params: vec![],
                default_timeout_ms: None,
                examples: vec![json!({ "type": types::PROCESS_KILL, "params": { "name": "sales.exe" } })],
            },
            Kind::ProcessKill,
        ),
        (
            Def {
                step_type: types::CLIPBOARD_GET,
                category: StepCategory::System,
                label: "クリップボード読み取り",
                description: "Outputs the text on the clipboard (\"\" when it holds no text). Windows only.",
                params_schema: object_schema(json!({}), &[]),
                risk: RiskLevel::Safe,
                resources: vec![ResourceDef::Static(CLIPBOARD.into())],
                secret_params: vec![],
                default_timeout_ms: None,
                examples: vec![json!({ "type": types::CLIPBOARD_GET, "saveAs": "copied" })],
            },
            Kind::ClipboardGet,
        ),
        (
            Def {
                step_type: types::CLIPBOARD_SET,
                category: StepCategory::System,
                label: "クリップボード書き込み",
                description: "Puts `text` on the clipboard (e.g. before desktop.press Ctrl+V into an app that ignores typing). Windows only.",
                params_schema: object_schema(json!({ "text": {} }), &["text"]),
                risk: RiskLevel::Interactive,
                resources: vec![ResourceDef::Static(CLIPBOARD.into())],
                secret_params: vec![],
                default_timeout_ms: None,
                examples: vec![json!({ "type": types::CLIPBOARD_SET, "params": { "text": "{{ join(map(rows, r => r.code), '\\r\\n') }}" } })],
            },
            Kind::ClipboardSet,
        ),
        (
            dialog(
                types::DIALOG_MESSAGE,
                "メッセージ表示",
                "Shows a message box to the person at the PC and waits (up to 10 minutes unless timeoutMs is set). Outputs the button pressed: \"ok\", \"cancel\", \"yes\" or \"no\". Use it only in flows that someone watches; unattended runs would wait until the timeout. Windows only.",
                object_schema(
                    json!({
                        "message": { "type": "string", "minLength": 1 },
                        "title": text,
                        "buttons": { "enum": ["ok", "okCancel", "yesNo", "yesNoCancel"] },
                        "level": { "enum": ["info", "warning", "error"] },
                    }),
                    &["message"],
                ),
                vec![json!({ "type": types::DIALOG_MESSAGE, "params": { "message": "{{ count }} 件を登録します。よろしいですか？", "buttons": "yesNo" }, "saveAs": "answer" })],
            ),
            Kind::DialogMessage,
        ),
        (
            dialog(
                types::DIALOG_INPUT,
                "入力ダイアログ",
                "Asks the person at the PC for one line of text and outputs it (\"\" when they cancel). Never use it for passwords: use registered secrets. Windows only.",
                object_schema(
                    json!({ "message": { "type": "string", "minLength": 1 }, "title": text, "default": text }),
                    &["message"],
                ),
                vec![json!({ "type": types::DIALOG_INPUT, "params": { "message": "対象月を入力してください（例: 2026-10）", "default": "{{ formatDate(today(), 'yyyy-MM') }}" }, "saveAs": "month" })],
            ),
            Kind::DialogInput,
        ),
        (
            dialog(
                types::DIALOG_FORM,
                "入力フォーム",
                "Asks the person at the PC for several values at once in one dialog, and outputs them as an object keyed by each field's `name` (null when they cancel). Field types: text (default), multiline, number (a number, or null when left empty), date (\"2026-10-28\" or null), select (one of `options`) and checkbox (true / false). `required: true` keeps OK from closing the form until the field has a value. Use it only in flows that someone watches; unattended runs would wait until the timeout (10 minutes unless timeoutMs is set). Never ask for passwords: use registered secrets. Windows only.",
                object_schema(
                    json!({
                        "message": text,
                        "title": text,
                        "fields": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 30,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string", "minLength": 1, "description": "結果のキー（例 month）" },
                                    "label": { "type": "string", "description": "画面に出す項目名（省略すると name）" },
                                    "type": { "enum": desktop::FIELD_TYPES },
                                    "required": { "type": "boolean" },
                                    "default": {},
                                    "options": { "type": "array", "items": { "type": ["string", "number"] } }
                                },
                                "required": ["name"],
                                "additionalProperties": false
                            }
                        }
                    }),
                    &["fields"],
                ),
                vec![json!({ "type": types::DIALOG_FORM, "params": {
                    "title": "請求書の発行",
                    "message": "今回の条件を入れてください",
                    "fields": [
                        { "name": "month", "label": "対象月", "default": "{{ formatDate(today(), 'yyyy-MM') }}", "required": true },
                        { "name": "dueDate", "label": "支払期限", "type": "date" },
                        { "name": "office", "label": "営業所", "type": "select", "options": ["東京", "大阪", "名古屋"], "required": true },
                        { "name": "minAmount", "label": "対象にする最低金額", "type": "number", "default": 10000 },
                        { "name": "sendMail", "label": "メールでも送る", "type": "checkbox", "default": true }
                    ]
                }, "saveAs": "form" })],
            ),
            Kind::DialogForm,
        ),
        (
            dialog(
                types::DIALOG_SELECT_FILE,
                "ファイル選択ダイアログ",
                "Lets the person pick a file (kind \"file\", default), several files (\"files\", outputs a list), a folder (\"folder\") or where to save (\"save\"). Outputs the path, or null when cancelled. `extensions` limits the files shown, e.g. [\"csv\", \"xlsx\"]. Windows only.",
                object_schema(
                    json!({
                        "kind": { "enum": ["file", "files", "folder", "save"] },
                        "title": text,
                        "folder": path,
                        "fileName": text,
                        "extensions": { "type": "array", "items": { "type": "string" } },
                    }),
                    &[],
                ),
                vec![json!({ "type": types::DIALOG_SELECT_FILE, "params": { "title": "取り込む CSV を選んでください", "extensions": ["csv"] }, "saveAs": "csvPath" })],
            ),
            Kind::DialogSelectFile,
        ),
    ]
    .into_iter()
    .map(|(def, kind)| (def.into(), kind))
    .collect()
}

/// Definitions of every step in this crate.
pub fn definitions() -> Vec<StepTypeDef> {
    step_defs().into_iter().map(|(def, _)| def).collect()
}
