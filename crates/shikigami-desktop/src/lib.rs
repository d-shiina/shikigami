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
//!
//! Where an app shows no elements (Citrix, remote desktops, drawn screens),
//! targets find their place on the picture of the window instead: an image
//! (`target.image`, template matching) or a text (`target.ocr`, offline
//! OCR: PaddleOCR, or Windows OCR where its models are not installed). `desktop.readText` reads a window's text with OCR and
//! `desktop.screenshot` saves its picture (see `visual`).

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
pub mod bitmap;
#[cfg(windows)]
mod capture;
pub mod engine;
pub mod keys;
pub mod paddle;
pub mod roles;
pub mod target;
#[cfg(windows)]
mod uia;
pub mod vision;
pub mod visual;

use backend::{Backend, MouseButton, Op, Text};
use target::{APP_SITE_PREFIX, Allow, ElementQuery, Target, WindowQuery};
use visual::Looking;

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
    pub const READ_TEXT: &str = "desktop.readText";
    pub const SCREENSHOT: &str = "desktop.screenshot";
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
            let mut result = self
                .backend
                .call(Op::Inspect {
                    window: window.clone(),
                    element,
                    max_nodes,
                })
                .await?;
            let screenshot = params.get("screenshotPath").and_then(Value::as_str);
            let ocr = params.get("ocr").and_then(Value::as_bool).unwrap_or(false);
            if screenshot.is_some() || ocr {
                self.look_at_window(&mut result, window, screenshot, ocr, &params)
                    .await;
            }
            Ok(result)
        })
    }
}

impl DesktopAdapter {
    /// Adds the window's picture (to `screenshot`) and, with `ocr`, the
    /// text read on it to an inspect_ui result. A window that cannot be
    /// pictured still has its element tree, so failures become a note.
    async fn look_at_window(
        &self,
        result: &mut Value,
        window: WindowQuery,
        screenshot: Option<&str>,
        ocr: bool,
        params: &Value,
    ) {
        let target = Target::window_only(window);
        let picture = match visual::picture(self.backend.as_ref(), &target).await {
            Ok(picture) => picture,
            Err(e) => {
                result["pictureError"] = json!(e.message);
                return;
            }
        };
        result["size"] = json!({ "width": picture.image.width, "height": picture.image.height });
        if let Some(path) = screenshot {
            let _ = std::fs::write(path, picture.image.to_png());
        }
        if ocr {
            let options = match visual::ocr_options(params) {
                Ok(options) => options,
                Err(e) => {
                    result["ocrError"] = json!(e.message);
                    return;
                }
            };
            match visual::read_lines(self.backend.as_ref(), &picture, options).await {
                Ok(lines) => {
                    result["ocr"] = vision::ocr_lines_json(&lines, 0, 0);
                    result["ocrHint"] = json!(
                        "Each line is text OCR read, at pixels from the window's top-left. Target it with { \"window\": …, \"ocr\": { \"text\": \"<text>\" } }, or read a part with desktop.readText and target.region."
                    );
                }
                Err(e) => result["ocrError"] = json!(e.message),
            }
        }
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
    ReadText,
    Screenshot,
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
                Kind::ReadText => return self.read_text(&input, deadline).await,
                Kind::Screenshot => return self.screenshot(&input, deadline).await,
                Kind::Click => Op::Click {
                    target: target(params, Allow::Plain)?,
                },
                Kind::SetValue => Op::SetValue {
                    target: target(params, Allow::Plain)?,
                    text: text(&input, "value")?,
                },
                Kind::GetValue => Op::GetValue {
                    target: target(params, Allow::Plain)?,
                },
                Kind::Select => Op::Select {
                    target: target(params, Allow::Plain)?,
                    option: string(params, "value")?,
                },
                Kind::MouseClick => {
                    let mut target = target(params, Allow::Mouse)?;
                    if target.is_visual() {
                        target = self.located(&target, &input, deadline).await?;
                    }
                    Op::MouseClick {
                        target,
                        button: match params.get("button").and_then(Value::as_str) {
                            Some("right") => MouseButton::Right,
                            _ => MouseButton::Left,
                        },
                        double: params
                            .get("double")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }
                }
                Kind::Type => {
                    let target = target(params, Allow::Visual)?;
                    let text = text(&input, "text")?;
                    if target.is_visual() {
                        // Click the place to focus it, then type into
                        // whatever has the focus in that window.
                        let at = self.located(&target, &input, deadline).await?;
                        self.until_found(
                            Op::MouseClick {
                                target: at,
                                button: MouseButton::Left,
                                double: false,
                            },
                            &input,
                            deadline,
                        )
                        .await?;
                        Op::Type {
                            target: Target::window_only(target.window),
                            text,
                        }
                    } else {
                        Op::Type { target, text }
                    }
                }
                Kind::Press => Op::Press {
                    target: target(params, Allow::Plain)?,
                    chord: keys::parse(&string(params, "key")?)?,
                },
                Kind::CloseWindow => Op::CloseWindow {
                    target: target(params, Allow::Plain)?,
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

    /// The target with `point` set where its image or text is now, waiting
    /// for it to appear.
    async fn located(
        &self,
        target: &Target,
        input: &ActionInput,
        deadline: Instant,
    ) -> Result<Target, StepError> {
        let looking = self.looking(target).await?;
        loop {
            let result = match visual::look(self.backend.as_ref(), target, &looking).await {
                Ok(seen) => visual::pick(target, &looking, &seen),
                Err(e) => Err(e),
            };
            match result {
                Ok(point) => {
                    let mut at = Target::window_only(target.window.clone());
                    at.point = Some(point);
                    return Ok(at);
                }
                Err(e)
                    if (is_not_ready(&e) || visual::is_not_seen(&e))
                        && Instant::now() + POLL < deadline =>
                {
                    tokio::select! {
                        () = tokio::time::sleep(POLL) => {}
                        () = input.cancel.cancelled() => return Err(e),
                    }
                }
                Err(e) => return Err(e),
            }
        }
    }

    async fn looking(&self, target: &Target) -> Result<Looking, StepError> {
        Looking::new(self.backend.as_ref(), target)
            .await?
            .ok_or_else(|| StepError::invalid_params("target needs image or ocr"))
    }

    /// `(found, visible, enabled)` of the target now. A visual target is
    /// found when its image or text is on the screen at least once.
    async fn probe_any(
        &self,
        target: &Target,
        looking: Option<&Looking>,
    ) -> Result<(bool, bool, bool), StepError> {
        let Some(looking) = looking else {
            return self.probe(target).await;
        };
        match visual::look(self.backend.as_ref(), target, looking).await {
            Ok(seen) => {
                let shown = !seen.places.is_empty();
                Ok((shown, shown, shown))
            }
            Err(e) if is_not_ready(&e) || e.code == "REGION_OUTSIDE" => Ok((false, false, false)),
            Err(e) => Err(e),
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
        let target = target(&input.params, Allow::Visual)?;
        let looking = match target.is_visual() {
            true => Some(self.looking(&target).await?),
            false => None,
        };
        let state = input
            .params
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("visible")
            .to_owned();
        loop {
            let (found, visible, enabled) = self.probe_any(&target, looking.as_ref()).await?;
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
        let target = target(&input.params, Allow::Visual)?;
        let looking = match target.is_visual() {
            true => Some(self.looking(&target).await?),
            false => None,
        };
        let wait = input
            .params
            .get("waitMs")
            .and_then(Value::as_u64)
            .unwrap_or(2000)
            .min(input.timeout_ms.saturating_sub(TIMEOUT_MARGIN_MS));
        let until = Instant::now() + Duration::from_millis(wait);
        loop {
            let (found, visible, _) = self.probe_any(&target, looking.as_ref()).await?;
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

    /// The picture of the target's window (or its element or region),
    /// waiting for the window like other steps.
    async fn picture(
        &self,
        target: &Target,
        input: &ActionInput,
        deadline: Instant,
    ) -> Result<visual::Picture, StepError> {
        loop {
            match visual::picture(self.backend.as_ref(), target).await {
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

    async fn read_text(&self, input: &ActionInput, deadline: Instant) -> Result<Value, StepError> {
        let params = &input.params;
        let options = visual::ocr_options(params)?;
        let picture = match (params.get("file"), params.get("target")) {
            (Some(_), Some(_)) => {
                return Err(StepError::invalid_params("give target or file, not both"));
            }
            (Some(_), None) => visual::Picture {
                image: self.backend.load_image(string(params, "file")?).await?,
                origin: (0, 0),
            },
            (None, _) => {
                let target = target(params, Allow::Picture)?;
                self.picture(&target, input, deadline).await?
            }
        };
        let lines = visual::read_lines(self.backend.as_ref(), &picture, options).await?;
        Ok(visual::read_output(&lines))
    }

    async fn screenshot(&self, input: &ActionInput, deadline: Instant) -> Result<Value, StepError> {
        let target = target(&input.params, Allow::Picture)?;
        let path = string(&input.params, "path")?;
        let picture = self.picture(&target, input, deadline).await?;
        let write = || -> std::io::Result<()> {
            if let Some(dir) = std::path::Path::new(&path).parent()
                && !dir.as_os_str().is_empty()
            {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&path, picture.image.to_png())
        };
        write().map_err(|e| {
            StepError::permanent("WRITE_FAILED", format!("cannot write {path}: {e}"))
        })?;
        Ok(Value::String(path))
    }
}

fn target(params: &Value, allow: Allow) -> Result<Target, StepError> {
    Target::from_params(params, "target", allow)
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

fn target_schema(allow: Allow) -> Value {
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
    let xy = |description: &str| {
        json!({
            "type": "object",
            "description": description,
            "properties": { "x": { "type": "integer" }, "y": { "type": "integer" } },
            "required": ["x", "y"],
            "additionalProperties": false
        })
    };
    let region = json!({
        "type": "object",
        "description": "ウィンドウの一部（ウィンドウ左上からの px）。image / ocr を探す範囲、または読む・保存する範囲。element と同時には書けない",
        "properties": {
            "x": { "type": "integer" }, "y": { "type": "integer" },
            "width": { "type": "integer", "minimum": 1 }, "height": { "type": "integer", "minimum": 1 }
        },
        "required": ["x", "y", "width", "height"],
        "additionalProperties": false
    });
    let image = json!({
        "type": "object",
        "description": "画面上で探す画像（部品が inspect_ui に出ないアプリ用）。同じアプリの画面から desktop.screenshot で切り出した PNG",
        "properties": {
            "path": { "type": "string", "minLength": 1, "description": "PNG ファイルのフルパス" },
            "threshold": { "type": "number", "minimum": 0.5, "maximum": 1, "description": "似ている度合いの下限（既定 0.9）" },
            "nth": { "type": "integer", "minimum": 0, "description": "複数見つかったときの 0 始まりの番号（上から、同じ行は左から）" }
        },
        "required": ["path"],
        "additionalProperties": false
    });
    let ocr = json!({
        "type": "object",
        "description": "画面上で探す文字（OCR、オフライン）。空白・大文字小文字・全角半角は無視",
        "properties": {
            "text": { "type": "string", "minLength": 1 },
            "exact": { "type": "boolean", "description": "行全体がこの文字のときだけ" },
            "nth": { "type": "integer", "minimum": 0, "description": "複数見つかったときの 0 始まりの番号（上から、同じ行は左から）" },
            "language": { "type": "string", "minLength": 2, "description": "Windows OCR の言語（ja, en-US など。既定はユーザーの言語）。PaddleOCR は日本語・中国語・英語をまとめて読むので不要" },
            "engine": { "enum": ["paddle", "windows"], "description": "OCR エンジン。既定は PaddleOCR（入っていなければ Windows OCR）" }
        },
        "required": ["text"],
        "additionalProperties": false
    });
    if let Value::Object(map) = &mut properties {
        if allow == Allow::Mouse {
            map.insert(
                "point".into(),
                xy("最終手段：ウィンドウ左上からの座標（px）。部品が inspect_ui に出ないときだけ使う。element と同時には書けない"),
            );
        }
        if matches!(allow, Allow::Mouse | Allow::Visual) {
            map.insert("image".into(), image);
            map.insert("ocr".into(), ocr);
            map.insert(
                "offset".into(),
                xy("image / ocr で見つけた場所の中心からずらす px（例：ラベルの右の入力欄 { \"x\": 120, \"y\": 0 }）"),
            );
        }
        if allow != Allow::Plain {
            map.insert("region".into(), region);
        }
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
    let target = target_schema(Allow::Plain);
    let visual = target_schema(Allow::Visual);
    let picture = target_schema(Allow::Picture);
    let citrix = json!({ "window": { "title": "Citrix" }, "image": { "path": "C:\\RPA\\images\\保存ボタン.png" } });
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
            description: "Brings the window to the front and clicks `target` with the real mouse (`button`: left or right; `double: true` for a double click). Use desktop.click first; this is for elements that ignore it. When the element is not in inspect_ui (Citrix, remote desktops, drawn screens), find the place on the screen instead: `target.ocr` { text } clicks a text OCR reads, `target.image` { path } clicks where a PNG cut from the screen appears (waits until it does), `target.offset` moves the click from its centre. `target.point` (pixels from the window's top-left) is the very last resort.",
            params: json!({
                "target": target_schema(Allow::Mouse),
                "button": { "enum": ["left", "right"] },
                "double": { "type": "boolean" }
            }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": MOUSE_CLICK, "name": "行をダブルクリック", "params": { "target": { "window": { "process": "billing.exe" }, "element": { "role": "row", "name": "{{ orderNo }}" } }, "double": true } }),
                json!({ "type": MOUSE_CLICK, "name": "保存ボタン（画像）を押す", "params": { "target": citrix } }),
                json!({ "type": MOUSE_CLICK, "name": "「検索」を押す", "params": { "target": { "window": { "title": "Citrix" }, "ocr": { "text": "検索" } } } }),
            ],
            secret_params: &[],
            input: true,
        },
        Def {
            step_type: TYPE,
            kind: Kind::Type,
            label: "キーボードで入力",
            description: "Brings the window to the front, focuses `target` and types `text` with the keyboard (does not clear the field first). For apps that ignore desktop.setValue. With `target.image` / `target.ocr` it first clicks that place (e.g. a label's text with `offset` to the field beside it). `text` may be a registered secret, typed only into the apps registered with it.",
            params: json!({ "target": visual, "text": text_or_secret_schema("打ち込む文字。パスワードは登録済みシークレット") }),
            required: &["target", "text"],
            has_output: false,
            examples: vec![
                json!({ "type": TYPE, "params": { "target": customer, "text": "{{ customerCode }}" } }),
                json!({ "type": TYPE, "name": "顧客コード欄に入力", "params": { "target": { "window": { "title": "Citrix" }, "ocr": { "text": "顧客コード" }, "offset": { "x": 150, "y": 0 } }, "text": "{{ customerCode }}" } }),
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
            description: "Waits until `target` reaches `state`: visible (default), hidden (closed or gone, e.g. a progress dialog), or enabled. The limit is the step's timeoutMs (default 30000). Other desktop steps already wait for their target, so use this for screens that must disappear or for slow apps. `target.image` / `target.ocr` wait for a picture or text on the screen (visible or hidden).",
            params: json!({ "target": visual, "state": { "enum": ["visible", "hidden", "enabled"] } }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": WAIT_FOR, "name": "処理中ダイアログが閉じるのを待つ", "params": { "target": { "window": { "process": "billing.exe", "title": "処理中" } }, "state": "hidden" } }),
                json!({ "type": WAIT_FOR, "name": "「登録完了」が出るのを待つ", "params": { "target": { "window": { "title": "Citrix" }, "ocr": { "text": "登録完了" } } } }),
            ],
            secret_params: &[],
            input: false,
        },
        Def {
            step_type: IS_VISIBLE,
            kind: Kind::IsVisible,
            label: "表示されているか",
            description: "Output: true when `target` is shown (waiting up to `waitMs`, default 2000), otherwise false. Never fails for a missing window or element: use it with control.if, e.g. to close a dialog only when it appears. Works with `target.image` / `target.ocr` too (is that picture or text on the screen).",
            params: json!({ "target": visual, "waitMs": { "type": "integer", "minimum": 0, "maximum": 20000 } }),
            required: &["target"],
            has_output: true,
            examples: vec![
                json!({ "type": IS_VISIBLE, "name": "確認ダイアログが出たか", "params": { "target": { "window": { "process": "billing.exe", "title": "確認" } } }, "saveAs": "confirmShown" }),
                json!({ "type": IS_VISIBLE, "name": "エラーアイコンが出たか", "params": { "target": { "window": { "title": "Citrix" }, "image": { "path": "C:\\RPA\\images\\エラー.png" } } }, "saveAs": "confirmShown" }),
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
        Def {
            step_type: READ_TEXT,
            kind: Kind::ReadText,
            label: "文字を読み取る（OCR）",
            description: "Reads the text shown in `target` with OCR (offline; PaddleOCR, which reads Japanese, Chinese and English, or Windows OCR where PaddleOCR is not installed or with engine: \"windows\"): the whole window, `target.element`, or `target.region` (pixels from the window's top-left). Or reads an image `file` (PNG, JPEG, BMP, TIFF) instead of a window. Output: { text, lines: [{ text, x, y, width, height }] } (places in window pixels). For apps whose elements inspect_ui does not show; use desktop.getValue where it does.",
            params: json!({
                "target": picture,
                "file": { "type": "string", "minLength": 1, "description": "画面の代わりに読む画像ファイルのフルパス" },
                "language": { "type": "string", "minLength": 2, "description": "Windows OCR の言語（ja, en-US など）。PaddleOCR では不要" },
                "engine": { "enum": ["paddle", "windows"], "description": "OCR エンジン。既定は PaddleOCR（入っていなければ Windows OCR）" }
            }),
            required: &[],
            has_output: true,
            examples: vec![
                json!({ "type": READ_TEXT, "name": "合計欄を読む", "params": { "target": { "window": { "title": "Citrix" }, "region": { "x": 620, "y": 410, "width": 180, "height": 32 } } }, "saveAs": "total" }),
                json!({ "type": READ_TEXT, "name": "請求書画像を読む", "params": { "file": "{{ outDir }}\\請求書.png" }, "saveAs": "total" }),
            ],
            secret_params: &[],
            input: false,
        },
        Def {
            step_type: SCREENSHOT,
            kind: Kind::Screenshot,
            label: "スクリーンショット",
            description: "Saves a PNG of `target` (the window, `target.element`, or `target.region` in pixels from the window's top-left) to `path` (absolute). Output: the path. Also the way to make the image for `target.image`: cut out just the button or icon with target.region.",
            params: json!({ "target": picture, "path": { "type": "string", "minLength": 1 } }),
            required: &["target", "path"],
            has_output: true,
            examples: vec![
                json!({ "type": SCREENSHOT, "name": "画面を記録", "params": { "target": { "window": { "process": "billing.exe" } }, "path": "{{ outDir }}\\請求画面.png" } }),
                json!({ "type": SCREENSHOT, "name": "保存ボタンの画像を切り出す", "params": { "target": { "window": { "title": "Citrix" }, "region": { "x": 860, "y": 640, "width": 90, "height": 30 } }, "path": "C:\\RPA\\images\\保存ボタン.png" } }),
            ],
            secret_params: &[],
            input: false,
        },
    ];

    defs.into_iter()
        .map(|d| {
            let mut resources = Vec::new();
            if d.params.get("target").is_some() {
                resources.push(ResourceDef::window("target"));
            }
            if d.kind == Kind::Screenshot {
                resources.push(ResourceDef::file("path"));
            }
            if d.input {
                resources.push(ResourceDef::Static(DESKTOP_INPUT.into()));
            }
            let def = StepTypeDef {
                step_type: d.step_type.into(),
                category: StepCategory::Windows,
                label: d.label.into(),
                description: d.description.into(),
                params_schema: {
                    let mut schema = schema(d.params, d.required);
                    if d.kind == Kind::ReadText {
                        schema["oneOf"] =
                            json!([{ "required": ["target"] }, { "required": ["file"] }]);
                    }
                    schema
                },
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
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod visual_tests;
