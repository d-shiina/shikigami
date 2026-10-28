//! Browser steps (`browser.*`) for the Shikigami Runtime.
//!
//! Each step forwards its rendered params to the Node.js + Playwright
//! adapter (`packages/browser-adapter`) over JSON-RPC on stdio. Pages live in
//! named browser contexts per run (`context`, default `"default"`): steps on
//! one context take turns, different contexts run in parallel.
//!
//! ```no_run
//! # use std::sync::Arc;
//! use shikigami_browser::{BrowserClient, BrowserConfig};
//! let client = Arc::new(BrowserClient::new(BrowserConfig::discover()));
//! let runtime = shikigami_browser::install(shikigami_runtime::Runtime::builder(), client).build();
//! ```

mod client;

use std::sync::Arc;

use serde_json::{Map, Value, json};
use shikigami_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use shikigami_core::resource::ResourceDef;
use shikigami_runtime::{ActionHandler, ActionInput, BoxFuture, RuntimeBuilder, StepError};

pub use client::{ADAPTER_SCRIPT, BrowserClient, BrowserConfig};

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

/// Registers every browser step type and closes a run's browser contexts
/// when it ends.
pub fn install(mut builder: RuntimeBuilder, client: Arc<BrowserClient>) -> RuntimeBuilder {
    for (def, method) in step_defs() {
        builder = builder.register(
            def,
            BrowserStep {
                client: client.clone(),
                method,
            },
        );
    }
    builder.on_run_finished(Arc::new(move |run_id| {
        let client = client.clone();
        Box::pin(async move { client.close_run(run_id.as_str()).await })
    }))
}

/// The Runtime used by the CLI, MCP server and Studio: built-in steps plus
/// browser steps backed by an adapter found with [`BrowserConfig::discover`].
pub fn default_runtime() -> (shikigami_runtime::Runtime, Arc<BrowserClient>) {
    let client = Arc::new(BrowserClient::new(BrowserConfig::discover()));
    let runtime = install(shikigami_runtime::Runtime::builder(), client.clone()).build();
    (runtime, client)
}

struct BrowserStep {
    client: Arc<BrowserClient>,
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
            description: "Waits until `target` reaches `state` (visible by default; hidden, attached, detached). The limit is the step's `timeoutMs` and at most 20 s per attempt; use retry for longer waits.",
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
