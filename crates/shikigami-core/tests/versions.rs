#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::json;
use shikigami_core::{
    Actor, ActorKind, DiffKind, EditOp, FileStore, ImportConflict, ImportMode, NewScenario,
    NewVersion, Position, ScenarioService, Step, StepPatch, StepRegistry, VarType, VariableDef,
    WorkspaceManifest,
};

fn service_at(root: &std::path::Path) -> ScenarioService {
    let store = FileStore::open_with_local(root, root, false).expect("store");
    ScenarioService::new(store, StepRegistry::with_builtins())
}

fn actor() -> Actor {
    Actor::named(ActorKind::Mcp, "test")
}

fn log(id: &str, message: &str) -> Step {
    Step::new("log.message")
        .with_id(id)
        .with_param("message", message)
}

fn version(name: &str) -> NewVersion {
    NewVersion {
        name: name.into(),
        note: String::new(),
    }
}

fn scenario_with_steps(svc: &ScenarioService) -> shikigami_core::Scenario {
    svc.create(
        NewScenario {
            name: "請求書処理".into(),
            steps: vec![log("stp_a", "a"), log("stp_b", "b"), log("stp_c", "c")],
            ..Default::default()
        },
        actor(),
    )
    .expect("create")
    .scenario
}

#[test]
fn versions_are_numbered_and_listed_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = scenario_with_steps(&svc);
    let v1 = svc
        .create_version(&s.id, version("v1"), None, actor())
        .unwrap();
    assert_eq!(v1.number, 1);
    assert_eq!(v1.revision, 1);
    let err = svc
        .create_version(&s.id, version("x"), Some(99), actor())
        .unwrap_err();
    assert_eq!(err.code(), "REVISION_CONFLICT");
    assert_eq!(
        svc.create_version(&s.id, version("  "), None, actor())
            .unwrap_err()
            .code(),
        "INVALID_EDIT"
    );
    svc.create_version(&s.id, version("v2"), None, actor())
        .unwrap();
    let list = svc.list_versions(&s.id).unwrap();
    assert_eq!(
        list.iter().map(|v| v.number).collect::<Vec<_>>(),
        vec![2, 1]
    );
    assert_eq!(svc.get_version(&s.id, 1).unwrap().scenario.steps.len(), 3);
    assert_eq!(
        svc.get_version(&s.id, 9).unwrap_err().code(),
        "VERSION_NOT_FOUND"
    );
}

#[test]
fn diff_reports_added_removed_changed_and_moved_steps() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = scenario_with_steps(&svc);
    svc.create_version(&s.id, version("v1"), None, actor())
        .unwrap();
    svc.edit(
        &s.id,
        None,
        vec![
            EditOp::RemoveStep {
                step_id: "stp_b".into(),
            },
            EditOp::UpdateStep {
                step_id: "stp_a".into(),
                patch: StepPatch {
                    params: Some(json!({ "message": "A" }).as_object().unwrap().clone()),
                    ..Default::default()
                },
            },
            EditOp::MoveStep {
                step_id: "stp_c".into(),
                position: Position {
                    index: Some(0),
                    ..Default::default()
                },
            },
            EditOp::AddStep {
                step: Step::new("control.if")
                    .with_id("stp_if")
                    .with_param("condition", "true")
                    .with_block("then", vec![log("stp_inner", "x")]),
                position: Position::default(),
            },
            EditOp::SetVariable {
                variable: VariableDef::new("total", VarType::Number),
                index: None,
            },
        ],
        actor(),
    )
    .unwrap();

    let diff = svc.diff_versions(&s.id, Some(1), None).unwrap();
    assert!(!diff.identical);
    assert_eq!(diff.from.version, Some(1));
    assert_eq!(diff.to.label, "current");
    let kinds: Vec<(DiffKind, &str)> = diff
        .steps
        .iter()
        .map(|c| (c.kind, c.step_id.as_str()))
        .collect();
    assert!(kinds.contains(&(DiffKind::Removed, "stp_b")));
    assert!(kinds.contains(&(DiffKind::Changed, "stp_a")));
    assert!(kinds.contains(&(DiffKind::Added, "stp_if")));
    // Children of an added step are not reported separately.
    assert!(!kinds.iter().any(|(_, id)| *id == "stp_inner"));
    // Only c changed its order relative to a; a is not reported as moved.
    assert!(
        kinds.contains(&(DiffKind::Moved, "stp_c")) ^ kinds.contains(&(DiffKind::Moved, "stp_a"))
    );
    let changed = diff
        .steps
        .iter()
        .find(|c| c.kind == DiffKind::Changed)
        .unwrap();
    assert_eq!(changed.fields[0].field, "params.message");
    assert_eq!(changed.fields[0].before, Some(json!("a")));
    let added = diff
        .steps
        .iter()
        .find(|c| c.kind == DiffKind::Added)
        .unwrap();
    assert_eq!(added.step_count, Some(2));
    assert_eq!(diff.variables.len(), 1);
    assert_eq!(diff.variables[0].kind, DiffKind::Added);

    let same = svc.diff_versions(&s.id, Some(1), Some(1)).unwrap();
    assert!(same.identical);
}

#[test]
fn restore_is_one_undoable_edit_and_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = scenario_with_steps(&svc);
    svc.create_version(&s.id, version("v1"), None, actor())
        .unwrap();
    let edited = svc
        .edit(
            &s.id,
            None,
            vec![
                EditOp::RemoveStep {
                    step_id: "stp_a".into(),
                },
                EditOp::SetVariable {
                    variable: VariableDef::new("x", VarType::String),
                    index: None,
                },
            ],
            actor(),
        )
        .unwrap()
        .scenario;

    let restored = svc
        .restore_version(&s.id, 1, Some(edited.revision), actor())
        .unwrap();
    assert_eq!(restored.scenario.revision, edited.revision + 1);
    assert_eq!(restored.scenario.steps, s.steps);
    assert!(restored.scenario.variables.is_empty());
    assert_eq!(svc.matching_version(&restored.scenario).unwrap(), Some(1));

    // Restoring again changes nothing.
    let again = svc.restore_version(&s.id, 1, None, actor()).unwrap();
    assert_eq!(again.scenario.revision, restored.scenario.revision);

    // One undo brings the edited content back.
    let undone = svc.undo(&s.id, None, actor()).unwrap().scenario;
    assert_eq!(undone.steps, edited.steps);
    assert_eq!(undone.variables, edited.variables);
    let history = svc.history(&s.id, 5).unwrap();
    assert!(history.iter().any(|h| h.label == "restore version 1 (v1)"));
}

#[test]
fn bundle_round_trip_between_workspaces() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = service_at(a_dir.path());
    let b = service_at(b_dir.path());
    let s = scenario_with_steps(&a);
    let mut secret = VariableDef::new("password", VarType::String);
    secret.secret = true;
    secret.default = Some(json!("hunter2"));
    a.edit(
        &s.id,
        None,
        vec![EditOp::SetVariable {
            variable: secret,
            index: None,
        }],
        actor(),
    )
    .unwrap();
    a.create_version(&s.id, version("v1"), None, actor())
        .unwrap();

    let bundle = a.export(&s.id, true).unwrap();
    let text = serde_json::to_string(&bundle).unwrap();
    assert!(
        !text.contains("hunter2"),
        "secret defaults must not be exported"
    );
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();

    let first = b.import_bundle(value.clone(), None, actor()).unwrap();
    assert_eq!(first.mode, ImportMode::Created);
    assert_eq!(
        first.outcome.scenario.id, s.id,
        "IDs are kept across workspaces"
    );
    assert_eq!(first.versions_added, 1);

    // Same ID again: the caller must choose.
    let err = b.import_bundle(value.clone(), None, actor()).unwrap_err();
    assert_eq!(err.code(), "IMPORT_CONFLICT");

    // Update with nothing new: no edit, no duplicate versions.
    let same = b
        .import_bundle(value.clone(), Some(ImportConflict::Update), actor())
        .unwrap();
    assert_eq!(same.mode, ImportMode::Updated);
    assert_eq!(same.versions_added, 0);
    assert_eq!(
        same.outcome.scenario.revision,
        first.outcome.scenario.revision
    );

    // A newer export from A updates B and brings the new version along.
    a.edit(
        &s.id,
        None,
        vec![EditOp::RemoveStep {
            step_id: "stp_c".into(),
        }],
        actor(),
    )
    .unwrap();
    a.create_version(&s.id, version("v2"), None, actor())
        .unwrap();
    let newer = serde_json::to_value(a.export(&s.id, true).unwrap()).unwrap();
    let updated = b
        .import_bundle(newer.clone(), Some(ImportConflict::Update), actor())
        .unwrap();
    assert_eq!(updated.versions_added, 1);
    assert_eq!(updated.outcome.scenario.steps.len(), 2);
    assert!(updated.outcome.can_undo);
    assert_eq!(b.list_versions(&s.id).unwrap()[0].name, "v2");

    let copy = b
        .import_bundle(newer, Some(ImportConflict::Copy), actor())
        .unwrap();
    assert_eq!(copy.mode, ImportMode::Copied);
    assert_ne!(copy.outcome.scenario.id, s.id);
    assert_eq!(b.list_versions(&copy.outcome.scenario.id).unwrap().len(), 2);
}

#[test]
fn bare_scenario_documents_import_too() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let doc = json!({
        "schemaVersion": 1,
        "id": "scn_handwritten",
        "name": "手書き",
        "steps": [{ "type": "log.message", "params": { "message": "hi" } }]
    });
    let out = svc.import_bundle(doc, None, actor()).unwrap();
    assert_eq!(out.mode, ImportMode::Created);
    assert_eq!(out.outcome.scenario.id.as_str(), "scn_handwritten");
    assert_eq!(out.versions_added, 0);
}

#[test]
fn shared_workspace_keeps_per_pc_data_outside() {
    let shared = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    FileStore::init(shared.path(), &WorkspaceManifest { shared: true }).unwrap();
    let store = FileStore::open_with_local(shared.path(), local.path(), true).unwrap();
    assert!(store.is_shared());
    let svc = ScenarioService::new(store, StepRegistry::with_builtins());
    let s = scenario_with_steps(&svc);
    svc.create_version(&s.id, version("v1"), None, actor())
        .unwrap();
    svc.edit(
        &s.id,
        None,
        vec![EditOp::RemoveStep {
            step_id: "stp_a".into(),
        }],
        actor(),
    )
    .unwrap();

    assert!(
        shared
            .path()
            .join("scenarios")
            .join(format!("{}.json", s.id))
            .is_file()
    );
    assert!(
        shared
            .path()
            .join("versions")
            .join(s.id.as_str())
            .join("1.json")
            .is_file()
    );
    assert!(!shared.path().join("history").exists());
    assert!(
        local
            .path()
            .join("history")
            .join(s.id.as_str())
            .join("undo.json")
            .is_file()
    );
}
