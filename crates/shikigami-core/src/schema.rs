//! JSON Schema export.
//!
//! `shikigami schema export` writes these to `schemas/`, and
//! `packages/schema` turns them into TypeScript types, so Rust, TypeScript
//! and AI clients all share one contract. A test fails when the committed
//! files drift from the Rust types.

use schemars::{JsonSchema, schema_for};
use serde_json::Value;

use crate::approval::ApprovalRequest;
use crate::error::ErrorPayload;
use crate::model::Scenario;
use crate::model::ScenarioSummary;
use crate::ops::EditOp;
use crate::policy::Policy;
use crate::registry::StepTypeDef;
use crate::review::{Evidence, NewReview, ObservationContent, ReviewTimeline};
use crate::service::{
    ChangeEvent, ChangeNote, EditOutcome, ExtractOutcome, ImportOutcome, NewScenario,
};
use crate::store::{HistoryEntry, WorkspaceInfo};
use crate::validate::ValidationReport;
use crate::version::{
    ImportConflict, NewVersion, PublishInput, PublishRecord, PublishedState, ScenarioBundle,
    ScenarioDiff, ScenarioVersion, VersionSummary,
};

const SCHEMA_BASE: &str = "https://shikigami.dev/schemas";

/// Every exported schema as `(file name, schema)`.
pub fn all() -> Vec<(&'static str, Value)> {
    vec![
        ("scenario.schema.json", schema::<Scenario>("scenario")),
        ("edit-op.schema.json", schema::<EditOp>("edit-op")),
        ("api.schema.json", api_schema()),
    ]
}

/// Removes prose (`description` and `title` strings) from a
/// schema, so a contract snapshot changes only when the shape does.
/// Properties that happen to be called `description` stay: their value is
/// a schema object, not a string.
pub fn strip_docs(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, v| {
                !(matches!(key.as_str(), "description" | "title") && v.is_string())
            });
            map.values_mut().for_each(strip_docs);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_docs),
        _ => {}
    }
}

fn schema<T: JsonSchema>(name: &str) -> Value {
    let mut value = serde_json::to_value(schema_for!(T)).unwrap_or(Value::Null);
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "$id".into(),
            Value::String(format!("{SCHEMA_BASE}/{name}.schema.json")),
        );
    }
    value
}

/// Bundle of the IPC/API payload types used by Studio and MCP tools.
#[derive(JsonSchema)]
#[allow(dead_code)]
#[schemars(rename = "ShikigamiApi")]
struct Api {
    scenario: Scenario,
    scenario_summary: ScenarioSummary,
    new_scenario: NewScenario,
    edit_op: EditOp,
    edit_outcome: EditOutcome,
    validation_report: ValidationReport,
    step_type_def: StepTypeDef,
    history_entry: HistoryEntry,
    change_event: ChangeEvent,
    error_payload: ErrorPayload,
    new_version: NewVersion,
    scenario_version: ScenarioVersion,
    version_summary: VersionSummary,
    scenario_diff: ScenarioDiff,
    scenario_bundle: ScenarioBundle,
    import_outcome: ImportOutcome,
    extract_outcome: ExtractOutcome,
    import_conflict: ImportConflict,
    workspace_info: WorkspaceInfo,
    change_note: ChangeNote,
    review_timeline: ReviewTimeline,
    evidence: Evidence,
    new_review: NewReview,
    observation_content: ObservationContent,
    published_state: PublishedState,
    publish_input: PublishInput,
    publish_record: PublishRecord,
    policy: Policy,
    approval_request: ApprovalRequest,
}

fn api_schema() -> Value {
    schema::<Api>("api")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn scenario_schema_accepts_examples() {
        let schema = schema::<Scenario>("scenario");
        let validator = jsonschema::validator_for(&schema).expect("compile");
        let examples = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples");
        let mut checked = 0;
        for entry in std::fs::read_dir(examples).expect("examples dir") {
            let path = entry.expect("entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let doc: Value =
                serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
            let errors: Vec<String> = validator.iter_errors(&doc).map(|e| e.to_string()).collect();
            assert!(errors.is_empty(), "{}: {errors:?}", path.display());
            checked += 1;
        }
        assert!(checked > 0);
    }

    #[test]
    fn committed_schemas_are_up_to_date() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schemas");
        for (name, schema) in all() {
            let expected = serde_json::to_string_pretty(&schema).expect("serialize") + "\n";
            let actual = std::fs::read_to_string(dir.join(name)).unwrap_or_default();
            assert!(
                actual == expected,
                "schemas/{name} is outdated; run `cargo run -p shikigami-cli -- schema export`"
            );
        }
    }
}
