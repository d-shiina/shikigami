//! Named versions, diffs and scenario bundles.
//!
//! A version is an immutable snapshot of a scenario with a name and a note
//! ("v1 本番リリース"). Versions live in the shared part of the workspace, so
//! everyone who opens the workspace sees them. Restoring a version is an
//! ordinary edit (undoable); diffs compare steps by their stable IDs.
//!
//! A bundle (`*.shikigami.json`) carries one scenario and its versions to
//! another workspace without Git or any server.

use std::collections::{BTreeMap, HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::OffsetDateTime;

use crate::ids::StepId;
use crate::model::{Scenario, Step, VariableDef};
use crate::ops::{EditOp, ScenarioPatch};
use crate::store::Actor;

/// Format marker of scenario bundles.
pub const BUNDLE_FORMAT: &str = "shikigami.scenarioBundle";
pub const BUNDLE_FORMAT_VERSION: u32 = 1;

/// One named snapshot of a scenario.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioVersion {
    /// Per-scenario sequence number (1, 2, …). This is how versions are referenced.
    pub number: u32,
    /// Globally unique ID; keeps versions apart when bundles are imported.
    pub uid: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub created_at: OffsetDateTime,
    pub created_by: Actor,
    /// Scenario revision the snapshot was taken from.
    pub revision: u64,
    #[serde(deserialize_with = "crate::migrate::deserialize")]
    pub scenario: Scenario,
}

impl ScenarioVersion {
    pub fn summary(&self) -> VersionSummary {
        VersionSummary {
            number: self.number,
            name: self.name.clone(),
            note: self.note.clone(),
            created_at: self.created_at,
            created_by: self.created_by.clone(),
            revision: self.revision,
            step_count: self.scenario.walk().count(),
        }
    }
}

/// Listing entry for versions (no scenario body).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    pub number: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub created_at: OffsetDateTime,
    pub created_by: Actor,
    pub revision: u64,
    pub step_count: usize,
}

/// Input for creating a version.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewVersion {
    /// Short name, e.g. "v1" or "本番リリース".
    pub name: String,
    /// What changed or why this version matters.
    #[serde(default)]
    pub note: String,
}

/// One line of `versions/<scenario-id>/publish.jsonl`: which version runs
/// unattended from now on (`None`: none, the scenario was withdrawn). The
/// last line is in force; earlier lines are the record of who published
/// what, kept in the shared part of the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishRecord {
    pub version: Option<u32>,
    /// The version's `uid`, so a record never points at another snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub at: OffsetDateTime,
    pub by: Actor,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// The published version of a scenario (what `shikigami run <id>` and
/// other unattended runs execute).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishedState {
    pub version: u32,
    pub name: String,
    /// Revision the version was taken from.
    pub revision: u64,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub published_at: OffsetDateTime,
    pub published_by: Actor,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// Whether the current (working) content equals the published version.
    /// `false` means there are changes that do not run unattended yet.
    pub matches_current: bool,
}

/// Input for publishing.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishInput {
    /// Version to publish. Omitted: the current content, saved as a new
    /// version first unless one already matches it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// Name of the version created for the current content (default `v<n>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub note: String,
    /// With `version` omitted: fail with REVISION_CONFLICT unless the
    /// current revision is this one (what the person reviewed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

/// File format for moving a scenario (and its versions) between workspaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioBundle {
    /// Always `shikigami.scenarioBundle`.
    pub format: String,
    pub format_version: u32,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub exported_at: OffsetDateTime,
    #[serde(deserialize_with = "crate::migrate::deserialize")]
    pub scenario: Scenario,
    #[serde(default)]
    pub versions: Vec<ScenarioVersion>,
    /// Every scenario `scenario` calls (directly or through others), without
    /// versions, so the bundle runs on its own.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "crate::migrate::deserialize_vec"
    )]
    pub subscenarios: Vec<Scenario>,
}

/// What to do when an imported scenario's ID already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ImportConflict {
    /// Apply the imported content to the existing scenario (one undoable
    /// edit) and add the bundle's versions that are not there yet.
    Update,
    /// Import as a new scenario with a new ID.
    Copy,
}

/// What importing a bundle did with one of its sub-scenarios.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SubscenarioImport {
    /// It was not in the workspace and was added with the same ID.
    Created,
    /// It existed and was updated (`onConflict: "update"`).
    Updated,
    /// It existed and was left as it is.
    Kept,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ImportMode {
    Created,
    Updated,
    Copied,
}

/// Which side of a comparison: a version number, or the current content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffSide {
    /// Version number; absent for the current content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    pub label: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DiffKind {
    Added,
    Removed,
    Changed,
    Moved,
}

/// One changed field: `name`, `params.url`, `settings`, …
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VariableChange {
    pub kind: DiffKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<FieldChange>,
}

/// Where a step sits: top level (`parentId` absent) or a parent's block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepLocation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<StepId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    pub index: usize,
}

/// One step-level difference. Added and removed subtrees are reported once,
/// at their top step (`stepCount` includes the children).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepChange {
    pub kind: DiffKind,
    pub step_id: StepId,
    #[serde(rename = "type")]
    pub step_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// Changed fields (`changed` only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<FieldChange>,
    /// Location in the older content (`removed`, `moved`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<StepLocation>,
    /// Location in the newer content (`added`, `moved`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<StepLocation>,
    /// Steps in the subtree (`added`, `removed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_count: Option<usize>,
}

/// Differences from `from` to `to`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioDiff {
    pub from: DiffSide,
    pub to: DiffSide,
    /// True when the contents are the same (names, variables, steps, settings).
    pub identical: bool,
    /// Scenario-level fields: name, description, tags, settings.
    pub scenario: Vec<FieldChange>,
    pub variables: Vec<VariableChange>,
    pub steps: Vec<StepChange>,
}

/// Compares the parts of two scenarios that versions track.
pub fn same_content(a: &Scenario, b: &Scenario) -> bool {
    a.name == b.name
        && a.description == b.description
        && a.metadata.tags == b.metadata.tags
        && a.requires == b.requires
        && a.settings == b.settings
        && a.variables == b.variables
        && a.steps == b.steps
}

/// Edit ops that turn `current` into `target`'s content. Empty when the
/// contents already match.
pub fn ops_to_match(current: &Scenario, target: &Scenario) -> Vec<EditOp> {
    let mut ops = Vec::new();
    let mut patch = ScenarioPatch::default();
    if current.name != target.name {
        patch.name = Some(target.name.clone());
    }
    if current.description != target.description {
        patch.description = Some(target.description.clone());
    }
    if current.settings != target.settings {
        patch.settings = Some(target.settings.clone());
    }
    if current.metadata.tags != target.metadata.tags {
        patch.tags = Some(target.metadata.tags.clone());
    }
    if current.requires != target.requires {
        patch.requires = Some(target.requires.clone());
    }
    if patch != ScenarioPatch::default() {
        ops.push(EditOp::UpdateScenario { patch });
    }
    if current.variables != target.variables {
        ops.extend(current.variables.iter().map(|v| EditOp::RemoveVariable {
            name: v.name.clone(),
        }));
        ops.extend(
            target
                .variables
                .iter()
                .enumerate()
                .map(|(i, v)| EditOp::SetVariable {
                    variable: v.clone(),
                    index: Some(i),
                }),
        );
    }
    if current.steps != target.steps {
        ops.push(EditOp::ReplaceSteps {
            steps: target.steps.clone(),
        });
    }
    ops
}

/// Removes values that must not leave this PC: defaults of secret variables.
pub fn strip_secrets(scenario: &mut Scenario) {
    for var in scenario.variables.iter_mut().filter(|v| v.secret) {
        var.default = None;
    }
}

// -- diff ----------------------------------------------------------------

pub fn diff(from: (&Scenario, DiffSide), to: (&Scenario, DiffSide)) -> ScenarioDiff {
    let (a, from_side) = from;
    let (b, to_side) = to;
    let mut scenario = Vec::new();
    push_field(&mut scenario, "name", &a.name, &b.name);
    push_field(&mut scenario, "description", &a.description, &b.description);
    push_field(&mut scenario, "tags", &a.metadata.tags, &b.metadata.tags);
    push_field(&mut scenario, "settings", &a.settings, &b.settings);
    let variables = diff_variables(&a.variables, &b.variables);
    let steps = diff_steps(a, b);
    ScenarioDiff {
        identical: scenario.is_empty() && variables.is_empty() && steps.is_empty(),
        from: from_side,
        to: to_side,
        scenario,
        variables,
        steps,
    }
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn push_field<T: Serialize + PartialEq>(out: &mut Vec<FieldChange>, field: &str, a: &T, b: &T) {
    if a != b {
        out.push(FieldChange {
            field: field.to_owned(),
            before: Some(to_value(a)),
            after: Some(to_value(b)),
        });
    }
}

fn diff_variables(a: &[VariableDef], b: &[VariableDef]) -> Vec<VariableChange> {
    let mut out = Vec::new();
    for old in a {
        match b.iter().find(|v| v.name == old.name) {
            None => out.push(VariableChange {
                kind: DiffKind::Removed,
                name: old.name.clone(),
                fields: Vec::new(),
            }),
            Some(new) if new != old => out.push(VariableChange {
                kind: DiffKind::Changed,
                name: old.name.clone(),
                fields: object_fields("", &to_value(old), &to_value(new)),
            }),
            Some(_) => {}
        }
    }
    for new in b.iter().filter(|n| !a.iter().any(|o| o.name == n.name)) {
        out.push(VariableChange {
            kind: DiffKind::Added,
            name: new.name.clone(),
            fields: Vec::new(),
        });
    }
    out
}

/// Field-by-field comparison of two JSON objects (one level deep).
fn object_fields(prefix: &str, a: &Value, b: &Value) -> Vec<FieldChange> {
    let empty = Map::new();
    let a = a.as_object().unwrap_or(&empty);
    let b = b.as_object().unwrap_or(&empty);
    let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter(|k| a.get(*k) != b.get(*k))
        .map(|k| FieldChange {
            field: format!("{prefix}{k}"),
            before: a.get(k).cloned(),
            after: b.get(k).cloned(),
        })
        .collect()
}

struct Placed<'a> {
    step: &'a Step,
    location: StepLocation,
}

/// Container key: (parent ID, block name); top level is (None, None).
type Container = (Option<StepId>, Option<String>);

fn index_steps(
    scenario: &Scenario,
) -> (
    HashMap<StepId, Placed<'_>>,
    BTreeMap<Container, Vec<StepId>>,
) {
    let mut placed = HashMap::new();
    let mut containers = BTreeMap::new();
    fn visit<'a>(
        steps: &'a [Step],
        container: Container,
        placed: &mut HashMap<StepId, Placed<'a>>,
        containers: &mut BTreeMap<Container, Vec<StepId>>,
    ) {
        containers.insert(
            container.clone(),
            steps.iter().map(|s| s.id.clone()).collect(),
        );
        for (index, step) in steps.iter().enumerate() {
            placed.insert(
                step.id.clone(),
                Placed {
                    step,
                    location: StepLocation {
                        parent_id: container.0.clone(),
                        block: container.1.clone(),
                        index,
                    },
                },
            );
            for (block, children) in &step.blocks {
                visit(
                    children,
                    (Some(step.id.clone()), Some(block.clone())),
                    placed,
                    containers,
                );
            }
        }
    }
    visit(&scenario.steps, (None, None), &mut placed, &mut containers);
    (placed, containers)
}

fn diff_steps(a: &Scenario, b: &Scenario) -> Vec<StepChange> {
    let (old, old_containers) = index_steps(a);
    let (new, new_containers) = index_steps(b);
    let mut out = Vec::new();

    // Removed: only the top of each removed subtree.
    for step in a.walk() {
        if new.contains_key(&step.id) {
            continue;
        }
        let loc = &old[&step.id].location;
        let parent_removed = loc.parent_id.as_ref().is_some_and(|p| !new.contains_key(p));
        if !parent_removed {
            out.push(StepChange {
                kind: DiffKind::Removed,
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                name: step.name.clone(),
                fields: Vec::new(),
                from: Some(loc.clone()),
                to: None,
                step_count: Some(step.walk().count()),
            });
        }
    }

    // Steps that stay in the same container but change their order relative
    // to the other surviving siblings (longest common subsequence keeps the rest).
    let mut reordered: Vec<StepId> = Vec::new();
    for (container, new_ids) in &new_containers {
        let Some(old_ids) = old_containers.get(container) else {
            continue;
        };
        let old_kept: Vec<&StepId> = old_ids.iter().filter(|id| new_ids.contains(id)).collect();
        let new_kept: Vec<&StepId> = new_ids.iter().filter(|id| old_ids.contains(id)).collect();
        let stable = lcs(&old_kept, &new_kept);
        reordered.extend(
            new_kept
                .into_iter()
                .filter(|id| !stable.contains(id))
                .cloned(),
        );
    }

    for step in b.walk() {
        let loc = &new[&step.id].location;
        let Some(before) = old.get(&step.id) else {
            let parent_added = loc.parent_id.as_ref().is_some_and(|p| !old.contains_key(p));
            if !parent_added {
                out.push(StepChange {
                    kind: DiffKind::Added,
                    step_id: step.id.clone(),
                    step_type: step.step_type.clone(),
                    name: step.name.clone(),
                    fields: Vec::new(),
                    from: None,
                    to: Some(loc.clone()),
                    step_count: Some(step.walk().count()),
                });
            }
            continue;
        };
        let fields = step_fields(before.step, step);
        if !fields.is_empty() {
            out.push(StepChange {
                kind: DiffKind::Changed,
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                name: step.name.clone(),
                fields,
                from: None,
                to: None,
                step_count: None,
            });
        }
        let container_changed =
            before.location.parent_id != loc.parent_id || before.location.block != loc.block;
        if container_changed || reordered.contains(&step.id) {
            out.push(StepChange {
                kind: DiffKind::Moved,
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                name: step.name.clone(),
                fields: Vec::new(),
                from: Some(before.location.clone()),
                to: Some(loc.clone()),
                step_count: None,
            });
        }
    }
    out
}

/// Own fields of a step (children are compared separately).
fn step_fields(a: &Step, b: &Step) -> Vec<FieldChange> {
    let own = |s: &Step| {
        let mut v = to_value(s);
        if let Some(obj) = v.as_object_mut() {
            obj.remove("blocks");
            obj.remove("id");
            if let Some(Value::Object(params)) = obj.remove("params") {
                for (k, p) in params {
                    obj.insert(format!("params.{k}"), p);
                }
            }
        }
        v
    };
    object_fields("", &own(a), &own(b))
}

fn lcs<'a>(a: &[&'a StepId], b: &[&'a StepId]) -> Vec<&'a StepId> {
    let (n, m) = (a.len(), b.len());
    let mut table = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i][j] = if a[i] == b[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(a[i]);
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

/// Bundle detection: true when `value` looks like a bundle (vs. a bare scenario).
pub fn is_bundle(value: &Value) -> bool {
    value.get("format").and_then(Value::as_str) == Some(BUNDLE_FORMAT)
}

/// Builds the label shown for a diff side.
pub fn side(version: Option<&ScenarioVersion>, current: &Scenario) -> DiffSide {
    match version {
        Some(v) => DiffSide {
            version: Some(v.number),
            label: format!("v{} {}", v.number, v.name),
            revision: v.revision,
        },
        None => DiffSide {
            version: None,
            label: "current".into(),
            revision: current.revision,
        },
    }
}
