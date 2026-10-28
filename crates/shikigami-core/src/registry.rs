//! Step type registry: the catalogue of step types and their parameter schemas.
//!
//! The registry is metadata only (no execution). Studio uses it to build the
//! palette and property forms, the MCP server exposes it through
//! `list_step_types` / `get_step_schema`, validation checks params against it,
//! and the Runtime pairs each definition with a handler. Automation adapters
//! contribute their own definitions (e.g. `browser.*`, `windows.*`).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::resource::ResourceDef;

/// Built-in control-flow step types (executed by the Runtime itself).
pub mod control {
    pub const IF: &str = "control.if";
    pub const WHILE: &str = "control.while";
    pub const REPEAT: &str = "control.repeat";
    pub const FOR_EACH: &str = "control.forEach";
    pub const TRY: &str = "control.try";
    pub const BREAK: &str = "control.break";
    pub const CONTINUE: &str = "control.continue";
    pub const FAIL: &str = "control.fail";
    pub const PARALLEL: &str = "control.parallel";
    pub const GROUP: &str = "control.group";
    /// Polls a condition; run by the interpreter like the `control.*` steps.
    pub const WAIT_UNTIL: &str = "wait.until";
}

/// Whether the Runtime interprets the step itself (no adapter handler).
pub fn is_control_type(step_type: &str) -> bool {
    step_type.starts_with("control.") || step_type == control::WAIT_UNTIL
}

/// Built-in action step types that need no external adapter.
pub mod builtin {
    pub const VARIABLE_SET: &str = "variable.set";
    pub const LOG_MESSAGE: &str = "log.message";
    pub const FLOW_DELAY: &str = "flow.delay";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StepCategory {
    Control,
    Variable,
    Log,
    Flow,
    Browser,
    Windows,
    File,
    /// Web APIs (`http.*`).
    Network,
    /// Programs, the clipboard and dialogs (`process.*`, `clipboard.*`, `dialog.*`).
    System,
    Other,
}

/// Named child block of a control-flow step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlockDef {
    pub name: String,
    pub label: String,
}

/// Risk level used by the permission layer (MCP approval, allow-lists).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum RiskLevel {
    /// No side effects outside the run (variables, logs, control flow).
    Safe,
    /// Interacts with applications or pages (clicks, typing, navigation).
    Interactive,
    /// May destroy data or reach outside the machine (file delete, downloads, process kill).
    Dangerous,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepTypeDef {
    /// Stable identifier, `namespace.action`.
    #[serde(rename = "type")]
    pub step_type: String,
    pub category: StepCategory,
    /// Japanese display name.
    pub label: String,
    /// Description written for both humans and AI clients.
    pub description: String,
    /// JSON Schema (draft 2020-12) for `params`.
    pub params_schema: Value,
    /// Child blocks allowed on this step (empty for action steps).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<BlockDef>,
    /// Whether the step produces a value that `saveAs` can capture.
    #[serde(default)]
    pub has_output: bool,
    /// Params whose string value is an expression (not a template).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expression_params: Vec<String>,
    /// Params that declare a variable name (introduced into scope).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub binds_variables: Vec<String>,
    pub risk: RiskLevel,
    /// Complete, valid step objects showing typical use (IDs omitted). AI
    /// clients get them from `get_step_schema` and can copy them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<Value>,
    /// Exclusive resources, derived from params at run time. Internal to the
    /// Runtime: scenario authors never name locks.
    #[serde(skip)]
    #[schemars(skip)]
    pub resources: Vec<ResourceDef>,
    /// Params that may take a registered secret,
    /// `{ "secret": "<name>", "field": "password" }`, instead of text.
    /// Secrets are rejected everywhere else.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_params: Vec<String>,
    /// Timeout when the step sets none (takes precedence over the
    /// scenario's default), for steps that wait on people (manual login).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_timeout_ms: Option<u64>,
}

impl StepTypeDef {
    pub fn is_loop(&self) -> bool {
        matches!(
            self.step_type.as_str(),
            control::WHILE | control::REPEAT | control::FOR_EACH
        )
    }

    pub fn allows_block(&self, name: &str) -> bool {
        self.blocks.iter().any(|b| b.name == name)
    }
}

/// Catalogue of step types, keyed by type name.
#[derive(Debug, Clone, Default)]
pub struct StepRegistry {
    types: BTreeMap<String, StepTypeDef>,
}

impl StepRegistry {
    pub fn empty() -> Self {
        Self::default()
    }

    /// Registry with every built-in (adapter-independent) step type.
    pub fn with_builtins() -> Self {
        let mut registry = Self::empty();
        for mut def in builtin_defs() {
            def.examples = builtin_examples(&def.step_type);
            registry.register(def);
        }
        registry
    }

    /// Adds or replaces a step type definition.
    pub fn register(&mut self, def: StepTypeDef) {
        self.types.insert(def.step_type.clone(), def);
    }

    pub fn get(&self, step_type: &str) -> Option<&StepTypeDef> {
        self.types.get(step_type)
    }

    pub fn iter(&self) -> impl Iterator<Item = &StepTypeDef> {
        self.types.values()
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }
}

fn block(name: &str, label: &str) -> BlockDef {
    BlockDef {
        name: name.to_owned(),
        label: label.to_owned(),
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

const IDENT_PATTERN: &str = "^[A-Za-z_][A-Za-z0-9_]*$";

/// Pattern of a string that is exactly one `{{ … }}` template.
pub const SINGLE_TEMPLATE_PATTERN: &str = r"^\s*\{\{.*\}\}\s*$";

/// An integer literal, or one `{{ expr }}` template that evaluates to one.
/// The same rule as every other non-expression param: strings are templates.
fn number_or_template(min: u64, max: u64) -> Value {
    json!({
        "oneOf": [
            { "type": "integer", "minimum": min, "maximum": max },
            { "type": "string", "pattern": SINGLE_TEMPLATE_PATTERN },
        ],
        "description": "整数、または {{ 式 }}（例: 3 / \"{{ retryCount }}\"）",
    })
}

fn builtin_defs() -> Vec<StepTypeDef> {
    let ident = json!({ "type": "string", "pattern": IDENT_PATTERN });
    let expression = json!({ "type": "string", "minLength": 1, "description": "式。{{ }} は付けない (例: count > 3 && status == 'OK')" });
    vec![
        StepTypeDef {
            step_type: control::IF.into(),
            category: StepCategory::Control,
            label: "条件分岐".into(),
            description: "Runs the `then` block when `condition` is truthy, otherwise the `else` block.".into(),
            params_schema: object_schema(json!({ "condition": expression }), &["condition"]),
            blocks: vec![block("then", "条件が真"), block("else", "条件が偽")],
            has_output: false,
            expression_params: vec!["condition".into()],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::WHILE.into(),
            category: StepCategory::Control,
            label: "条件ループ".into(),
            description: "Repeats `body` while `condition` is truthy. `maxIterations` (default 1000) guards against infinite loops.".into(),
            params_schema: object_schema(
                json!({
                    "condition": expression,
                    "maxIterations": { "type": "integer", "minimum": 1, "maximum": 1_000_000 },
                }),
                &["condition"],
            ),
            blocks: vec![block("body", "繰り返す処理")],
            has_output: false,
            expression_params: vec!["condition".into()],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::REPEAT.into(),
            category: StepCategory::Control,
            label: "回数ループ".into(),
            description: "Repeats `body` `count` times. `indexVar` (optional) receives the 0-based iteration index.".into(),
            params_schema: object_schema(
                json!({
                    "count": number_or_template(0, 1_000_000),
                    "indexVar": ident,
                }),
                &["count"],
            ),
            blocks: vec![block("body", "繰り返す処理")],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec!["indexVar".into()],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::FOR_EACH.into(),
            category: StepCategory::Control,
            label: "繰り返し（リスト）".into(),
            description: "Runs `body` once per element of the array produced by the `items` expression, binding it to `itemVar` (and the 0-based index to `indexVar`). `collect` (optional expression) is evaluated at the end of each iteration; `saveAs` receives the array of those values in item order. `concurrency` (optional, 1-64) runs up to that many iterations at the same time: each iteration then works on its own copy of the variables, writes inside `body` are discarded, `collect` + `saveAs` is the only way to return results, `control.break` is not allowed, and the first failure stops the loop (error details include `index`).".into(),
            params_schema: object_schema(
                json!({
                    "items": expression,
                    "itemVar": ident,
                    "indexVar": ident,
                    "collect": expression,
                    "concurrency": number_or_template(1, 64),
                }),
                &["items", "itemVar"],
            ),
            blocks: vec![block("body", "要素ごとの処理")],
            has_output: true,
            expression_params: vec!["items".into(), "collect".into()],
            binds_variables: vec!["itemVar".into(), "indexVar".into()],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::TRY.into(),
            category: StepCategory::Control,
            label: "例外処理".into(),
            description: "Runs `try`; on failure runs `catch` with the error bound to `errorVar` (default `error`); always runs `finally`.".into(),
            params_schema: object_schema(json!({ "errorVar": ident }), &[]),
            blocks: vec![block("try", "try：まず実行"), block("catch", "catch：失敗したら"), block("finally", "finally：成功でも失敗でも最後に")],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec!["errorVar".into()],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::PARALLEL.into(),
            category: StepCategory::Control,
            label: "並行実行".into(),
            description: "Runs each step in `branches` at the same time and waits for all of them. Use `control.group` as a branch to run several steps in sequence. Each branch starts from a copy of the variables; variables changed by a branch are merged back afterwards, and two branches changing the same variable to different values fail with PARALLEL_VARIABLE_CONFLICT. When one branch fails, the others are cancelled. `maxConcurrency` (optional) limits how many branches run at once.".into(),
            params_schema: object_schema(
                json!({ "maxConcurrency": { "type": "integer", "minimum": 1, "maximum": 64 } }),
                &[],
            ),
            blocks: vec![block("branches", "同時に実行")],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::GROUP.into(),
            category: StepCategory::Control,
            label: "グループ".into(),
            description: "Runs `body` in order. Use it to name a set of steps or as one branch of `control.parallel`.".into(),
            params_schema: object_schema(json!({}), &[]),
            blocks: vec![block("body", "処理")],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::BREAK.into(),
            category: StepCategory::Control,
            label: "ループを抜ける".into(),
            description: "Exits the innermost loop.".into(),
            params_schema: object_schema(json!({}), &[]),
            blocks: vec![],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::CONTINUE.into(),
            category: StepCategory::Control,
            label: "次の繰り返しへ".into(),
            description: "Skips to the next iteration of the innermost loop.".into(),
            params_schema: object_schema(json!({}), &[]),
            blocks: vec![],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::FAIL.into(),
            category: StepCategory::Control,
            label: "エラーを発生".into(),
            description: "Fails the run (or jumps to the enclosing catch) with `message` and optional `code`.".into(),
            params_schema: object_schema(
                json!({
                    "message": { "type": "string", "minLength": 1 },
                    "code": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
                }),
                &["message"],
            ),
            blocks: vec![],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: builtin::VARIABLE_SET.into(),
            category: StepCategory::Variable,
            label: "変数に代入".into(),
            description: "Assigns a value to variable `name`. Use `value` for a literal or template (`{{ … }}`), or `expression` to compute it.".into(),
            params_schema: json!({
                "type": "object",
                "properties": {
                    "name": ident,
                    "value": {},
                    "expression": expression,
                },
                "required": ["name"],
                "oneOf": [ { "required": ["value"] }, { "required": ["expression"] } ],
                "additionalProperties": false,
            }),
            blocks: vec![],
            has_output: true,
            expression_params: vec!["expression".into()],
            binds_variables: vec!["name".into()],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: builtin::LOG_MESSAGE.into(),
            category: StepCategory::Log,
            label: "ログ出力".into(),
            description: "Writes `message` (templates allowed) to the run log at `level` (info by default).".into(),
            params_schema: object_schema(
                json!({
                    "message": { "type": "string" },
                    "level": { "enum": ["debug", "info", "warn", "error"] },
                }),
                &["message"],
            ),
            blocks: vec![],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: control::WAIT_UNTIL.into(),
            category: StepCategory::Flow,
            label: "条件を待つ".into(),
            description: "Waits until `condition` is truthy, checking every `intervalMs` (default 500). The optional `check` block runs before each check, e.g. a step that reads a file or screen state into a variable with `saveAs`. The step's `timeoutMs` (default 30000) limits the whole wait; when it passes the step fails with WAIT_TIMEOUT. Use this, not flow.delay or retry, to wait for slow work to finish.".into(),
            params_schema: object_schema(
                json!({
                    "condition": expression,
                    "intervalMs": number_or_template(50, 60_000),
                }),
                &["condition"],
            ),
            blocks: vec![block("check", "確認のたびに実行")],
            has_output: false,
            expression_params: vec!["condition".into()],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
        StepTypeDef {
            step_type: builtin::FLOW_DELAY.into(),
            category: StepCategory::Flow,
            label: "待機（時間指定）".into(),
            description: "Waits for a fixed `ms` milliseconds. To wait for something to finish or appear, use wait.until instead.".into(),
            params_schema: object_schema(
                json!({ "ms": number_or_template(0, 3_600_000) }),
                &["ms"],
            ),
            blocks: vec![],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
            examples: vec![],
            resources: vec![],
            secret_params: vec![],
            default_timeout_ms: None,
        },
    ]
}

/// Whether a string is a valid variable identifier.
pub fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Copyable examples for the built-in step types.
fn builtin_examples(step_type: &str) -> Vec<Value> {
    match step_type {
        control::IF => vec![json!({
            "type": "control.if",
            "name": "高額かどうか",
            "params": { "condition": "invoice.amount >= 100000" },
            "blocks": {
                "then": [ { "type": "log.message", "params": { "message": "高額: {{ invoice.no }}" } } ],
                "else": [ { "type": "log.message", "params": { "message": "通常: {{ invoice.no }}" } } ]
            }
        })],
        control::WHILE => vec![json!({
            "type": "control.while",
            "name": "10 件になるまで",
            "params": { "condition": "count < 10", "maxIterations": 500 },
            "blocks": { "body": [
                { "type": "variable.set", "params": { "name": "count", "expression": "count + 1" } }
            ] }
        })],
        control::REPEAT => vec![json!({
            "type": "control.repeat",
            "name": "3回試す",
            "params": { "count": 3, "indexVar": "i" },
            "blocks": { "body": [ { "type": "log.message", "params": { "message": "{{ i + 1 }} 回目" } } ] }
        })],
        control::FOR_EACH => vec![
            json!({
                "type": "control.forEach",
                "name": "請求書ごとに処理",
                "params": { "items": "invoices", "itemVar": "invoice", "indexVar": "i" },
                "blocks": { "body": [
                    { "type": "variable.set", "params": { "name": "total", "expression": "total + invoice.amount" } }
                ] }
            }),
            json!({
                "type": "control.forEach",
                "name": "請求書を4件ずつ同時に処理",
                "params": { "items": "invoices", "itemVar": "invoice", "concurrency": 4, "collect": "taxed" },
                "saveAs": "taxedAmounts",
                "blocks": { "body": [
                    { "type": "variable.set", "params": { "name": "taxed", "expression": "round(invoice.amount * 1.1)" } }
                ] }
            }),
        ],
        control::TRY => vec![json!({
            "type": "control.try",
            "name": "失敗しても続ける",
            "params": { "errorVar": "error" },
            "blocks": {
                "try": [ { "type": "control.fail", "params": { "message": "例" } } ],
                "catch": [ { "type": "log.message", "params": { "level": "warn", "message": "失敗: {{ error.message }}" } } ],
                "finally": [ { "type": "log.message", "params": { "message": "後片付け" } } ]
            }
        })],
        control::PARALLEL => vec![json!({
            "type": "control.parallel",
            "name": "同時に処理",
            "params": {},
            "blocks": { "branches": [
                { "type": "control.group", "name": "帳票を出力して待つ", "blocks": { "body": [
                    { "type": "flow.delay", "params": { "ms": 1000 } },
                    { "type": "variable.set", "params": { "name": "reportReady", "value": true } }
                ] } },
                { "type": "variable.set", "name": "その間に別の作業", "params": { "name": "otherDone", "value": true } }
            ] }
        })],
        control::GROUP => vec![json!({
            "type": "control.group",
            "name": "ログインする",
            "blocks": { "body": [ { "type": "log.message", "params": { "message": "ログイン" } } ] }
        })],
        control::BREAK => vec![json!({ "type": "control.break" })],
        control::CONTINUE => vec![json!({ "type": "control.continue" })],
        control::FAIL => vec![json!({
            "type": "control.fail",
            "params": { "message": "請求書 {{ invoice.no }} の金額が不正です", "code": "INVALID_AMOUNT" }
        })],
        builtin::VARIABLE_SET => vec![
            json!({ "type": "variable.set", "params": { "name": "total", "expression": "total + invoice.amount" } }),
            json!({ "type": "variable.set", "params": { "name": "greeting", "value": "こんにちは {{ user.name }}" } }),
        ],
        builtin::LOG_MESSAGE => vec![json!({
            "type": "log.message",
            "params": { "level": "info", "message": "合計 {{ total }} 円" }
        })],
        control::WAIT_UNTIL => vec![json!({
            "type": "wait.until",
            "name": "転記が終わるまで待つ",
            "params": { "condition": "status == 'done'", "intervalMs": 2000 },
            "timeoutMs": 600000,
            "blocks": { "check": [
                { "type": "log.message", "name": "状態を読む（実際は読み取りステップに saveAs: status）", "params": { "message": "確認中: {{ status }}" } }
            ] }
        })],
        builtin::FLOW_DELAY => vec![json!({ "type": "flow.delay", "params": { "ms": 1000 } })],
        _ => Vec::new(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn builtin_schemas_compile() {
        let registry = StepRegistry::with_builtins();
        assert!(registry.len() >= 11);
        for def in registry.iter() {
            assert!(
                jsonschema::validator_for(&def.params_schema).is_ok(),
                "schema of {} does not compile",
                def.step_type
            );
        }
    }

    #[test]
    fn identifiers() {
        assert!(is_identifier("count_1"));
        assert!(is_identifier("_x"));
        assert!(!is_identifier("1x"));
        assert!(!is_identifier("a-b"));
        assert!(!is_identifier(""));
    }
}
