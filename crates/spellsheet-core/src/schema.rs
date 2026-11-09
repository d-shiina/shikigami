//! JSON Schema export.
//!
//! `spellsheet schema export` writes these to `schemas/`, and
//! `packages/schema` turns them into TypeScript types, so Rust, TypeScript
//! and AI clients all share one contract. A test fails when the committed
//! files drift from the Rust types.

use schemars::{JsonSchema, schema_for};
use serde_json::Value;

use crate::approval::ApprovalRequest;
use crate::error::ErrorPayload;
use crate::model::Flow;
use crate::model::FlowSummary;
use crate::ops::EditOp;
use crate::policy::Policy;
use crate::project::{ConfigFile, ProjectFile, ProjectFiles};
use crate::registry::StepTypeDef;
use crate::review::{Evidence, NewReview, ObservationContent, ReviewTimeline};
use crate::service::{
    ChangeEvent, ChangeNote, EditOutcome, ExtractOutcome, ImportOutcome, NewFlow,
};
use crate::store::{HistoryEntry, WorkspaceInfo};
use crate::validate::ValidationReport;
use crate::version::{
    FlowBundle, FlowDiff, FlowVersion, ImportConflict, NewVersion, PublishInput, PublishRecord,
    PublishedState, VersionSummary,
};

const SCHEMA_BASE: &str = "https://spellsheet.dev/schemas";

/// Every exported schema as `(file name, schema)`.
pub fn all() -> Vec<(&'static str, Value)> {
    vec![
        ("flow.schema.json", schema::<Flow>("flow")),
        ("edit-op.schema.json", schema::<EditOp>("edit-op")),
        ("api.schema.json", api_schema()),
        (
            "test-case.schema.json",
            schema::<crate::testcase::TestCase>("test-case"),
        ),
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
#[schemars(rename = "SpellSheetApi")]
struct Api {
    flow: Flow,
    flow_summary: FlowSummary,
    new_flow: NewFlow,
    edit_op: EditOp,
    edit_outcome: EditOutcome,
    validation_report: ValidationReport,
    step_type_def: StepTypeDef,
    history_entry: HistoryEntry,
    change_event: ChangeEvent,
    error_payload: ErrorPayload,
    new_version: NewVersion,
    flow_version: FlowVersion,
    version_summary: VersionSummary,
    flow_diff: FlowDiff,
    flow_bundle: FlowBundle,
    import_outcome: ImportOutcome,
    package_manifest: crate::package::PackageManifest,
    package_plan: crate::package::PackagePlan,
    package_options: crate::package::PackageOptions,
    package_preview: crate::package::PackagePreview,
    distribution_folder: crate::distribution::DistributionFolder,
    distribution_view: crate::distribution::DistributionView,
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
    project_files: ProjectFiles,
    project_file: ProjectFile,
    config_file: ConfigFile,
    test_case: crate::testcase::TestCase,
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
    fn flow_schema_accepts_examples() {
        let schema = schema::<Flow>("flow");
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
            // A bundle (`*.spellsheet.json`) is not a flow; validate the
            // flows it carries instead of the bundle wrapper.
            let flows: Vec<&Value> = if crate::version::is_bundle(&doc) {
                let mut v = vec![doc.get("flow").expect("bundle has a flow")];
                if let Some(Value::Array(subs)) = doc.get("subflows") {
                    v.extend(subs.iter());
                }
                v
            } else {
                vec![&doc]
            };
            for flow in flows {
                let errors: Vec<String> =
                    validator.iter_errors(flow).map(|e| e.to_string()).collect();
                assert!(errors.is_empty(), "{}: {errors:?}", path.display());
                checked += 1;
            }
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
                "schemas/{name} is outdated; run `cargo run -p spellsheet-cli -- schema export`"
            );
        }
    }
}
