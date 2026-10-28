//! Run events, errors and reports. All of these are serialised to the run
//! record on disk, streamed to Studio, and returned by MCP tools.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shikigami_core::{RunId, ScenarioId, StepId};
use time::OffsetDateTime;

use crate::debug::{PauseReason, ResumeAction};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Pending,
    Running,
    /// An interactive run waits for a person (see `paused`).
    Paused,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StepOutcome {
    Succeeded,
    Failed,
    Skipped,
}

/// Structured failure information, kept for AI-assisted diagnosis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code}: {message}")]
pub struct RunError {
    /// Stable code, e.g. `STEP_TIMEOUT`, `EXPR_UNDEFINED_VARIABLE`, `ELEMENT_NOT_FOUND`.
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<StepId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_type: Option<String>,
    /// Adapter-specific evidence: UI element snapshot, screenshot path,
    /// expected vs. actual state, etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl RunError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            step_id: None,
            step_type: None,
            details: None,
        }
    }

    pub fn at_step(mut self, step_id: &StepId, step_type: &str) -> Self {
        if self.step_id.is_none() {
            self.step_id = Some(step_id.clone());
            self.step_type = Some(step_type.to_owned());
        }
        self
    }

    /// Representation bound to `errorVar` / `lastError` inside scenarios.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunEvent {
    RunStarted {
        scenario_id: ScenarioId,
        scenario_name: String,
        revision: u64,
    },
    StepStarted {
        step_id: StepId,
        step_type: String,
        attempt: u32,
    },
    StepFinished {
        step_id: StepId,
        step_type: String,
        outcome: StepOutcome,
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RunError>,
        #[serde(default, skip_serializing_if = "is_false")]
        will_retry: bool,
    },
    /// A variable was assigned: by `variable.set`, a step's `saveAs`, a
    /// loop's item/index variable, `errorVar` / `lastError`, or (without
    /// `stepId`) its input or default value when the run starts. Changes a
    /// parallel branch makes are reported when the branch makes them, not
    /// again when they are merged back.
    ///
    /// `value` is the new value: `"***"` for secret variables, other
    /// secrets masked inside it, and cut to a preview when large (see
    /// `truncated`).
    VariableChanged {
        variable: String,
        // Documented above: a field doc would make the generated TypeScript
        // type an object instead of `unknown`.
        value: Value,
        /// The step that assigned it; absent for inputs and defaults.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step_id: Option<StepId>,
        /// Item index (from 0) of the concurrent `forEach` iteration that
        /// made the change, so interleaved iterations can be told apart.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        iteration: Option<usize>,
        #[serde(default, skip_serializing_if = "is_false")]
        secret: bool,
        /// `value` is a preview: a long string cut short, or the start of
        /// a large array / object's JSON text.
        #[serde(default, skip_serializing_if = "is_false")]
        truncated: bool,
    },
    Log {
        level: LogLevel,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step_id: Option<StepId>,
    },
    /// A step waits for a person (e.g. to log in or approve MFA on the
    /// screen). Studio shows `message` until the step finishes.
    HumanActionRequired { step_id: StepId, message: String },
    /// An interactive run stopped before `stepId` (breakpoint, step
    /// command, pause request) or after it failed (`reason: "error"`, with
    /// `error`). Nothing runs until it is resumed.
    ///
    /// `variables` holds every variable's value at that point, masked and
    /// cut like `variableChanged` values. `revision` is the scenario
    /// revision the run is executing.
    Paused {
        step_id: StepId,
        step_type: String,
        reason: PauseReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RunError>,
        variables: Map<String, Value>,
        revision: u64,
    },
    /// The run goes on after `paused`. `revision` is set when a newer
    /// revision of the scenario was swapped in while it was paused.
    Resumed {
        action: ResumeAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision: Option<u64>,
    },
    RunFinished {
        status: RunStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RunError>,
        duration_ms: u64,
    },
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A run event with ordering and timing metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunEventEnvelope {
    pub run_id: RunId,
    /// Monotonic sequence number within the run, starting at 0.
    pub seq: u64,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub at: OffsetDateTime,
    #[serde(flatten)]
    pub event: RunEvent,
}

/// Final result of a run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub run_id: RunId,
    pub scenario_id: ScenarioId,
    pub scenario_name: String,
    pub revision: u64,
    /// Named version whose content was run, when it matches one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    pub status: RunStatus,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub started_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub finished_at: OffsetDateTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RunError>,
    /// Values of output variables (secret outputs are masked when recorded).
    pub outputs: Map<String, Value>,
}

/// Live state of a run, for `get_run_status` while it is executing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run_id: RunId,
    pub scenario_id: ScenarioId,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_step: Option<StepId>,
    pub steps_executed: u64,
}
