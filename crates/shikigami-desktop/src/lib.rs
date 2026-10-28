//! Desktop app steps (`desktop.*`) for the Shikigami Runtime.
//!
//! One set of steps for every kind of Windows application: a step names a
//! window and an element by meaning (`{ "window": { "process":
//! "billing.exe" }, "element": { "id": "btnSave" } }`) and the adapter
//! decides how to reach it. Today that is Microsoft UI Automation on a
//! dedicated thread (`uia`); SAP GUI and Java windows are recognised and get
//! their own backends later behind the same steps (see `engine`).
//!
//! Steps that only use UI Automation patterns (`desktop.click`,
//! `desktop.setValue`, ...) need no focus and lock only their app's window.
//! Steps that use the real mouse and keyboard (`desktop.mouseClick`,
//! `desktop.type`, `desktop.press`) also take `desktop.input`, so they never
//! run at the same time as each other.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use shikigami_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use shikigami_core::resource::{DESKTOP_INPUT, ResourceDef};
use shikigami_core::secret::text_or_secret_schema;
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};

pub mod backend;
pub mod engine;
pub mod keys;
pub mod roles;
pub mod target;
#[cfg(windows)]
mod uia;

use backend::{Backend, MouseButton, Op, Text};
use target::{APP_SITE_PREFIX, ElementQuery, Target, WindowQuery};

pub mod types {
    pub const LAUNCH: &str = "desktop.launch";
    pub const CLICK: &str = "desktop.click";
    pub const SET_VALUE: &str = "desktop.setValue";
    pub const GET_VALUE: &str = "desktop.getValue";
    pub const SELECT: &str = "desktop.select";
    pub const MOUSE_CLICK: &str = "desktop.mouseClick";
    pub const TYPE: &str = "desktop.type";
    pub const PRESS: &str = "desktop.press";
    pub const WAIT_FOR: &str = "desktop.waitFor";
    pub const IS_VISIBLE: &str = "desktop.isVisible";
    pub const CLOSE_WINDOW: &str = "desktop.closeWindow";
}

/// How much earlier than the step timeout the adapter stops waiting.
const TIMEOUT_MARGIN_MS: u64 = 500;
/// How often a missing window or element is looked for again.
const POLL: Duration = Duration::from_millis(250);
const DEFAULT_MAX_NODES: usize = 1500;

/// Desktop steps backed by the platform's backend (UI Automation on
/// Windows; elsewhere every step fails with `PLATFORM_UNSUPPORTED`).
#[derive(Clone)]
pub struct DesktopAdapter {
    backend: Arc<dyn Backend>,
}

impl std::fmt::Debug for DesktopAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DesktopAdapter")
    }
}

impl DesktopAdapter {
    pub fn new() -> Self {
        #[cfg(windows)]
        let backend: Arc<dyn Backend> = Arc::new(uia::UiaBackend::new());
        #[cfg(not(windows))]
        let backend: Arc<dyn Backend> = Arc::new(backend::Unsupported);
        Self { backend }
    }

    /// An adapter over another backend (tests use a scripted one).
    pub fn with_backend(backend: Arc<dyn Backend>) -> Self {
        Self { backend }
    }
}

impl Default for DesktopAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl Adapter for DesktopAdapter {
    fn name(&self) -> &'static str {
        "desktop"
    }

    fn install(&self, mut builder: RuntimeBuilder) -> RuntimeBuilder {
        for (def, kind) in step_defs() {
            builder = builder.register(
                def,
                DesktopStep {
                    backend: self.backend.clone(),
                    kind,
                },
            );
        }
        builder
    }

    /// Without `window`: the open windows. With it: that window's element
    /// tree (`element` narrows it to one part, `maxNodes` caps its size).
    fn inspect<'a>(
        &'a self,
        _session: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let Some(window) = params.get("window") else {
                let windows = self.backend.call(Op::ListWindows).await?;
                return Ok(json!({
                    "windows": windows,
                    "hint": "Pass `window` (e.g. { \"process\": \"notepad.exe\" }) to see the elements of one window.",
                }));
            };
            let window: WindowQuery =
                serde_json::from_value(window.clone()).map_err(StepError::invalid_params)?;
            let element = params
                .get("element")
                .map(|e| serde_json::from_value::<ElementQuery>(e.clone()))
                .transpose()
                .map_err(StepError::invalid_params)?;
            let max_nodes = params
                .get("maxNodes")
                .and_then(Value::as_u64)
                .map_or(DEFAULT_MAX_NODES, |n| n.clamp(1, 10_000) as usize);
            self.backend
                .call(Op::Inspect {
                    window,
                    element,
                    max_nodes,
                })
                .await
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Launch,
    Click,
    SetValue,
    GetValue,
    Select,
    MouseClick,
    Type,
    Press,
    WaitFor,
    IsVisible,
    CloseWindow,
}

struct DesktopStep {
    backend: Arc<dyn Backend>,
    kind: Kind,
}

impl ActionHandler for DesktopStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let deadline = Instant::now()
                + Duration::from_millis(input.timeout_ms.saturating_sub(TIMEOUT_MARGIN_MS).max(1));
            let params = &input.params;
            let op = match self.kind {
                Kind::Launch => return launch(params),
                Kind::WaitFor => return self.wait_for(&input, deadline).await,
                Kind::IsVisible => return self.is_visible(&input).await,
                Kind::Click => Op::Click {
                    target: target(params)?,
                },
                Kind::SetValue => Op::SetValue {
                    target: target(params)?,
                    text: text(&input, "value")?,
                },
                Kind::GetValue => Op::GetValue {
                    target: target(params)?,
                },
                Kind::Select => Op::Select {
                    target: target(params)?,
                    option: string(params, "value")?,
                },
                Kind::MouseClick => Op::MouseClick {
                    target: target(params)?,
                    button: match params.get("button").and_then(Value::as_str) {
                        Some("right") => MouseButton::Right,
                        _ => MouseButton::Left,
                    },
                    double: params
                        .get("double")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                },
                Kind::Type => Op::Type {
                    target: target(params)?,
                    text: text(&input, "text")?,
                },
                Kind::Press => Op::Press {
                    target: target(params)?,
                    chord: keys::parse(&string(params, "key")?)?,
                },
                Kind::CloseWindow => Op::CloseWindow {
                    target: target(params)?,
                },
            };
            let output = self.until_found(op, &input, deadline).await?;
            Ok(output)
        })
    }
}

/// Errors that mean "not there yet": the step looks again until its time
/// is up, like a person waiting for a screen to appear.
fn is_not_ready(e: &StepError) -> bool {
    matches!(
        e.code.as_str(),
        "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_DISABLED" | "ELEMENT_GONE"
    )
}

impl DesktopStep {
    async fn until_found(
        &self,
        op: Op,
        input: &ActionInput,
        deadline: Instant,
    ) -> Result<Value, StepError> {
        loop {
            match self.backend.call(op.clone()).await {
                Err(e) if is_not_ready(&e) && Instant::now() + POLL < deadline => {
                    tokio::select! {
                        () = tokio::time::sleep(POLL) => {}
                        () = input.cancel.cancelled() => return Err(e),
                    }
                }
                other => return other,
            }
        }
    }

    async fn probe(&self, target: &Target) -> Result<(bool, bool, bool), StepError> {
        let state = self
            .backend
            .call(Op::Probe {
                target: target.clone(),
            })
            .await?;
        let flag = |key: &str| state.get(key).and_then(Value::as_bool).unwrap_or(false);
        Ok((flag("found"), flag("visible"), flag("enabled")))
    }

    async fn wait_for(&self, input: &ActionInput, deadline: Instant) -> Result<Value, StepError> {
        let target = target(&input.params)?;
        let state = input
            .params
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("visible")
            .to_owned();
        loop {
            let (found, visible, enabled) = self.probe(&target).await?;
            let done = match state.as_str() {
                "hidden" => !(found && visible),
                "enabled" => found && visible && enabled,
                _ => found && visible,
            };
            if done {
                return Ok(Value::Null);
            }
            if Instant::now() + POLL >= deadline {
                return Err(StepError::new(
                    "WAIT_TIMEOUT",
                    format!("the target did not become {state} in time"),
                )
                .with_details(json!({
                    "found": found, "visible": visible, "enabled": enabled,
                    "hint": "Check the target with inspect_ui, or raise the step's timeoutMs if the app is slow."
                })));
            }
            tokio::select! {
                () = tokio::time::sleep(POLL) => {}
                () = input.cancel.cancelled() => return Err(StepError::new("CANCELLED", "cancelled")),
            }
        }
    }

    async fn is_visible(&self, input: &ActionInput) -> Result<Value, StepError> {
        let target = target(&input.params)?;
        let wait = input
            .params
            .get("waitMs")
            .and_then(Value::as_u64)
            .unwrap_or(2000)
            .min(input.timeout_ms.saturating_sub(TIMEOUT_MARGIN_MS));
        let until = Instant::now() + Duration::from_millis(wait);
        loop {
            let (found, visible, _) = self.probe(&target).await?;
            if found && visible {
                return Ok(Value::Bool(true));
            }
            if Instant::now() + POLL >= until {
                return Ok(Value::Bool(false));
            }
            tokio::select! {
                () = tokio::time::sleep(POLL) => {}
                () = input.cancel.cancelled() => return Ok(Value::Bool(false)),
            }
        }
    }
}

fn target(params: &Value) -> Result<Target, StepError> {
    Target::from_params(params, "target")
}

fn string(params: &Value, key: &str) -> Result<String, StepError> {
    match params.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        Some(Value::Bool(b)) => Ok(b.to_string()),
        _ => Err(StepError::invalid_params(format!(
            "'{key}' must be a string"
        ))),
    }
}

/// Text from a param that may be a secret reference. A secret is typed
/// only into the apps registered with it (`app:billing.exe`).
fn text(input: &ActionInput, key: &str) -> Result<Text, StepError> {
    let value = input
        .params
        .get(key)
        .ok_or_else(|| StepError::invalid_params(format!("'{key}' is required")))?;
    let Some(secret) = input.resolve_secret(value)? else {
        return Ok(Text {
            value: string(&input.params, key)?,
            allowed_apps: None,
        });
    };
    let apps: Vec<String> = secret
        .sites
        .iter()
        .filter(|s| s.starts_with(APP_SITE_PREFIX))
        .cloned()
        .collect();
    if apps.is_empty() {
        return Err(StepError::permanent(
            "SECRET_APP_NOT_SET",
            format!("secret '{}' has no desktop app it may be typed into", secret.name),
        )
        .with_details(json!({
            "secret": secret.name,
            "hint": "Call request_secret with this name and the app, written as app:<exe name> (e.g. app:billing.exe): Studio then asks the user to add it to this secret's sites."
        })));
    }
    Ok(Text {
        value: secret.value,
        allowed_apps: Some(apps),
    })
}

/// Starts a program and returns its process ID; the next steps wait for
/// its window by themselves.
fn launch(params: &Value) -> Result<Value, StepError> {
    let path = string(params, "path")?;
    let mut command = std::process::Command::new(&path);
    if let Some(args) = params.get("args").and_then(Value::as_array) {
        command.args(args.iter().map(|a| match a {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }));
    }
    if let Some(dir) = params.get("workingDir").and_then(Value::as_str) {
        command.current_dir(dir);
    }
    let child = command.spawn().map_err(|e| {
        StepError::permanent("LAUNCH_FAILED", format!("could not start {path}: {e}")).with_details(
            json!({ "hint": "Use the program's full path (e.g. C:\\Program Files\\App\\app.exe), or a program on PATH such as notepad.exe." }),
        )
    })?;
    Ok(json!({ "pid": child.id() }))
}

// -- step type definitions ----------------------------------------------------

fn target_schema(point: bool) -> Value {
    let mut properties = json!({
        "window": {
            "type": "object",
            "description": "トップレベルのウィンドウ。inspect_ui（引数なし）の一覧から title / process を写す",
            "properties": {
                "title": { "type": "string", "minLength": 1, "description": "タイトル（既定は部分一致・大文字小文字無視）" },
                "process": { "type": "string", "minLength": 1, "description": "実行ファイル名（例 billing.exe）" },
                "className": { "type": "string", "minLength": 1 },
                "exact": { "type": "boolean", "description": "title を完全一致にする" },
                "nth": { "type": "integer", "minimum": 0, "description": "複数一致したときの 0 始まりの番号" }
            },
            "additionalProperties": false,
            "anyOf": [ { "required": ["title"] }, { "required": ["process"] }, { "required": ["className"] } ]
        },
        "element": {
            "type": "object",
            "description": "ウィンドウ内の部品。inspect_ui の行から写す：id が第一候補、なければ role + name。省略するとウィンドウ自体",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "部品の ID（UIA の AutomationId）。完全一致" },
                "name": { "type": "string", "minLength": 1, "description": "表示名（既定は部分一致・大文字小文字無視）" },
                "role": { "enum": roles::names(), "description": "部品の種類（ブラウザと同じ語彙：button, textbox, checkbox, combobox, menuitem, tab, row ...）" },
                "className": { "type": "string", "minLength": 1 },
                "exact": { "type": "boolean", "description": "name を完全一致にする" },
                "nth": { "type": "integer", "minimum": 0, "description": "複数一致したときの 0 始まりの番号（inspect_ui の表示順）" }
            },
            "additionalProperties": false,
            "anyOf": [ { "required": ["id"] }, { "required": ["name"] }, { "required": ["role"] }, { "required": ["className"] } ]
        }
    });
    if point && let Value::Object(map) = &mut properties {
        map.insert(
            "point".into(),
            json!({
                "type": "object",
                "description": "最終手段：ウィンドウ左上からの座標（px）。部品が inspect_ui に出ないときだけ使う。element と同時には書けない",
                "properties": { "x": { "type": "integer" }, "y": { "type": "integer" } },
                "required": ["x", "y"],
                "additionalProperties": false
            }),
        );
    }
    json!({
        "type": "object",
        "description": "操作する対象。例 { \"window\": { \"process\": \"billing.exe\" }, \"element\": { \"id\": \"btnSave\" } }",
        "properties": properties,
        "required": ["window"],
        "additionalProperties": false
    })
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

struct Def {
    step_type: &'static str,
    kind: Kind,
    label: &'static str,
    description: &'static str,
    params: Value,
    required: &'static [&'static str],
    has_output: bool,
    examples: Vec<Value>,
    secret_params: &'static [&'static str],
    /// Uses the real mouse / keyboard (takes `desktop.input`).
    input: bool,
}

/// Step type definitions with the operation each one performs.
fn step_defs() -> Vec<(StepTypeDef, Kind)> {
    use types::*;
    let target = target_schema(false);
    let save = json!({ "window": { "title": "請求システム", "process": "billing.exe" }, "element": { "id": "btnSave" } });
    let customer =
        json!({ "window": { "process": "billing.exe" }, "element": { "id": "txtCustomer" } });
    let defs = vec![
        Def {
            step_type: LAUNCH,
            kind: Kind::Launch,
            label: "アプリを起動",
            description: "Starts the program `path` (full path, or a program on PATH) with `args`. Output: { pid }. The following steps wait for its window by themselves, so no wait step is needed.",
            params: json!({
                "path": { "type": "string", "minLength": 1 },
                "args": { "type": "array", "items": { "type": "string" } },
                "workingDir": { "type": "string", "minLength": 1 }
            }),
            required: &["path"],
            has_output: true,
            examples: vec![
                json!({ "type": LAUNCH, "name": "請求システムを起動", "params": { "path": "C:\\Program Files\\Billing\\billing.exe" } }),
                json!({ "type": LAUNCH, "params": { "path": "notepad.exe", "args": ["{{ outDir }}\\memo.txt"] } }),
            ],
            secret_params: &[],
            input: false,
        },
        Def {
            step_type: CLICK,
            kind: Kind::Click,
            label: "クリック",
            description: "Activates `target` without the mouse: presses a button or menu item, toggles a checkbox, selects a list item or tab, expands a tree item. Works even when the window is behind others. Waits until the element exists and is enabled. For elements that only react to a real mouse click, use desktop.mouseClick.",
            params: json!({ "target": target }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": CLICK, "name": "保存する", "params": { "target": save } }),
                json!({ "type": CLICK, "params": { "target": { "window": { "process": "billing.exe" }, "element": { "role": "menuitem", "name": "ファイル" } } } }),
            ],
            secret_params: &[],
            input: false,
        },
        Def {
            step_type: SET_VALUE,
            kind: Kind::SetValue,
            label: "値を入力",
            description: "Replaces the text of the input `target` with `value`, without the keyboard: a template, or a registered secret { \"secret\": \"<name>\", \"field\": \"username\" | \"password\" } (typed only into the apps registered with it as app:<exe>). Never write a password as text. If the field ignores it (some apps react only to keystrokes), use desktop.type.",
            params: json!({ "target": target, "value": text_or_secret_schema("入力する文字。パスワードは登録済みシークレット { \"secret\": \"名前\", \"field\": \"password\" }") }),
            required: &["target", "value"],
            has_output: false,
            examples: vec![
                json!({ "type": SET_VALUE, "name": "顧客コードを入力", "params": { "target": customer, "value": "{{ customerCode }}" } }),
                json!({ "type": SET_VALUE, "name": "パスワードを入力", "params": { "target": { "window": { "process": "billing.exe" }, "element": { "id": "txtPassword" } }, "value": { "secret": "請求システム", "field": "password" } } }),
            ],
            secret_params: &["value"],
            input: false,
        },
        Def {
            step_type: GET_VALUE,
            kind: Kind::GetValue,
            label: "値を取得",
            description: "Reads `target`: the text of an input or combo box, true/false for a checkbox or radio button, otherwise the element's name (e.g. a label's text). Use saveAs to keep it.",
            params: json!({ "target": target }),
            required: &["target"],
            has_output: true,
            examples: vec![
                json!({ "type": GET_VALUE, "name": "合計を読む", "params": { "target": { "window": { "process": "billing.exe" }, "element": { "id": "lblTotal" } } }, "saveAs": "total" }),
            ],
            secret_params: &[],
            input: false,
        },
        Def {
            step_type: SELECT,
            kind: Kind::Select,
            label: "選択",
            description: "Selects the option named `value` in the combo box or list `target` (exact name first, then a unique partial match). Fails with the available options when none fits.",
            params: json!({ "target": target, "value": { "type": "string", "minLength": 1 } }),
            required: &["target", "value"],
            has_output: false,
            examples: vec![
                json!({ "type": SELECT, "params": { "target": { "window": { "process": "billing.exe" }, "element": { "id": "cmbPref" } }, "value": "東京都" } }),
            ],
            secret_params: &[],
            input: false,
        },
        Def {
            step_type: MOUSE_CLICK,
            kind: Kind::MouseClick,
            label: "マウスでクリック",
            description: "Brings the window to the front and clicks `target` with the real mouse (`button`: left or right; `double: true` for a double click). Use desktop.click first; this is for elements that ignore it. `target.point` (pixels from the window's top-left) is the last resort when the element is not in inspect_ui.",
            params: json!({
                "target": target_schema(true),
                "button": { "enum": ["left", "right"] },
                "double": { "type": "boolean" }
            }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": MOUSE_CLICK, "name": "行をダブルクリック", "params": { "target": { "window": { "process": "billing.exe" }, "element": { "role": "row", "name": "{{ orderNo }}" } }, "double": true } }),
            ],
            secret_params: &[],
            input: true,
        },
        Def {
            step_type: TYPE,
            kind: Kind::Type,
            label: "キーボードで入力",
            description: "Brings the window to the front, focuses `target` and types `text` with the keyboard (does not clear the field first). For apps that ignore desktop.setValue. `text` may be a registered secret, typed only into the apps registered with it.",
            params: json!({ "target": target, "text": text_or_secret_schema("打ち込む文字。パスワードは登録済みシークレット") }),
            required: &["target", "text"],
            has_output: false,
            examples: vec![
                json!({ "type": TYPE, "params": { "target": customer, "text": "{{ customerCode }}" } }),
            ],
            secret_params: &["text"],
            input: true,
        },
        Def {
            step_type: PRESS,
            kind: Kind::Press,
            label: "キー入力",
            description: "Brings the window to the front, focuses `target` (or the window) and presses `key`, e.g. Enter, Tab, Escape, F5, Control+S, Alt+F4, Shift+ArrowDown.",
            params: json!({ "target": target, "key": { "type": "string", "minLength": 1 } }),
            required: &["target", "key"],
            has_output: false,
            examples: vec![
                json!({ "type": PRESS, "name": "保存（Ctrl+S）", "params": { "target": { "window": { "process": "billing.exe" } }, "key": "Control+S" } }),
            ],
            secret_params: &[],
            input: true,
        },
        Def {
            step_type: WAIT_FOR,
            kind: Kind::WaitFor,
            label: "画面を待つ",
            description: "Waits until `target` reaches `state`: visible (default), hidden (closed or gone, e.g. a progress dialog), or enabled. The limit is the step's timeoutMs (default 30000). Other desktop steps already wait for their target, so use this for screens that must disappear or for slow apps.",
            params: json!({ "target": target, "state": { "enum": ["visible", "hidden", "enabled"] } }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": WAIT_FOR, "name": "処理中ダイアログが閉じるのを待つ", "params": { "target": { "window": { "process": "billing.exe", "title": "処理中" } }, "state": "hidden" } }),
            ],
            secret_params: &[],
            input: false,
        },
        Def {
            step_type: IS_VISIBLE,
            kind: Kind::IsVisible,
            label: "表示されているか",
            description: "Output: true when `target` is shown (waiting up to `waitMs`, default 2000), otherwise false. Never fails for a missing window or element: use it with control.if, e.g. to close a dialog only when it appears.",
            params: json!({ "target": target, "waitMs": { "type": "integer", "minimum": 0, "maximum": 20000 } }),
            required: &["target"],
            has_output: true,
            examples: vec![
                json!({ "type": IS_VISIBLE, "name": "確認ダイアログが出たか", "params": { "target": { "window": { "process": "billing.exe", "title": "確認" } } }, "saveAs": "confirmShown" }),
            ],
            secret_params: &[],
            input: false,
        },
        Def {
            step_type: CLOSE_WINDOW,
            kind: Kind::CloseWindow,
            label: "ウィンドウを閉じる",
            description: "Closes the window `target.window` as its close button would (the app may still ask to save).",
            params: json!({ "target": target }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": CLOSE_WINDOW, "params": { "target": { "window": { "process": "notepad.exe" } } } }),
            ],
            secret_params: &[],
            input: false,
        },
    ];

    defs.into_iter()
        .map(|d| {
            let mut resources = Vec::new();
            if d.required.contains(&"target") {
                resources.push(ResourceDef::window("target"));
            }
            if d.input {
                resources.push(ResourceDef::Static(DESKTOP_INPUT.into()));
            }
            let def = StepTypeDef {
                step_type: d.step_type.into(),
                category: StepCategory::Windows,
                label: d.label.into(),
                description: d.description.into(),
                params_schema: schema(d.params, d.required),
                blocks: vec![],
                has_output: d.has_output,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Interactive,
                examples: d.examples,
                resources,
                secret_params: d.secret_params.iter().map(|p| (*p).to_owned()).collect(),
                default_timeout_ms: None,
                deprecated: None,
                plugin: None,
            };
            (def, d.kind)
        })
        .collect()
}

/// The step type definitions (for docs and tests).
pub fn definitions() -> Vec<StepTypeDef> {
    step_defs().into_iter().map(|(def, _)| def).collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
