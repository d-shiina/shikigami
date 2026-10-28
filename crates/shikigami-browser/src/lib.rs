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

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use shikigami_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use shikigami_core::resource::ResourceDef;
use shikigami_runtime::sidecar::{SidecarClient, SidecarConfig};
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};
use tokio_util::sync::CancellationToken;

/// How much earlier than the step timeout the adapter stops an operation.
const ADAPTER_TIMEOUT_MARGIN_MS: u64 = 500;

/// Path of the adapter entry point inside the repository / install dir.
pub const ADAPTER_SCRIPT: &str = "packages/browser-adapter/src/main.ts";

pub mod types {
    pub const OPEN: &str = "browser.open";
    pub const CLICK: &str = "browser.click";
    pub const FILL: &str = "browser.fill";
    pub const SELECT: &str = "browser.select";
    pub const PRESS: &str = "browser.press";
    pub const GET_TEXT: &str = "browser.getText";
    pub const GET_TABLE: &str = "browser.getTable";
    pub const WAIT_FOR: &str = "browser.waitFor";
    pub const SCREENSHOT: &str = "browser.screenshot";
    pub const CLOSE: &str = "browser.close";
}

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
    /// otherwise `node` on PATH and the adapter found next to the executable
    /// (or the current directory) or in one of their parents.
    pub fn discover() -> Self {
        let node =
            std::env::var_os("SHIKIGAMI_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from);
        let script = std::env::var_os("SHIKIGAMI_BROWSER_ADAPTER")
            .map(PathBuf::from)
            .or_else(|| {
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(Path::to_path_buf));
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
        unavailable,
        setup_hint: "Install Node.js 22.18+ and run `pnpm install` in the Shikigami folder, or set SHIKIGAMI_BROWSER_ADAPTER to packages/browser-adapter/src/main.ts.".into(),
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
            builder = builder.register(
                def,
                BrowserStep {
                    client: self.client.clone(),
                    method,
                },
            );
        }
        let client = self.client.clone();
        builder.on_run_finished(Arc::new(move |run_id| {
            let client = client.clone();
            Box::pin(async move {
                if client.is_running().await {
                    let _ = client
                        .call(
                            "closeRun",
                            json!({ "runId": run_id.as_str() }),
                            &CancellationToken::new(),
                        )
                        .await;
                }
            })
        }))
    }

    /// The page's accessibility tree (`url` opens a page first; `context`,
    /// `target` narrow it down).
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
            self.client
                .call("snapshot", Value::Object(params), &CancellationToken::new())
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
            let mut params = match input.params {
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
            self.client
                .call(self.method, Value::Object(params), &input.cancel)
                .await
        })
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
            "nth": { "type": "integer", "minimum": 0, "description": "複数一致したときの 0 始まりの番号" }
        },
        "additionalProperties": false,
        "anyOf": [
            { "required": ["role"] }, { "required": ["label"] }, { "required": ["placeholder"] },
            { "required": ["text"] }, { "required": ["testId"] }, { "required": ["css"] }
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
}

/// Step type definitions with the adapter method each one calls.
pub fn step_defs() -> Vec<(StepTypeDef, &'static str)> {
    use types::*;
    let target = target_schema();
    let defs = vec![
        Def {
            step_type: OPEN,
            method: "open",
            label: "ブラウザで開く",
            description: "Opens `url` in the browser context `context` (started on first use; reused afterwards). Output: { url, title }. Every other browser step needs a browser.open on the same context first. `headless: true` runs without a window.",
            params: json!({ "url": { "type": "string", "minLength": 1 }, "headless": { "type": "boolean" } }),
            required: &["url"],
            has_output: true,
            examples: vec![
                json!({ "type": OPEN, "name": "受注システムを開く", "params": { "url": "{{ siteUrl }}" } }),
            ],
        },
        Def {
            step_type: CLICK,
            method: "click",
            label: "クリック",
            description: "Clicks the element `target` (waits until it is visible and enabled).",
            params: json!({ "target": target }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": CLICK, "name": "ログインする", "params": { "target": { "role": "button", "name": "ログイン" } } }),
            ],
        },
        Def {
            step_type: FILL,
            method: "fill",
            label: "入力",
            description: "Replaces the text of the input `target` with `value` (a template).",
            params: json!({ "target": target, "value": { "type": "string" } }),
            required: &["target", "value"],
            has_output: false,
            examples: vec![
                json!({ "type": FILL, "name": "ユーザー名を入力", "params": { "target": { "label": "ユーザー名" }, "value": "{{ user }}" } }),
            ],
        },
        Def {
            step_type: SELECT,
            method: "select",
            label: "選択",
            description: "Selects the option(s) `value` (visible label, or value) in the drop-down `target`.",
            params: json!({ "target": target, "value": { "oneOf": [ { "type": "string" }, { "type": "array", "items": { "type": "string" } } ] } }),
            required: &["target", "value"],
            has_output: false,
            examples: vec![
                json!({ "type": SELECT, "params": { "target": { "label": "都道府県" }, "value": "東京都" } }),
            ],
        },
        Def {
            step_type: PRESS,
            method: "press",
            label: "キー入力",
            description: "Presses `key` (e.g. Enter, Tab, Control+A) on `target`, or on the page when `target` is omitted.",
            params: json!({ "key": { "type": "string", "minLength": 1 }, "target": target }),
            required: &["key"],
            has_output: false,
            examples: vec![
                json!({ "type": PRESS, "params": { "target": { "label": "検索" }, "key": "Enter" } }),
            ],
        },
        Def {
            step_type: GET_TEXT,
            method: "getText",
            label: "文字を取得",
            description: "Reads the visible text of `target`. With `all: true`, returns an array with the text of every matching element. Use saveAs to keep it.",
            params: json!({ "target": target, "all": { "type": "boolean" } }),
            required: &["target"],
            has_output: true,
            examples: vec![
                json!({ "type": GET_TEXT, "params": { "target": { "role": "heading", "nth": 0 } }, "saveAs": "title" }),
            ],
        },
        Def {
            step_type: GET_TABLE,
            method: "getTable",
            label: "表を取得",
            description: "Reads an HTML table into an array of objects keyed by the header cells (cell text as strings; use num() for amounts). `target` defaults to the first table on the page. Use with control.forEach.",
            params: json!({ "target": target }),
            required: &[],
            has_output: true,
            examples: vec![
                json!({ "type": GET_TABLE, "name": "受注一覧を読む", "params": { "target": { "role": "table", "name": "受注" } }, "saveAs": "orders" }),
            ],
        },
        Def {
            step_type: WAIT_FOR,
            method: "waitFor",
            label: "要素を待つ",
            description: "Waits until `target` reaches `state` (visible by default; hidden, attached, detached). The limit is the step's `timeoutMs` (default 30000).",
            params: json!({ "target": target, "state": { "enum": ["visible", "hidden", "attached", "detached"] } }),
            required: &["target"],
            has_output: false,
            examples: vec![
                json!({ "type": WAIT_FOR, "name": "一覧の表示を待つ", "params": { "target": { "role": "heading", "name": "受注一覧" } } }),
            ],
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
        },
        Def {
            step_type: CLOSE,
            method: "close",
            label: "ブラウザを閉じる",
            description: "Closes the browser context `context`. Optional: contexts are closed when the run ends.",
            params: json!({}),
            required: &[],
            has_output: false,
            examples: vec![json!({ "type": CLOSE })],
        },
    ];

    defs.into_iter()
        .map(|d| {
            let mut resources = vec![ResourceDef::browser_context("context")];
            if d.step_type == SCREENSHOT {
                resources.push(ResourceDef::file("path"));
            }
            let def = StepTypeDef {
                step_type: d.step_type.into(),
                category: StepCategory::Browser,
                label: d.label.into(),
                description: d.description.into(),
                params_schema: schema(props(d.params), d.required),
                blocks: vec![],
                has_output: d.has_output,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Interactive,
                examples: d.examples,
                resources,
            };
            (def, d.method)
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
