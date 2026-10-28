//! Tool input types. Their JSON Schemas (via schemars) are what MCP clients
//! see as each tool's `inputSchema`, so doc comments here are written for AI.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shikigami_core::{EditOp, ImportConflict, Position, Scenario, Step, StepPatch, VariableDef};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioRef {
    /// Scenario ID, e.g. `scn_...`.
    pub scenario_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ValidateParams {
    /// Validate a stored scenario by ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<String>,
    /// Or validate an unsaved scenario document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<Scenario>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateScenarioParams {
    /// Display name (Japanese is fine).
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Input/output/internal variables.
    #[serde(default)]
    pub variables: Vec<VariableDef>,
    /// Initial steps. Step IDs may be omitted; Core assigns them.
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateScenarioParams {
    pub scenario_id: String,
    /// When given, the edit fails with REVISION_CONFLICT unless the stored
    /// revision matches (someone else, e.g. a human in Studio, changed it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    /// Edit operations applied atomically as one revision (one undo step).
    pub ops: Vec<EditOp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddStepParams {
    pub scenario_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    /// The step to insert (children included). Omit `id` to let Core assign one.
    pub step: Step,
    /// Where to insert. Omit to append at the top level.
    #[serde(default)]
    pub position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStepParams {
    pub scenario_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    pub step_id: String,
    /// Partial update. `params` is a JSON Merge Patch (null removes a key).
    pub patch: StepPatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoveStepParams {
    pub scenario_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    /// Step to remove (its children are removed too).
    pub step_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveStepParams {
    pub scenario_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    pub step_id: String,
    /// New location. `index` is counted after removing the step.
    pub position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevisionedRef {
    pub scenario_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteScenarioParams {
    pub scenario_id: String,
    /// Required: the revision you last read. Deleting moves the scenario to
    /// the workspace trash.
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryParams {
    pub scenario_id: String,
    /// Most recent entries to return (default 20).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepTypeRef {
    /// Step type, e.g. `control.if`.
    #[serde(rename = "type")]
    pub step_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunScenarioParams {
    pub scenario_id: String,
    /// Values for input variables, by name.
    #[serde(default)]
    pub inputs: Map<String, Value>,
    /// Wait up to this many milliseconds (max 300000) for the run to finish
    /// and return its report. Omit or 0 to return immediately with the run ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunRef {
    /// Run ID, e.g. `run_...`.
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunLogsParams {
    pub run_id: String,
    /// Only events with `seq` greater than this (for polling).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_seq: Option<u64>,
    /// Maximum events to return (default 200).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    /// Only the `variableChanged` events of this variable: what it was set
    /// to, by which step, in order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListRunsParams {
    /// Only runs of this scenario.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<String>,
    /// Most recent runs to return (default 20).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectPageParams {
    /// Page to open first. Omit to inspect the page already open in `context`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Browser context to use (default "default"). Contexts here belong to the MCP session, not to runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Limit the snapshot to one element, e.g. { "role": "table", "name": "受注" }.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectUiParams {
    /// The window to look into, e.g. { "process": "notepad.exe" } or { "title": "請求" }
    /// (title matches partially). Omit to list the open windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<Value>,
    /// Limit the tree to one element and what is inside it, e.g. { "role": "table", "name": "明細" }.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element: Option<Value>,
    /// Most elements to list (default 1500).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestStepParams {
    /// One step as it would appear in a scenario, e.g.
    /// { "type": "browser.click", "params": { "target": { "role": "button", "name": "ログイン" } } }.
    /// `id` may be omitted.
    pub step: Step,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateVersionParams {
    pub scenario_id: String,
    /// Short name, e.g. "v1" or "本番リリース".
    pub name: String,
    /// What changed or why this version matters.
    #[serde(default)]
    pub note: String,
    /// When given, fails with REVISION_CONFLICT unless the stored revision
    /// matches, so the version is exactly what you last read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionRef {
    pub scenario_id: String,
    /// Version number from list_versions.
    pub number: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RestoreVersionParams {
    pub scenario_id: String,
    /// Version number from list_versions.
    pub number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffVersionsParams {
    pub scenario_id: String,
    /// Older side: a version number. Omit for the latest version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<u32>,
    /// Newer side: a version number. Omit for the current content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportScenarioParams {
    pub scenario_id: String,
    /// Include named versions (default true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_versions: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportScenarioParams {
    /// The `bundle` returned by export_scenario, or a bare scenario document.
    pub bundle: Value,
    /// Only needed when the scenario ID already exists (IMPORT_CONFLICT):
    /// "update" applies the content to the existing scenario as one undoable
    /// edit and adds missing versions; "copy" imports it under a new ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_conflict: Option<ImportConflict>,
}
