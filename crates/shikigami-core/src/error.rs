//! Structured errors for Scenario Core.
//!
//! Every error carries a stable, machine-readable `code` (SCREAMING_SNAKE_CASE)
//! that MCP tools, Tauri commands and the CLI expose unchanged. Messages are
//! human-readable English; UI layers localise by code.

use serde::Serialize;
use serde_json::Value;

use crate::ids::{ScenarioId, StepId};
use crate::validate::ValidationReport;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("scenario not found: {0}")]
    ScenarioNotFound(ScenarioId),

    #[error("scenario already exists: {0}")]
    ScenarioAlreadyExists(ScenarioId),

    #[error("invalid scenario id: {0:?}")]
    InvalidScenarioId(String),

    #[error("step not found: {0}")]
    StepNotFound(StepId),

    #[error("duplicate step id: {0}")]
    DuplicateStepId(StepId),

    #[error("revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },

    #[error("invalid edit: {0}")]
    InvalidEdit(String),

    #[error("nothing to {0}")]
    NothingTo(&'static str),

    #[error("unsupported schema version {found} (supported up to {supported})")]
    UnsupportedSchemaVersion { found: u32, supported: u32 },

    #[error("scenario is invalid ({} error(s))", .0.error_count())]
    ValidationFailed(ValidationReport),

    #[error("failed to parse scenario JSON: {0}")]
    Parse(#[from] serde_json::Error),

    #[error("storage error: {0}")]
    Io(#[from] std::io::Error),
}

impl CoreError {
    /// Stable error code shared by every interface.
    pub fn code(&self) -> &'static str {
        match self {
            Self::ScenarioNotFound(_) => "SCENARIO_NOT_FOUND",
            Self::ScenarioAlreadyExists(_) => "SCENARIO_ALREADY_EXISTS",
            Self::InvalidScenarioId(_) => "INVALID_SCENARIO_ID",
            Self::StepNotFound(_) => "STEP_NOT_FOUND",
            Self::DuplicateStepId(_) => "DUPLICATE_STEP_ID",
            Self::RevisionConflict { .. } => "REVISION_CONFLICT",
            Self::InvalidEdit(_) => "INVALID_EDIT",
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
            Self::StepNotFound(id) | Self::DuplicateStepId(id) => {
                Some(serde_json::json!({ "step_id": id }))
            }
            Self::ScenarioNotFound(id) | Self::ScenarioAlreadyExists(id) => {
                Some(serde_json::json!({ "scenario_id": id }))
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
