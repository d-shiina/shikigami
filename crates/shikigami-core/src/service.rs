//! `FlowService`: the single API through which every client reads and
//! changes flows. Studio (Tauri commands), the MCP server and the CLI are
//! thin adapters over this type; none of them manipulate documents directly.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::call::{self, Subflow};
use crate::distribution;
use crate::error::{CoreError, CoreResult};
use crate::ids::{FlowId, ObservationId, StepId};
use crate::model::{Flow, FlowSummary, Step, VariableDef, now};
use crate::ops::{self, EditOp, FlowPatch};
use crate::package;
use crate::project::{self, BundledFile, ProjectFile, ProjectFiles};
use crate::registry::{RiskLevel, StepRegistry};
use crate::review::{
    self, Evidence, EvidenceDetail, NewObservation, NewReview, Observation, ObservationContent,
    ObservationLink, ReviewTimeline, ReviewVerdict, TestRun,
};
use crate::store::{Actor, ActorKind, ChangeKind, FileStore, HistoryEntry, UNDO_LIMIT, UndoState};
use crate::validate::{ValidationReport, Validator};
use crate::version::{
    self, BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, FlowBundle, FlowDiff, FlowVersion, ImportConflict,
    ImportMode, NewVersion, PublishInput, PublishRecord, PublishedState, SubflowImport,
    VersionSummary,
};

/// Input for creating a flow.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewFlow {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub variables: Vec<VariableDef>,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// What the author of a change says about it (MCP edit tools).
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeNote {
    /// Why the change was made, in the author's words. Kept in the journal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Things the author wants a person to decide or confirm before the change
    /// is approved (assumptions, guesses), one question each. Kept in the journal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    /// Observations (screens looked at with inspect_* / test_step) the change
    /// is based on. They are linked to the new revision and its steps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<ObservationId>,
}

impl ChangeNote {
    /// The parts of the note the journal keeps, trimmed and cut to size.
    fn remarks(&self) -> Remarks {
        Remarks {
            summary: review::clean_text(self.summary.clone(), review::MAX_SUMMARY_CHARS),
            checks: review::clean_checks(&self.checks),
        }
    }
}

/// What a journal entry keeps from its author's note.
#[derive(Debug, Clone, Default)]
struct Remarks {
    summary: Option<String>,
    checks: Vec<String>,
}

/// Result of a committed change.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    #[serde(alias = "scenario")]
    pub flow: Flow,
    /// Full validation of the new revision. Drafts may contain errors;
    /// they must be fixed before the flow can run.
    pub validation: ValidationReport,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// Notification sent to in-process listeners after every committed change.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    #[serde(alias = "scenarioId")]
    pub flow_id: FlowId,
    pub kind: ChangeKind,
    pub revision: u64,
    pub actor: Actor,
}

/// One sub-flow of an imported bundle.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSubflow {
    pub id: FlowId,
    pub name: String,
    pub mode: SubflowImport,
}

/// Result of importing a bundle or flow file.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub mode: ImportMode,
    /// Versions from the bundle that were added (already present ones are skipped).
    pub versions_added: usize,
    /// The bundle's sub-flows and what happened to each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[serde(alias = "subscenarios")]
    pub subflows: Vec<ImportedSubflow>,
    #[serde(flatten)]
    pub outcome: EditOutcome,
}

/// What an unattended run executes (see [`FlowService::published_run`]).
#[derive(Debug, Clone)]
pub struct PublishedRun {
    pub flow: Flow,
    pub version: u32,
    pub subflows: Vec<Subflow>,
}

/// Result of moving steps into a new sub-flow.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtractOutcome {
    /// The new flow holding the steps.
    #[serde(alias = "subscenario")]
    pub subflow: EditOutcome,
    /// The calling flow, with the steps replaced by one `flow.call`.
    pub caller: EditOutcome,
    /// ID of the new `flow.call` step.
    pub call_step_id: StepId,
}

type Listener = Arc<dyn Fn(&ChangeEvent) + Send + Sync>;

pub struct FlowService {
    store: FileStore,
    validator: Validator,
    listeners: Mutex<Vec<Listener>>,
}

impl FlowService {
    pub fn new(store: FileStore, registry: StepRegistry) -> Self {
        Self {
            store,
            validator: Validator::new(registry),
            listeners: Mutex::new(Vec::new()),
        }
    }

    pub fn store(&self) -> &FileStore {
        &self.store
    }

    pub fn registry(&self) -> &StepRegistry {
        self.validator.registry()
    }

    /// Registers a listener for changes made through *this* service instance.
    /// Changes by other processes are observed by watching
    /// [`FileStore::flows_dir`].
    pub fn subscribe(&self, listener: impl Fn(&ChangeEvent) + Send + Sync + 'static) {
        if let Ok(mut listeners) = self.listeners.lock() {
            listeners.push(Arc::new(listener));
        }
    }

    fn notify(&self, event: ChangeEvent) {
        let listeners = match self.listeners.lock() {
            Ok(l) => l.clone(),
            Err(_) => return,
        };
        for listener in listeners {
            listener(&event);
        }
    }

    // -- queries ----------------------------------------------------------

    pub fn list(&self) -> CoreResult<Vec<FlowSummary>> {
        Ok(self.store.load_all()?.iter().map(Flow::summary).collect())
    }

    pub fn get(&self, id: &FlowId) -> CoreResult<Flow> {
        self.store.load(id)
    }

    /// Full validation, including the flows it calls.
    pub fn validate(&self, flow: &Flow) -> ValidationReport {
        self.validator
            .validate_with_calls(flow, &|id| self.store.load(id).ok())
    }

    /// [`Self::validate`] for a document from a bundle: its sub-flows
    /// are looked up in `bundled` before the workspace.
    pub fn validate_bundled(&self, flow: &Flow, bundled: &[Flow]) -> ValidationReport {
        self.validator.validate_with_calls(flow, &|id| {
            bundled
                .iter()
                .find(|s| &s.id == id)
                .cloned()
                .or_else(|| self.store.load(id).ok())
        })
    }

    /// Every flow `flow` calls, directly or through others (each
    /// once, missing ones left out), with the version each one matches.
    /// Pass them to the Runtime with the run.
    pub fn subflows(&self, flow: &Flow) -> CoreResult<Vec<Subflow>> {
        self.subflows_bundled(flow, &[])
    }

    /// Like [`Self::subflows`] for a bundle: its own sub-flows win
    /// over the workspace's, the same lookup [`Self::validate_bundled`] uses.
    pub fn subflows_bundled(&self, flow: &Flow, bundled: &[Flow]) -> CoreResult<Vec<Subflow>> {
        Ok(self
            .called_flows(flow, bundled)
            .into_iter()
            .map(|s| {
                let version = self.matching_version(&s).ok().flatten();
                // A bundle's own sub-flows have no folder here.
                let project_dir =
                    (!bundled.iter().any(|b| b.id == s.id)).then(|| self.store.project_dir(&s.id));
                Subflow {
                    flow: s,
                    version,
                    project_dir,
                }
            })
            .collect())
    }

    fn called_flows(&self, flow: &Flow, bundled: &[Flow]) -> Vec<Flow> {
        let mut found: Vec<Flow> = Vec::new();
        let mut queue: Vec<FlowId> = call::called_ids(flow).into_iter().collect();
        while let Some(id) = queue.pop() {
            if id == flow.id || found.iter().any(|s| s.id == id) {
                continue;
            }
            let next = match bundled.iter().find(|s| s.id == id) {
                Some(s) => Some(s.clone()),
                None => self.store.load(&id).ok(),
            };
            if let Some(next) = next {
                queue.extend(call::called_ids(&next));
                found.push(next);
            }
        }
        found.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));
        found
    }

    /// The riskiest step `flows` contain (unknown step types count as
    /// dangerous) and the step types at that level, for the policy's
    /// per-risk rules. Control flow and calls themselves are safe.
    pub fn risk_of<'a>(
        &self,
        flows: impl IntoIterator<Item = &'a Flow>,
    ) -> (RiskLevel, Vec<String>) {
        let mut level = RiskLevel::Safe;
        let mut types: Vec<String> = Vec::new();
        for flow in flows {
            // A call is as risky as what it calls, which is counted itself.
            for step in flow
                .walk()
                .filter(|s| s.step_type != crate::registry::flow::CALL)
            {
                let risk = self
                    .registry()
                    .get(&step.step_type)
                    .map_or(RiskLevel::Dangerous, |d| d.risk);
                if risk > level {
                    level = risk;
                    types.clear();
                }
                if risk == level && risk > RiskLevel::Safe && !types.contains(&step.step_type) {
                    types.push(step.step_type.clone());
                }
            }
        }
        (level, types)
    }

    /// Flows that call `id` directly.    /// Flows that call `id` directly.
    pub fn callers(&self, id: &FlowId) -> CoreResult<Vec<FlowSummary>> {
        Ok(self
            .store
            .load_all()?
            .iter()
            .filter(|s| &s.id != id && call::called_ids(s).contains(id))
            .map(Flow::summary)
            .collect())
    }

    pub fn validate_stored(&self, id: &FlowId) -> CoreResult<ValidationReport> {
        Ok(self.validate(&self.get(id)?))
    }

    pub fn history(&self, id: &FlowId, limit: usize) -> CoreResult<Vec<HistoryEntry>> {
        self.store.read_journal(id, limit)
    }

    /// Loads a flow and fails with `VALIDATION_FAILED` unless it is runnable.
    pub fn get_runnable(&self, id: &FlowId) -> CoreResult<Flow> {
        let flow = self.get(id)?;
        let report = self.validate(&flow);
        if report.valid {
            Ok(flow)
        } else {
            Err(CoreError::ValidationFailed(report))
        }
    }

    // -- lifecycle --------------------------------------------------------

    pub fn create(&self, input: NewFlow, actor: Actor) -> CoreResult<EditOutcome> {
        self.create_noted(input, actor, ChangeNote::default())
    }

    /// [`Self::create`] with the author's summary and observations.
    pub fn create_noted(
        &self,
        input: NewFlow,
        actor: Actor,
        note: ChangeNote,
    ) -> CoreResult<EditOutcome> {
        self.check_observations(&note.observations)?;
        let mut flow = Flow::new(input.name);
        flow.description = input.description;
        flow.variables = input.variables;
        flow.steps = input.steps;
        flow.metadata.tags = input.tags;
        let outcome = self.insert_new(flow, actor.clone(), "create flow", note.remarks())?;
        let steps: Vec<_> = outcome.flow.walk().map(|s| s.id.clone()).collect();
        self.link_observations(&outcome.flow, &steps, &actor, &note.observations);
        Ok(outcome)
    }

    /// Imports a complete document (e.g. from a file). Keeps its ID unless it
    /// is missing or already taken.
    pub fn import(&self, mut flow: Flow, actor: Actor) -> CoreResult<EditOutcome> {
        if flow.id.is_empty() || self.store.exists(&flow.id) {
            flow.id = FlowId::generate();
        }
        flow.revision = 0;
        let now = now();
        flow.metadata.created_at.get_or_insert(now);
        flow.metadata.updated_at = Some(now);
        self.insert_new(flow, actor, "import flow", Remarks::default())
    }

    /// Takes in an answer an AI wrote in a chat window without MCP (see
    /// [`crate::chat`]), pasted by a person: a new flow, or, with `into`,
    /// the new content of that flow as one undoable edit. The AI's summary
    /// and checks go to the journal, so the review desk shows the change
    /// like an MCP edit. Step IDs the AI made up are replaced.
    pub fn apply_answer(
        &self,
        answer: crate::chat::ChatAnswer,
        into: Option<&FlowId>,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        let note = ChangeNote {
            summary: answer.summary,
            checks: answer.checks,
            observations: Vec::new(),
        };
        let mut flow = answer.flow;
        let mut seen = std::collections::HashSet::new();
        fn fix_ids(steps: &mut [Step], seen: &mut std::collections::HashSet<StepId>) {
            for step in steps {
                if !step.id.is_well_formed() || !seen.insert(step.id.clone()) {
                    step.id = StepId::generate();
                    seen.insert(step.id.clone());
                }
                for block in step.blocks.values_mut() {
                    fix_ids(block, seen);
                }
            }
        }
        fix_ids(&mut flow.steps, &mut seen);
        match into {
            Some(id) => {
                let current = self.get(id)?;
                flow.id = current.id.clone();
                if flow.name.trim().is_empty() {
                    flow.name = current.name.clone();
                }
                // What the AI does not see stays as it is.
                flow.metadata = current.metadata.clone();
                flow.requires = current.requires.clone();
                crate::requires::sync(&mut flow, self.registry());
                let label = "paste AI answer".to_owned();
                self.match_content(id, &flow, expected_revision, actor, label, note.remarks())
            }
            None => {
                flow.id = FlowId::generate();
                if flow.name.trim().is_empty() {
                    flow.name = "AI が作成したフロー".into();
                }
                flow.revision = 0;
                let now = now();
                flow.metadata = crate::model::Metadata {
                    created_at: Some(now),
                    updated_at: Some(now),
                    ..crate::model::Metadata::default()
                };
                self.insert_new(flow, actor, "paste AI answer", note.remarks())
            }
        }
    }

    pub fn duplicate(
        &self,
        id: &FlowId,
        name: Option<String>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        let source = self.get(id)?;
        let mut copy = Flow::new(name.unwrap_or_else(|| format!("{} のコピー", source.name)));
        copy.description = source.description;
        copy.variables = source.variables;
        copy.steps = source.steps;
        copy.settings = source.settings;
        copy.requires = source.requires;
        copy.metadata.tags = source.metadata.tags;
        let outcome = self.insert_new(copy, actor, "duplicate flow", Remarks::default())?;
        // The copy brings the files it works with, not what runs made.
        let files = self.bundled_files(id)?;
        self.write_bundled_files(id, &outcome.flow.id, &files)?;
        Ok(outcome)
    }

    fn insert_new(
        &self,
        mut flow: Flow,
        actor: Actor,
        label: &str,
        remarks: Remarks,
    ) -> CoreResult<EditOutcome> {
        if !flow.id.is_well_formed() {
            return Err(CoreError::InvalidFlowId(flow.id.to_string()));
        }
        if flow.name.trim().is_empty() {
            return Err(CoreError::InvalidEdit("flow name must not be empty".into()));
        }
        flow.steps.iter_mut().for_each(ops::assign_missing_ids);
        self.reject_structural_errors(&flow)?;
        crate::requires::sync(&mut flow, self.registry());
        flow.revision = 1;

        let _lock = self.store.lock()?;
        if self.store.exists(&flow.id) {
            return Err(CoreError::FlowAlreadyExists(flow.id));
        }
        self.store.save(&flow)?;
        self.store.remove_undo(&flow.id)?;
        let entry = HistoryEntry {
            kind: ChangeKind::Create,
            revision: flow.revision,
            actor: actor.clone(),
            at: now(),
            label: label.to_owned(),
            summary: remarks.summary,
            checks: remarks.checks,
            step_ids: Vec::new(),
            ops: Vec::new(),
            inverse: Vec::new(),
        };
        self.store.append_journal(&flow.id, &entry)?;
        drop(_lock);

        self.notify(ChangeEvent {
            flow_id: flow.id.clone(),
            kind: ChangeKind::Create,
            revision: flow.revision,
            actor,
        });
        let validation = self.validate(&flow);
        Ok(EditOutcome {
            flow,
            validation,
            can_undo: false,
            can_redo: false,
        })
    }

    /// Moves the flow to the workspace trash (recoverable).
    pub fn delete(
        &self,
        id: &FlowId,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<()> {
        let callers = self.callers(id)?;
        if !callers.is_empty() {
            return Err(CoreError::FlowInUse {
                flow_id: id.clone(),
                callers: callers.into_iter().map(|c| (c.id, c.name)).collect(),
            });
        }
        let _lock = self.store.lock()?;
        let current = self.store.load(id)?;
        check_revision(expected_revision, current.revision)?;
        self.store.trash(id)?;
        self.store.remove_undo(id)?;
        // A flow in the trash no longer runs unattended.
        if self.published_entry(id).ok().flatten().is_some() {
            self.store.append_publish(
                id,
                &PublishRecord {
                    version: None,
                    uid: None,
                    at: now(),
                    by: actor.clone(),
                    note: "deleted".into(),
                },
            )?;
        }
        let entry = HistoryEntry {
            kind: ChangeKind::Delete,
            revision: current.revision,
            actor: actor.clone(),
            at: now(),
            label: "delete flow".into(),
            summary: None,
            checks: Vec::new(),
            step_ids: Vec::new(),
            ops: Vec::new(),
            inverse: Vec::new(),
        };
        self.store.append_journal(id, &entry)?;
        drop(_lock);
        self.notify(ChangeEvent {
            flow_id: id.clone(),
            kind: ChangeKind::Delete,
            revision: current.revision,
            actor,
        });
        Ok(())
    }

    // -- editing ----------------------------------------------------------

    /// Applies a batch of edits atomically.
    ///
    /// `expected_revision` enables optimistic concurrency: when given and the
    /// stored revision differs, nothing is applied and `REVISION_CONFLICT` is
    /// returned so the client can reload and retry.
    pub fn edit(
        &self,
        id: &FlowId,
        expected_revision: Option<u64>,
        ops: Vec<EditOp>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        self.edit_noted(id, expected_revision, ops, actor, ChangeNote::default())
    }

    /// [`Self::edit`] with the author's summary and the observations the
    /// change is based on (linked to the new revision and touched steps).
    pub fn edit_noted(
        &self,
        id: &FlowId,
        expected_revision: Option<u64>,
        ops: Vec<EditOp>,
        actor: Actor,
        note: ChangeNote,
    ) -> CoreResult<EditOutcome> {
        self.check_observations(&note.observations)?;
        if ops.is_empty() {
            return Err(CoreError::InvalidEdit("no operations given".into()));
        }
        let label = if ops.len() == 1 {
            ops[0].label()
        } else {
            format!("{} edits", ops.len())
        };
        let mut step_ids = Vec::new();
        let outcome = self.commit(
            id,
            expected_revision,
            actor.clone(),
            ChangeKind::Edit,
            note.remarks(),
            |_, current| {
                let (next, inverse) = ops::apply_all(current, ops.clone())?;
                step_ids = review::touched_steps(&inverse);
                Ok(Commit {
                    next,
                    applied: ops,
                    inverse,
                    label,
                })
            },
        )?;
        self.link_observations(&outcome.flow, &step_ids, &actor, &note.observations);
        Ok(outcome)
    }

    pub fn undo(
        &self,
        id: &FlowId,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        self.commit(
            id,
            expected_revision,
            actor,
            ChangeKind::Undo,
            Remarks::default(),
            |undo, current| {
                let entry = undo.undo.pop().ok_or(CoreError::NothingTo("undo"))?;
                let (next, redo_ops) = ops::apply_all(current, entry.inverse.clone())?;
                Ok(Commit {
                    next,
                    applied: entry.inverse,
                    inverse: redo_ops,
                    label: format!("undo: {}", entry.label),
                })
            },
        )
    }

    pub fn redo(
        &self,
        id: &FlowId,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        self.commit(
            id,
            expected_revision,
            actor,
            ChangeKind::Redo,
            Remarks::default(),
            |undo, current| {
                let entry = undo.redo.pop().ok_or(CoreError::NothingTo("redo"))?;
                let (next, undo_ops) = ops::apply_all(current, entry.inverse.clone())?;
                Ok(Commit {
                    next,
                    applied: entry.inverse,
                    inverse: undo_ops,
                    label: entry
                        .label
                        .strip_prefix("undo: ")
                        .unwrap_or(&entry.label)
                        .to_owned(),
                })
            },
        )
    }

    pub fn undo_state(&self, id: &FlowId) -> CoreResult<(bool, bool)> {
        let flow = self.get(id)?;
        let state = self.store.load_undo(id)?;
        if state.head_revision != flow.revision {
            return Ok((false, false));
        }
        Ok((!state.undo.is_empty(), !state.redo.is_empty()))
    }

    // -- versions ---------------------------------------------------------

    /// Saves the current content as a new named version.
    pub fn create_version(
        &self,
        id: &FlowId,
        input: NewVersion,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<VersionSummary> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(CoreError::InvalidEdit(
                "version name must not be empty".into(),
            ));
        }
        let _lock = self.store.lock()?;
        let current = self.store.load(id)?;
        check_revision(expected_revision, current.revision)?;
        let number = self.next_version_number(id)?;
        let mut flow = current;
        flow.schema_ref = None;
        let version = FlowVersion {
            number,
            uid: uuid::Uuid::now_v7().simple().to_string(),
            name: name.to_owned(),
            note: input.note.trim().to_owned(),
            created_at: now(),
            created_by: actor,
            revision: flow.revision,
            flow,
        };
        self.store.save_version(&version)?;
        Ok(version.summary())
    }

    /// Versions of a flow, newest first.
    pub fn list_versions(&self, id: &FlowId) -> CoreResult<Vec<VersionSummary>> {
        let mut versions: Vec<_> = self
            .store
            .load_versions(id)?
            .iter()
            .map(FlowVersion::summary)
            .collect();
        versions.reverse();
        Ok(versions)
    }

    pub fn get_version(&self, id: &FlowId, number: u32) -> CoreResult<FlowVersion> {
        self.store.load_version(id, number)
    }

    /// Number of the newest version, if any.
    pub fn latest_version(&self, id: &FlowId) -> CoreResult<Option<u32>> {
        Ok(self.store.load_versions(id)?.last().map(|v| v.number))
    }

    /// Newest version whose content equals `flow` (e.g. to label a run).
    pub fn matching_version(&self, flow: &Flow) -> CoreResult<Option<u32>> {
        Ok(self
            .store
            .load_versions(&flow.id)?
            .iter()
            .rev()
            .find(|v| version::same_content(&v.flow, flow))
            .map(|v| v.number))
    }

    /// Differences from version `from` to version `to`; `None` means the
    /// current content.
    pub fn diff_versions(
        &self,
        id: &FlowId,
        from: Option<u32>,
        to: Option<u32>,
    ) -> CoreResult<FlowDiff> {
        let current = self.get(id)?;
        let load = |n: Option<u32>| n.map(|n| self.get_version(id, n)).transpose();
        let (from_v, to_v) = (load(from)?, load(to)?);
        let from_s = from_v.as_ref().map_or(&current, |v| &v.flow);
        let to_s = to_v.as_ref().map_or(&current, |v| &v.flow);
        Ok(version::diff(
            (from_s, version::side(from_v.as_ref(), &current)),
            (to_s, version::side(to_v.as_ref(), &current)),
        ))
    }

    /// Makes the current content equal to a version, as one undoable edit.
    /// Does nothing (and returns the current state) when it already matches.
    pub fn restore_version(
        &self,
        id: &FlowId,
        number: u32,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        let target = self.get_version(id, number)?;
        let label = format!("restore version {number} ({})", target.name);
        self.match_content(
            id,
            &target.flow,
            expected_revision,
            actor,
            label,
            Remarks::default(),
        )
    }

    fn match_content(
        &self,
        id: &FlowId,
        target: &Flow,
        expected_revision: Option<u64>,
        actor: Actor,
        label: String,
        remarks: Remarks,
    ) -> CoreResult<EditOutcome> {
        let current = self.get(id)?;
        check_revision(expected_revision, current.revision)?;
        let ops = version::ops_to_match(&current, target);
        if ops.is_empty() {
            return self.current_outcome(current);
        }
        self.commit(
            id,
            expected_revision.or(Some(current.revision)),
            actor,
            ChangeKind::Edit,
            remarks,
            |_, current| {
                let (next, inverse) = ops::apply_all(current, ops.clone())?;
                Ok(Commit {
                    next,
                    applied: ops,
                    inverse,
                    label,
                })
            },
        )
    }

    fn current_outcome(&self, flow: Flow) -> CoreResult<EditOutcome> {
        let (can_undo, can_redo) = self.undo_state(&flow.id)?;
        let validation = self.validate(&flow);
        Ok(EditOutcome {
            flow,
            validation,
            can_undo,
            can_redo,
        })
    }

    fn next_version_number(&self, id: &FlowId) -> CoreResult<u32> {
        Ok(self
            .store
            .load_versions(id)?
            .last()
            .map_or(1, |v| v.number + 1))
    }

    // -- publishing -------------------------------------------------------

    /// The version unattended runs execute, if one is published.
    pub fn published(&self, id: &FlowId) -> CoreResult<Option<PublishedState>> {
        let Some((record, version)) = self.published_entry(id)? else {
            return Ok(None);
        };
        let matches_current = self
            .store
            .load(id)
            .is_ok_and(|current| version::same_content(&version.flow, &current));
        Ok(Some(PublishedState {
            version: version.number,
            name: version.name,
            revision: version.revision,
            published_at: record.at,
            published_by: record.by,
            note: record.note,
            matches_current,
        }))
    }

    /// Snapshot of the published version.
    pub fn published_version(&self, id: &FlowId) -> CoreResult<Option<FlowVersion>> {
        Ok(self.published_entry(id)?.map(|(_, v)| v))
    }

    fn published_entry(&self, id: &FlowId) -> CoreResult<Option<(PublishRecord, FlowVersion)>> {
        let Some(record) = self.store.read_publish_log(id)?.pop() else {
            return Ok(None);
        };
        let Some(number) = record.version else {
            return Ok(None);
        };
        match self.store.load_version(id, number) {
            Ok(v) if record.uid.as_ref().is_none_or(|uid| *uid == v.uid) => Ok(Some((record, v))),
            Ok(_) | Err(CoreError::VersionNotFound { .. }) => {
                tracing::warn!(flow = %id, number, "published version is missing");
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    /// Makes a version the one unattended runs execute. Only people publish
    /// (Studio, the CLI): an AI client gets `PUBLISH_NOT_ALLOWED`. Without
    /// `input.version` the current content is published, saved as a new
    /// version first unless one already matches it. The version must
    /// validate, and every flow it calls must be published already.
    pub fn publish(
        &self,
        id: &FlowId,
        input: PublishInput,
        actor: Actor,
    ) -> CoreResult<PublishedState> {
        ensure_person(&actor, "publish a flow")?;
        let version = match input.version {
            Some(number) => self.get_version(id, number)?,
            None => {
                let current = self.get(id)?;
                check_revision(input.expected_revision, current.revision)?;
                let existing = self
                    .store
                    .load_versions(id)?
                    .into_iter()
                    .rev()
                    .find(|v| version::same_content(&v.flow, &current));
                match existing {
                    Some(v) => v,
                    None => {
                        // Checked before a version is saved for nothing.
                        self.check_publishable(&current)?;
                        let name = input
                            .name
                            .as_deref()
                            .map(str::trim)
                            .filter(|n| !n.is_empty())
                            .map_or_else(
                                || self.next_version_number(id).map(|n| format!("v{n}")),
                                |n| Ok(n.to_owned()),
                            )?;
                        let created = self.create_version(
                            id,
                            NewVersion {
                                name,
                                note: input.note.clone(),
                            },
                            Some(current.revision),
                            actor.clone(),
                        )?;
                        self.get_version(id, created.number)?
                    }
                }
            }
        };
        self.check_publishable(&version.flow)?;
        {
            let _lock = self.store.lock()?;
            self.store.append_publish(
                id,
                &PublishRecord {
                    version: Some(version.number),
                    uid: Some(version.uid.clone()),
                    at: now(),
                    by: actor,
                    note: input.note.trim().to_owned(),
                },
            )?;
        }
        self.published(id)?.ok_or_else(|| {
            CoreError::InvalidEdit("published version could not be read back".into())
        })
    }

    /// Approves the current revision in review and publishes it, in one
    /// step (Studio's review desk). Nothing is recorded when publishing
    /// fails.
    pub fn approve_and_publish(
        &self,
        id: &FlowId,
        revision: u64,
        reason: String,
        input: PublishInput,
        actor: Actor,
    ) -> CoreResult<PublishedState> {
        ensure_person(&actor, "approve and publish a flow")?;
        let published = self.publish(
            id,
            PublishInput {
                version: None,
                expected_revision: Some(revision),
                ..input
            },
            actor.clone(),
        )?;
        self.submit_review(
            id,
            NewReview {
                revision,
                verdict: ReviewVerdict::Approved,
                reason,
                steps: Vec::new(),
            },
            actor,
        )?;
        Ok(published)
    }

    /// Stops unattended runs of a flow until a version is published
    /// again. People only, like [`Self::publish`].
    pub fn unpublish(&self, id: &FlowId, note: String, actor: Actor) -> CoreResult<()> {
        ensure_person(&actor, "withdraw a published flow")?;
        if self.published_entry(id)?.is_none() {
            return Ok(());
        }
        let _lock = self.store.lock()?;
        self.store.append_publish(
            id,
            &PublishRecord {
                version: None,
                uid: None,
                at: now(),
                by: actor,
                note: note.trim().to_owned(),
            },
        )
    }

    /// Who published what, oldest first.
    pub fn publish_log(&self, id: &FlowId) -> CoreResult<Vec<PublishRecord>> {
        self.store.read_publish_log(id)
    }

    /// What an unattended run of `id` executes: the published version and
    /// the published versions of every flow it calls. Fails with
    /// `NOT_PUBLISHED` / `SUBFLOW_NOT_PUBLISHED` rather than falling
    /// back to working content nobody approved.
    /// What an unattended run of `id` (`spellsheet run`, a schedule, a
    /// management server) executes: the published versions, once the
    /// workspace policy allows the flow and everything it calls to run
    /// unattended (`UNATTENDED_NOT_ALLOWED` otherwise).
    pub fn unattended_run(&self, id: &FlowId) -> CoreResult<PublishedRun> {
        let policy = crate::Policy::load(&crate::Policy::path(self.store.root()))?;
        let refuse = |id: &FlowId| -> CoreResult<()> {
            if policy.allows_unattended(id.as_str()) {
                return Ok(());
            }
            Err(CoreError::Rejected {
                code: "UNATTENDED_NOT_ALLOWED",
                message: format!("the workspace policy keeps {id} from running unattended"),
                hint: Some(
                    "Run it from Writer, or change \"unattended\" for it in policy.json.".into(),
                ),
            })
        };
        refuse(id)?;
        let run = self.published_run(id)?;
        for sub in &run.subflows {
            refuse(&sub.flow.id)?;
        }
        Ok(run)
    }

    pub fn published_run(&self, id: &FlowId) -> CoreResult<PublishedRun> {
        let Some(version) = self.published_version(id)? else {
            if !self.store.exists(id) {
                return Err(CoreError::FlowNotFound(id.clone()));
            }
            return Err(CoreError::Rejected {
                code: "NOT_PUBLISHED",
                message: format!("flow {id} has no published version"),
                hint: Some(
                    "Unattended runs execute the published version only. A person approves and publishes it in Writer (レビュー台 → 確認して公開) or with `spellsheet version publish <id>`; `spellsheet run <id> --draft` runs the working content instead."
                        .into(),
                ),
            });
        };
        let subflows = self.check_publishable(&version.flow)?;
        Ok(PublishedRun {
            version: version.number,
            flow: version.flow,
            subflows,
        })
    }

    /// The published versions of everything `flow` calls, once it is
    /// known to validate against them.
    fn check_publishable(&self, flow: &Flow) -> CoreResult<Vec<Subflow>> {
        let mut found: Vec<Subflow> = Vec::new();
        let mut missing: Vec<FlowId> = Vec::new();
        let mut queue: Vec<FlowId> = call::called_ids(flow).into_iter().collect();
        while let Some(next) = queue.pop() {
            if next == flow.id || missing.contains(&next) || found.iter().any(|s| s.flow.id == next)
            {
                continue;
            }
            match self.published_version(&next)? {
                Some(v) => {
                    queue.extend(call::called_ids(&v.flow));
                    found.push(Subflow {
                        project_dir: Some(self.store.project_dir(&next)),
                        flow: v.flow,
                        version: Some(v.number),
                    });
                }
                None => missing.push(next),
            }
        }
        if !missing.is_empty() {
            missing.sort_by(|a, b| a.as_str().cmp(b.as_str()));
            let list: Vec<&str> = missing.iter().map(FlowId::as_str).collect();
            return Err(CoreError::Rejected {
                code: "SUBFLOW_NOT_PUBLISHED",
                message: format!(
                    "called flow(s) have no published version: {}",
                    list.join(", ")
                ),
                hint: Some("Publish the called flows first.".into()),
            });
        }
        found.sort_by(|a, b| a.flow.id.as_str().cmp(b.flow.id.as_str()));
        let report = self.validator.validate_with_calls(flow, &|id| {
            found
                .iter()
                .find(|s| &s.flow.id == id)
                .map(|s| s.flow.clone())
        });
        if !report.valid {
            return Err(CoreError::ValidationFailed(report));
        }
        Ok(found)
    }

    // -- review evidence --------------------------------------------------

    /// Stores what an AI saw on screen (inspect_* / test_step) so a later
    /// edit can name it as its basis. Unused observations are deleted after
    /// [`review::UNLINKED_OBSERVATION_DAYS`] days.
    pub fn record_observation(
        &self,
        input: NewObservation,
        actor: Actor,
    ) -> CoreResult<Observation> {
        if let Err(e) = self
            .store
            .prune_observations(time::Duration::days(review::UNLINKED_OBSERVATION_DAYS))
        {
            tracing::warn!(error = %e, "failed to prune old observations");
        }
        let mut observation = Observation {
            id: ObservationId::generate(),
            source: input.source,
            at: now(),
            actor,
            title: review::clean_text(Some(input.title), 200).unwrap_or_default(),
            request: input.request,
            status: input.status,
            output: input.output,
            tree_file: None,
            screenshot_file: None,
            notes: Vec::new(),
            linked: Vec::new(),
        };
        let mut files = Vec::new();
        if let Some(mut tree) = input.tree {
            if review::cut_bytes(&mut tree, review::MAX_TREE_BYTES) {
                observation.notes.push(format!(
                    "UI tree cut at {} KB",
                    review::MAX_TREE_BYTES / 1024
                ));
            }
            observation.tree_file = Some("tree.txt".into());
            files.push(("tree.txt".to_owned(), tree.into_bytes()));
        }
        if let Some(bytes) = input.screenshot {
            match review::image_extension(&bytes) {
                _ if bytes.len() > review::MAX_SCREENSHOT_BYTES => observation.notes.push(format!(
                    "screenshot left out: larger than {} MB",
                    review::MAX_SCREENSHOT_BYTES / (1024 * 1024)
                )),
                Some(ext) => {
                    let name = format!("screenshot.{ext}");
                    observation.screenshot_file = Some(name.clone());
                    files.push((name, bytes));
                }
                None => observation
                    .notes
                    .push("screenshot left out: not a PNG or JPEG image".into()),
            }
        }
        self.store.save_observation(&observation, &files)?;
        Ok(observation)
    }

    /// An observation with its tree text and screenshot (as a data URL).
    pub fn get_observation(&self, id: &ObservationId) -> CoreResult<ObservationContent> {
        let observation = self.store.load_observation(id)?;
        let dir = self.store.observation_dir(id)?;
        let tree = match &observation.tree_file {
            Some(name) => {
                Some(String::from_utf8_lossy(&std::fs::read(dir.join(name))?).into_owned())
            }
            None => None,
        };
        let screenshot_data_url = match &observation.screenshot_file {
            Some(name) => {
                let mime = if name.ends_with(".png") {
                    "image/png"
                } else {
                    "image/jpeg"
                };
                let bytes = std::fs::read(dir.join(name))?;
                Some(format!("data:{mime};base64,{}", review::base64(&bytes)))
            }
            None => None,
        };
        Ok(ObservationContent {
            observation,
            tree,
            screenshot_data_url,
        })
    }

    /// Records a run an AI started to check a revision.
    pub fn record_test_run(
        &self,
        id: &FlowId,
        revision: u64,
        run: TestRun,
        actor: Actor,
    ) -> CoreResult<Evidence> {
        let evidence = Evidence {
            revision,
            at: now(),
            actor,
            detail: run.into(),
        };
        self.store.append_evidence(id, &evidence)?;
        Ok(evidence)
    }

    /// Records an AI's test case work (a saved case, or the results of the
    /// cases it ran) against `revision`.
    pub fn record_test_evidence(
        &self,
        id: &FlowId,
        revision: u64,
        detail: EvidenceDetail,
        actor: Actor,
    ) -> CoreResult<Evidence> {
        let evidence = Evidence {
            revision,
            at: now(),
            actor,
            detail,
        };
        self.store.append_evidence(id, &evidence)?;
        Ok(evidence)
    }

    /// Records a human's verdict on the current revision. Sending a flow
    /// back (`rejected`) needs a reason or at least one step note; the AI
    /// reads it with get_review / get_flow.
    pub fn submit_review(
        &self,
        id: &FlowId,
        input: NewReview,
        actor: Actor,
    ) -> CoreResult<Evidence> {
        let reason = review::clean_text(Some(input.reason), review::MAX_REVIEW_TEXT_CHARS)
            .unwrap_or_default();
        let mut steps = Vec::new();
        for mut note in input.steps {
            if let Some(text) = review::clean_text(Some(note.note), review::MAX_REVIEW_TEXT_CHARS) {
                note.note = text;
                steps.push(note);
            }
        }
        if input.verdict == ReviewVerdict::Rejected && reason.is_empty() && steps.is_empty() {
            return Err(CoreError::InvalidEdit(
                "sending a flow back needs a reason or a note on a step".into(),
            ));
        }
        let _lock = self.store.lock()?;
        let current = self.store.load(id)?;
        check_revision(Some(input.revision), current.revision)?;
        if let Some(note) = steps
            .iter()
            .find(|n| current.find_step(&n.step_id).is_none())
        {
            return Err(CoreError::StepNotFound(note.step_id.clone()));
        }
        let evidence = Evidence {
            revision: current.revision,
            at: now(),
            actor,
            detail: EvidenceDetail::Review {
                verdict: input.verdict,
                reason,
                steps,
            },
        };
        self.store.append_evidence(id, &evidence)?;
        Ok(evidence)
    }

    /// Changes and evidence after `since` (default: the last approved
    /// revision), for reviewing what an AI did.
    pub fn review_timeline(&self, id: &FlowId, since: Option<u64>) -> CoreResult<ReviewTimeline> {
        let flow = self.get(id)?;
        let journal = self.store.read_journal(id, usize::MAX)?;
        let evidence = self.store.read_evidence(id)?;
        Ok(review::timeline(
            flow.id,
            flow.revision,
            since,
            &journal,
            evidence,
        ))
    }

    /// The latest review when it sent the flow back.
    pub fn open_feedback(&self, id: &FlowId) -> CoreResult<Option<Evidence>> {
        Ok(review::open_feedback(&self.store.read_evidence(id)?))
    }

    fn check_observations(&self, ids: &[ObservationId]) -> CoreResult<()> {
        for id in ids {
            self.store.load_observation(id)?;
        }
        Ok(())
    }

    /// Links observations to a committed revision. The edit already
    /// happened, so failures are logged rather than returned.
    fn link_observations(
        &self,
        flow: &Flow,
        step_ids: &[crate::ids::StepId],
        actor: &Actor,
        observations: &[ObservationId],
    ) {
        for id in observations {
            let result = self.store.load_observation(id).and_then(|mut o| {
                o.linked.push(ObservationLink {
                    flow_id: flow.id.clone(),
                    revision: flow.revision,
                });
                self.store.write_observation(&o)?;
                self.store.append_evidence(
                    &flow.id,
                    &Evidence {
                        revision: flow.revision,
                        at: now(),
                        actor: actor.clone(),
                        detail: EvidenceDetail::Observation {
                            observation_id: o.id.clone(),
                            source: o.source,
                            title: o.title.clone(),
                            step_ids: step_ids.to_vec(),
                            has_screenshot: o.screenshot_file.is_some(),
                        },
                    },
                )
            });
            if let Err(e) = result {
                tracing::warn!(observation = %id, error = %e, "failed to link observation");
            }
        }
    }

    // -- sub-flows ----------------------------------------------------

    /// Moves `step_ids` (next to each other in one block) into a new
    /// flow named `name` and puts one `flow.call` in their place
    /// that reads and writes the same variables. Two changes: the new
    /// flow is created, then the caller is edited once (undoable).
    pub fn extract_subflow(
        &self,
        id: &FlowId,
        expected_revision: Option<u64>,
        step_ids: &[StepId],
        name: &str,
        actor: Actor,
        note: ChangeNote,
    ) -> CoreResult<ExtractOutcome> {
        let caller = self.get(id)?;
        check_revision(expected_revision, caller.revision)?;
        let plan = call::extract(&caller, step_ids, name, self.registry())?;
        let subflow = self.insert_new(
            plan.subflow,
            actor.clone(),
            "extract subflow",
            note.remarks(),
        )?;
        let mut call_step = plan.call;
        ops::assign_missing_ids(&mut call_step);
        let call_step_id = call_step.id.clone();
        let mut edit: Vec<EditOp> = plan
            .declare
            .into_iter()
            .map(|variable| EditOp::SetVariable {
                variable,
                index: None,
            })
            .collect();
        edit.extend(
            plan.removed
                .into_iter()
                .map(|step_id| EditOp::RemoveStep { step_id }),
        );
        edit.push(EditOp::AddStep {
            step: call_step,
            position: plan.position,
        });
        let caller = match self.edit_noted(id, Some(caller.revision), edit, actor.clone(), note) {
            Ok(outcome) => outcome,
            Err(e) => {
                // The caller changed in between: do not leave the copy behind.
                let _ = self.delete(&subflow.flow.id, None, actor);
                return Err(e);
            }
        };
        Ok(ExtractOutcome {
            subflow,
            caller,
            call_step_id,
        })
    }

    // -- project files ----------------------------------------------------

    /// The flow's folder, where relative paths in its steps point.
    pub fn project_dir(&self, id: &FlowId) -> CoreResult<PathBuf> {
        if !self.store.exists(id) {
            return Err(CoreError::FlowNotFound(id.clone()));
        }
        Ok(self.store.project_dir(id))
    }

    /// The folders and files of the flow's folder.
    pub fn project_files(&self, id: &FlowId) -> CoreResult<ProjectFiles> {
        project::list(id, &self.project_dir(id)?)
    }

    /// Absolute path of a file (or folder) in the flow's folder; it need
    /// not exist.
    pub fn project_path(&self, id: &FlowId, path: &str) -> CoreResult<PathBuf> {
        Ok(self.project_dir(id)?.join(project::relative_path(path)?))
    }

    /// Writes a file into the flow's folder (creating its folders).
    /// Refuses to replace an existing file unless `overwrite`.
    pub fn write_project_file(
        &self,
        id: &FlowId,
        path: &str,
        contents: &[u8],
        overwrite: bool,
    ) -> CoreResult<ProjectFile> {
        let target = self.project_path(id, path)?;
        if target.is_dir() {
            return Err(CoreError::ProjectFileExists { path: path.into() });
        }
        if !overwrite && target.exists() {
            return Err(CoreError::ProjectFileExists { path: path.into() });
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::store::write_atomic(&target, contents)?;
        self.project_file_info(id, path)
    }

    /// Copies a file from anywhere on the PC into the flow's folder.
    pub fn copy_into_project(
        &self,
        id: &FlowId,
        from: &Path,
        path: &str,
        overwrite: bool,
    ) -> CoreResult<ProjectFile> {
        let target = self.project_path(id, path)?;
        if !from.is_file() {
            return Err(CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{} is not a file", from.display()),
            )));
        }
        if target.is_dir() || (!overwrite && target.exists()) {
            return Err(CoreError::ProjectFileExists { path: path.into() });
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Through a temporary file, so a reader never sees half a copy.
        let dir = target.parent().unwrap_or(&target);
        let tmp = tempfile::NamedTempFile::new_in(dir)?;
        std::fs::copy(from, tmp.path())?;
        tmp.persist(&target).map_err(|e| CoreError::Io(e.error))?;
        self.project_file_info(id, path)
    }

    /// Reads a file of the flow's folder.
    pub fn read_project_file(&self, id: &FlowId, path: &str) -> CoreResult<Vec<u8>> {
        let target = self.project_path(id, path)?;
        match std::fs::read(&target) {
            Ok(bytes) => Ok(bytes),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::IsADirectory
                ) || target.is_dir() =>
            {
                Err(CoreError::ProjectFileNotFound { path: path.into() })
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Creates a folder in the flow's folder (an existing one is fine).
    pub fn create_project_folder(&self, id: &FlowId, path: &str) -> CoreResult<()> {
        let target = self.project_path(id, path)?;
        if target.is_file() {
            return Err(CoreError::ProjectFileExists { path: path.into() });
        }
        Ok(std::fs::create_dir_all(target)?)
    }

    /// Moves a file or folder of the flow's folder to the workspace
    /// trash (`trash/<id>.files.<unix-ts>/<path>`). A standard folder
    /// (`input/`, …) is emptied instead of removed.
    pub fn delete_project_file(&self, id: &FlowId, path: &str) -> CoreResult<()> {
        let rel = project::relative_path(path)?;
        let target = self.project_dir(id)?.join(&rel);
        if !target.exists() {
            return Err(CoreError::ProjectFileNotFound { path: path.into() });
        }
        let ts = now().unix_timestamp();
        let trash = self
            .store
            .root()
            .join("trash")
            .join(format!("{id}.files.{ts}"));
        let standard = project::FOLDERS.iter().any(|f| rel == Path::new(f.name));
        if standard {
            for entry in std::fs::read_dir(&target)? {
                let entry = entry?;
                let to = trash.join(&rel).join(entry.file_name());
                std::fs::create_dir_all(trash.join(&rel))?;
                std::fs::rename(entry.path(), to)?;
            }
            return Ok(());
        }
        let to = trash.join(&rel);
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&target, &to)?;
        Ok(())
    }

    /// Renames (moves) a file or folder within the flow's folder.
    pub fn rename_project_file(
        &self,
        id: &FlowId,
        from: &str,
        to: &str,
    ) -> CoreResult<ProjectFile> {
        let source = self.project_path(id, from)?;
        let target = self.project_path(id, to)?;
        if !source.exists() {
            return Err(CoreError::ProjectFileNotFound { path: from.into() });
        }
        if target.exists() {
            return Err(CoreError::ProjectFileExists { path: to.into() });
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&source, &target)?;
        self.project_file_info(id, to)
    }

    fn project_file_info(&self, id: &FlowId, path: &str) -> CoreResult<ProjectFile> {
        let rel = project::relative_path(path)?;
        let meta = std::fs::metadata(self.project_dir(id)?.join(&rel))?;
        Ok(ProjectFile {
            path: project::display_path(&rel),
            size: meta.len(),
            modified: meta.modified().ok().map(time::OffsetDateTime::from),
            in_use: false,
        })
    }

    /// The files of a flow's folder that travel in a bundle.
    fn bundled_files(&self, id: &FlowId) -> CoreResult<Vec<BundledFile>> {
        use base64::Engine as _;
        let dir = self.store.project_dir(id);
        let mut out = Vec::new();
        for file in project::list(id, &dir)?.files {
            if !project::is_bundled(&file.path) {
                continue;
            }
            let bytes = std::fs::read(dir.join(project::relative_path(&file.path)?))?;
            out.push(BundledFile {
                flow_id: id.clone(),
                path: file.path,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
        Ok(out)
    }

    /// Writes the bundle's files of flow `from` into the folder of `to`
    /// (the same flow, or its copy), replacing files of the same name.
    fn write_bundled_files(
        &self,
        from: &FlowId,
        to: &FlowId,
        files: &[BundledFile],
    ) -> CoreResult<()> {
        project::unpack(files, from, &self.project_dir(to)?)
    }

    // -- sharing ----------------------------------------------------------

    /// Packs a flow (and optionally its versions) into a bundle for
    /// another workspace. Secret variable defaults are removed.
    pub fn export(&self, id: &FlowId, include_versions: bool) -> CoreResult<FlowBundle> {
        let mut flow = self.get(id)?;
        version::strip_secrets(&mut flow);
        let versions = if include_versions {
            let mut versions = self.store.load_versions(id)?;
            for v in &mut versions {
                version::strip_secrets(&mut v.flow);
            }
            versions
        } else {
            Vec::new()
        };
        let mut subflows = self.called_flows(&flow, &[]);
        subflows.iter_mut().for_each(version::strip_secrets);
        let mut files = self.bundled_files(&flow.id)?;
        for sub in &subflows {
            files.extend(self.bundled_files(&sub.id)?);
        }
        Ok(FlowBundle {
            format: BUNDLE_FORMAT.into(),
            // An older build would drop the files without a word.
            format_version: if files.is_empty() {
                version::BUNDLE_FORMAT_VERSION_WITHOUT_FILES
            } else {
                BUNDLE_FORMAT_VERSION
            },
            exported_at: now(),
            flow,
            versions,
            subflows,
            files,
        })
    }

    /// Imports a bundle or a bare flow document.
    ///
    /// A new ID is created as is. When the ID already exists, `on_conflict`
    /// decides; without it the import fails with `IMPORT_CONFLICT` so the
    /// caller can ask the user.
    pub fn import_bundle(
        &self,
        value: serde_json::Value,
        on_conflict: Option<ImportConflict>,
        actor: Actor,
    ) -> CoreResult<ImportOutcome> {
        let bundle = parse_bundle(value)?;
        let files = bundle.files;
        // Sub-flows first, so the flow validates against them.
        let mut subflows = Vec::with_capacity(bundle.subflows.len());
        for sub in bundle.subflows {
            if sub.id == bundle.flow.id || !sub.id.is_well_formed() {
                continue;
            }
            let (id, name) = (sub.id.clone(), sub.name.clone());
            let mode = if !self.store.exists(&sub.id) {
                self.insert_imported(sub, actor.clone())?;
                SubflowImport::Created
            } else if on_conflict == Some(ImportConflict::Update) {
                let label = "import update".to_owned();
                self.match_content(&id, &sub, None, actor.clone(), label, Remarks::default())?;
                SubflowImport::Updated
            } else {
                SubflowImport::Kept
            };
            if mode != SubflowImport::Kept {
                self.write_bundled_files(&id, &id, &files)?;
            }
            subflows.push(ImportedSubflow { id, name, mode });
        }
        let mut flow = bundle.flow;
        let original_id = flow.id.clone();
        let exists = flow.id.is_well_formed() && self.store.exists(&flow.id);
        let (mode, outcome) = match (exists, on_conflict) {
            (true, None) => {
                let existing = self.get(&flow.id)?;
                return Err(CoreError::ImportConflict {
                    flow_id: existing.id,
                    name: existing.name,
                });
            }
            (true, Some(ImportConflict::Update)) => {
                let id = flow.id.clone();
                let label = "import update".to_owned();
                (
                    ImportMode::Updated,
                    self.match_content(&id, &flow, None, actor, label, Remarks::default())?,
                )
            }
            (true, Some(ImportConflict::Copy)) => {
                flow.id = FlowId::generate();
                (ImportMode::Copied, self.insert_imported(flow, actor)?)
            }
            (false, _) => {
                if !flow.id.is_well_formed() {
                    flow.id = FlowId::generate();
                }
                (ImportMode::Created, self.insert_imported(flow, actor)?)
            }
        };
        self.write_bundled_files(&original_id, &outcome.flow.id, &files)?;
        let versions_added = self.add_versions(&outcome.flow.id, bundle.versions)?;
        // Validated before the sub-flows existed when it was created.
        let outcome = EditOutcome {
            validation: self.validate(&outcome.flow),
            ..outcome
        };
        Ok(ImportOutcome {
            mode,
            versions_added,
            subflows,
            outcome,
        })
    }

    // -- packages (.spx) -------------------------------------------

    /// What exporting `id` would put in a package, for choosing files
    /// before exporting.
    pub fn package_plan(
        &self,
        id: &FlowId,
        content: package::PackageContent,
    ) -> CoreResult<package::PackagePlan> {
        let current = self.get(id)?;
        let published = self.published_version(id)?;
        let use_published =
            published.is_some() && !matches!(content, package::PackageContent::Current);
        let content = match (&published, use_published) {
            (Some(v), true) => &v.flow,
            _ => &current,
        };
        let subflows = self.package_subflows(content, use_published);
        let mut files = Vec::new();
        for (flow_id, flow_name) in std::iter::once((&current.id, &current.name))
            .chain(subflows.iter().map(|s| (&s.id, &s.name)))
        {
            for file in project::list(flow_id, &self.store.project_dir(flow_id))?.files {
                if !project::is_bundled(&file.path) {
                    continue;
                }
                files.push(package::PackageFileChoice {
                    flow_id: flow_id.clone(),
                    flow_name: flow_name.clone(),
                    included_by_default: !is_input(&file.path),
                    path: file.path,
                    size: file.size,
                });
            }
        }
        let flows: Vec<&Flow> = std::iter::once(content).chain(subflows.iter()).collect();
        Ok(package::PackagePlan {
            flow_id: current.id.clone(),
            name: current.name.clone(),
            files,
            has_unpublished_changes: published
                .as_ref()
                .is_some_and(|v| !version::same_content(&v.flow, &current)),
            current: !use_published,
            published: published.as_ref().map(packaged_version),
            requires: package::requirements(&flows, self.registry()),
            subflows: subflows
                .iter()
                .map(|s| package::PackagedSubflow {
                    id: s.id.clone(),
                    name: s.name.clone(),
                })
                .collect(),
            file_name: package::file_name(
                &current.name,
                published
                    .as_ref()
                    .filter(|_| use_published)
                    .map(|v| v.number),
            ),
        })
    }

    /// Sub-flows `flow` calls, at their published version where they have one
    /// (`published`) or as they are now.
    /// Each one is resolved before following its own calls, so a published
    /// sub-flow brings what its published version calls.
    fn package_subflows(&self, flow: &Flow, published: bool) -> Vec<Flow> {
        let mut found: Vec<Flow> = Vec::new();
        let mut queue: Vec<FlowId> = call::called_ids(flow).into_iter().collect();
        while let Some(id) = queue.pop() {
            if id == flow.id || found.iter().any(|s| s.id == id) {
                continue;
            }
            let snapshot = if published {
                self.published_version(&id).ok().flatten().map(|v| v.flow)
            } else {
                None
            };
            let Some(mut next) = snapshot.or_else(|| self.store.load(&id).ok()) else {
                continue;
            };
            next.id = id;
            queue.extend(call::called_ids(&next));
            found.push(next);
        }
        found.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));
        found
    }

    /// The 配布フォルダー this PC looks at.
    pub fn distribution_folders(&self) -> CoreResult<Vec<distribution::DistributionFolder>> {
        Ok(distribution::load(self.store.local_root())?.folders)
    }

    /// Replaces the list of 配布フォルダー (checked: names and full paths).
    pub fn set_distribution_folders(
        &self,
        folders: Vec<distribution::DistributionFolder>,
    ) -> CoreResult<Vec<distribution::DistributionFolder>> {
        Ok(distribution::save(
            self.store.local_root(),
            &distribution::DistributionSettings { folders },
        )?
        .folders)
    }

    /// What each 配布フォルダー holds, against the flows here. A folder that
    /// cannot be reached says so instead of failing the rest.
    pub fn scan_distribution(&self) -> CoreResult<Vec<distribution::DistributionView>> {
        let local = |id: &FlowId| {
            if !self.store.exists(id) {
                return None;
            }
            let versions = self.store.load_versions(id).unwrap_or_default();
            Some(distribution::Local {
                latest: versions.last().map(|v| v.number),
                uids: versions.into_iter().map(|v| v.uid).collect(),
            })
        };
        Ok(self
            .distribution_folders()?
            .iter()
            .map(|folder| distribution::view(folder, local))
            .collect())
    }

    /// Puts the published version of `id` into the 配布フォルダー `folder`
    /// as `<name> v<n>.spx`, returning the file. Only a published version
    /// goes there. When the folder already has that very version, nothing
    /// is written.
    pub fn place_in_distribution(
        &self,
        id: &FlowId,
        folder: &str,
        exported_by: Option<String>,
    ) -> CoreResult<std::path::PathBuf> {
        let target = self
            .distribution_folders()?
            .into_iter()
            .find(|f| f.name == folder)
            .ok_or_else(|| CoreError::Rejected {
                code: "NOT_FOUND",
                message: format!("no distribution folder named {folder}"),
                hint: None,
            })?;
        let (manifest, bytes) = self.export_package(
            id,
            &package::PackageOptions {
                content: package::PackageContent::Published,
                exported_by,
                ..package::PackageOptions::default()
            },
        )?;
        let version = manifest.flow.version.as_ref().map(|v| v.uid.clone());
        let dir = std::path::Path::new(&target.path);
        let existing = distribution::manifests(dir).map_err(|e| CoreError::Rejected {
            code: "FOLDER_UNREACHABLE",
            message: format!("{}: {e}", target.path),
            hint: Some("Check that the folder exists and this PC can open it.".into()),
        })?;
        if let Some((path, _)) = existing.iter().find(|(_, m)| {
            m.flow.id == manifest.flow.id
                && m.flow.version.as_ref().map(|v| v.uid.clone()) == version
        }) {
            return Ok(path.clone());
        }
        let path = dir.join(package::file_name(
            &manifest.flow.name,
            manifest.flow.version.as_ref().map(|v| v.number),
        ));
        if path.exists() {
            return Err(CoreError::Rejected {
                code: "FILE_EXISTS",
                message: format!("{} already exists and holds something else", path.display()),
                hint: Some("Rename or remove that file in the folder first.".into()),
            });
        }
        std::fs::write(&path, &bytes)?;
        Ok(path)
    }

    /// Writes a `.spx` package of `id`. Secret defaults are removed;
    /// logins are referred to by name only.
    pub fn export_package(
        &self,
        id: &FlowId,
        options: &package::PackageOptions,
    ) -> CoreResult<(package::PackageManifest, Vec<u8>)> {
        use package::{PackageContent, PackageVersions};
        let current = self.get(id)?;
        let published = self.published_version(id)?;
        let all_versions = self.store.load_versions(id)?;
        let (mut flow, version, is_published) = match (options.content, published) {
            (PackageContent::Auto | PackageContent::Published, Some(v)) => {
                let mut flow = v.flow.clone();
                flow.id = current.id.clone();
                (flow, Some(v), true)
            }
            (PackageContent::Published, None) => {
                return Err(CoreError::Rejected {
                    code: "NOT_PUBLISHED",
                    message: format!("flow {id} has no published version"),
                    hint: Some(
                        "Export the current content instead (content: \"current\"), or have a person publish it first."
                            .into(),
                    ),
                });
            }
            (_, published) => {
                let matched = all_versions
                    .iter()
                    .rev()
                    .find(|v| version::same_content(&v.flow, &current))
                    .cloned();
                let is_published =
                    matches!((&matched, &published), (Some(m), Some(p)) if m.uid == p.uid);
                (current.clone(), matched, is_published)
            }
        };
        version::strip_secrets(&mut flow);
        let mut versions = match options.versions {
            PackageVersions::None => Vec::new(),
            PackageVersions::Content => version.clone().into_iter().collect(),
            PackageVersions::All => all_versions,
        };
        for v in &mut versions {
            version::strip_secrets(&mut v.flow);
        }
        let mut subflows = self.package_subflows(&flow, is_published);
        subflows.iter_mut().for_each(version::strip_secrets);
        let mut files = Vec::new();
        for flow_id in std::iter::once(&flow.id).chain(subflows.iter().map(|s| &s.id)) {
            files.extend(self.bundled_files(flow_id)?.into_iter().filter(|f| {
                let is = |x: &package::FileRef| x.flow_id == f.flow_id && x.path == f.path;
                match &options.only {
                    Some(only) => only.iter().any(is),
                    None => {
                        (options.include_input || !is_input(&f.path))
                            && !options.exclude.iter().any(is)
                    }
                }
            }));
        }
        self.write_package(
            FlowBundle {
                format: BUNDLE_FORMAT.into(),
                format_version: BUNDLE_FORMAT_VERSION,
                exported_at: now(),
                flow,
                versions,
                subflows,
                files,
            },
            version.as_ref(),
            is_published,
            options.exported_by.clone(),
        )
    }

    /// Writes `bundle` as a package with its manifest.
    fn write_package(
        &self,
        bundle: FlowBundle,
        version: Option<&FlowVersion>,
        is_published: bool,
        exported_by: Option<String>,
    ) -> CoreResult<(package::PackageManifest, Vec<u8>)> {
        let flow = &bundle.flow;
        let flows: Vec<&Flow> = std::iter::once(flow)
            .chain(bundle.subflows.iter())
            .collect();
        let manifest = package::PackageManifest {
            format: package::PACKAGE_FORMAT.into(),
            format_version: package::PACKAGE_FORMAT_VERSION,
            exported_at: bundle.exported_at,
            app_version: env!("CARGO_PKG_VERSION").into(),
            exported_by,
            flow: package::PackagedFlow {
                id: flow.id.clone(),
                name: flow.name.clone(),
                description: flow.description.clone(),
                version: version.map(packaged_version),
                published: is_published,
                step_count: flow.walk().count(),
            },
            subflows: bundle
                .subflows
                .iter()
                .map(|s| package::PackagedSubflow {
                    id: s.id.clone(),
                    name: s.name.clone(),
                })
                .collect(),
            requires: package::requirements(&flows, self.registry()),
            contents: Vec::new(),
        };
        let bytes = package::write(&bundle, manifest)?;
        let manifest = package::read_manifest(&bytes)?;
        Ok((manifest, bytes))
    }

    /// [`Self::preview_package`] for any file a flow can be imported from:
    /// an older JSON bundle or a flow document is previewed as the package
    /// it would have been.
    pub fn preview_file(
        &self,
        bytes: &[u8],
        registered_secrets: &[String],
    ) -> CoreResult<package::PackagePreview> {
        if package::is_package(bytes) {
            return self.preview_package(bytes, registered_secrets);
        }
        let bundle = parse_bundle(file_to_bundle_value(bytes)?)?;
        // The newest version that matches the content says which one it is.
        let version = bundle
            .versions
            .iter()
            .rev()
            .find(|v| version::same_content(&v.flow, &bundle.flow))
            .cloned();
        let (_, bytes) = self.write_package(bundle, version.as_ref(), false, None)?;
        self.preview_package(&bytes, registered_secrets)
    }

    /// What importing a package would do, and what this PC still needs for
    /// it. `registered_secrets` are the names of the logins registered here.
    pub fn preview_package(
        &self,
        bytes: &[u8],
        registered_secrets: &[String],
    ) -> CoreResult<package::PackagePreview> {
        use package::{CheckKind, CheckStatus, RequirementCheck};
        let (manifest, bundle) = package::read(bytes)?;
        let requires = &manifest.requires;
        let mut checks = Vec::new();
        for (key, range) in &requires.plugins {
            let name = key
                .strip_prefix(crate::requires::PLUGIN_PREFIX)
                .unwrap_or(key)
                .to_owned();
            let (status, installed) = match crate::requires::check(key, range, self.registry()) {
                crate::requires::Check::Ok => (CheckStatus::Ok, None),
                crate::requires::Check::Mismatch { installed } => {
                    (CheckStatus::Mismatch, Some(installed))
                }
                _ => (CheckStatus::Missing, None),
            };
            checks.push(RequirementCheck {
                kind: CheckKind::Plugin,
                name,
                range: Some(range.clone()),
                installed,
                status,
            });
        }
        for name in &requires.secrets {
            checks.push(RequirementCheck {
                kind: CheckKind::Secret,
                name: name.clone(),
                range: None,
                installed: None,
                status: if registered_secrets.contains(name) {
                    CheckStatus::Ok
                } else {
                    CheckStatus::Missing
                },
            });
        }
        let policy = crate::Policy::load(&crate::Policy::path(self.store.root()))?;
        for site in &requires.sites {
            checks.push(RequirementCheck {
                kind: CheckKind::Site,
                name: site.clone(),
                range: None,
                installed: None,
                status: if policy.check_site(site).is_ok() {
                    CheckStatus::Ok
                } else {
                    CheckStatus::NotAllowed
                },
            });
        }
        for app in &requires.apps {
            checks.push(RequirementCheck {
                kind: CheckKind::App,
                name: app.clone(),
                range: None,
                installed: None,
                status: if policy.check_app(app).is_ok() {
                    CheckStatus::Ok
                } else {
                    CheckStatus::NotAllowed
                },
            });
        }
        let id = &bundle.flow.id;
        let existing = if id.is_well_formed() && self.store.exists(id) {
            let current = self.get(id)?;
            let versions = self.store.load_versions(id)?;
            let incoming = version::DiffSide {
                version: manifest.flow.version.as_ref().map(|v| v.number),
                label: manifest.flow.version.as_ref().map_or_else(
                    || "package".to_owned(),
                    |v| format!("v{} {}", v.number, v.name),
                ),
                revision: bundle.flow.revision,
            };
            Some(package::ExistingFlow {
                name: current.name.clone(),
                latest_version: versions.last().map(|v| v.number),
                published_version: self.published(id)?.map(|p| p.version),
                has_package_version: manifest
                    .flow
                    .version
                    .as_ref()
                    .is_some_and(|pv| versions.iter().any(|v| v.uid == pv.uid)),
                diff: version::diff(
                    (&current, version::side(None, &current)),
                    (&bundle.flow, incoming),
                ),
            })
        } else {
            None
        };
        Ok(package::PackagePreview {
            manifest,
            existing,
            checks,
        })
    }

    /// Imports a `.spx` package, a bundle (`*.shikigami.json`) or a
    /// bare flow document, telling them apart by their first bytes.
    pub fn import_file(
        &self,
        bytes: &[u8],
        on_conflict: Option<ImportConflict>,
        actor: Actor,
    ) -> CoreResult<ImportOutcome> {
        self.import_bundle(file_to_bundle_value(bytes)?, on_conflict, actor)
    }

    fn insert_imported(&self, mut flow: Flow, actor: Actor) -> CoreResult<EditOutcome> {
        flow.revision = 0;
        let now = now();
        flow.metadata.created_at.get_or_insert(now);
        flow.metadata.updated_at = Some(now);
        self.insert_new(flow, actor, "import flow", Remarks::default())
    }

    /// Adds versions whose `uid` is not present yet, in their original
    /// order, after the existing ones (keeping their number when it is
    /// higher than ours).
    fn add_versions(&self, id: &FlowId, mut incoming: Vec<FlowVersion>) -> CoreResult<usize> {
        if incoming.is_empty() {
            return Ok(0);
        }
        let _lock = self.store.lock()?;
        let existing = self.store.load_versions(id)?;
        let mut next = existing.last().map_or(1, |v| v.number + 1);
        incoming.sort_by_key(|v| v.number);
        let mut added = 0;
        for mut v in incoming {
            if existing.iter().any(|e| e.uid == v.uid) {
                continue;
            }
            // Keep the sender's number when it is still free after ours, so
            // "v3" means the same version on both PCs.
            next = next.max(v.number);
            v.number = next;
            v.flow.id = id.clone();
            self.store.save_version(&v)?;
            next += 1;
            added += 1;
        }
        Ok(added)
    }

    fn reject_structural_errors(&self, flow: &Flow) -> CoreResult<()> {
        let issues = self.validator.structural_errors(flow);
        if issues.is_empty() {
            Ok(())
        } else {
            Err(CoreError::ValidationFailed(ValidationReport {
                valid: false,
                issues,
            }))
        }
    }

    fn commit(
        &self,
        id: &FlowId,
        expected_revision: Option<u64>,
        actor: Actor,
        kind: ChangeKind,
        remarks: Remarks,
        change: impl FnOnce(&mut UndoState, &Flow) -> CoreResult<Commit>,
    ) -> CoreResult<EditOutcome> {
        let lock = self.store.lock()?;
        let current = self.store.load(id)?;
        check_revision(expected_revision, current.revision)?;
        let mut undo = self.store.load_undo(id)?;
        if undo.head_revision != current.revision {
            // The document changed outside Shikigami (hand edit, git checkout):
            // undo entries would apply to the wrong content, so drop them.
            let had_history = !undo.undo.is_empty() || !undo.redo.is_empty();
            undo = UndoState {
                head_revision: current.revision,
                ..UndoState::default()
            };
            if had_history && matches!(kind, ChangeKind::Undo | ChangeKind::Redo) {
                self.store.save_undo(id, &undo)?;
                return Err(CoreError::InvalidEdit(
                    "undo history no longer matches the flow (it was changed outside SpellSheet)"
                        .into(),
                ));
            }
        }

        let Commit {
            mut next,
            mut applied,
            mut inverse,
            label,
        } = change(&mut undo, &current)?;
        self.reject_structural_errors(&next)?;
        let before_sync = next.requires.clone();
        crate::requires::sync(&mut next, self.registry());
        if next.requires != before_sync {
            // Core's own change to `requires` is part of the edit, so undo and
            // redo restore the exact ranges (a hand-set one included).
            let patch = |requires| EditOp::UpdateFlow {
                patch: FlowPatch {
                    requires: Some(requires),
                    ..FlowPatch::default()
                },
            };
            applied.push(patch(next.requires.clone()));
            inverse.insert(0, patch(before_sync));
        }
        next.id = current.id.clone();
        next.revision = current.revision + 1;
        ops::touch(&mut next.metadata);

        let entry = HistoryEntry {
            kind,
            revision: next.revision,
            actor: actor.clone(),
            at: now(),
            label,
            summary: remarks.summary,
            checks: remarks.checks,
            step_ids: review::touched_steps(&inverse),
            ops: applied,
            inverse,
        };
        match kind {
            ChangeKind::Undo => undo.redo.push(entry.clone()),
            ChangeKind::Redo => undo.undo.push(entry.clone()),
            _ => {
                undo.undo.push(entry.clone());
                undo.redo.clear();
            }
        }
        undo.head_revision = next.revision;
        if undo.undo.len() > UNDO_LIMIT {
            let excess = undo.undo.len() - UNDO_LIMIT;
            undo.undo.drain(..excess);
        }

        self.store.save(&next)?;
        self.store.save_undo(id, &undo)?;
        self.store.append_journal(id, &entry)?;
        drop(lock);

        self.notify(ChangeEvent {
            flow_id: id.clone(),
            kind,
            revision: next.revision,
            actor,
        });
        let validation = self.validate(&next);
        Ok(EditOutcome {
            can_undo: !undo.undo.is_empty(),
            can_redo: !undo.redo.is_empty(),
            flow: next,
            validation,
        })
    }
}

struct Commit {
    next: Flow,
    applied: Vec<EditOp>,
    inverse: Vec<EditOp>,
    label: String,
}

fn is_input(path: &str) -> bool {
    path.split('/')
        .next()
        .is_some_and(|top| top.eq_ignore_ascii_case("input"))
}

fn packaged_version(v: &FlowVersion) -> package::PackagedVersion {
    package::PackagedVersion {
        number: v.number,
        uid: v.uid.clone(),
        name: v.name.clone(),
        note: v.note.clone(),
    }
}

/// The JSON bundle (or bare flow) a file holds: a `.spx` package is
/// read (and its hashes checked), anything else is parsed as JSON.
pub fn file_to_bundle_value(bytes: &[u8]) -> CoreResult<serde_json::Value> {
    if package::is_package(bytes) {
        let (_, bundle) = package::read(bytes)?;
        return Ok(serde_json::to_value(bundle)?);
    }
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    serde_json::from_slice(text)
        .map_err(|e| CoreError::InvalidEdit(format!("not a flow file (.spx or JSON): {e}")))
}

fn parse_bundle(value: serde_json::Value) -> CoreResult<FlowBundle> {
    if !version::is_bundle(&value) {
        return Ok(FlowBundle {
            format: BUNDLE_FORMAT.into(),
            format_version: BUNDLE_FORMAT_VERSION,
            exported_at: now(),
            flow: crate::migrate::from_value(value)?,
            versions: Vec::new(),
            subflows: Vec::new(),
            files: Vec::new(),
        });
    }
    let found = value
        .get("formatVersion")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1);
    if found > u64::from(BUNDLE_FORMAT_VERSION) {
        return Err(CoreError::InvalidEdit(format!(
            "bundle format version {found} is newer than this build supports ({BUNDLE_FORMAT_VERSION})"
        )));
    }
    // The flow documents inside (and in its versions) go through the
    // same migrations as files (`migrate::deserialize`); check their format
    // versions first so a newer one reports UNSUPPORTED_SCHEMA_VERSION.
    let items = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
    };
    // `scenario` / `subscenarios`: bundles from before flows were renamed.
    let documents = ["flow", "scenario"]
        .into_iter()
        .filter_map(|key| value.get(key))
        .chain(items("subflows"))
        .chain(items("subscenarios"))
        .chain(items("versions").filter_map(|v| v.get("flow").or_else(|| v.get("scenario"))));
    for document in documents {
        crate::migrate::check_supported(document)?;
    }
    Ok(serde_json::from_value(value)?)
}

/// Publishing is a person's decision: an AI client may prepare a version
/// but never make it the one that runs unattended.
fn ensure_person(actor: &Actor, what: &str) -> CoreResult<()> {
    if matches!(actor.kind, ActorKind::Mcp | ActorKind::Chat) {
        return Err(CoreError::Rejected {
            code: "PUBLISH_NOT_ALLOWED",
            message: format!("only a person can {what}"),
            hint: Some(
                "Ask the user to review the changes in SpellSheet Writer (レビュー台) and press 確認して公開."
                    .into(),
            ),
        });
    }
    Ok(())
}

fn check_revision(expected: Option<u64>, actual: u64) -> CoreResult<()> {
    match expected {
        Some(expected) if expected != actual => {
            Err(CoreError::RevisionConflict { expected, actual })
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::ops::{Position, StepPatch};
    use crate::store::ActorKind;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn service() -> (tempfile::TempDir, FlowService) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FileStore::open(dir.path()).expect("store");
        (dir, FlowService::new(store, StepRegistry::with_builtins()))
    }

    fn mcp() -> Actor {
        Actor::named(ActorKind::Mcp, "test-client")
    }

    fn studio() -> Actor {
        Actor::new(ActorKind::Studio)
    }

    #[test]
    fn a_pasted_answer_is_reviewed_like_an_ai_edit() {
        let (_dir, svc) = service();
        let chat = Actor::named(ActorKind::Chat, "Copilot");
        let answer = crate::chat::read_answer(
            r#"```json
{ "format": "shikigami.answer", "summary": "挨拶する", "checks": ["宛名はこれでよいですか？"],
  "flow": { "name": "挨拶", "steps": [
    { "id": "step1", "type": "log.message", "params": { "message": "a" } },
    { "type": "log.message", "params": { "message": "b" } } ] } }
```"#,
        )
        .unwrap();
        let made = svc.apply_answer(answer, None, None, chat.clone()).unwrap();
        let flow = made.flow;
        assert!(flow.id.is_well_formed());
        // Made-up IDs are replaced, missing ones assigned.
        assert!(flow.steps.iter().all(|s| s.id.is_well_formed()));
        let history = svc.history(&flow.id, 5).unwrap();
        assert_eq!(history[0].actor.kind, ActorKind::Chat);
        assert_eq!(history[0].summary.as_deref(), Some("挨拶する"));
        assert_eq!(history[0].checks, vec!["宛名はこれでよいですか？"]);

        // Pasting into the open flow keeps its ID and the IDs the AI kept.
        let kept = flow.steps[0].id.clone();
        let text = format!(
            r#"{{ "summary": "締めの挨拶を追加", "flow": {{ "name": "挨拶", "steps": [
                {{ "id": "{kept}", "type": "log.message", "params": {{ "message": "a" }} }},
                {{ "type": "log.message", "params": {{ "message": "c" }} }} ] }} }}"#
        );
        let answer = crate::chat::read_answer(&text).unwrap();
        let edited = svc
            .apply_answer(answer, Some(&flow.id), Some(flow.revision), chat.clone())
            .unwrap();
        assert_eq!(edited.flow.id, flow.id);
        assert_eq!(edited.flow.steps[0].id, kept);
        assert_eq!(edited.flow.steps[1].params["message"], "c");
        assert!(edited.can_undo);
        let history = svc.history(&flow.id, 5).unwrap();
        let last = history.iter().max_by_key(|e| e.revision).unwrap();
        assert_eq!(last.summary.as_deref(), Some("締めの挨拶を追加"));
        assert_eq!(last.actor.kind, ActorKind::Chat);

        // Only a person publishes.
        let publish = svc.publish(&flow.id, PublishInput::default(), chat);
        assert!(publish.is_err());
    }

    #[test]
    fn unattended_runs_use_the_published_version_only() {
        let (_dir, svc) = service();
        let sub = svc
            .create(
                NewFlow {
                    name: "部品".into(),
                    steps: vec![Step::new("log.message").with_param("message", "sub")],
                    ..NewFlow::default()
                },
                studio(),
            )
            .unwrap()
            .flow;
        let main = svc
            .create(
                NewFlow {
                    name: "本体".into(),
                    steps: vec![
                        Step::new("log.message").with_param("message", "one"),
                        Step::new("flow.call").with_param("flow", sub.id.as_str()),
                    ],
                    ..NewFlow::default()
                },
                studio(),
            )
            .unwrap()
            .flow;

        assert_eq!(
            svc.published_run(&main.id).unwrap_err().code(),
            "NOT_PUBLISHED"
        );
        assert_eq!(
            svc.published_run(&FlowId::new("scn_missing"))
                .unwrap_err()
                .code(),
            "FLOW_NOT_FOUND"
        );
        // An AI may prepare versions but never publish.
        assert_eq!(
            svc.publish(&main.id, PublishInput::default(), mcp())
                .unwrap_err()
                .code(),
            "PUBLISH_NOT_ALLOWED"
        );
        // The called flow has to be published first; nothing is saved meanwhile.
        assert_eq!(
            svc.publish(&main.id, PublishInput::default(), studio())
                .unwrap_err()
                .code(),
            "SUBFLOW_NOT_PUBLISHED"
        );
        assert!(svc.list_versions(&main.id).unwrap().is_empty());

        svc.publish(&sub.id, PublishInput::default(), studio())
            .unwrap();
        let published = svc
            .publish(
                &main.id,
                PublishInput {
                    expected_revision: Some(main.revision),
                    note: "初回".into(),
                    ..PublishInput::default()
                },
                studio(),
            )
            .unwrap();
        assert_eq!((published.version, published.name.as_str()), (1, "v1"));
        assert!(published.matches_current);

        // Later edits stay out of unattended runs until published again.
        svc.edit(&main.id, None, vec![add_log("two")], mcp())
            .unwrap();
        svc.edit(&sub.id, None, vec![add_log("sub two")], mcp())
            .unwrap();
        assert!(!svc.published(&main.id).unwrap().unwrap().matches_current);
        let run = svc.published_run(&main.id).unwrap();
        assert_eq!((run.version, run.flow.steps.len()), (1, 2));
        assert_eq!(run.subflows.len(), 1);
        assert_eq!(run.subflows[0].flow.steps.len(), 1);
        assert_eq!(run.subflows[0].version, Some(1));

        // Approving in review publishes the reviewed revision in one step.
        let current = svc.get(&main.id).unwrap();
        assert_eq!(
            svc.approve_and_publish(
                &main.id,
                current.revision - 1,
                String::new(),
                PublishInput::default(),
                studio()
            )
            .unwrap_err()
            .code(),
            "REVISION_CONFLICT"
        );
        let again = svc
            .approve_and_publish(
                &main.id,
                current.revision,
                "確認しました".into(),
                PublishInput {
                    name: Some("本番".into()),
                    ..PublishInput::default()
                },
                studio(),
            )
            .unwrap();
        assert_eq!((again.version, again.name.as_str()), (2, "本番"));
        let timeline = svc.review_timeline(&main.id, None).unwrap();
        assert_eq!(timeline.last_approval.unwrap().revision, current.revision);
        // Publishing unchanged content reuses its version.
        assert_eq!(
            svc.publish(&main.id, PublishInput::default(), studio())
                .unwrap()
                .version,
            2
        );
        assert_eq!(svc.list_versions(&main.id).unwrap().len(), 2);
        // An older version can be put back in force.
        let back = svc
            .publish(
                &main.id,
                PublishInput {
                    version: Some(1),
                    ..PublishInput::default()
                },
                studio(),
            )
            .unwrap();
        assert!(!back.matches_current);

        svc.unpublish(&main.id, "止める".into(), Actor::new(ActorKind::Cli))
            .unwrap();
        assert!(svc.published(&main.id).unwrap().is_none());
        assert_eq!(
            svc.published_run(&main.id).unwrap_err().code(),
            "NOT_PUBLISHED"
        );
        let log = svc.publish_log(&main.id).unwrap();
        assert_eq!(
            log.iter().map(|r| r.version).collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(2), Some(1), None]
        );

        // A flow moved to the trash stops running unattended.
        let sub_rev = svc.get(&sub.id).unwrap().revision;
        svc.edit(
            &main.id,
            None,
            vec![EditOp::RemoveStep {
                step_id: svc.get(&main.id).unwrap().steps[1].id.clone(),
            }],
            studio(),
        )
        .unwrap();
        svc.delete(&sub.id, Some(sub_rev), studio()).unwrap();
        assert!(svc.published(&sub.id).unwrap().is_none());
    }

    #[test]
    fn risk_counts_the_riskiest_step() {
        let (_dir, svc) = service();
        let mut s = Flow::new("r");
        s.steps = vec![Step::new("log.message"), Step::new("unknown.thing")];
        assert_eq!(
            svc.risk_of([&s]),
            (RiskLevel::Dangerous, vec!["unknown.thing".to_owned()])
        );
        s.steps.pop();
        assert_eq!(svc.risk_of([&s]), (RiskLevel::Safe, vec![]));
    }

    fn add_log(message: &str) -> EditOp {
        EditOp::AddStep {
            step: Step::new("log.message").with_param("message", message),
            position: Position::default(),
        }
    }

    #[test]
    fn requires_follows_the_plugin_steps() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut registry = StepRegistry::with_builtins();
        let mut def = registry.get("log.message").expect("log").clone();
        def.step_type = "hello.greet".into();
        def.plugin = Some(crate::registry::PluginInfo {
            name: "hello".into(),
            version: "0.3.1".into(),
            ..Default::default()
        });
        registry.register(def);
        let svc = FlowService::new(FileStore::open(dir.path()).expect("store"), registry);
        let created = svc
            .create(
                NewFlow {
                    name: "plugin".into(),
                    description: String::new(),
                    variables: vec![],
                    steps: vec![Step::new("hello.greet").with_param("message", "hi")],
                    tags: vec![],
                },
                mcp(),
            )
            .expect("create");
        let id = created.flow.id.clone();
        assert_eq!(created.flow.requires["plugin:hello"], "^0.3.1");

        // A hand-set range is kept while the plugin is used.
        let patch = FlowPatch {
            requires: Some(BTreeMap::from([(
                "plugin:hello".into(),
                ">=0.3, <2".into(),
            )])),
            ..FlowPatch::default()
        };
        let loosened = svc
            .edit(&id, None, vec![EditOp::UpdateFlow { patch }], mcp())
            .expect("patch");
        assert_eq!(loosened.flow.requires["plugin:hello"], ">=0.3, <2");
        assert!(loosened.validation.valid, "{:?}", loosened.validation);

        let step = created.flow.steps[0].id.clone();
        let removed = svc
            .edit(&id, None, vec![EditOp::RemoveStep { step_id: step }], mcp())
            .expect("remove");
        assert!(removed.flow.requires.is_empty());
        // Undo brings back the hand-set range, not the installed default.
        let undone = svc.undo(&id, None, mcp()).expect("undo");
        assert_eq!(undone.flow.requires["plugin:hello"], ">=0.3, <2");
        let redone = svc.redo(&id, None, mcp()).expect("redo");
        assert!(redone.flow.requires.is_empty());
    }

    #[test]
    fn bundles_with_newer_flows_are_refused() {
        let (_dir, svc) = service();
        let value = serde_json::json!({
            "format": BUNDLE_FORMAT,
            "formatVersion": 1,
            "exportedAt": "2026-10-28T00:00:00Z",
            "flow": { "schemaVersion": 99, "id": "scn_new", "name": "x" },
        });
        let err = svc.import_bundle(value, None, mcp()).expect_err("newer");
        assert_eq!(err.code(), "UNSUPPORTED_SCHEMA_VERSION");
    }

    #[test]
    fn create_list_get_delete() {
        let (_dir, svc) = service();
        let created = svc
            .create(
                NewFlow {
                    name: "請求書処理".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create");
        assert_eq!(created.flow.revision, 1);
        let list = svc.list().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "請求書処理");
        let id = created.flow.id;
        assert_eq!(svc.get(&id).expect("get").name, "請求書処理");
        svc.delete(&id, Some(1), studio()).expect("delete");
        assert_eq!(svc.get(&id).expect_err("gone").code(), "FLOW_NOT_FOUND");
        assert!(svc.list().expect("list").is_empty());
    }

    #[test]
    fn edits_from_two_clients_detect_conflicts() {
        let (_dir, svc) = service();
        let id = svc
            .create(
                NewFlow {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .flow
            .id;

        // MCP edits based on revision 1.
        let after_mcp = svc
            .edit(&id, Some(1), vec![add_log("from ai")], mcp())
            .expect("mcp edit");
        assert_eq!(after_mcp.flow.revision, 2);

        // Studio still thinks it is at revision 1: conflict, nothing applied.
        let err = svc
            .edit(&id, Some(1), vec![add_log("from gui")], studio())
            .expect_err("conflict");
        assert_eq!(err.code(), "REVISION_CONFLICT");
        assert_eq!(svc.get(&id).expect("get").steps.len(), 1);

        // After reloading, Studio sees the AI's change immediately.
        let latest = svc.get(&id).expect("get");
        svc.edit(
            &id,
            Some(latest.revision),
            vec![add_log("from gui")],
            studio(),
        )
        .expect("gui edit");
        assert_eq!(svc.get(&id).expect("get").steps.len(), 2);
    }

    #[test]
    fn undo_redo_round_trip_and_history() {
        let (_dir, svc) = service();
        let id = svc
            .create(
                NewFlow {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .flow
            .id;
        let edited = svc
            .edit(&id, None, vec![add_log("a"), add_log("b")], mcp())
            .expect("edit");
        let step_id = edited.flow.steps[0].id.clone();
        svc.edit(
            &id,
            None,
            vec![EditOp::UpdateStep {
                step_id: step_id.clone(),
                patch: StepPatch {
                    name: Some("最初".into()),
                    ..Default::default()
                },
            }],
            studio(),
        )
        .expect("rename");

        let undone = svc.undo(&id, None, studio()).expect("undo 1");
        assert_eq!(undone.flow.steps[0].name, "");
        assert!(undone.can_redo);
        let undone = svc.undo(&id, None, studio()).expect("undo 2");
        assert!(undone.flow.steps.is_empty());
        assert_eq!(
            svc.undo(&id, None, studio()).expect_err("empty").code(),
            "NOTHING_TO_UNDO_OR_REDO"
        );

        let redone = svc.redo(&id, None, studio()).expect("redo");
        assert_eq!(redone.flow.steps.len(), 2);
        assert_eq!(
            redone.flow.steps[0].id, step_id,
            "step ids survive undo/redo"
        );
        let redone = svc.redo(&id, None, studio()).expect("redo 2");
        assert_eq!(redone.flow.steps[0].name, "最初");

        // A new edit clears the redo stack.
        svc.undo(&id, None, studio()).expect("undo");
        let after = svc
            .edit(&id, None, vec![add_log("c")], studio())
            .expect("edit");
        assert!(!after.can_redo);

        let history = svc.history(&id, 100).expect("history");
        let kinds: Vec<_> = history.iter().map(|h| h.kind).collect();
        use ChangeKind::*;
        assert_eq!(
            kinds,
            [Create, Edit, Edit, Undo, Undo, Redo, Redo, Undo, Edit]
        );
        assert_eq!(history[1].actor, mcp());
    }

    #[test]
    fn stale_undo_history_is_discarded_after_external_change() {
        let (_dir, svc) = service();
        let id = svc
            .create(
                NewFlow {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .flow
            .id;
        svc.edit(&id, None, vec![add_log("a")], mcp())
            .expect("edit");
        // Simulate a hand edit / git checkout that bumps the revision.
        let mut doc = svc.get(&id).expect("get");
        doc.revision += 5;
        svc.store().save(&doc).expect("save");
        assert_eq!(
            svc.undo(&id, None, studio()).expect_err("stale").code(),
            "INVALID_EDIT"
        );
        assert_eq!(svc.undo_state(&id).expect("state"), (false, false));
    }

    #[test]
    fn drafts_may_be_incomplete_but_not_structurally_broken() {
        let (_dir, svc) = service();
        let id = svc
            .create(
                NewFlow {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .flow
            .id;
        // An `if` without its condition is a valid draft (reported, not rejected).
        let outcome = svc
            .edit(
                &id,
                None,
                vec![EditOp::AddStep {
                    step: Step::new("control.if"),
                    position: Position::default(),
                }],
                mcp(),
            )
            .expect("draft edit");
        assert!(!outcome.validation.valid);
        assert_eq!(
            svc.get_runnable(&id).expect_err("not runnable").code(),
            "VALIDATION_FAILED"
        );

        // A malformed id is rejected outright.
        let err = svc
            .edit(
                &id,
                None,
                vec![EditOp::AddStep {
                    step: Step::new("log.message").with_id("bad id!"),
                    position: Position::default(),
                }],
                mcp(),
            )
            .expect_err("structural");
        assert_eq!(err.code(), "VALIDATION_FAILED");
    }

    #[test]
    fn listeners_are_notified_and_ids_are_path_safe() {
        let (_dir, svc) = service();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        svc.subscribe(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        });
        let id = svc
            .create(
                NewFlow {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .flow
            .id;
        svc.edit(&id, None, vec![add_log("x")], mcp())
            .expect("edit");
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(
            svc.get(&FlowId::new("../../etc/passwd"))
                .expect_err("bad id")
                .code(),
            "INVALID_FLOW_ID"
        );
    }

    #[test]
    fn observations_are_capped_and_unused_ones_expire() {
        use crate::review::{MAX_TREE_BYTES, NewObservation, ObservationSource};
        let (_dir, svc) = service();
        let observe = |tree: String, screenshot: Vec<u8>| {
            svc.record_observation(
                NewObservation {
                    source: ObservationSource::InspectUi,
                    title: "請求 - 明細".into(),
                    request: serde_json::json!({ "window": { "process": "billing.exe" } }),
                    status: None,
                    output: None,
                    tree: Some(tree),
                    screenshot: Some(screenshot),
                },
                mcp(),
            )
            .expect("observe")
        };
        let big = observe("あ".repeat(MAX_TREE_BYTES), b"not an image".to_vec());
        assert_eq!(big.screenshot_file, None);
        assert_eq!(big.notes.len(), 2, "{:?}", big.notes);
        let content = svc.get_observation(&big.id).expect("content");
        assert!(content.tree.expect("tree").len() <= MAX_TREE_BYTES);

        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        let small = observe("- button \"保存\"".into(), png);
        let content = svc.get_observation(&small.id).expect("content");
        assert!(
            content
                .screenshot_data_url
                .expect("screenshot")
                .starts_with("data:image/png;base64,iVBORw0K")
        );

        // An old observation no edit used is deleted; a linked one stays.
        let id = svc
            .create_noted(
                NewFlow {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
                ChangeNote {
                    observations: vec![small.id.clone()],
                    ..Default::default()
                },
            )
            .expect("create")
            .flow
            .id;
        for o in [&big, &small] {
            let mut old = svc.store().load_observation(&o.id).expect("load");
            old.at -= time::Duration::days(30);
            svc.store().write_observation(&old).expect("age");
        }
        assert_eq!(
            svc.store()
                .prune_observations(time::Duration::days(3))
                .expect("prune"),
            1
        );
        assert_eq!(
            svc.get_observation(&big.id).expect_err("gone").code(),
            "OBSERVATION_NOT_FOUND"
        );
        let kept = svc.get_observation(&small.id).expect("kept").observation;
        assert_eq!(kept.linked[0].flow_id, id);
        assert_eq!(kept.linked[0].revision, 1);
    }

    #[test]
    fn duplicate_and_import() {
        let (_dir, svc) = service();
        let src = svc
            .create(
                NewFlow {
                    name: "元".into(),
                    steps: vec![Step::new("log.message").with_param("message", "x")],
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .flow;
        let copy = svc.duplicate(&src.id, None, studio()).expect("dup").flow;
        assert_ne!(copy.id, src.id);
        assert_eq!(copy.name, "元 のコピー");
        assert_eq!(copy.steps, src.steps);

        // Importing a document whose id already exists gets a fresh id.
        let imported = svc.import(src.clone(), studio()).expect("import").flow;
        assert_ne!(imported.id, src.id);
        assert_eq!(svc.list().expect("list").len(), 3);
    }
}
