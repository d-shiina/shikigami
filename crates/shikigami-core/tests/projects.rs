#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! A scenario's folder: its document and the files it works with.

use shikigami_core::{
    Actor, ActorKind, FileStore, ImportConflict, ImportMode, NewScenario, ScenarioService, Step,
    StepRegistry,
};

fn service_at(root: &std::path::Path) -> ScenarioService {
    let store = FileStore::open_with_local(root, root, false).expect("store");
    ScenarioService::new(store, StepRegistry::with_builtins())
}

fn actor() -> Actor {
    Actor::named(ActorKind::Mcp, "test")
}

fn create(svc: &ScenarioService, name: &str) -> shikigami_core::Scenario {
    svc.create(
        NewScenario {
            name: name.into(),
            steps: vec![Step::new("log.message").with_param("message", "hi")],
            ..Default::default()
        },
        actor(),
    )
    .expect("create")
    .scenario
}

fn paths(svc: &ScenarioService, id: &shikigami_core::ScenarioId) -> Vec<String> {
    svc.project_files(id)
        .unwrap()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect()
}

#[test]
fn a_new_scenario_gets_a_folder_with_the_standard_folders() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = create(&svc, "受注");
    let folder = dir.path().join("scenarios").join(s.id.as_str());
    assert!(folder.join("scenario.json").is_file());
    for name in ["input", "config", "templates", "output", "work", "logs"] {
        assert!(folder.join(name).is_dir(), "{name}");
    }
    let listed = svc.project_files(&s.id).unwrap();
    assert_eq!(
        listed.folders,
        ["input", "config", "templates", "output", "work", "logs"]
    );
    assert!(listed.files.is_empty(), "scenario.json is not listed");
    assert_eq!(svc.list().unwrap().len(), 1);
}

#[test]
fn flat_scenario_files_move_into_folders() {
    let dir = tempfile::tempdir().unwrap();
    let id = {
        let svc = service_at(dir.path());
        create(&svc, "古い形").id
    };
    // The layout before scenario folders.
    let scenarios = dir.path().join("scenarios");
    std::fs::rename(
        scenarios.join(id.as_str()).join("scenario.json"),
        scenarios.join(format!("{id}.json")),
    )
    .unwrap();
    std::fs::remove_dir_all(scenarios.join(id.as_str())).unwrap();

    let svc = service_at(dir.path());
    assert!(!scenarios.join(format!("{id}.json")).exists());
    assert!(scenarios.join(id.as_str()).join("scenario.json").is_file());
    assert!(scenarios.join(id.as_str()).join("input").is_dir());
    assert_eq!(svc.get(&id).unwrap().name, "古い形");
}

#[test]
fn a_flat_file_written_later_is_still_read_and_moved_on_save() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = create(&svc, "a");
    let scenarios = dir.path().join("scenarios");
    // An older build creates a scenario while this one is open.
    let mut other = s.clone();
    other.id = shikigami_core::ScenarioId::generate();
    other.name = "older build".into();
    std::fs::write(
        scenarios.join(format!("{}.json", other.id)),
        serde_json::to_vec(&other).unwrap(),
    )
    .unwrap();
    assert_eq!(svc.list().unwrap().len(), 2);
    assert_eq!(svc.get(&other.id).unwrap().name, "older build");
    svc.edit(
        &other.id,
        None,
        vec![shikigami_core::EditOp::UpdateScenario {
            patch: shikigami_core::ScenarioPatch {
                name: Some("moved".into()),
                ..Default::default()
            },
        }],
        actor(),
    )
    .unwrap();
    assert!(!scenarios.join(format!("{}.json", other.id)).exists());
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
    for bad in ["../x.txt", "C:\\x.txt", "scenario.json"] {
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
fn deleting_a_scenario_trashes_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let s = create(&svc, "a");
    svc.write_project_file(&s.id, "input/a.csv", b"x", false)
        .unwrap();
    svc.delete(&s.id, None, actor()).unwrap();
    assert!(!dir.path().join("scenarios").join(s.id.as_str()).exists());
    let trashed = std::fs::read_dir(dir.path().join("trash"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(trashed.join("scenario.json").is_file());
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
    let copy_id = copied.outcome.scenario.id;
    assert_ne!(copy_id, s.id);
    assert_eq!(paths(&other, &copy_id), ["templates/請求書.xlsx"]);

    // So does a duplicate.
    let dup = svc.duplicate(&s.id, None, actor()).unwrap().scenario;
    assert_eq!(paths(&svc, &dup.id), ["templates/請求書.xlsx"]);
}
