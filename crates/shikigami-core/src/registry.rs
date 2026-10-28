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
        for def in builtin_defs() {
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

fn builtin_defs() -> Vec<StepTypeDef> {
    let ident = json!({ "type": "string", "pattern": IDENT_PATTERN });
    let expression = json!({ "type": "string", "minLength": 1, "description": "式 (例: count > 3 && status == 'OK')" });
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
        },
        StepTypeDef {
            step_type: control::REPEAT.into(),
            category: StepCategory::Control,
            label: "回数ループ".into(),
            description: "Repeats `body` `count` times. `indexVar` (optional) receives the 0-based iteration index.".into(),
            params_schema: object_schema(
                json!({
                    "count": { "oneOf": [ { "type": "integer", "minimum": 0, "maximum": 1_000_000 }, { "type": "string", "minLength": 1 } ] },
                    "indexVar": ident,
                }),
                &["count"],
            ),
            blocks: vec![block("body", "繰り返す処理")],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec!["indexVar".into()],
            risk: RiskLevel::Safe,
        },
        StepTypeDef {
            step_type: control::FOR_EACH.into(),
            category: StepCategory::Control,
            label: "繰り返し（リスト）".into(),
            description: "Runs `body` once per element of the array produced by the `items` expression, binding it to `itemVar`.".into(),
            params_schema: object_schema(
                json!({ "items": expression, "itemVar": ident, "indexVar": ident }),
                &["items", "itemVar"],
            ),
            blocks: vec![block("body", "要素ごとの処理")],
            has_output: false,
            expression_params: vec!["items".into()],
            binds_variables: vec!["itemVar".into(), "indexVar".into()],
            risk: RiskLevel::Safe,
        },
        StepTypeDef {
            step_type: control::TRY.into(),
            category: StepCategory::Control,
            label: "例外処理".into(),
            description: "Runs `try`; on failure runs `catch` with the error bound to `errorVar` (default `error`); always runs `finally`.".into(),
            params_schema: object_schema(json!({ "errorVar": ident }), &[]),
            blocks: vec![block("try", "試行"), block("catch", "エラー時"), block("finally", "最後に必ず")],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec!["errorVar".into()],
            risk: RiskLevel::Safe,
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
        },
        StepTypeDef {
            step_type: builtin::FLOW_DELAY.into(),
            category: StepCategory::Flow,
            label: "待機（時間指定）".into(),
            description: "Waits for `ms` milliseconds. Prefer state-based waits (e.g. wait_for_element) for UI synchronisation.".into(),
            params_schema: object_schema(
                json!({ "ms": { "oneOf": [ { "type": "integer", "minimum": 0, "maximum": 3_600_000 }, { "type": "string", "minLength": 1 } ] } }),
                &["ms"],
            ),
            blocks: vec![],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: RiskLevel::Safe,
        },
    ]
}

/// Whether a string is a valid variable identifier.
pub fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
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
