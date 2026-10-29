//! Steps that reach outside the scenario but not into an application:
//! web APIs (`http.request`), command-line programs (`process.run`), the
//! clipboard (`clipboard.*`) and dialogs for the person at the PC
//! (`dialog.*`). See docs/system.md.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use serde_json::{Value, json};
use shikigami_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use shikigami_core::resource::ResourceDef;
use shikigami_core::secret::token_or_secret_schema;
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};

mod desktop;
mod http;
pub mod oauth;
mod process;

#[cfg(test)]
mod tests;

pub mod types {
    pub const HTTP_REQUEST: &str = "http.request";
    pub const PROCESS_RUN: &str = "process.run";
    pub const CLIPBOARD_GET: &str = "clipboard.get";
    pub const CLIPBOARD_SET: &str = "clipboard.set";
    pub const DIALOG_MESSAGE: &str = "dialog.message";
    pub const DIALOG_INPUT: &str = "dialog.input";
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
    ClipboardGet,
    ClipboardSet,
    DialogMessage,
    DialogInput,
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
                Kind::ClipboardGet => blocking(desktop::clipboard_get).await,
                Kind::ClipboardSet => blocking(move || desktop::clipboard_set(&params)).await,
                Kind::DialogMessage | Kind::DialogInput | Kind::DialogSelectFile => {
                    input.request_human("Shikigami のダイアログに答えてください");
                    // Each dialog is its own process: a stop or timeout kills
                    // it and closes the window.
                    match kind {
                        Kind::DialogMessage => desktop::message(&params).await,
                        Kind::DialogInput => desktop::input(&params).await,
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
        StepTypeDef {
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
        }
    }
}

#[allow(clippy::too_many_lines)]
fn step_defs() -> Vec<(StepTypeDef, Kind)> {
    let text = json!({ "type": "string" });
    let object = json!({ "type": "object" });
    let path = json!({ "type": "string", "minLength": 1, "description": "絶対パス" });
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
                label: "Web API を呼ぶ",
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
                label: "プログラムを実行",
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
                step_type: types::CLIPBOARD_GET,
                category: StepCategory::System,
                label: "クリップボードを読む",
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
                label: "クリップボードに入れる",
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
                "メッセージを表示",
                "Shows a message box to the person at the PC and waits (up to 10 minutes unless timeoutMs is set). Outputs the button pressed: \"ok\", \"cancel\", \"yes\" or \"no\". Use it only in scenarios that someone watches; unattended runs would wait until the timeout. Windows only.",
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
                "入力してもらう",
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
                types::DIALOG_SELECT_FILE,
                "ファイルを選んでもらう",
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
