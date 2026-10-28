//! `ScenarioService`: the single API through which every client reads and
//! changes scenarios. Studio (Tauri commands), the MCP server and the CLI are
//! thin adapters over this type; none of them manipulate documents directly.

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::ids::ScenarioId;
use crate::model::{Scenario, ScenarioSummary, Step, VariableDef, now};
use crate::ops::{self, EditOp};
use crate::registry::StepRegistry;
use crate::store::{Actor, ChangeKind, FileStore, HistoryEntry, UNDO_LIMIT, UndoState};
use crate::validate::{ValidationReport, Validator};

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

    pub fn validate(&self, scenario: &Scenario) -> ValidationReport {
        self.validator.validate(scenario)
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
        let mut scenario = Scenario::new(input.name);
        scenario.description = input.description;
        scenario.variables = input.variables;
        scenario.steps = input.steps;
        scenario.metadata.tags = input.tags;
        self.insert_new(scenario, actor, "create scenario")
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
        self.insert_new(scenario, actor, "import scenario")
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
        copy.metadata.tags = source.metadata.tags;
        self.insert_new(copy, actor, "duplicate scenario")
    }

    fn insert_new(
        &self,
        mut scenario: Scenario,
        actor: Actor,
        label: &str,
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
        if ops.is_empty() {
            return Err(CoreError::InvalidEdit("no operations given".into()));
        }
        let label = if ops.len() == 1 {
            ops[0].label()
        } else {
            format!("{} edits", ops.len())
        };
        self.commit(
            id,
            expected_revision,
            actor,
            ChangeKind::Edit,
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
            applied,
            inverse,
            label,
        } = change(&mut undo, &current)?;
        self.reject_structural_errors(&next)?;
        next.id = current.id.clone();
        next.revision = current.revision + 1;
        ops::touch(&mut next.metadata);

        let entry = HistoryEntry {
            kind,
            revision: next.revision,
            actor: actor.clone(),
            at: now(),
            label,
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
