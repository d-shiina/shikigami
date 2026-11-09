//! Browser steps (`browser.*`) for the Shikigami Runtime.
//!
//! Each step forwards its rendered params to the Node.js + Playwright
//! adapter (`packages/browser-adapter`) over JSON-RPC on stdio. Pages live in
//! named browser contexts per run (`context`, default `"default"`): steps on
//! one context take turns, different contexts run in parallel.
//!
//! ```no_run
//! use shikigami_browser::BrowserAdapter;
//! let runtime = shikigami_runtime::Runtime::builder()
//!     .adapter(&BrowserAdapter::discover())
//!     .build();
//! ```

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use shikigami_core::policy::TargetDef;
use shikigami_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use shikigami_core::resource::ResourceDef;
use shikigami_core::secret::{SecretProvider, text_or_secret_schema};
use shikigami_runtime::sidecar::{SidecarClient, SidecarConfig};
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};
use tokio_util::sync::CancellationToken;

/// How much earlier than the step timeout the adapter stops an operation.
const ADAPTER_TIMEOUT_MARGIN_MS: u64 = 500;

/// Path of the adapter entry point inside the repository.
pub const ADAPTER_SCRIPT: &str = "packages/browser-adapter/src/main.ts";

/// Where the installer puts the adapter, relative to the executable.
pub const BUNDLED_ADAPTER_SCRIPT: &str = "browser-adapter/src/main.ts";

pub mod types {
    pub const OPEN: &str = "browser.open";
    pub const ATTACH: &str = "browser.attach";
    pub const CLICK: &str = "browser.click";
    pub const HOVER: &str = "browser.hover";
    pub const SCROLL: &str = "browser.scroll";
    pub const GET_ATTRIBUTE: &str = "browser.getAttribute";
    pub const RUN_SCRIPT: &str = "browser.runScript";
    pub const SWITCH_TAB: &str = "browser.switchTab";
    pub const CLOSE_TAB: &str = "browser.closeTab";
    pub const DOWNLOAD: &str = "browser.download";
    pub const UPLOAD: &str = "browser.upload";
    pub const FILL: &str = "browser.fill";
    pub const CHECK: &str = "browser.check";
    pub const NAVIGATE: &str = "browser.navigate";
    pub const SELECT: &str = "browser.select";
    pub const PRESS: &str = "browser.press";
    pub const GET_TEXT: &str = "browser.getText";
    pub const GET_TABLE: &str = "browser.getTable";
    pub const WAIT_FOR: &str = "browser.waitFor";
    pub const SCREENSHOT: &str = "browser.screenshot";
    pub const CLOSE: &str = "browser.close";
    pub const IS_VISIBLE: &str = "browser.isVisible";
    pub const WAIT_FOR_HUMAN: &str = "browser.waitForHuman";
    pub const OAUTH_SIGN_IN: &str = "oauth.signIn";
}

mod oauth;

/// Browser steps backed by the Node.js + Playwright sidecar.
#[derive(Debug, Clone)]
pub struct BrowserAdapter {
    client: Arc<SidecarClient>,
}

impl BrowserAdapter {
    pub fn new(config: SidecarConfig) -> Self {
        Self {
            client: Arc::new(SidecarClient::new(config)),
        }
    }

    /// Uses `SHIKIGAMI_NODE` / `SHIKIGAMI_BROWSER_ADAPTER` when set,
    /// otherwise what the installer ships next to the executable
    /// (`node\node.exe`, `browser-adapter\src\main.ts`), otherwise `node`
    /// on PATH and the repository's adapter found from the executable (or
    /// the current directory) or one of their parents.
    pub fn discover() -> Self {
        let node = shikigami_runtime::node::node_program();
        let exe_dir = shikigami_runtime::node::exe_dir();
        let script = std::env::var_os("SHIKIGAMI_BROWSER_ADAPTER")
            .map(PathBuf::from)
            .or_else(|| {
                exe_dir
                    .as_deref()
                    .map(|dir| dir.join(BUNDLED_ADAPTER_SCRIPT))
                    .filter(|script| script.is_file())
            })
            .or_else(|| {
                let cwd = std::env::current_dir().ok();
                [exe_dir, cwd]
                    .into_iter()
                    .flatten()
                    .find_map(|start| find_upwards(&start))
            });
        Self::new(sidecar_config(node, script))
    }
}

/// How to start the adapter script with Node.js (22.18+ runs TypeScript).
pub fn sidecar_config(node: PathBuf, script: Option<PathBuf>) -> SidecarConfig {
    let mut args: Vec<OsString> = vec![
        "--experimental-strip-types".into(),
        "--disable-warning=ExperimentalWarning".into(),
    ];
    let unavailable = match script {
        Some(script) => {
            args.push(script.into_os_string());
            None
        }
        None => Some(format!("{ADAPTER_SCRIPT} not found")),
    };
    SidecarConfig {
        name: "browser".into(),
        program: node,
        args,
        cwd: None,
        unavailable,
        setup_hint: "The installer ships Node.js and the adapter; reinstall SpellSheet if its node or browser-adapter folder is missing. From a source checkout, install Node.js 22.18+ and run `pnpm install`, or set SHIKIGAMI_NODE / SHIKIGAMI_BROWSER_ADAPTER.".into(),
    }
}

fn find_upwards(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .map(|dir| dir.join(ADAPTER_SCRIPT))
        .find(|candidate| candidate.is_file())
}

impl Adapter for BrowserAdapter {
    fn name(&self) -> &'static str {
        "browser"
    }

    /// Registers every browser step type and closes a run's browser
    /// contexts when it ends.
    fn install(&self, mut builder: RuntimeBuilder) -> RuntimeBuilder {
        for (def, method) in step_defs() {
            builder = if method == "authorize" {
                builder.register(
                    def,
                    oauth::SignIn {
                        client: self.client.clone(),
                    },
                )
            } else {
                builder.register(
                    def,
                    BrowserStep {
                        client: self.client.clone(),
                        method,
                    },
                )
            };
        }
        let client = self.client.clone();
        builder.on_run_finished(Arc::new(move |end| {
            let client = client.clone();
            Box::pin(async move {
                if client.is_running().await
                    && let Ok(result) = client
                        .call(
                            "closeRun",
                            json!({ "runId": end.run_id.as_str() }),
                            &CancellationToken::new(),
                        )
                        .await
                    && let Some(secrets) = &end.secrets
                {
                    save_sessions(secrets.as_ref(), &result);
                }
            })
        }))
    }

    /// The page's accessibility tree (`url` opens a page first; `context`,
    /// `target` narrow it down). `action` asks for something else about the
    /// open page instead: `"pick"` waits for the person to click an element
    /// and returns it as a target (`message`, `candidates`, `timeoutMs`),
    /// `"highlight"` outlines `target` / `targets` for a moment, `"record"`
    /// records what the person does on the page until they press 終了
    /// (`{ status, actions }`; `"stopRecording"` ends it from outside),
    /// `"endHuman"` ends a browser.waitForHuman (`how: "person"` as finished,
    /// otherwise as stopped).
    fn inspect<'a>(
        &'a self,
        session: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let mut params = match params {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            params.insert("runId".into(), Value::String(session.to_owned()));
            let method = match params.remove("action") {
                Some(Value::String(a)) if a == "pick" => "pick",
                Some(Value::String(a)) if a == "highlight" => "highlight",
                Some(Value::String(a)) if a == "cancelPick" => "cancelPick",
                Some(Value::String(a)) if a == "endHuman" => "endHuman",
                Some(Value::String(a)) if a == "record" => "record",
                Some(Value::String(a)) if a == "stopRecording" => "stopRecording",
                _ => "snapshot",
            };
            self.client
                .call(method, Value::Object(params), &CancellationToken::new())
                .await
        })
    }
}

struct BrowserStep {
    client: Arc<SidecarClient>,
    method: &'static str,
}

impl ActionHandler for BrowserStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let mut params = match input.params.clone() {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            params.insert("runId".into(), Value::String(input.run_id.to_string()));
            // Playwright gives up just before the Runtime does, so a timed-out
            // click can never land after the step was retried or skipped.
            let limit = input
                .timeout_ms
                .saturating_sub(ADAPTER_TIMEOUT_MARGIN_MS)
                .max(1);
            params.insert("timeoutMs".into(), Value::from(limit));
            match self.method {
                "fill" => resolve_fill_secret(&input, &mut params)?,
                "open" => load_session(&input, &mut params)?,
                "waitForHuman" => {
                    let message = params
                        .get("message")
                        .and_then(Value::as_str)
                        .filter(|m| !m.trim().is_empty())
                        .unwrap_or(DEFAULT_HUMAN_MESSAGE)
                        .to_owned();
                    input.request_human(message);
                }
                _ => {}
            }
            // Stopped while the person was at it (the run dropped this step):
            // the page's wait ends too, the browser staying as it is.
            let mut end_wait = (self.method == "waitForHuman").then(|| EndHumanOnDrop {
                client: Some(self.client.clone()),
                params: json!({ "runId": input.run_id.to_string(), "context": params.get("context") }),
            });
            let result = self
                .client
                .call(self.method, Value::Object(params), &input.cancel)
                .await;
            if let Some(end_wait) = end_wait.as_mut() {
                // It answered by itself: nothing to end.
                end_wait.client = None;
            }
            let result = result?;
            if self.method == "close" {
                if let Ok(secrets) = input.secret_provider() {
                    save_sessions(secrets.as_ref(), &result);
                }
                return Ok(Value::Null);
            }
            Ok(result)
        })
    }
}

const DEFAULT_HUMAN_MESSAGE: &str = "ブラウザで操作してください";

/// Ends the page's browser.waitForHuman when the step is dropped before it
/// answered (the run was stopped), so a later wait in the same context does
/// not race a stale one.
struct EndHumanOnDrop {
    client: Option<Arc<SidecarClient>>,
    params: Value,
}

impl Drop for EndHumanOnDrop {
    fn drop(&mut self) {
        let Some(client) = self.client.take() else {
            return;
        };
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let params = self.params.take();
        rt.spawn(async move {
            let _ = client
                .call("endHuman", params, &CancellationToken::new())
                .await;
        });
    }
}

/// `value: { "secret": .., "field": .. }` becomes the value itself plus the
/// sites it may be typed into; the adapter refuses other pages and masks
/// the field in screenshots and page text.
fn resolve_fill_secret(
    input: &ActionInput,
    params: &mut Map<String, Value>,
) -> Result<(), StepError> {
    let Some(value) = params.get("value") else {
        return Ok(());
    };
    let Some(secret) = input.resolve_secret(value)? else {
        return Ok(());
    };
    if secret.sites.is_empty() {
        return Err(StepError::permanent(
            "SECRET_SITE_NOT_SET",
            format!("secret '{}' has no site it may be typed into", secret.name),
        )
        .with_details(json!({
            "secret": secret.name,
            "hint": "Call request_secret with this name and the site's address (e.g. https://example.com): Writer then asks the user to add it to this secret."
        })));
    }
    params.insert("value".into(), Value::String(secret.value));
    params.insert(
        "secret".into(),
        json!({
            "name": secret.name,
            "sites": secret.sites,
            "sensitive": secret.field.is_sensitive(),
        }),
    );
    Ok(())
}

/// `session: "<name>"` on browser.open starts the context with the login
/// saved under that name (cookies, local storage); it is saved again when
/// the context closes.
fn load_session(input: &ActionInput, params: &mut Map<String, Value>) -> Result<(), StepError> {
    let Some(name) = params.get("session").and_then(Value::as_str) else {
        return Ok(());
    };
    shikigami_core::secret::check_name(name).map_err(StepError::invalid_params)?;
    if let Some(state) = input.secret_provider()?.load_session(name)? {
        params.insert("storageState".into(), state);
    }
    Ok(())
}

/// Saves the logins the adapter returns when contexts close:
/// `{ "sessions": [{ "name": .., "state": .. }] }`.
fn save_sessions(secrets: &dyn SecretProvider, result: &Value) {
    let Some(sessions) = result.get("sessions").and_then(Value::as_array) else {
        return;
    };
    for session in sessions {
        let (Some(name), Some(state)) = (
            session.get("name").and_then(Value::as_str),
            session.get("state"),
        ) else {
            continue;
        };
        if let Err(e) = secrets.save_session(name, state) {
            tracing::warn!(session = name, error = %e, "could not save the browser login");
        }
    }
}

fn target_schema() -> Value {
    json!({
        "type": "object",
        "description": "操作する要素。意味で指定する: { \"role\": \"button\", \"name\": \"ログイン\" } が第一候補、入力欄は { \"label\": \"ユーザー名\" }。css は最終手段",
        "properties": {
            "role": { "type": "string", "description": "ARIA ロール（button, link, textbox, heading, cell, row, checkbox, combobox ...）" },
            "name": { "type": "string", "description": "role と組み合わせるアクセシブル名（ボタンの文字など）" },
            "label": { "type": "string", "description": "入力欄のラベル" },
            "placeholder": { "type": "string" },
            "text": { "type": "string", "description": "表示されている文字" },
            "testId": { "type": "string" },
            "css": { "type": "string" },
            "exact": { "type": "boolean", "description": "完全一致（既定は部分一致・大文字小文字無視）" },
            "nth": { "type": "integer", "minimum": 0, "description": "複数一致したときの 0 始まりの番号" },
            "frame": frame_schema(FRAME_DEPTH - 1)
        },
        "additionalProperties": false,
        "anyOf": [
            { "required": ["role"] }, { "required": ["label"] }, { "required": ["placeholder"] },
            { "required": ["text"] }, { "required": ["testId"] }, { "required": ["css"] }
        ]
    })
}

/// How many frames deep a target may sit (the top page's iframe, a frame
/// inside it, ...). Picking an element returns its whole frame path.
const FRAME_DEPTH: u32 = 4;

/// The iframe (or frameset frame) an element is in; `outer` more frames
/// may sit around it.
fn frame_schema(outer: u32) -> Value {
    let mut properties = json!({
        "name": { "type": "string", "description": "フレームの name（または id）属性" },
        "title": { "type": "string", "description": "title 属性の一部" },
        "src": { "type": "string", "description": "フレームのアドレス（src）の一部" },
        "css": { "type": "string" },
        "nth": { "type": "integer", "minimum": 0, "description": "複数一致したときの 0 始まりの番号" }
    });
    if outer > 0
        && let Some(map) = properties.as_object_mut()
    {
        map.insert("frame".into(), frame_schema(outer - 1));
    }
    json!({
        "type": "object",
        "description": if outer == FRAME_DEPTH - 1 {
            "要素が入っている iframe（フレームセットのフレームも）。inspect_page の frames に出る name / title / src で指定する"
        } else {
            "そのフレームを囲むフレーム（フレームの中のフレーム）"
        },
        "properties": properties,
        "additionalProperties": false,
        "anyOf": [
            { "required": ["name"] }, { "required": ["title"] }, { "required": ["src"] }, { "required": ["css"] }
        ]
    })
}

/// How a step answers the JS dialog (alert / confirm / prompt) it causes.
fn dialog_schema() -> Value {
    json!({
        "description": "この操作で出る JS のダイアログ（alert・confirm・prompt）への答え。accept = OK、dismiss = キャンセル。prompt に入れる文字は { \"action\": \"accept\", \"promptText\": \"…\" }",
        "oneOf": [
            { "enum": ["accept", "dismiss"] },
            {
                "type": "object",
                "properties": {
                    "action": { "enum": ["accept", "dismiss"] },
                    "promptText": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            }
        ]
    })
}

fn context_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "description": "ブラウザの作業領域の名前（既定 default）。並行ブランチで別々の名前にすると同時に動く"
    })
}

fn schema(mut properties: Map<String, Value>, required: &[&str]) -> Value {
    properties.insert("context".into(), context_schema());
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn props(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

struct Def {
    step_type: &'static str,
    method: &'static str,
    label: &'static str,
    description: &'static str,
    params: Value,
    required: &'static [&'static str],
    has_output: bool,
    examples: Vec<Value>,
    secret_params: &'static [&'static str],
    default_timeout_ms: Option<u64>,
}

impl Default for Def {
    fn default() -> Self {
        Self {
            step_type: "",
            method: "",
            label: "",
            description: "",
            params: json!({}),
            required: &[],
            has_output: false,
            examples: vec![],
            secret_params: &[],
            default_timeout_ms: None,
        }
    }
}

/// Step type definitions with the adapter method each one calls.
pub fn step_defs() -> Vec<(StepTypeDef, &'static str)> {
    use types::*;
    let target = target_schema();
    let defs = vec![
        Def {
            step_type: OPEN,
            method: "open",
            label: "ページ表示",
            description: "Opens `url` in the browser context `context` (started on first use; reused afterwards). Output: { url, title }. Every other browser step needs a browser.open on the same context first; it opens in the current tab. `dialog` answers a JS dialog the page shows while loading (output then has `dialog`: its message). `headless: true` runs without a window. `session: \"<name>\"` keeps the login: the context starts with the cookies saved under that name and saves them again when it closes, so later runs skip the login page (check with browser.isVisible whether the login form is shown).",
            params: json!({
                "url": { "type": "string", "minLength": 1 },
                "headless": { "type": "boolean" },
                "session": { "type": "string", "minLength": 1, "maxLength": 64, "description": "保存したログイン状態の名前（例：受注システム）。次回はログイン済みで開く" },
                "dialog": dialog_schema()
            }),
            required: &["url"],
            has_output: true,
            examples: vec![
                json!({ "type": OPEN, "name": "受注システムを開く", "params": { "url": "{{ siteUrl }}" } }),
                json!({ "type": OPEN, "name": "受注システムを開く（ログインを保持）", "params": { "url": "{{ siteUrl }}", "session": "受注システム" } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: ATTACH,
            method: "attach",
            label: "既存ブラウザへの接続",
            description: "Uses a browser the person started on this PC instead of opening a new one: its tabs, logins, client certificates and extensions (for sites only reachable from the person's browser, e.g. with SSO). The browser must be started with a debugging port and its own profile folder, e.g. msedge.exe --remote-debugging-port=9222 --user-data-dir=\"%LOCALAPPDATA%\\SpellSheet\\edge-profile\" (Edge and Chrome ignore the port on their everyday profile; sign in there once). Only 127.0.0.1 is reached. Later steps on the same `context` work in it; `title` / `url` pick a tab as in browser.switchTab (default: the first tab). The browser is never closed: the run lets go of it when it ends. Output: { url, title }. Fails with BROWSER_NOT_RUNNING when nothing listens on `port`. Not for unattended runs: use browser.open with `session` there.",
            params: json!({
                "port": { "type": "integer", "minimum": 1, "maximum": 65535, "description": "ブラウザを起動したときの --remote-debugging-port（既定 9222）" },
                "title": { "type": "string", "minLength": 1, "description": "使うタブのタイトルの一部" },
                "url": { "type": "string", "minLength": 1, "description": "使うタブのアドレスの一部" }
            }),
            required: &[],
            has_output: true,
            examples: vec![
                json!({ "type": ATTACH, "name": "開いている Edge の勤怠システムを使う", "params": { "title": "勤怠" } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: CLICK,
            method: "click",
            label: "クリック",
            description: "Clicks the element `target` (waits until it is visible and enabled). `button: \"right\"` right-clicks (to open the page's own menu), `double: true` double-clicks, `modifiers` holds keys down during the click (e.g. [\"Control\"] to open a link in a new tab, [\"Shift\"] to extend a selection). To set a checkbox, use browser.check, not a click. When the click shows a JS dialog (alert / confirm / prompt), set `dialog`: \"accept\" (OK) or \"dismiss\" (Cancel), or { \"action\": \"accept\", \"promptText\": \"…\" } for a prompt; the step then waits for the dialog, answers it and outputs its message (saveAs to read e.g. a receipt number). Without `dialog`, dialogs are dismissed (a confirm is cancelled). A dialog drawn by the page itself is not a JS dialog: click its button. A link or button that opens a new tab or window: follow with browser.switchTab. An element inside an iframe: add `frame` to the target.",
            params: json!({
                "target": target,
                "button": { "enum": ["left", "right"], "description": "押すボタン（既定は左）" },
                "double": { "type": "boolean", "description": "ダブルクリックする" },
                "modifiers": { "type": "array", "items": { "enum": ["Control", "Shift", "Alt"] }, "uniqueItems": true, "description": "押しながらクリックするキー" },
                "dialog": dialog_schema()
            }),
            required: &["target"],
            has_output: true,
            examples: vec![
                json!({ "type": CLICK, "name": "ログインする", "params": { "target": { "role": "button", "name": "ログイン" } } }),
                json!({ "type": CLICK, "name": "削除して確認に OK", "params": { "target": { "role": "button", "name": "削除" }, "dialog": "accept" } }),
                json!({ "type": CLICK, "name": "フレームの中の検索", "params": { "target": { "role": "button", "name": "検索", "frame": { "name": "main" } } } }),
                json!({ "type": CLICK, "name": "明細の行を開く", "params": { "target": { "role": "row", "name": "{{ order.id }}" }, "double": true } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: DOWNLOAD,
            method: "download",
            label: "ダウンロード",
            description: "Clicks `target` (the link or button that downloads a file, e.g. CSV出力) and saves the file: to `path`, or into `folder` under the name the site gives it (one of the two). Paths are relative to the flow folder, e.g. \"input/受注.csv\" to read it next with file.readCsv or excel.readRows; an existing file is replaced. Output: { path, fileName } (fileName: the site's name). Fails with DOWNLOAD_NOT_STARTED when the click starts no download.",
            params: json!({
                "target": target,
                "path": { "type": "string", "minLength": 1, "description": "保存するファイル（フローのフォルダーからの相対パス可）" },
                "folder": { "type": "string", "minLength": 1, "description": "保存するフォルダー。名前はサイトが付けたもの" }
            }),
            required: &["target"],
            has_output: true,
            examples: vec![
                json!({ "type": DOWNLOAD, "name": "受注の CSV を落とす", "params": { "target": { "role": "button", "name": "CSV出力" }, "path": "input/受注.csv" }, "saveAs": "csv" }),
                json!({ "type": DOWNLOAD, "name": "請求書を落とす（サイトの名前のまま）", "params": { "target": { "role": "link", "name": "請求書" }, "folder": "output" } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: UPLOAD,
            method: "upload",
            label: "ファイル添付",
            description: "Attaches the file `path` (or a list of files) to the file input `target`, or to the button that opens the file picker (the picker is answered without a window). Paths are relative to the flow folder. It only fills the form: click the send button next. Fails with FILE_NOT_FOUND when a file is missing.",
            params: json!({
                "target": target,
                "path": { "oneOf": [
                    { "type": "string", "minLength": 1 },
                    { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 }
                ], "description": "添付するファイル（複数なら配列）" }
            }),
            required: &["target", "path"],
            has_output: false,
            examples: vec![
                json!({ "type": UPLOAD, "name": "請求書を添付", "params": { "target": { "label": "添付ファイル" }, "path": "output/請求書.pdf" } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: HOVER,
            method: "hover",
            label: "マウスオーバー",
            description: "Moves the mouse over `target`, e.g. to open a menu that appears on hover or show a tooltip. Follow with browser.click on the item that appears.",
            params: json!({ "target": target }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": HOVER, "name": "レポートのメニューを開く", "params": { "target": { "role": "menuitem", "name": "レポート" } } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: SCROLL,
            method: "scroll",
            label: "スクロール",
            description: "Scrolls. `target` alone: brings it into view (clicks and other steps already do this; use it for lists that load more rows when their end is shown). `to: \"bottom\"` / \"top\" alone: the page. Both: scrolls inside `target` (a box that scrolls by itself). To read a list that grows as it scrolls, repeat scroll + browser.waitFor in control.while.",
            params: json!({ "target": target, "to": { "enum": ["top", "bottom"], "description": "一番上・一番下まで" } }),
            required: &[],
            has_output: false,
            examples: vec![
                json!({ "type": SCROLL, "name": "ページの下まで", "params": { "to": "bottom" } }),
                json!({ "type": SCROLL, "name": "一覧の最後の行を出す", "params": { "target": { "role": "row", "nth": 49 } } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: GET_ATTRIBUTE,
            method: "getAttribute",
            label: "属性の取得",
            description: "Reads the attribute `name` of `target` (e.g. href of a link, src of an image, value, data-id). href / src / action come as full addresses. Output: the text, or null when the element has no such attribute. With `all: true`, an array for every matching element. For the text a person sees use browser.getText.",
            params: json!({ "target": target, "name": { "type": "string", "minLength": 1, "description": "属性の名前（href・src・value・data-id など）" }, "all": { "type": "boolean" } }),
            required: &["target", "name"],
            has_output: true,
            examples: vec![
                json!({ "type": GET_ATTRIBUTE, "name": "請求書のリンク先", "params": { "target": { "role": "link", "name": "請求書" }, "name": "href" }, "saveAs": "invoiceUrl" }),
            ],
            ..Def::default()
        },
        Def {
            step_type: RUN_SCRIPT,
            method: "runScript",
            label: "JavaScript の実行",
            description: "Runs JavaScript in the current page and returns what it returns. `script` is the body of an async function: use `return` for the result and `await` freely. Inside it, `args` is the value of `args` (pass flow values here, e.g. { \"code\": \"{{ order.code }}\" }; never write {{ }} inside `script`, a value with a quote would break the code) and `element` is the element `target` points at (null without `target`). `frame` runs it inside that iframe when there is no `target` (with `target`, its own frame is used). Output: the return value (text, number, true/false, null, arrays and objects of them; elements and functions come back as null). Waits for a returned promise up to the step's timeoutMs, then fails with SCRIPT_TIMEOUT; an exception or a syntax error fails with SCRIPT_ERROR and its message. Use it only when no other browser.* step can do the job (a value kept in the page's JavaScript, a hidden state, a calculation on many elements): reading text, attributes and tables, clicking and typing have their own steps, which read better and survive page changes. It runs only inside the page, never on the PC; registered secrets cannot be passed in, and secret values typed on the page are returned as ***.",
            params: json!({
                "script": { "type": "string", "minLength": 1, "description": "実行する JavaScript（async 関数の中身。結果は return で返す。args・element が使える）" },
                "args": { "description": "スクリプトに渡す値（args として使える）。フローの値はここに {{ }} で入れる" },
                "target": target,
                "frame": frame_schema(FRAME_DEPTH - 1)
            }),
            required: &["script"],
            has_output: true,
            examples: vec![
                json!({ "type": RUN_SCRIPT, "name": "画面の受注件数を読む", "params": { "script": "return window.app.orders.length;" }, "saveAs": "orderCount" }),
                json!({ "type": RUN_SCRIPT, "name": "選んだ行の受注番号を集める", "params": {
                    "script": "return [...element.querySelectorAll('tr.selected')].map(tr => tr.dataset.code);",
                    "target": { "role": "table", "name": "受注" }
                }, "saveAs": "codes" }),
                json!({ "type": RUN_SCRIPT, "name": "検索 API を呼ぶ", "params": {
                    "script": "const res = await fetch('/api/orders?code=' + encodeURIComponent(args.code)); return await res.json();",
                    "args": { "code": "{{ order.code }}" }
                }, "saveAs": "detail" }),
            ],
            ..Def::default()
        },
        Def {
            step_type: SWITCH_TAB,
            method: "switchTab",
            label: "タブ切り替え",
            description: "Makes another tab or popup window of the browser context current; every later step on this context works on it. Picks the newest tab whose title contains `title` and/or whose address contains `url`, or the `index`-th tab in opening order (0 = the first). Waits for it to open, so put it right after the click that opens a new tab or window. Output: { url, title, index }. Go back with browser.closeTab, or browser.switchTab { index: 0 }; when a popup closes itself, steps return to the tab before it by themselves.",
            params: json!({
                "title": { "type": "string", "minLength": 1, "description": "タブのタイトルの一部" },
                "url": { "type": "string", "minLength": 1, "description": "タブのアドレスの一部" },
                "index": { "type": "integer", "minimum": 0, "description": "開いた順の番号（0 が最初のタブ）" }
            }),
            required: &[],
            has_output: true,
            examples: vec![
                json!({ "type": SWITCH_TAB, "name": "詳細のウィンドウへ", "params": { "title": "受注詳細" } }),
                json!({ "type": SWITCH_TAB, "name": "最初のタブに戻る", "params": { "index": 0 } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: CLOSE_TAB,
            method: "closeTab",
            label: "タブ終了",
            description: "Closes the current tab (a popup or a tab opened by a link) and goes back to the tab that was current before it. Output: { url, title } of that tab. The last tab cannot be closed this way (use browser.close).",
            params: json!({}),
            required: &[],
            has_output: true,
            examples: vec![json!({ "type": CLOSE_TAB, "name": "詳細を閉じて一覧に戻る" })],
            ..Def::default()
        },
        Def {
            step_type: FILL,
            method: "fill",
            label: "文字入力",
            description: "Replaces the text of the input `target` with `value`: a template, or a registered secret { \"secret\": \"<name>\", \"field\": \"username\" | \"password\" | \"totp\" } (list_secrets shows the names). Secrets are typed only on the sites registered with them and never appear in logs or screenshots. Never write a password as text. `typing: true` clears the field and types the text one key at a time, for pages that react to each key (suggestions, inputs that format as you type) and ignore a pasted value; leave it out otherwise (it is slower). A secret is always filled at once, even with `typing`.",
            params: json!({
                "target": target,
                "value": text_or_secret_schema("入力する文字。パスワードは登録済みシークレット { \"secret\": \"名前\", \"field\": \"password\" }"),
                "typing": { "type": "boolean", "description": "1 文字ずつキーを打って入力する（キー入力を見ているページ向け）" }
            }),
            required: &["target", "value"],
            has_output: false,
            examples: vec![
                json!({ "type": FILL, "name": "ユーザー名を入力", "params": { "target": { "label": "ユーザー名" }, "value": { "secret": "受注システム", "field": "username" } } }),
                json!({ "type": FILL, "name": "パスワードを入力", "params": { "target": { "label": "パスワード" }, "value": { "secret": "受注システム", "field": "password" } } }),
                json!({ "type": FILL, "name": "検索語を入力", "params": { "target": { "label": "検索" }, "value": "{{ keyword }}" } }),
            ],
            secret_params: &["value"],
            ..Def::default()
        },
        Def {
            step_type: CHECK,
            method: "check",
            label: "チェック状態",
            description: "Sets the checkbox (or radio button / switch) `target` to checked (`checked: true`, the default) or unchecked (`checked: false`). Does nothing when it already is, so running the flow twice never flips it back (a browser.click would). For a radio button only `checked: true` makes sense: check the other option to move away.",
            params: json!({
                "target": target,
                "checked": { "type": "boolean", "description": "チェックを付ける（外すときは false、既定は付ける）" }
            }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": CHECK, "name": "利用規約に同意", "params": { "target": { "role": "checkbox", "name": "利用規約に同意する" } } }),
                json!({ "type": CHECK, "name": "メール配信を外す", "params": { "target": { "label": "お知らせメールを受け取る" }, "checked": false } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: NAVIGATE,
            method: "navigate",
            label: "ページ移動",
            description: "Goes `action`: \"back\" (the browser's Back), \"forward\" or \"reload\" in the current tab, and waits for the page to load. Output: { url, title }. To go to an address, use browser.open on the same context (it opens in the current tab). Fails with NAVIGATION_FAILED when there is no page to go back or forward to.",
            params: json!({
                "action": { "enum": ["back", "forward", "reload"], "description": "戻る・進む・再読み込み" }
            }),
            required: &["action"],
            has_output: true,
            examples: vec![
                json!({ "type": NAVIGATE, "name": "一覧に戻る", "params": { "action": "back" } }),
                json!({ "type": NAVIGATE, "name": "最新の状態を読み込む", "params": { "action": "reload" } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: SELECT,
            method: "select",
            label: "項目選択",
            description: "Selects the option(s) `value` (visible label, or value) in the drop-down `target`.",
            params: json!({ "target": target, "value": { "oneOf": [ { "type": "string" }, { "type": "array", "items": { "type": "string" } } ] } }),
            required: &["target", "value"],
            has_output: false,
            examples: vec![
                json!({ "type": SELECT, "params": { "target": { "label": "都道府県" }, "value": "東京都" } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: PRESS,
            method: "press",
            label: "キー入力",
            description: "Presses `key` (e.g. Enter, Tab, Control+A) on `target`, or on the page when `target` is omitted. `dialog` answers a JS dialog the key causes, as in browser.click (output: its message).",
            params: json!({ "key": { "type": "string", "minLength": 1 }, "target": target, "dialog": dialog_schema() }),
            required: &["key"],
            has_output: true,
            examples: vec![
                json!({ "type": PRESS, "params": { "target": { "label": "検索" }, "key": "Enter" } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: GET_TEXT,
            method: "getText",
            label: "文字の取得",
            description: "Reads the visible text of `target`. With `all: true`, returns an array with the text of every matching element. Use saveAs to keep it.",
            params: json!({ "target": target, "all": { "type": "boolean" } }),
            required: &["target"],
            has_output: true,
            examples: vec![
                json!({ "type": GET_TEXT, "params": { "target": { "role": "heading", "nth": 0 } }, "saveAs": "title" }),
            ],
            ..Def::default()
        },
        Def {
            step_type: GET_TABLE,
            method: "getTable",
            label: "表の取得",
            description: "Reads an HTML table into an array of objects keyed by the header cells (cell text as strings; use num() for amounts). `target` defaults to the first table on the page. Use with control.forEach.",
            params: json!({ "target": target }),
            required: &[],
            has_output: true,
            examples: vec![
                json!({ "type": GET_TABLE, "name": "受注一覧を読む", "params": { "target": { "role": "table", "name": "受注" } }, "saveAs": "orders" }),
            ],
            ..Def::default()
        },
        Def {
            step_type: WAIT_FOR,
            method: "waitFor",
            label: "要素の待機",
            description: "Waits until `target` reaches `state` (visible by default; hidden, attached, detached). The limit is the step's `timeoutMs` (default 30000).",
            params: json!({ "target": target, "state": { "enum": ["visible", "hidden", "attached", "detached"] } }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": WAIT_FOR, "name": "一覧の表示を待つ", "params": { "target": { "role": "heading", "name": "受注一覧" } } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: SCREENSHOT,
            method: "screenshot",
            label: "スクリーンショット",
            description: "Saves a PNG of the page to `path` (absolute; `fullPage: true` for the whole page). Output: the path.",
            params: json!({ "path": { "type": "string", "minLength": 1 }, "fullPage": { "type": "boolean" } }),
            required: &["path"],
            has_output: true,
            examples: vec![
                json!({ "type": SCREENSHOT, "params": { "path": "{{ outDir }}\\受注一覧.png", "fullPage": true } }),
            ],
            ..Def::default()
        },
        Def {
            step_type: IS_VISIBLE,
            method: "isVisible",
            label: "表示の確認",
            description: "Output: true when `target` is visible (waiting up to `waitMs`, default 2000), otherwise false. Never fails for a missing element: use it with control.if, e.g. to log in only when the login form is shown.",
            params: json!({ "target": target, "waitMs": { "type": "integer", "minimum": 0, "maximum": 20000 } }),
            required: &["target"],
            has_output: true,
            examples: vec![
                json!({ "type": IS_VISIBLE, "name": "ログイン画面か確かめる", "params": { "target": { "label": "パスワード" } }, "saveAs": "needsLogin" }),
            ],
            ..Def::default()
        },
        Def {
            step_type: WAIT_FOR_HUMAN,
            method: "waitForHuman",
            label: "手動操作の待機",
            description: "Shows `message` to the person at the PC and waits until they finish something in the browser window (log in, approve MFA on their phone, solve a CAPTCHA): the step ends when `until` becomes visible. Waits up to the step's timeoutMs (default 5 minutes). Fails at once with HUMAN_REQUIRED in headless runs.",
            params: json!({
                "message": { "type": "string", "description": "人に頼むこと（例：スマホで認証を承認してください）" },
                "until": target
            }),
            required: &["until"],
            has_output: false,
            examples: vec![
                json!({ "type": WAIT_FOR_HUMAN, "name": "MFA の承認を待つ", "params": { "message": "スマホで認証を承認してください", "until": { "role": "heading", "name": "受注一覧" } } }),
            ],
            default_timeout_ms: Some(300_000),
            ..Def::default()
        },
        Def {
            step_type: OAUTH_SIGN_IN,
            method: "authorize",
            label: "OAuth サインイン",
            description: "Signs in to a web API with OAuth 2.0 (authorization code flow) so http.request can use { \"secret\": \"<name>\", \"field\": \"accessToken\" } as auth. The secret `secret` holds the app registered at the provider: username = client ID, password = client secret (empty for public clients), sites = the origins of tokenUrl and of the API. When saved tokens work (or can be refreshed) it finishes at once without a person. Otherwise it opens `authorizeUrl` in the browser context `context`, shows `message`, and waits (default 5 minutes) while the person signs in and allows access. The browser's request to `redirectUrl` (the redirect URI registered at the provider, any fixed URL such as https://www.example.com/callback; localhost is not needed) is caught inside the browser, so that page never loads; state is checked and the code is exchanged at `tokenUrl` (PKCE unless `pkce: false`). Output: { secret, signedIn, via: saved | refreshed | browser, expiresAt, scope } (never the tokens). Fails with HUMAN_REQUIRED in headless runs that need a person.",
            params: json!({
                "secret": { "type": "string", "minLength": 1, "maxLength": 64, "description": "クライアントを登録したシークレットの名前（ユーザー名 = Client ID、パスワード = Client secret）" },
                "authorizeUrl": { "type": "string", "minLength": 1, "description": "認可ページの URL（例：https://account.box.com/api/oauth2/authorize）" },
                "tokenUrl": { "type": "string", "minLength": 1, "description": "トークンの URL（例：https://api.box.com/oauth2/token）" },
                "redirectUrl": { "type": "string", "minLength": 1, "description": "プロバイダに登録したリダイレクト URL。そのまま一致させる" },
                "scope": { "type": "string", "description": "空白区切りのスコープ（プロバイダが求めるときだけ）" },
                "authorizeParams": { "type": "object", "description": "認可ページに付ける追加のパラメータ（例：{ \"prompt\": \"consent\" }）" },
                "pkce": { "type": "boolean", "description": "PKCE を使う（既定 true）。プロバイダが受け付けないときだけ false" },
                "message": { "type": "string", "description": "人に頼むこと（既定：ブラウザでサインインして、アクセスを許可してください）" }
            }),
            required: &["secret", "authorizeUrl", "tokenUrl", "redirectUrl"],
            has_output: true,
            examples: vec![
                json!({ "type": OAUTH_SIGN_IN, "name": "Box にサインイン", "params": {
                    "secret": "Box",
                    "authorizeUrl": "https://account.box.com/api/oauth2/authorize",
                    "tokenUrl": "https://api.box.com/oauth2/token",
                    "redirectUrl": "https://www.example.com/"
                } }),
            ],
            default_timeout_ms: Some(300_000),
            ..Def::default()
        },
        Def {
            step_type: CLOSE,
            method: "close",
            label: "ブラウザ終了",
            description: "Closes the browser context `context`. Optional: contexts are closed when the run ends.",
            params: json!({}),
            required: &[],
            has_output: false,
            examples: vec![json!({ "type": CLOSE })],
            ..Def::default()
        },
    ];

    defs.into_iter()
        .map(|d| {
            let mut resources = vec![ResourceDef::browser_context("context")];
            match d.step_type {
                SCREENSHOT | UPLOAD => resources.push(ResourceDef::file("path")),
                DOWNLOAD => {
                    resources.push(ResourceDef::file("path"));
                    resources.push(ResourceDef::file("folder"));
                }
                _ => {}
            }
            let oauth = d.step_type == OAUTH_SIGN_IN;
            let targets = if d.step_type == OPEN {
                vec![TargetDef::site("url")]
            } else if oauth {
                vec![TargetDef::site("authorizeUrl"), TargetDef::site("tokenUrl")]
            } else {
                Vec::new()
            };
            let def = StepTypeDef {
                targets,
                step_type: d.step_type.into(),
                category: if oauth {
                    StepCategory::Network
                } else {
                    StepCategory::Browser
                },
                label: d.label.into(),
                description: d.description.into(),
                params_schema: schema(props(d.params), d.required),
                blocks: vec![],
                has_output: d.has_output,
                expression_params: vec![],
                binds_variables: vec![],
                // Downloads write files; uploads send them out.
                // Attaching reaches the person's own logins.
                // A script can do anything the page can (send, delete).
                risk: if oauth || [DOWNLOAD, UPLOAD, ATTACH, RUN_SCRIPT].contains(&d.step_type) {
                    RiskLevel::Dangerous
                } else {
                    RiskLevel::Interactive
                },
                examples: d.examples,
                resources,
                secret_params: d.secret_params.iter().map(|p| (*p).to_owned()).collect(),
                default_timeout_ms: d.default_timeout_ms,
                deprecated: None,
                plugin: None,
                path_params: Vec::new(),
            };
            (def, d.method)
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
