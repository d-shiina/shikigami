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

mod evidence;
mod files;
mod sharing;
mod versions;

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
        self.write_bundled_files(id, &outcome.flow.id, &files, false)?;
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
        // Names are unique (each names its flow's folder): a new flow whose
        // name is taken gets a number, like a copied file in Explorer.
        flow.name = self.store.free_flow_name(&flow.name, None);
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

    // -- committing changes ---------------------------------------------

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
            // The document changed outside SpellSheet (hand edit, git checkout):
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
                "Ask the user to review the changes in SpellSheet Writer (レビュー台) and press 変更を承諾."
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
mod tests;
