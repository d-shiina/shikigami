#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! A flow's folder: its document and the files it works with.

use shikigami_core::{
    Actor, ActorKind, FileStore, FlowService, ImportConflict, ImportMode, NewFlow, Step,
    StepRegistry,
};

fn service_at(root: &std::path::Path) -> FlowService {
    let store = FileStore::open_with_local(root, root, false).expect("store");
    FlowService::new(store, StepRegistry::with_builtins())
}

fn actor() -> Actor {
    Actor::named(ActorKind::Mcp, "test")
}

fn create(svc: &FlowService, name: &str) -> shikigami_core::Flow {
    svc.create(
        NewFlow {
            name: name.into(),
            steps: vec![Step::new("log.message").with_param("message", "hi")],
            ..Default::default()
        },
        actor(),
    )
    .expect("create")
    .flow
}

fn paths(svc: &FlowService, id: &shikigami_core::FlowId) -> Vec<String> {
    svc.project_files(id)
        .unwrap()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect()
}

#[test]
fn a_new_flow_gets_a_folder_with_the_standard_folders() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = create(&svc, "受注");
    let folder = dir.path().join("flows").join(s.id.as_str());
    assert!(folder.join("flow.json").is_file());
    for name in ["input", "config", "templates", "output", "work", "logs"] {
        assert!(folder.join(name).is_dir(), "{name}");
    }
    let listed = svc.project_files(&s.id).unwrap();
    assert_eq!(
        listed.folders,
        ["input", "config", "templates", "output", "work", "logs"]
    );
    assert!(listed.files.is_empty(), "flow.json is not listed");
    assert_eq!(svc.list().unwrap().len(), 1);
}

#[test]
fn flat_flow_files_move_into_folders() {
    let dir = tempfile::tempdir().unwrap();
    let id = {
        let svc = service_at(dir.path());
        create(&svc, "古い形").id
    };
    // The layout before flow folders.
    let flows = dir.path().join("flows");
    std::fs::rename(
        flows.join(id.as_str()).join("flow.json"),
        flows.join(format!("{id}.json")),
    )
    .unwrap();
    std::fs::remove_dir_all(flows.join(id.as_str())).unwrap();

    let svc = service_at(dir.path());
    assert!(!flows.join(format!("{id}.json")).exists());
    assert!(flows.join(id.as_str()).join("flow.json").is_file());
    assert!(flows.join(id.as_str()).join("input").is_dir());
    assert_eq!(svc.get(&id).unwrap().name, "古い形");
}

#[test]
fn scenario_workspaces_from_0_1_become_flow_workspaces() {
    let dir = tempfile::tempdir().unwrap();
    let (id, flat_id) = {
        let svc = service_at(dir.path());
        (create(&svc, "フォルダー").id, create(&svc, "平たい").id)
    };
    // The 0.1 layout: scenarios/<id>/scenario.json, and a flat file from
    // before folders, written with the old call step.
    let flows = dir.path().join("flows");
    let folder = flows.join(id.as_str());
    std::fs::rename(folder.join("flow.json"), folder.join("scenario.json")).unwrap();
    let old_call = serde_json::json!({
        "schemaVersion": 3, "id": flat_id.as_str(), "name": "平たい",
        "steps": [{ "id": "c", "type": "scenario.call", "params": { "scenario": id.as_str() } }]
    });
    std::fs::remove_dir_all(flows.join(flat_id.as_str())).unwrap();
    std::fs::write(flows.join(format!("{flat_id}.json")), old_call.to_string()).unwrap();
    std::fs::rename(&flows, dir.path().join("scenarios")).unwrap();

    let svc = service_at(dir.path());
    assert!(!dir.path().join("scenarios").exists());
    assert!(folder.join("flow.json").is_file());
    assert!(!folder.join("scenario.json").exists());
    assert_eq!(svc.get(&id).unwrap().name, "フォルダー");
    let caller = svc.get(&flat_id).unwrap();
    assert_eq!(caller.steps[0].step_type, "flow.call");
    assert_eq!(caller.steps[0].params["flow"], id.as_str());
    assert!(flows.join(flat_id.as_str()).join("flow.json").is_file());
}

#[test]
fn a_flat_file_written_later_is_still_read_and_moved_on_save() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = create(&svc, "a");
    let flows = dir.path().join("flows");
    // An older build creates a flow while this one is open.
    let mut other = s.clone();
    other.id = shikigami_core::FlowId::generate();
    other.name = "older build".into();
    std::fs::write(
        flows.join(format!("{}.json", other.id)),
        serde_json::to_vec(&other).unwrap(),
    )
    .unwrap();
    assert_eq!(svc.list().unwrap().len(), 2);
    assert_eq!(svc.get(&other.id).unwrap().name, "older build");
    svc.edit(
        &other.id,
        None,
        vec![shikigami_core::EditOp::UpdateFlow {
            patch: shikigami_core::FlowPatch {
                name: Some("moved".into()),
                ..Default::default()
            },
        }],
        actor(),
    )
    .unwrap();
    assert!(!flows.join(format!("{}.json", other.id)).exists());
    assert_eq!(svc.get(&other.id).unwrap().name, "moved");
}

#[test]
fn files_are_written_listed_renamed_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = create(&svc, "a");
    svc.write_project_file(&s.id, "config\\settings.json", b"{}", false)
        .unwrap();
    svc.write_project_file(&s.id, "input/2026/10.csv", b"a,b", false)
        .unwrap();
    assert_eq!(
        svc.write_project_file(&s.id, "config/settings.json", b"{}", false)
            .unwrap_err()
            .code(),
        "PROJECT_FILE_EXISTS"
    );
    for bad in ["../x.txt", "C:\\x.txt", "flow.json"] {
        assert_eq!(
            svc.write_project_file(&s.id, bad, b"", true)
                .unwrap_err()
                .code(),
            "INVALID_PROJECT_PATH",
            "{bad}"
        );
    }
    assert_eq!(
        paths(&svc, &s.id),
        ["config/settings.json", "input/2026/10.csv"]
    );
    assert!(
        svc.project_files(&s.id)
            .unwrap()
            .folders
            .contains(&"input/2026".to_owned())
    );
    assert_eq!(
        svc.read_project_file(&s.id, "input/2026/10.csv").unwrap(),
        b"a,b"
    );
    assert_eq!(
        svc.read_project_file(&s.id, "input/none.csv")
            .unwrap_err()
            .code(),
        "PROJECT_FILE_NOT_FOUND"
    );

    svc.rename_project_file(&s.id, "input/2026/10.csv", "input/10.csv")
        .unwrap();
    assert_eq!(paths(&svc, &s.id), ["config/settings.json", "input/10.csv"]);

    // Deleting goes to the trash; a standard folder is emptied, not removed.
    svc.write_project_file(&s.id, "work/tmp.txt", b"x", false)
        .unwrap();
    svc.delete_project_file(&s.id, "work").unwrap();
    assert!(svc.project_path(&s.id, "work").unwrap().is_dir());
    svc.delete_project_file(&s.id, "input/10.csv").unwrap();
    assert_eq!(paths(&svc, &s.id), ["config/settings.json"]);
    let trashed: Vec<_> = std::fs::read_dir(dir.path().join("trash"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(trashed.iter().all(|n| n.contains(".files.")), "{trashed:?}");

    // Copying in from elsewhere on the PC.
    let outside = dir.path().join("受注一覧.xlsx");
    std::fs::write(&outside, b"PK").unwrap();
    let file = svc
        .copy_into_project(&s.id, &outside, "input/受注一覧.xlsx", false)
        .unwrap();
    assert_eq!(file.path, "input/受注一覧.xlsx");
    assert_eq!(file.size, 2);
}

#[test]
fn deleting_a_flow_trashes_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = create(&svc, "a");
    svc.write_project_file(&s.id, "input/a.csv", b"x", false)
        .unwrap();
    svc.delete(&s.id, None, actor()).unwrap();
    assert!(!dir.path().join("flows").join(s.id.as_str()).exists());
    let trashed = std::fs::read_dir(dir.path().join("trash"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(trashed.join("flow.json").is_file());
    assert!(trashed.join("input").join("a.csv").is_file());
}

#[test]
fn bundles_carry_the_files_but_not_what_runs_made() {
    let from = tempfile::tempdir().unwrap();
    let svc = service_at(from.path());
    let s = create(&svc, "a");
    svc.write_project_file(&s.id, "templates/請求書.xlsx", &[0, 159, 255], false)
        .unwrap();
    svc.write_project_file(&s.id, "output/result.csv", b"made by a run", false)
        .unwrap();
    svc.write_project_file(&s.id, "logs/x.log", b"log", false)
        .unwrap();
    let bundle = svc.export(&s.id, true).unwrap();
    let carried: Vec<_> = bundle.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(carried, ["templates/請求書.xlsx"]);
    let value = serde_json::to_value(&bundle).unwrap();

    let to = tempfile::tempdir().unwrap();
    let other = service_at(to.path());
    let imported = other.import_bundle(value.clone(), None, actor()).unwrap();
    assert_eq!(imported.mode, ImportMode::Created);
    assert_eq!(
        other
            .read_project_file(&s.id, "templates/請求書.xlsx")
            .unwrap(),
        [0, 159, 255]
    );

    // A copy gets its own folder with the files.
    let copied = other
        .import_bundle(value, Some(ImportConflict::Copy), actor())
        .unwrap();
    let copy_id = copied.outcome.flow.id;
    assert_ne!(copy_id, s.id);
    assert_eq!(paths(&other, &copy_id), ["templates/請求書.xlsx"]);

    // So does a duplicate.
    let dup = svc.duplicate(&s.id, None, actor()).unwrap().flow;
    assert_eq!(paths(&svc, &dup.id), ["templates/請求書.xlsx"]);
}
