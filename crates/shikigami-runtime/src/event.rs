//! Run events, errors and reports. All of these are serialised to the run
//! record on disk, streamed to Studio, and returned by MCP tools.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shikigami_core::{FlowId, RunId, StepId};
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
    /// The node as people know it: its name, else its type's label. Set on
    /// the run's final error (report, notifications), so the place can be
    /// told without the flow at hand; `stepId` stays the key to the node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_label: Option<String>,
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
            step_label: None,
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

    /// Representation bound to `errorVar` / `lastError` inside flows.
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
        #[serde(alias = "scenarioId")]
        flow_id: FlowId,
        #[serde(alias = "scenarioName")]
        flow_name: String,
        revision: u64,
        /// Who asked for the run, from where, on which PC.
        #[serde(default, skip_serializing_if = "RunOrigin::is_empty")]
        origin: RunOrigin,
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
    /// A picture of the screen a browser or desktop step works on, kept
    /// for the flow's 手順書 (runs given `RunOptions::screens_dir`). Taken
    /// the first time each step runs: before it acts, or after it for
    /// steps that open, read or wait. `file` is its name in that folder.
    /// `mark` is where the step's element is in the picture (pixels);
    /// `regions` are the input fields and table cells there, which the
    /// 手順書 can blur. Fields the run typed into are already covered in
    /// the picture, password fields blacked out.
    ScreenCaptured {
        step_id: StepId,
        file: String,
        width: u32,
        height: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mark: Option<ScreenRect>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        regions: Vec<ScreenRect>,
        /// The page's or window's title, secrets masked.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        /// Equal for two pictures of the same view (the same address
        /// scrolled to the same place): their marks share one picture.
        /// An opaque digest.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        view: Option<String>,
    },
    /// An interactive run stopped before `stepId` (breakpoint, step
    /// command, pause request) or after it failed (`reason: "error"`, with
    /// `error`). Nothing runs until it is resumed.
    ///
    /// `variables` holds every variable's value at that point, masked and
    /// cut like `variableChanged` values. `revision` is the flow
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
    /// revision of the flow was swapped in while it was paused.
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

/// A rectangle in a picture's pixels, from its top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
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
    /// The `flow.call` steps (outermost first) the event happened
    /// inside; empty for the flow that was started. Step IDs in the
    /// event belong to the innermost called flow.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub call_path: Vec<StepId>,
    #[serde(flatten)]
    pub event: RunEvent,
}

/// Final result of a run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub run_id: RunId,
    #[serde(alias = "scenarioId")]
    pub flow_id: FlowId,
    #[serde(alias = "scenarioName")]
    pub flow_name: String,
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
    /// The flows `flow.call` steps could run, as they were when the
    /// run started.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[serde(alias = "subscenarios")]
    pub subflows: Vec<SubflowRef>,
    /// Who asked for the run, from where, on which PC.
    #[serde(default, skip_serializing_if = "RunOrigin::is_empty")]
    pub origin: RunOrigin,
    /// Names of the secrets the run used (typed values, API auth, saved
    /// logins, OAuth tokens), never their values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets_used: Vec<String>,
}

/// How a run was started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunTrigger {
    /// "Run" in Studio (a person watching).
    Studio,
    /// An AI client's `run_flow` / `test_step`.
    Mcp,
    /// `spellsheet run` (a person, a batch file or Task Scheduler).
    Cli,
    /// A schedule of the agent.
    Schedule,
    /// A job from a management server.
    Remote,
}

/// Who asked for a run, from where, and on which PC. Recorded in
/// `runStarted` and the report so that runs can be told apart later (and
/// collected from many PCs).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunOrigin {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<RunTrigger>,
    /// The person, AI client, schedule or manager that asked, in its own
    /// words (e.g. "claude-code", a schedule's name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    /// The job of a schedule or management server this run carries out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// The PC the run happened on (its computer name). Filled in by the
    /// Runtime when not given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

impl RunOrigin {
    pub fn new(trigger: RunTrigger) -> Self {
        Self {
            trigger: Some(trigger),
            ..Self::default()
        }
    }

    pub fn requested_by(mut self, who: impl Into<String>) -> Self {
        self.requested_by = Some(who.into());
        self
    }

    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// This PC's name (`COMPUTERNAME` on Windows), if known.
pub fn machine_name() -> Option<String> {
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|v| v.trim().to_string())
        .find(|v| !v.is_empty())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

/// A called flow's content as used by a run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubflowRef {
    #[serde(alias = "scenarioId")]
    pub flow_id: FlowId,
    #[serde(alias = "scenarioName")]
    pub flow_name: String,
    pub revision: u64,
    /// Named version its content matches, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
}

/// Live state of a run, for `get_run_status` while it is executing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run_id: RunId,
    #[serde(alias = "scenarioId")]
    pub flow_id: FlowId,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_step: Option<StepId>,
    pub steps_executed: u64,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// Runs recorded before flows were renamed (up to 0.1.2) still read.
    #[test]
    fn reads_run_started_events_from_0_1() {
        let event: RunEvent = serde_json::from_value(serde_json::json!({
            "type": "runStarted", "scenarioId": "scn_x", "scenarioName": "x", "revision": 3
        }))
        .unwrap();
        let RunEvent::RunStarted {
            flow_id, flow_name, ..
        } = event
        else {
            panic!("not runStarted");
        };
        assert_eq!(flow_id.as_str(), "scn_x");
        assert_eq!(flow_name, "x");
    }
}
