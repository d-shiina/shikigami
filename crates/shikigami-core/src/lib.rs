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
pub mod review;
pub mod schema;
pub mod secret;
pub mod service;
pub mod store;
pub mod validate;
pub mod version;

pub use error::{CoreError, CoreResult, ErrorPayload};
pub use ids::{ObservationId, RunId, ScenarioId, StepId};
pub use model::{
    Metadata, OnError, RetryPolicy, SCHEMA_VERSION, Scenario, ScenarioSettings, ScenarioSummary,
    Step, VarDirection, VarType, VariableDef,
};
pub use ops::{EditOp, Position, ScenarioPatch, StepPatch};
pub use registry::{RiskLevel, StepCategory, StepRegistry, StepTypeDef};
pub use review::{
    ChangeRecord, Evidence, EvidenceDetail, NewObservation, NewReview, Observation,
    ObservationContent, ObservationSource, ReviewTimeline, ReviewVerdict, StepNote, TestRun,
};
pub use service::{
    ChangeEvent, ChangeNote, EditOutcome, ImportOutcome, NewScenario, ScenarioService,
};
pub use store::{
    Actor, ActorKind, ChangeKind, FileStore, HistoryEntry, UserConfig, WorkspaceInfo,
    WorkspaceManifest,
};
pub use validate::{Severity, ValidationIssue, ValidationReport, Validator};
pub use version::{
    DiffKind, ImportConflict, ImportMode, NewVersion, ScenarioBundle, ScenarioDiff,
    ScenarioVersion, VersionSummary,
};
