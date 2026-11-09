#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! 配布フォルダー: one PC puts published versions in a shared folder,
//! another sees what is new and takes it in.

use shikigami_core::distribution::{DistributedState, DistributionFolder};
use shikigami_core::{
    Actor, ActorKind, EditOp, FileStore, FlowPatch, FlowService, ImportConflict, NewFlow,
    PublishInput, Step, StepRegistry,
};

fn service_at(root: &std::path::Path) -> FlowService {
    let store = FileStore::open_with_local(root, root.join("local"), false).expect("store");
    FlowService::new(store, StepRegistry::with_builtins())
}

fn person() -> Actor {
    Actor::named(ActorKind::Studio, "daiki")
}

fn folder(shared: &std::path::Path) -> Vec<DistributionFolder> {
    vec![DistributionFolder {
        name: "経理課".into(),
        path: shared.to_string_lossy().into_owned(),
    }]
}

#[test]
fn a_new_version_in_the_folder_shows_up_as_an_update() {
    let shared = tempfile::tempdir().unwrap();
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = service_at(a_dir.path());
    let b = service_at(b_dir.path());
    a.set_distribution_folders(folder(shared.path())).unwrap();
    b.set_distribution_folders(folder(shared.path())).unwrap();

    let flow = a
        .create(
            NewFlow {
                name: "請求書の集計".into(),
                steps: vec![Step::new("log.message").with_param("message", "1")],
                ..Default::default()
            },
            person(),
        )
        .unwrap()
        .flow;
    // Only a published version goes to the folder.
    assert!(
        a.place_in_distribution(&flow.id, "経理課", None, None)
            .is_err()
    );
    a.publish(&flow.id, PublishInput::default(), person())
        .unwrap();
    let first = a
        .place_in_distribution(&flow.id, "経理課", None, Some("椎名".into()))
        .unwrap();
    assert!(first.ends_with("請求書の集計 v1.spx"));
    // Putting the same version again writes nothing new.
    assert_eq!(
        a.place_in_distribution(&flow.id, "経理課", None, None)
            .unwrap(),
        first
    );
    assert_eq!(std::fs::read_dir(shared.path()).unwrap().count(), 1);

    let seen = b.scan_distribution().unwrap();
    let item = &seen[0].flows[0];
    assert_eq!(item.state, DistributedState::New);
    assert_eq!(item.exported_by.as_deref(), Some("椎名"));
    let bytes = std::fs::read(&item.path).unwrap();
    b.import_file(&bytes, None, person()).unwrap();
    assert_eq!(
        b.scan_distribution().unwrap()[0].flows[0].state,
        DistributedState::Latest
    );

    // The sender changes it, publishes v2 and puts it there; v1 stays beside it.
    a.edit(
        &flow.id,
        None,
        vec![EditOp::UpdateFlow {
            patch: FlowPatch {
                description: Some("締め日基準に変更".into()),
                ..FlowPatch::default()
            },
        }],
        person(),
    )
    .unwrap();
    a.publish(&flow.id, PublishInput::default(), person())
        .unwrap();
    a.place_in_distribution(&flow.id, "経理課", None, None)
        .unwrap();
    let seen = b.scan_distribution().unwrap();
    assert_eq!(seen[0].flows.len(), 1);
    let item = &seen[0].flows[0];
    assert_eq!(item.state, DistributedState::Update);
    assert_eq!(item.version.number, 2);
    assert_eq!(item.local_version, Some(1));
    let bytes = std::fs::read(&item.path).unwrap();
    b.import_file(&bytes, Some(ImportConflict::Update), person())
        .unwrap();
    assert_eq!(
        b.scan_distribution().unwrap()[0].flows[0].state,
        DistributedState::Latest
    );
    // Taking it in does not publish it here.
    assert!(b.published(&flow.id).unwrap().is_none());
}

#[test]
fn a_folder_that_cannot_be_reached_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let gone = dir.path().join("ない");
    svc.set_distribution_folders(folder(&gone)).unwrap();
    let seen = svc.scan_distribution().unwrap();
    assert!(seen[0].error.is_some());
    assert!(seen[0].flows.is_empty());
}

#[test]
fn placing_puts_only_the_files_chosen() {
    let shared = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    svc.set_distribution_folders(folder(shared.path())).unwrap();
    let flow = svc
        .create(
            NewFlow {
                name: "勤怠の締め".into(),
                steps: vec![Step::new("log.message").with_param("message", "1")],
                ..Default::default()
            },
            person(),
        )
        .unwrap()
        .flow;
    svc.write_project_file(&flow.id, "templates/ひな形.xlsx", b"t", false)
        .unwrap();
    svc.write_project_file(&flow.id, "config/設定.json", b"{}", false)
        .unwrap();
    svc.publish(&flow.id, PublishInput::default(), person())
        .unwrap();
    let only = vec![shikigami_core::package::FileRef {
        flow_id: flow.id.clone(),
        path: "config/設定.json".into(),
    }];
    let path = svc
        .place_in_distribution(&flow.id, "経理課", Some(only), None)
        .unwrap();
    let manifest = shikigami_core::package::read_manifest(&std::fs::read(path).unwrap()).unwrap();
    let paths: Vec<_> = manifest.contents.iter().map(|e| e.path.as_str()).collect();
    assert!(paths.iter().any(|p| p.ends_with("config/設定.json")));
    assert!(!paths.iter().any(|p| p.contains("templates/")));
    // No temporary file is left beside it.
    assert_eq!(std::fs::read_dir(shared.path()).unwrap().count(), 1);
}
