//! Shikigami Scenario Core.
//!
//! The one place where scenario documents are defined, validated, edited,
//! versioned and stored. Studio, the MCP server, the CLI and the Runtime all
//! depend on this crate and never re-implement its logic.

pub mod error;
pub mod expr;
pub mod ids;
pub mod migrate;
pub mod model;
pub mod ops;
pub mod registry;
pub mod resource;
pub mod schema;
pub mod secret;
pub mod service;
pub mod store;
pub mod validate;

pub use error::{CoreError, CoreResult, ErrorPayload};
pub use ids::{RunId, ScenarioId, StepId};
pub use model::{
    Metadata, OnError, RetryPolicy, SCHEMA_VERSION, Scenario, ScenarioSettings, ScenarioSummary,
    Step, VarDirection, VarType, VariableDef,
};
pub use ops::{EditOp, Position, ScenarioPatch, StepPatch};
pub use registry::{RiskLevel, StepCategory, StepRegistry, StepTypeDef};
pub use service::{ChangeEvent, EditOutcome, NewScenario, ScenarioService};
pub use store::{Actor, ActorKind, ChangeKind, FileStore, HistoryEntry};
pub use validate::{Severity, ValidationIssue, ValidationReport, Validator};
