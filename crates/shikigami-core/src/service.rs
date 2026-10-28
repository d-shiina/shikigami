//! `ScenarioService`: the single API through which every client reads and
//! changes scenarios. Studio (Tauri commands), the MCP server and the CLI are
//! thin adapters over this type; none of them manipulate documents directly.

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::call::{self, Subscenario};
use crate::error::{CoreError, CoreResult};
use crate::ids::{ObservationId, ScenarioId, StepId};
use crate::model::{Scenario, ScenarioSummary, Step, VariableDef, now};
use crate::ops::{self, EditOp, ScenarioPatch};
use crate::registry::StepRegistry;
use crate::review::{
    self, Evidence, EvidenceDetail, NewObservation, NewReview, Observation, ObservationContent,
    ObservationLink, ReviewTimeline, ReviewVerdict, TestRun,
};
use crate::store::{Actor, ChangeKind, FileStore, HistoryEntry, UNDO_LIMIT, UndoState};
use crate::validate::{ValidationReport, Validator};
use crate::version::{
    self, BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, ImportConflict, ImportMode, NewVersion,
    ScenarioBundle, ScenarioDiff, ScenarioVersion, SubscenarioImport, VersionSummary,
};

/// Input for creating a scenario.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewScenario {
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
    /// Observations (screens looked at with inspect_* / test_step) the change
    /// is based on. They are linked to the new revision and its steps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<ObservationId>,
}

/// Result of a committed change.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub scenario: Scenario,
    /// Full validation of the new revision. Drafts may contain errors;
    /// they must be fixed before the scenario can run.
    pub validation: ValidationReport,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// Notification sent to in-process listeners after every committed change.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub scenario_id: ScenarioId,
    pub kind: ChangeKind,
    pub revision: u64,
    pub actor: Actor,
}

/// One sub-scenario of an imported bundle.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSubscenario {
    pub id: ScenarioId,
    pub name: String,
    pub mode: SubscenarioImport,
}

/// Result of importing a bundle or scenario file.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub mode: ImportMode,
    /// Versions from the bundle that were added (already present ones are skipped).
    pub versions_added: usize,
    /// The bundle's sub-scenarios and what happened to each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subscenarios: Vec<ImportedSubscenario>,
    #[serde(flatten)]
    pub outcome: EditOutcome,
}

/// Result of moving steps into a new sub-scenario.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtractOutcome {
    /// The new scenario holding the steps.
    pub subscenario: EditOutcome,
    /// The calling scenario, with the steps replaced by one `scenario.call`.
    pub caller: EditOutcome,
    /// ID of the new `scenario.call` step.
    pub call_step_id: StepId,
}

type Listener = Arc<dyn Fn(&ChangeEvent) + Send + Sync>;

pub struct ScenarioService {
    store: FileStore,
    validator: Validator,
    listeners: Mutex<Vec<Listener>>,
}

impl ScenarioService {
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
    /// [`FileStore::scenarios_dir`].
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

    pub fn list(&self) -> CoreResult<Vec<ScenarioSummary>> {
        Ok(self
            .store
            .load_all()?
            .iter()
            .map(Scenario::summary)
            .collect())
    }

    pub fn get(&self, id: &ScenarioId) -> CoreResult<Scenario> {
        self.store.load(id)
    }

    /// Full validation, including the scenarios it calls.
    pub fn validate(&self, scenario: &Scenario) -> ValidationReport {
        self.validator
            .validate_with_calls(scenario, &|id| self.store.load(id).ok())
    }

    /// [`Self::validate`] for a document from a bundle: its sub-scenarios
    /// are looked up in `bundled` before the workspace.
    pub fn validate_bundled(&self, scenario: &Scenario, bundled: &[Scenario]) -> ValidationReport {
        self.validator.validate_with_calls(scenario, &|id| {
            bundled
                .iter()
                .find(|s| &s.id == id)
                .cloned()
                .or_else(|| self.store.load(id).ok())
        })
    }

    /// Every scenario `scenario` calls, directly or through others (each
    /// once, missing ones left out), with the version each one matches.
    /// Pass them to the Runtime with the run.
    pub fn subscenarios(&self, scenario: &Scenario) -> CoreResult<Vec<Subscenario>> {
        self.subscenarios_bundled(scenario, &[])
    }

    /// Like [`Self::subscenarios`] for a bundle: its own sub-scenarios win
    /// over the workspace's, the same lookup [`Self::validate_bundled`] uses.
    pub fn subscenarios_bundled(
        &self,
        scenario: &Scenario,
        bundled: &[Scenario],
    ) -> CoreResult<Vec<Subscenario>> {
        Ok(self
            .called_scenarios(scenario, bundled)
            .into_iter()
            .map(|s| {
                let version = self.matching_version(&s).ok().flatten();
                Subscenario {
                    scenario: s,
                    version,
                }
            })
            .collect())
    }

    fn called_scenarios(&self, scenario: &Scenario, bundled: &[Scenario]) -> Vec<Scenario> {
        let mut found: Vec<Scenario> = Vec::new();
        let mut queue: Vec<ScenarioId> = call::called_ids(scenario).into_iter().collect();
        while let Some(id) = queue.pop() {
            if id == scenario.id || found.iter().any(|s| s.id == id) {
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

    /// Scenarios that call `id` directly.
    pub fn callers(&self, id: &ScenarioId) -> CoreResult<Vec<ScenarioSummary>> {
        Ok(self
            .store
            .load_all()?
            .iter()
            .filter(|s| &s.id != id && call::called_ids(s).contains(id))
            .map(Scenario::summary)
            .collect())
    }

    pub fn validate_stored(&self, id: &ScenarioId) -> CoreResult<ValidationReport> {
        Ok(self.validate(&self.get(id)?))
    }

    pub fn history(&self, id: &ScenarioId, limit: usize) -> CoreResult<Vec<HistoryEntry>> {
        self.store.read_journal(id, limit)
    }

    /// Loads a scenario and fails with `VALIDATION_FAILED` unless it is runnable.
    pub fn get_runnable(&self, id: &ScenarioId) -> CoreResult<Scenario> {
        let scenario = self.get(id)?;
        let report = self.validate(&scenario);
        if report.valid {
            Ok(scenario)
        } else {
            Err(CoreError::ValidationFailed(report))
        }
    }

    // -- lifecycle --------------------------------------------------------

    pub fn create(&self, input: NewScenario, actor: Actor) -> CoreResult<EditOutcome> {
        self.create_noted(input, actor, ChangeNote::default())
    }

    /// [`Self::create`] with the author's summary and observations.
    pub fn create_noted(
        &self,
        input: NewScenario,
        actor: Actor,
        note: ChangeNote,
    ) -> CoreResult<EditOutcome> {
        self.check_observations(&note.observations)?;
        let mut scenario = Scenario::new(input.name);
        scenario.description = input.description;
        scenario.variables = input.variables;
        scenario.steps = input.steps;
        scenario.metadata.tags = input.tags;
        let summary = review::clean_text(note.summary, review::MAX_SUMMARY_CHARS);
        let outcome = self.insert_new(scenario, actor.clone(), "create scenario", summary)?;
        let steps: Vec<_> = outcome.scenario.walk().map(|s| s.id.clone()).collect();
        self.link_observations(&outcome.scenario, &steps, &actor, &note.observations);
        Ok(outcome)
    }

    /// Imports a complete document (e.g. from a file). Keeps its ID unless it
    /// is missing or already taken.
    pub fn import(&self, mut scenario: Scenario, actor: Actor) -> CoreResult<EditOutcome> {
        if scenario.id.is_empty() || self.store.exists(&scenario.id) {
            scenario.id = ScenarioId::generate();
        }
        scenario.revision = 0;
        let now = now();
        scenario.metadata.created_at.get_or_insert(now);
        scenario.metadata.updated_at = Some(now);
        self.insert_new(scenario, actor, "import scenario", None)
    }

    pub fn duplicate(
        &self,
        id: &ScenarioId,
        name: Option<String>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        let source = self.get(id)?;
        let mut copy = Scenario::new(name.unwrap_or_else(|| format!("{} のコピー", source.name)));
        copy.description = source.description;
        copy.variables = source.variables;
        copy.steps = source.steps;
        copy.settings = source.settings;
        copy.requires = source.requires;
        copy.metadata.tags = source.metadata.tags;
        self.insert_new(copy, actor, "duplicate scenario", None)
    }

    fn insert_new(
        &self,
        mut scenario: Scenario,
        actor: Actor,
        label: &str,
        summary: Option<String>,
    ) -> CoreResult<EditOutcome> {
        if !scenario.id.is_well_formed() {
            return Err(CoreError::InvalidScenarioId(scenario.id.to_string()));
        }
        if scenario.name.trim().is_empty() {
            return Err(CoreError::InvalidEdit(
                "scenario name must not be empty".into(),
            ));
        }
        scenario.steps.iter_mut().for_each(ops::assign_missing_ids);
        self.reject_structural_errors(&scenario)?;
        crate::requires::sync(&mut scenario, self.registry());
        scenario.revision = 1;

        let _lock = self.store.lock()?;
        if self.store.exists(&scenario.id) {
            return Err(CoreError::ScenarioAlreadyExists(scenario.id));
        }
        self.store.save(&scenario)?;
        self.store.remove_undo(&scenario.id)?;
        let entry = HistoryEntry {
            kind: ChangeKind::Create,
            revision: scenario.revision,
            actor: actor.clone(),
            at: now(),
            label: label.to_owned(),
            summary,
            step_ids: Vec::new(),
            ops: Vec::new(),
            inverse: Vec::new(),
        };
        self.store.append_journal(&scenario.id, &entry)?;
        drop(_lock);

        self.notify(ChangeEvent {
            scenario_id: scenario.id.clone(),
            kind: ChangeKind::Create,
            revision: scenario.revision,
            actor,
        });
        let validation = self.validate(&scenario);
        Ok(EditOutcome {
            scenario,
            validation,
            can_undo: false,
            can_redo: false,
        })
    }

    /// Moves the scenario to the workspace trash (recoverable).
    pub fn delete(
        &self,
        id: &ScenarioId,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<()> {
        let callers = self.callers(id)?;
        if !callers.is_empty() {
            return Err(CoreError::ScenarioInUse {
                scenario_id: id.clone(),
                callers: callers.into_iter().map(|c| (c.id, c.name)).collect(),
            });
        }
        let _lock = self.store.lock()?;
        let current = self.store.load(id)?;
        check_revision(expected_revision, current.revision)?;
        self.store.trash(id)?;
        self.store.remove_undo(id)?;
        let entry = HistoryEntry {
            kind: ChangeKind::Delete,
            revision: current.revision,
            actor: actor.clone(),
            at: now(),
            label: "delete scenario".into(),
            summary: None,
            step_ids: Vec::new(),
            ops: Vec::new(),
            inverse: Vec::new(),
        };
        self.store.append_journal(id, &entry)?;
        drop(_lock);
        self.notify(ChangeEvent {
            scenario_id: id.clone(),
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
        id: &ScenarioId,
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
        id: &ScenarioId,
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
        let summary = review::clean_text(note.summary, review::MAX_SUMMARY_CHARS);
        let mut step_ids = Vec::new();
        let outcome = self.commit(
            id,
            expected_revision,
            actor.clone(),
            ChangeKind::Edit,
            summary,
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
        self.link_observations(&outcome.scenario, &step_ids, &actor, &note.observations);
        Ok(outcome)
    }

    pub fn undo(
        &self,
        id: &ScenarioId,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        self.commit(
            id,
            expected_revision,
            actor,
            ChangeKind::Undo,
            None,
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
        id: &ScenarioId,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        self.commit(
            id,
            expected_revision,
            actor,
            ChangeKind::Redo,
            None,
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

    pub fn undo_state(&self, id: &ScenarioId) -> CoreResult<(bool, bool)> {
        let scenario = self.get(id)?;
        let state = self.store.load_undo(id)?;
        if state.head_revision != scenario.revision {
            return Ok((false, false));
        }
        Ok((!state.undo.is_empty(), !state.redo.is_empty()))
    }

    // -- versions ---------------------------------------------------------

    /// Saves the current content as a new named version.
    pub fn create_version(
        &self,
        id: &ScenarioId,
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
        let mut scenario = current;
        scenario.schema_ref = None;
        let version = ScenarioVersion {
            number,
            uid: uuid::Uuid::now_v7().simple().to_string(),
            name: name.to_owned(),
            note: input.note.trim().to_owned(),
            created_at: now(),
            created_by: actor,
            revision: scenario.revision,
            scenario,
        };
        self.store.save_version(&version)?;
        Ok(version.summary())
    }

    /// Versions of a scenario, newest first.
    pub fn list_versions(&self, id: &ScenarioId) -> CoreResult<Vec<VersionSummary>> {
        let mut versions: Vec<_> = self
            .store
            .load_versions(id)?
            .iter()
            .map(ScenarioVersion::summary)
            .collect();
        versions.reverse();
        Ok(versions)
    }

    pub fn get_version(&self, id: &ScenarioId, number: u32) -> CoreResult<ScenarioVersion> {
        self.store.load_version(id, number)
    }

    /// Number of the newest version, if any.
    pub fn latest_version(&self, id: &ScenarioId) -> CoreResult<Option<u32>> {
        Ok(self.store.load_versions(id)?.last().map(|v| v.number))
    }

    /// Newest version whose content equals `scenario` (e.g. to label a run).
    pub fn matching_version(&self, scenario: &Scenario) -> CoreResult<Option<u32>> {
        Ok(self
            .store
            .load_versions(&scenario.id)?
            .iter()
            .rev()
            .find(|v| version::same_content(&v.scenario, scenario))
            .map(|v| v.number))
    }

    /// Differences from version `from` to version `to`; `None` means the
    /// current content.
    pub fn diff_versions(
        &self,
        id: &ScenarioId,
        from: Option<u32>,
        to: Option<u32>,
    ) -> CoreResult<ScenarioDiff> {
        let current = self.get(id)?;
        let load = |n: Option<u32>| n.map(|n| self.get_version(id, n)).transpose();
        let (from_v, to_v) = (load(from)?, load(to)?);
        let from_s = from_v.as_ref().map_or(&current, |v| &v.scenario);
        let to_s = to_v.as_ref().map_or(&current, |v| &v.scenario);
        Ok(version::diff(
            (from_s, version::side(from_v.as_ref(), &current)),
            (to_s, version::side(to_v.as_ref(), &current)),
        ))
    }

    /// Makes the current content equal to a version, as one undoable edit.
    /// Does nothing (and returns the current state) when it already matches.
    pub fn restore_version(
        &self,
        id: &ScenarioId,
        number: u32,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        let target = self.get_version(id, number)?;
        let label = format!("restore version {number} ({})", target.name);
        self.match_content(id, &target.scenario, expected_revision, actor, label)
    }

    fn match_content(
        &self,
        id: &ScenarioId,
        target: &Scenario,
        expected_revision: Option<u64>,
        actor: Actor,
        label: String,
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
            None,
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

    fn current_outcome(&self, scenario: Scenario) -> CoreResult<EditOutcome> {
        let (can_undo, can_redo) = self.undo_state(&scenario.id)?;
        let validation = self.validate(&scenario);
        Ok(EditOutcome {
            scenario,
            validation,
            can_undo,
            can_redo,
        })
    }

    fn next_version_number(&self, id: &ScenarioId) -> CoreResult<u32> {
        Ok(self
            .store
            .load_versions(id)?
            .last()
            .map_or(1, |v| v.number + 1))
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
        id: &ScenarioId,
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

    /// Records a human's verdict on the current revision. Sending a scenario
    /// back (`rejected`) needs a reason or at least one step note; the AI
    /// reads it with get_review / get_scenario.
    pub fn submit_review(
        &self,
        id: &ScenarioId,
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
                "sending a scenario back needs a reason or a note on a step".into(),
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
    pub fn review_timeline(
        &self,
        id: &ScenarioId,
        since: Option<u64>,
    ) -> CoreResult<ReviewTimeline> {
        let scenario = self.get(id)?;
        let journal = self.store.read_journal(id, usize::MAX)?;
        let evidence = self.store.read_evidence(id)?;
        Ok(review::timeline(
            scenario.id,
            scenario.revision,
            since,
            &journal,
            evidence,
        ))
    }

    /// The latest review when it sent the scenario back.
    pub fn open_feedback(&self, id: &ScenarioId) -> CoreResult<Option<Evidence>> {
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
        scenario: &Scenario,
        step_ids: &[crate::ids::StepId],
        actor: &Actor,
        observations: &[ObservationId],
    ) {
        for id in observations {
            let result = self.store.load_observation(id).and_then(|mut o| {
                o.linked.push(ObservationLink {
                    scenario_id: scenario.id.clone(),
                    revision: scenario.revision,
                });
                self.store.write_observation(&o)?;
                self.store.append_evidence(
                    &scenario.id,
                    &Evidence {
                        revision: scenario.revision,
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

    // -- sub-scenarios ----------------------------------------------------

    /// Moves `step_ids` (next to each other in one block) into a new
    /// scenario named `name` and puts one `scenario.call` in their place
    /// that reads and writes the same variables. Two changes: the new
    /// scenario is created, then the caller is edited once (undoable).
    pub fn extract_subscenario(
        &self,
        id: &ScenarioId,
        expected_revision: Option<u64>,
        step_ids: &[StepId],
        name: &str,
        actor: Actor,
        note: ChangeNote,
    ) -> CoreResult<ExtractOutcome> {
        let caller = self.get(id)?;
        check_revision(expected_revision, caller.revision)?;
        let plan = call::extract(&caller, step_ids, name, self.registry())?;
        let summary = review::clean_text(note.summary.clone(), review::MAX_SUMMARY_CHARS);
        let subscenario = self.insert_new(
            plan.subscenario,
            actor.clone(),
            "extract subscenario",
            summary,
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
                let _ = self.delete(&subscenario.scenario.id, None, actor);
                return Err(e);
            }
        };
        Ok(ExtractOutcome {
            subscenario,
            caller,
            call_step_id,
        })
    }

    // -- sharing ----------------------------------------------------------

    /// Packs a scenario (and optionally its versions) into a bundle for
    /// another workspace. Secret variable defaults are removed.
    pub fn export(&self, id: &ScenarioId, include_versions: bool) -> CoreResult<ScenarioBundle> {
        let mut scenario = self.get(id)?;
        version::strip_secrets(&mut scenario);
        let versions = if include_versions {
            let mut versions = self.store.load_versions(id)?;
            for v in &mut versions {
                version::strip_secrets(&mut v.scenario);
            }
            versions
        } else {
            Vec::new()
        };
        let mut subscenarios = self.called_scenarios(&scenario, &[]);
        subscenarios.iter_mut().for_each(version::strip_secrets);
        Ok(ScenarioBundle {
            format: BUNDLE_FORMAT.into(),
            format_version: BUNDLE_FORMAT_VERSION,
            exported_at: now(),
            scenario,
            versions,
            subscenarios,
        })
    }

    /// Imports a bundle or a bare scenario document.
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
        // Sub-scenarios first, so the scenario validates against them.
        let mut subscenarios = Vec::with_capacity(bundle.subscenarios.len());
        for sub in bundle.subscenarios {
            if sub.id == bundle.scenario.id || !sub.id.is_well_formed() {
                continue;
            }
            let (id, name) = (sub.id.clone(), sub.name.clone());
            let mode = if !self.store.exists(&sub.id) {
                self.insert_imported(sub, actor.clone())?;
                SubscenarioImport::Created
            } else if on_conflict == Some(ImportConflict::Update) {
                let label = "import update".to_owned();
                self.match_content(&id, &sub, None, actor.clone(), label)?;
                SubscenarioImport::Updated
            } else {
                SubscenarioImport::Kept
            };
            subscenarios.push(ImportedSubscenario { id, name, mode });
        }
        let mut scenario = bundle.scenario;
        let exists = scenario.id.is_well_formed() && self.store.exists(&scenario.id);
        let (mode, outcome) = match (exists, on_conflict) {
            (true, None) => {
                let existing = self.get(&scenario.id)?;
                return Err(CoreError::ImportConflict {
                    scenario_id: existing.id,
                    name: existing.name,
                });
            }
            (true, Some(ImportConflict::Update)) => {
                let id = scenario.id.clone();
                let label = "import update".to_owned();
                (
                    ImportMode::Updated,
                    self.match_content(&id, &scenario, None, actor, label)?,
                )
            }
            (true, Some(ImportConflict::Copy)) => {
                scenario.id = ScenarioId::generate();
                (ImportMode::Copied, self.insert_imported(scenario, actor)?)
            }
            (false, _) => {
                if !scenario.id.is_well_formed() {
                    scenario.id = ScenarioId::generate();
                }
                (ImportMode::Created, self.insert_imported(scenario, actor)?)
            }
        };
        let versions_added = self.add_versions(&outcome.scenario.id, bundle.versions)?;
        // Validated before the sub-scenarios existed when it was created.
        let outcome = EditOutcome {
            validation: self.validate(&outcome.scenario),
            ..outcome
        };
        Ok(ImportOutcome {
            mode,
            versions_added,
            subscenarios,
            outcome,
        })
    }

    fn insert_imported(&self, mut scenario: Scenario, actor: Actor) -> CoreResult<EditOutcome> {
        scenario.revision = 0;
        let now = now();
        scenario.metadata.created_at.get_or_insert(now);
        scenario.metadata.updated_at = Some(now);
        self.insert_new(scenario, actor, "import scenario", None)
    }

    /// Adds versions whose `uid` is not present yet, renumbered after the
    /// existing ones in their original order.
    fn add_versions(
        &self,
        id: &ScenarioId,
        mut incoming: Vec<ScenarioVersion>,
    ) -> CoreResult<usize> {
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
            v.number = next;
            v.scenario.id = id.clone();
            self.store.save_version(&v)?;
            next += 1;
            added += 1;
        }
        Ok(added)
    }

    fn reject_structural_errors(&self, scenario: &Scenario) -> CoreResult<()> {
        let issues = self.validator.structural_errors(scenario);
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
        id: &ScenarioId,
        expected_revision: Option<u64>,
        actor: Actor,
        kind: ChangeKind,
        summary: Option<String>,
        change: impl FnOnce(&mut UndoState, &Scenario) -> CoreResult<Commit>,
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
                    "undo history no longer matches the scenario (it was changed outside Shikigami)".into(),
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
            let patch = |requires| EditOp::UpdateScenario {
                patch: ScenarioPatch {
                    requires: Some(requires),
                    ..ScenarioPatch::default()
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
            summary,
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
            scenario_id: id.clone(),
            kind,
            revision: next.revision,
            actor,
        });
        let validation = self.validate(&next);
        Ok(EditOutcome {
            can_undo: !undo.undo.is_empty(),
            can_redo: !undo.redo.is_empty(),
            scenario: next,
            validation,
        })
    }
}

struct Commit {
    next: Scenario,
    applied: Vec<EditOp>,
    inverse: Vec<EditOp>,
    label: String,
}

fn parse_bundle(value: serde_json::Value) -> CoreResult<ScenarioBundle> {
    if !version::is_bundle(&value) {
        return Ok(ScenarioBundle {
            format: BUNDLE_FORMAT.into(),
            format_version: BUNDLE_FORMAT_VERSION,
            exported_at: now(),
            scenario: crate::migrate::from_value(value)?,
            versions: Vec::new(),
            subscenarios: Vec::new(),
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
    // The scenario documents inside (and in its versions) go through the
    // same migrations as files (`migrate::deserialize`); check their format
    // versions first so a newer one reports UNSUPPORTED_SCHEMA_VERSION.
    let items = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
    };
    let documents = value
        .get("scenario")
        .into_iter()
        .chain(items("subscenarios"))
        .chain(items("versions").filter_map(|v| v.get("scenario")));
    for document in documents {
        crate::migrate::check_supported(document)?;
    }
    Ok(serde_json::from_value(value)?)
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

    fn service() -> (tempfile::TempDir, ScenarioService) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FileStore::open(dir.path()).expect("store");
        (
            dir,
            ScenarioService::new(store, StepRegistry::with_builtins()),
        )
    }

    fn mcp() -> Actor {
        Actor::named(ActorKind::Mcp, "test-client")
    }

    fn studio() -> Actor {
        Actor::new(ActorKind::Studio)
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
        });
        registry.register(def);
        let svc = ScenarioService::new(FileStore::open(dir.path()).expect("store"), registry);
        let created = svc
            .create(
                NewScenario {
                    name: "plugin".into(),
                    description: String::new(),
                    variables: vec![],
                    steps: vec![Step::new("hello.greet").with_param("message", "hi")],
                    tags: vec![],
                },
                mcp(),
            )
            .expect("create");
        let id = created.scenario.id.clone();
        assert_eq!(created.scenario.requires["plugin:hello"], "^0.3.1");

        // A hand-set range is kept while the plugin is used.
        let patch = ScenarioPatch {
            requires: Some(BTreeMap::from([(
                "plugin:hello".into(),
                ">=0.3, <2".into(),
            )])),
            ..ScenarioPatch::default()
        };
        let loosened = svc
            .edit(&id, None, vec![EditOp::UpdateScenario { patch }], mcp())
            .expect("patch");
        assert_eq!(loosened.scenario.requires["plugin:hello"], ">=0.3, <2");
        assert!(loosened.validation.valid, "{:?}", loosened.validation);

        let step = created.scenario.steps[0].id.clone();
        let removed = svc
            .edit(&id, None, vec![EditOp::RemoveStep { step_id: step }], mcp())
            .expect("remove");
        assert!(removed.scenario.requires.is_empty());
        // Undo brings back the hand-set range, not the installed default.
        let undone = svc.undo(&id, None, mcp()).expect("undo");
        assert_eq!(undone.scenario.requires["plugin:hello"], ">=0.3, <2");
        let redone = svc.redo(&id, None, mcp()).expect("redo");
        assert!(redone.scenario.requires.is_empty());
    }

    #[test]
    fn bundles_with_newer_scenarios_are_refused() {
        let (_dir, svc) = service();
        let value = serde_json::json!({
            "format": BUNDLE_FORMAT,
            "formatVersion": 1,
            "exportedAt": "2026-10-28T00:00:00Z",
            "scenario": { "schemaVersion": 99, "id": "scn_new", "name": "x" },
        });
        let err = svc.import_bundle(value, None, mcp()).expect_err("newer");
        assert_eq!(err.code(), "UNSUPPORTED_SCHEMA_VERSION");
    }

    #[test]
    fn create_list_get_delete() {
        let (_dir, svc) = service();
        let created = svc
            .create(
                NewScenario {
                    name: "請求書処理".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create");
        assert_eq!(created.scenario.revision, 1);
        let list = svc.list().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "請求書処理");
        let id = created.scenario.id;
        assert_eq!(svc.get(&id).expect("get").name, "請求書処理");
        svc.delete(&id, Some(1), studio()).expect("delete");
        assert_eq!(svc.get(&id).expect_err("gone").code(), "SCENARIO_NOT_FOUND");
        assert!(svc.list().expect("list").is_empty());
    }

    #[test]
    fn edits_from_two_clients_detect_conflicts() {
        let (_dir, svc) = service();
        let id = svc
            .create(
                NewScenario {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .scenario
            .id;

        // MCP edits based on revision 1.
        let after_mcp = svc
            .edit(&id, Some(1), vec![add_log("from ai")], mcp())
            .expect("mcp edit");
        assert_eq!(after_mcp.scenario.revision, 2);

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
                NewScenario {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .scenario
            .id;
        let edited = svc
            .edit(&id, None, vec![add_log("a"), add_log("b")], mcp())
            .expect("edit");
        let step_id = edited.scenario.steps[0].id.clone();
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
        assert_eq!(undone.scenario.steps[0].name, "");
        assert!(undone.can_redo);
        let undone = svc.undo(&id, None, studio()).expect("undo 2");
        assert!(undone.scenario.steps.is_empty());
        assert_eq!(
            svc.undo(&id, None, studio()).expect_err("empty").code(),
            "NOTHING_TO_UNDO_OR_REDO"
        );

        let redone = svc.redo(&id, None, studio()).expect("redo");
        assert_eq!(redone.scenario.steps.len(), 2);
        assert_eq!(
            redone.scenario.steps[0].id, step_id,
            "step ids survive undo/redo"
        );
        let redone = svc.redo(&id, None, studio()).expect("redo 2");
        assert_eq!(redone.scenario.steps[0].name, "最初");

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
                NewScenario {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .scenario
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
                NewScenario {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .scenario
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
                NewScenario {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .scenario
            .id;
        svc.edit(&id, None, vec![add_log("x")], mcp())
            .expect("edit");
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(
            svc.get(&ScenarioId::new("../../etc/passwd"))
                .expect_err("bad id")
                .code(),
            "INVALID_SCENARIO_ID"
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
                NewScenario {
                    name: "s".into(),
                    ..Default::default()
                },
                mcp(),
                ChangeNote {
                    summary: None,
                    observations: vec![small.id.clone()],
                },
            )
            .expect("create")
            .scenario
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
        assert_eq!(kept.linked[0].scenario_id, id);
        assert_eq!(kept.linked[0].revision, 1);
    }

    #[test]
    fn duplicate_and_import() {
        let (_dir, svc) = service();
        let src = svc
            .create(
                NewScenario {
                    name: "元".into(),
                    steps: vec![Step::new("log.message").with_param("message", "x")],
                    ..Default::default()
                },
                mcp(),
            )
            .expect("create")
            .scenario;
        let copy = svc
            .duplicate(&src.id, None, studio())
            .expect("dup")
            .scenario;
        assert_ne!(copy.id, src.id);
        assert_eq!(copy.name, "元 のコピー");
        assert_eq!(copy.steps, src.steps);

        // Importing a document whose id already exists gets a fresh id.
        let imported = svc.import(src.clone(), studio()).expect("import").scenario;
        assert_ne!(imported.id, src.id);
        assert_eq!(svc.list().expect("list").len(), 3);
    }
}
