//! Structured errors for Flow Core.
//!
//! Every error carries a stable, machine-readable `code` (SCREAMING_SNAKE_CASE)
//! that MCP tools, Tauri commands and the CLI expose unchanged. Messages are
//! human-readable English; UI layers localise by code.

use serde::Serialize;
use serde_json::Value;

use crate::ids::{FlowId, ObservationId, StepId};
use crate::validate::ValidationReport;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("flow not found: {0}")]
    FlowNotFound(FlowId),

    #[error("flow already exists: {0}")]
    FlowAlreadyExists(FlowId),

    #[error("invalid flow id: {0:?}")]
    InvalidFlowId(String),

    #[error("step not found: {0}")]
    StepNotFound(StepId),

    #[error("duplicate step id: {0}")]
    DuplicateStepId(StepId),

    #[error("revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },

    #[error("version {number} of flow {flow_id} not found")]
    VersionNotFound { flow_id: FlowId, number: u32 },

    #[error(
        "flow {flow_id} ({name}) already exists in this workspace; choose \"update\" or \"copy\" (onConflict)"
    )]
    ImportConflict { flow_id: FlowId, name: String },

    #[error("flow {flow_id} is called by {} other flow(s)", .callers.len())]
    FlowInUse {
        flow_id: FlowId,
        /// `(id, name)` of each flow that calls it.
        callers: Vec<(FlowId, String)>,
    },

    #[error("observation not found: {0}")]
    ObservationNotFound(ObservationId),

    #[error("invalid project file path {path:?}: {reason}")]
    InvalidProjectPath { path: String, reason: String },

    #[error("no file {path:?} in the flow's folder")]
    ProjectFileNotFound { path: String },

    #[error("{path:?} already exists in the flow's folder")]
    ProjectFileExists { path: String },

    #[error("invalid edit: {0}")]
    InvalidEdit(String),

    /// Refused by a rule (publishing, the workspace policy, approvals),
    /// with its own stable code and a hint for the client.
    #[error("{message}")]
    Rejected {
        code: &'static str,
        message: String,
        hint: Option<String>,
    },

    #[error("nothing to {0}")]
    NothingTo(&'static str),

    #[error("unsupported schema version {found} (supported up to {supported})")]
    UnsupportedSchemaVersion { found: u32, supported: u32 },

    #[error("flow is invalid ({} error(s))", .0.error_count())]
    ValidationFailed(ValidationReport),

    #[error("failed to parse flow JSON: {0}")]
    Parse(#[from] serde_json::Error),

    #[error("storage error: {0}")]
    Io(#[from] std::io::Error),
}

impl CoreError {
    /// Stable error code shared by every interface.
    pub fn code(&self) -> &'static str {
        match self {
            Self::FlowNotFound(_) => "FLOW_NOT_FOUND",
            Self::FlowAlreadyExists(_) => "FLOW_ALREADY_EXISTS",
            Self::InvalidFlowId(_) => "INVALID_FLOW_ID",
            Self::StepNotFound(_) => "STEP_NOT_FOUND",
            Self::DuplicateStepId(_) => "DUPLICATE_STEP_ID",
            Self::RevisionConflict { .. } => "REVISION_CONFLICT",
            Self::VersionNotFound { .. } => "VERSION_NOT_FOUND",
            Self::ImportConflict { .. } => "IMPORT_CONFLICT",
            Self::FlowInUse { .. } => "FLOW_IN_USE",
            Self::ObservationNotFound(_) => "OBSERVATION_NOT_FOUND",
            Self::InvalidProjectPath { .. } => "INVALID_PROJECT_PATH",
            Self::ProjectFileNotFound { .. } => "PROJECT_FILE_NOT_FOUND",
            Self::ProjectFileExists { .. } => "PROJECT_FILE_EXISTS",
            Self::InvalidEdit(_) => "INVALID_EDIT",
            Self::Rejected { code, .. } => code,
            Self::NothingTo(_) => "NOTHING_TO_UNDO_OR_REDO",
            Self::UnsupportedSchemaVersion { .. } => "UNSUPPORTED_SCHEMA_VERSION",
            Self::ValidationFailed(_) => "VALIDATION_FAILED",
            Self::Parse(_) => "PARSE_ERROR",
            Self::Io(_) => "STORAGE_ERROR",
        }
    }

    /// Structured details for clients (e.g. the validation issues or revisions).
    pub fn details(&self) -> Option<Value> {
        match self {
            Self::RevisionConflict { expected, actual } => {
                Some(serde_json::json!({ "expected": expected, "actual": actual }))
            }
            Self::ValidationFailed(report) => serde_json::to_value(report).ok(),
            Self::UnsupportedSchemaVersion { found, supported } => Some(serde_json::json!({
                "found": found,
                "supported": supported,
                "hint": "The file was saved by a newer SpellSheet. Update SpellSheet (Studio offers the update, or install the latest release) to open it.",
            })),
            Self::StepNotFound(id) | Self::DuplicateStepId(id) => {
                Some(serde_json::json!({ "step_id": id }))
            }
            Self::VersionNotFound { flow_id, number } => {
                Some(serde_json::json!({ "flow_id": flow_id, "number": number }))
            }
            Self::ImportConflict { flow_id, name } => Some(serde_json::json!({
                "flow_id": flow_id,
                "name": name,
                "hint": "\"update\" applies the imported content to the existing flow as one undoable edit and adds its versions; \"copy\" imports it as a new flow with a new ID",
            })),
            Self::FlowInUse { flow_id, callers } => Some(serde_json::json!({
                "flow_id": flow_id,
                "callers": callers
                    .iter()
                    .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
                    .collect::<Vec<_>>(),
                "hint": "Remove or change the flow.call steps in these flows first.",
            })),
            Self::ObservationNotFound(id) => Some(serde_json::json!({
                "observation_id": id,
                "hint": "Use the observationId returned by inspect_page, inspect_ui or test_step in this session; unused observations are deleted after a few days.",
            })),
            Self::Rejected {
                hint: Some(hint), ..
            } => Some(serde_json::json!({ "hint": hint })),
            Self::InvalidProjectPath { path, .. } => Some(serde_json::json!({
                "path": path,
                "hint": "Paths are relative to the flow's folder and use its folders: input/, config/, templates/, output/, work/ (e.g. input/orders.xlsx).",
            })),
            Self::ProjectFileNotFound { path } => Some(serde_json::json!({
                "path": path,
                "hint": "list_project_files shows the files the flow's folder holds.",
            })),
            Self::ProjectFileExists { path } => Some(serde_json::json!({
                "path": path,
                "hint": "Pass overwrite: true to replace it, or choose another name.",
            })),
            Self::FlowNotFound(id) | Self::FlowAlreadyExists(id) => {
                Some(serde_json::json!({ "flow_id": id }))
            }
            _ => None,
        }
    }

    pub fn to_payload(&self) -> ErrorPayload {
        ErrorPayload {
            code: self.code().to_owned(),
            message: self.to_string(),
            details: self.details(),
        }
    }
}

/// Serializable error shape returned over IPC / MCP.
#[derive(Debug, Clone, Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl From<CoreError> for ErrorPayload {
    fn from(err: CoreError) -> Self {
        err.to_payload()
    }
}
