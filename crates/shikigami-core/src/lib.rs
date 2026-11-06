//! Shikigami Flow Core.
//!
//! The one place where flow documents are defined, validated, edited,
//! versioned and stored. Studio, the MCP server, the CLI and the Runtime all
//! depend on this crate and never re-implement its logic.

pub mod approval;
pub mod call;
pub mod error;
pub mod expr;
pub mod ids;
pub mod migrate;
pub mod model;
pub mod ops;
pub mod policy;
pub mod project;
pub mod registry;
pub mod requires;
pub mod resource;
pub mod review;
pub mod schema;
pub mod secret;
pub mod service;
pub mod store;
pub mod validate;
pub mod version;

pub use approval::{AiAction, ApprovalRequest, ApprovalStatus, ApprovalStore, NewApproval, Redeem};
pub use call::Subflow;
pub use error::{CoreError, CoreResult, ErrorPayload};
pub use ids::{ApprovalId, FlowId, ObservationId, RunId, StepId};
pub use model::{
    Flow, FlowSettings, FlowSummary, Metadata, OnError, RetryPolicy, SCHEMA_VERSION, Step,
    VarDirection, VarType, VariableDef,
};
pub use ops::{EditOp, FlowPatch, Position, StepPatch};
pub use policy::{Decision, Policy, TargetDef, TargetKind};
pub use project::{BundledFile, ConfigFile, ConfigItem, ConfigType, ProjectFile, ProjectFiles};
pub use registry::{Deprecation, PluginInfo, RiskLevel, StepCategory, StepRegistry, StepTypeDef};
pub use review::{
    ChangeRecord, Evidence, EvidenceDetail, NewObservation, NewReview, Observation,
    ObservationContent, ObservationSource, ReviewTimeline, ReviewVerdict, StepNote, TestRun,
};
pub use service::{
    ChangeEvent, ChangeNote, EditOutcome, ExtractOutcome, FlowService, ImportOutcome,
    ImportedSubflow, NewFlow, PublishedRun,
};
pub use store::{
    Actor, ActorKind, ChangeKind, FileStore, HistoryEntry, UserConfig, WorkspaceInfo,
    WorkspaceManifest,
};
pub use validate::{Severity, ValidationIssue, ValidationReport, Validator};
pub use version::{
    DiffKind, FlowBundle, FlowDiff, FlowVersion, ImportConflict, ImportMode, NewVersion,
    PublishInput, PublishRecord, PublishedState, SubflowImport, VersionSummary,
};
