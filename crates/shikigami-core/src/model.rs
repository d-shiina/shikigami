//! Canonical scenario model.
//!
//! The JSON produced by these types *is* the scenario file format. Rust is the
//! single source of truth: the JSON Schema (`schemas/scenario.schema.json`) and
//! the TypeScript types (`packages/schema`) are generated from it.
//!
//! Steps form a tree. Every step has the same shape (`id`, `type`, `params`,
//! `blocks`), and control-flow steps keep their children in named `blocks`
//! (`then`/`else`, `body`, `try`/`catch`/`finally`). Because references are
//! always by stable step ID, adding, removing or moving steps never breaks
//! other references.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::OffsetDateTime;

use crate::ids::{ScenarioId, StepId};

/// Current scenario schema version. Bump on every change to the file shape
/// (readers reject unknown fields, so new optional fields count too) and add
/// a migration in [`crate::migrate`]. See docs/compatibility.md.
pub const SCHEMA_VERSION: u32 = 3;

/// A scenario: the unit that AI clients, Studio and the Runtime share.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(title = "Scenario")]
pub struct Scenario {
    /// Optional JSON Schema reference for editors. Ignored by Shikigami.
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema_ref: Option<String>,
    /// Version of the scenario file format.
    pub schema_version: u32,
    pub id: ScenarioId,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Plugins the steps need, with the versions they were written for:
    /// `{ "plugin:kintone": "^0.3.1" }`. Kept up to date by Core when steps
    /// are added or removed, so authors normally leave it alone.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub requires: BTreeMap<String, String>,
    /// Monotonic revision, incremented by every committed edit. Used for
    /// optimistic concurrency between Studio, MCP clients and the CLI.
    #[serde(default)]
    pub revision: u64,
    /// Declared variables (inputs, outputs and locals).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables: Vec<VariableDef>,
    /// Top-level steps, executed in order.
    #[serde(default)]
    pub steps: Vec<Step>,
    /// Scenario-wide defaults for error handling, timeouts and retries.
    #[serde(default, skip_serializing_if = "ScenarioSettings::is_default")]
    pub settings: ScenarioSettings,
    #[serde(default)]
    pub metadata: Metadata,
}

impl Scenario {
    /// Creates an empty scenario with a fresh ID.
    pub fn new(name: impl Into<String>) -> Self {
        let now = now();
        Self {
            schema_ref: None,
            schema_version: SCHEMA_VERSION,
            id: ScenarioId::generate(),
            name: name.into(),
            description: String::new(),
            requires: BTreeMap::new(),
            revision: 0,
            variables: Vec::new(),
            steps: Vec::new(),
            settings: ScenarioSettings::default(),
            metadata: Metadata {
                created_at: Some(now),
                updated_at: Some(now),
                ..Metadata::default()
            },
        }
    }

    /// Lightweight summary used for listings.
    pub fn summary(&self) -> ScenarioSummary {
        ScenarioSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            revision: self.revision,
            step_count: self.walk().count(),
            tags: self.metadata.tags.clone(),
            updated_at: self.metadata.updated_at,
        }
    }

    /// Depth-first iterator over every step (including nested ones).
    pub fn walk(&self) -> impl Iterator<Item = &Step> {
        let mut stack: Vec<&Step> = self.steps.iter().rev().collect();
        std::iter::from_fn(move || {
            let step = stack.pop()?;
            for block in step.blocks.values().rev() {
                stack.extend(block.iter().rev());
            }
            Some(step)
        })
    }

    pub fn find_step(&self, id: &StepId) -> Option<&Step> {
        self.walk().find(|s| &s.id == id)
    }

    pub fn variable(&self, name: &str) -> Option<&VariableDef> {
        self.variables.iter().find(|v| v.name == name)
    }
}

/// A single step. Control-flow and action steps share this shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    /// Stable unique ID. Omit when adding a step; Core assigns one.
    #[serde(default, skip_serializing_if = "StepId::is_empty")]
    pub id: StepId,
    /// Step type, e.g. `control.if`, `variable.set`, `browser.click`.
    #[serde(rename = "type")]
    pub step_type: String,
    /// Display label (Japanese is fine). Purely informational.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Type-specific parameters, validated against the step type's schema.
    /// String values may contain `{{ expression }}` templates.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    /// Child step lists of control-flow steps, keyed by block name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub blocks: BTreeMap<String, Vec<Step>>,
    /// Disabled steps are skipped by the Runtime but kept in the scenario.
    #[serde(default, skip_serializing_if = "is_false")]
    pub disabled: bool,
    /// Per-attempt timeout. Falls back to `settings.defaultTimeoutMs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    /// What to do when the step still fails after retries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<OnError>,
    /// Variable that receives the step's output value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_as: Option<String>,
    /// Free-form metadata (Studio layout hints, AI provenance such as the UI
    /// element a selector was derived from). Never interpreted by the Runtime.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub meta: Map<String, Value>,
}

impl Step {
    pub fn new(step_type: impl Into<String>) -> Self {
        Self {
            id: StepId::default(),
            step_type: step_type.into(),
            name: String::new(),
            description: String::new(),
            params: Map::new(),
            blocks: BTreeMap::new(),
            disabled: false,
            timeout_ms: None,
            retry: None,
            on_error: None,
            save_as: None,
            meta: Map::new(),
        }
    }

    pub fn with_id(mut self, id: impl Into<StepId>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    pub fn with_param(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }

    pub fn with_block(mut self, name: impl Into<String>, steps: Vec<Step>) -> Self {
        self.blocks.insert(name.into(), steps);
        self
    }

    pub fn block(&self, name: &str) -> &[Step] {
        self.blocks.get(name).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Depth-first iterator over this step and all of its descendants.
    pub fn walk(&self) -> impl Iterator<Item = &Step> {
        let mut stack: Vec<&Step> = vec![self];
        std::iter::from_fn(move || {
            let step = stack.pop()?;
            for block in step.blocks.values().rev() {
                stack.extend(block.iter().rev());
            }
            Some(step)
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryPolicy {
    /// Total attempts including the first one (1 = no retry).
    pub max_attempts: u32,
    /// Delay before the second attempt.
    #[serde(default = "default_backoff_ms")]
    pub backoff_ms: u64,
    /// Multiplier applied to the delay after each failed attempt.
    #[serde(default = "default_backoff_multiplier")]
    pub backoff_multiplier: f64,
}

fn default_backoff_ms() -> u64 {
    1000
}

fn default_backoff_multiplier() -> f64 {
    2.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum OnError {
    /// Stop the run (or hand control to the enclosing `control.try`).
    #[default]
    Fail,
    /// Record the error in `lastError` and continue with the next step.
    Continue,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioSettings {
    /// Default per-step timeout in milliseconds (30 s when omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_retry: Option<RetryPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<OnError>,
    /// Leave the files in the scenario's `work/` folder when a run starts.
    /// By default a run starts with `work/` emptied.
    #[serde(default, skip_serializing_if = "is_false")]
    pub keep_work: bool,
}

impl ScenarioSettings {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VariableDef {
    /// Identifier used in expressions: `[A-Za-z_][A-Za-z0-9_]*`.
    pub name: String,
    #[serde(rename = "type", default)]
    pub var_type: VarType,
    #[serde(default)]
    pub direction: VarDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Secret values are masked in logs, events and run records.
    #[serde(default, skip_serializing_if = "is_false")]
    pub secret: bool,
}

impl VariableDef {
    pub fn new(name: impl Into<String>, var_type: VarType) -> Self {
        Self {
            name: name.into(),
            var_type,
            direction: VarDirection::Local,
            default: None,
            description: String::new(),
            secret: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum VarType {
    String,
    Number,
    Boolean,
    Object,
    Array,
    #[default]
    Any,
}

impl VarType {
    pub fn accepts(self, value: &Value) -> bool {
        match self {
            Self::Any => true,
            Self::String => value.is_string(),
            Self::Number => value.is_number(),
            Self::Boolean => value.is_boolean(),
            Self::Object => value.is_object(),
            Self::Array => value.is_array(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum VarDirection {
    /// Supplied by the caller when the run starts.
    Input,
    /// Returned to the caller when the run finishes.
    Output,
    /// Both supplied and returned.
    InOut,
    #[default]
    Local,
}

impl VarDirection {
    pub fn is_input(self) -> bool {
        matches!(self, Self::Input | Self::InOut)
    }

    pub fn is_output(self) -> bool {
        matches!(self, Self::Output | Self::InOut)
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    #[serde(
        default,
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<String>")]
    pub created_at: Option<OffsetDateTime>,
    #[serde(
        default,
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<String>")]
    pub updated_at: Option<OffsetDateTime>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Extension data. Unknown keys are preserved on round-trip.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Listing entry returned by `list_scenarios`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSummary {
    pub id: ScenarioId,
    pub name: String,
    pub description: String,
    pub revision: u64,
    pub step_count: usize,
    pub tags: Vec<String>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    #[schemars(with = "Option<String>")]
    pub updated_at: Option<OffsetDateTime>,
}

pub(crate) fn now() -> OffsetDateTime {
    // Drop sub-second precision so files stay readable and diffs small.
    let now = OffsetDateTime::now_utc();
    now.replace_nanosecond(0).unwrap_or(now)
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn walk_visits_nested_steps_in_document_order() {
        let mut scenario = Scenario::new("t");
        scenario.steps = vec![
            Step::new("log.message").with_id("a"),
            Step::new("control.if")
                .with_id("b")
                .with_block("then", vec![Step::new("log.message").with_id("c")])
                .with_block("else", vec![Step::new("log.message").with_id("d")]),
            Step::new("log.message").with_id("e"),
        ];
        let ids: Vec<_> = scenario.walk().map(|s| s.id.as_str()).collect();
        // Blocks are stored in a BTreeMap, so "else" sorts before "then".
        assert_eq!(ids, ["a", "b", "d", "c", "e"]);
    }

    #[test]
    fn round_trips_through_json_and_preserves_unknown_metadata() {
        let value = json!({
            "schemaVersion": 1,
            "id": "scn_demo",
            "name": "デモ",
            "revision": 3,
            "steps": [
                { "id": "stp_1", "type": "log.message", "params": { "message": "こんにちは" } }
            ],
            "metadata": { "tags": ["demo"], "x-owner": "team-a" }
        });
        let scenario: Scenario = serde_json::from_value(value.clone()).expect("parse");
        assert_eq!(
            scenario.metadata.extra.get("x-owner"),
            Some(&json!("team-a"))
        );
        let back = serde_json::to_value(&scenario).expect("serialize");
        assert_eq!(back, value);
    }

    #[test]
    fn unknown_step_fields_are_rejected() {
        let result: Result<Step, _> =
            serde_json::from_value(json!({ "type": "log.message", "parms": {} }));
        assert!(result.is_err());
    }
}
