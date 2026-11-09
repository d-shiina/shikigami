#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! `.spx` packages: handing a flow to another person or PC.

use std::io::Write as _;

use shikigami_core::package::{CheckKind, CheckStatus, PackageContent, PackageOptions};
use shikigami_core::{
    Actor, ActorKind, EditOp, FileStore, FlowPatch, FlowService, ImportConflict, ImportMode,
    NewFlow, PublishInput, Step, StepRegistry, TargetDef,
};

fn registry() -> StepRegistry {
    let mut registry = StepRegistry::with_builtins();
    let mut def = registry.get("log.message").unwrap().clone();
    def.step_type = "web.open".into();
    def.targets = vec![TargetDef::site("url")];
    def.params_schema = serde_json::json!({ "type": "object" });
    def.secret_params = vec!["password".into()];
    registry.register(def);
    registry
}

fn service_at(root: &std::path::Path) -> FlowService {
    let store = FileStore::open_with_local(root, root, false).expect("store");
    FlowService::new(store, registry())
}

fn ai() -> Actor {
    Actor::named(ActorKind::Mcp, "test")
}

fn person() -> Actor {
    Actor::named(ActorKind::Studio, "daiki")
}

fn create(svc: &FlowService) -> shikigami_core::Flow {
    svc.create(
        NewFlow {
            name: "請求書の集計".into(),
            steps: vec![
                Step::new("web.open").with_param("url", "https://orders.example.com/list?x=1"),
                Step::new("web.open").with_param("url", "{{ 1 + 1 }}"),
                Step::new("web.open")
                    .with_param("url", "https://orders.example.com/login")
                    .with_param(
                        "password",
                        serde_json::json!({ "secret": "受注システム", "field": "password" }),
                    ),
            ],
            ..Default::default()
        },
        ai(),
    )
    .expect("create")
    .flow
}

fn rename(svc: &FlowService, id: &shikigami_core::FlowId, description: &str) {
    svc.edit(
        id,
        None,
        vec![EditOp::UpdateFlow {
            patch: FlowPatch {
                description: Some(description.into()),
                ..FlowPatch::default()
            },
        }],
        ai(),
    )
    .unwrap();
}

#[test]
fn a_package_carries_the_published_version_and_says_what_it_needs() {
    let from = tempfile::tempdir().unwrap();
    let svc = service_at(from.path());
    let flow = create(&svc);
    svc.write_project_file(&flow.id, "templates/ひな形.xlsx", &[1, 2, 3], false)
        .unwrap();
    svc.write_project_file(&flow.id, "input/顧客一覧.xlsx", b"real data", false)
        .unwrap();
    svc.publish(&flow.id, PublishInput::default(), person())
        .unwrap();
    // Work after publishing is not what goes out by default.
    rename(&svc, &flow.id, "まだ確認していない変更");

    let plan = svc.package_plan(&flow.id, PackageContent::Auto).unwrap();
    assert_eq!(plan.published.as_ref().unwrap().number, 1);
    assert!(plan.has_unpublished_changes);
    assert_eq!(plan.file_name, "請求書の集計 v1.spx");
    let input = plan
        .files
        .iter()
        .find(|f| f.path.starts_with("input/"))
        .unwrap();
    assert!(!input.included_by_default);

    let (manifest, bytes) = svc
        .export_package(&flow.id, &PackageOptions::default())
        .unwrap();
    assert!(manifest.flow.published);
    assert_eq!(manifest.flow.version.as_ref().unwrap().number, 1);
    assert_eq!(manifest.flow.description, "");
    assert_eq!(manifest.requires.secrets, ["受注システム"]);
    assert_eq!(manifest.requires.sites, ["https://orders.example.com"]);
    let paths: Vec<_> = manifest.contents.iter().map(|e| e.path.as_str()).collect();
    assert!(paths.contains(&"flow.json"));
    assert!(paths.contains(&"versions/1.json"));
    assert!(paths.iter().any(|p| p.ends_with("templates/ひな形.xlsx")));
    assert!(!paths.iter().any(|p| p.contains("input/")));

    // The current content, when asked for.
    let (current, _) = svc
        .export_package(
            &flow.id,
            &PackageOptions {
                content: PackageContent::Current,
                include_input: true,
                ..PackageOptions::default()
            },
        )
        .unwrap();
    assert!(!current.flow.published);
    assert!(current.flow.version.is_none());
    assert_eq!(current.flow.description, "まだ確認していない変更");
    assert!(current.contents.iter().any(|e| e.path.contains("input/")));

    // On another PC: what is missing, then import.
    let to = tempfile::tempdir().unwrap();
    let other = service_at(to.path());
    let preview = other.preview_package(&bytes, &[]).unwrap();
    assert!(preview.existing.is_none());
    let secret = preview
        .checks
        .iter()
        .find(|c| c.kind == CheckKind::Secret)
        .unwrap();
    assert_eq!(secret.status, CheckStatus::Missing);
    let preview = other
        .preview_package(&bytes, &["受注システム".to_owned()])
        .unwrap();
    assert!(preview.checks.iter().all(|c| c.status == CheckStatus::Ok));

    let imported = other.import_file(&bytes, None, ai()).unwrap();
    assert_eq!(imported.mode, ImportMode::Created);
    assert_eq!(imported.outcome.flow.id, flow.id);
    let versions = other.list_versions(&flow.id).unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].number, 1);
    assert_eq!(
        other
            .read_project_file(&flow.id, "templates/ひな形.xlsx")
            .unwrap(),
        [1, 2, 3]
    );
    assert!(
        other
            .read_project_file(&flow.id, "input/顧客一覧.xlsx")
            .is_err()
    );
    // Nothing runs unattended until a person here publishes it.
    assert!(other.published(&flow.id).unwrap().is_none());

    // The next version arrives as an update with its own number.
    svc.publish(&flow.id, PublishInput::default(), person())
        .unwrap();
    let (next, bytes) = svc
        .export_package(&flow.id, &PackageOptions::default())
        .unwrap();
    assert_eq!(next.flow.version.as_ref().unwrap().number, 2);
    let preview = other.preview_package(&bytes, &[]).unwrap();
    let existing = preview.existing.unwrap();
    assert_eq!(existing.latest_version, Some(1));
    assert!(!existing.has_package_version);
    assert!(!existing.diff.identical);
    let updated = other
        .import_file(&bytes, Some(ImportConflict::Update), ai())
        .unwrap();
    assert_eq!(updated.mode, ImportMode::Updated);
    let numbers: Vec<_> = other
        .list_versions(&flow.id)
        .unwrap()
        .iter()
        .map(|v| v.number)
        .collect();
    assert_eq!(numbers, [2, 1]);
}

#[test]
fn a_changed_package_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let flow = create(&svc);
    let (_, bytes) = svc
        .export_package(&flow.id, &PackageOptions::default())
        .unwrap();

    // Same manifest, different flow.json.
    let mut original = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for i in 0..original.len() {
        let mut entry = original.by_index(i).unwrap();
        let name = entry.name().unwrap().into_owned();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
        if name == "flow.json" {
            data = String::from_utf8(data)
                .unwrap()
                .replace("orders.example.com", "evil.example.com")
                .into_bytes();
        }
        out.start_file(name, options).unwrap();
        out.write_all(&data).unwrap();
    }
    let tampered = out.finish().unwrap().into_inner();
    let err = svc.import_file(&tampered, None, ai()).unwrap_err();
    assert!(err.to_string().contains("damaged"), "{err}");
}

#[test]
fn old_json_bundles_still_import() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let flow = create(&svc);
    let bundle = svc.export(&flow.id, true).unwrap();
    let json = serde_json::to_vec(&bundle).unwrap();
    let to = tempfile::tempdir().unwrap();
    let other = service_at(to.path());
    // The check before importing works on them too.
    let preview = other.preview_file(&json, &[]).unwrap();
    assert_eq!(preview.manifest.flow.name, "請求書の集計");
    let imported = other.import_file(&json, None, ai()).unwrap();
    assert_eq!(imported.outcome.flow.name, "請求書の集計");
}

fn plain(svc: &FlowService, name: &str, steps: Vec<Step>) -> shikigami_core::Flow {
    svc.create(
        NewFlow {
            name: name.into(),
            steps,
            ..Default::default()
        },
        ai(),
    )
    .unwrap()
    .flow
}

fn calls(target: &shikigami_core::FlowId) -> Step {
    Step::new("flow.call").with_param("flow", target.as_str())
}

#[test]
fn a_published_subflow_brings_what_its_published_version_calls() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let c = plain(
        &svc,
        "C",
        vec![Step::new("log.message").with_param("message", "c")],
    );
    svc.publish(&c.id, PublishInput::default(), person())
        .unwrap();
    let b = plain(&svc, "B", vec![calls(&c.id)]);
    svc.publish(&b.id, PublishInput::default(), person())
        .unwrap();
    // B no longer calls C now, but its published version does.
    let step = svc.get(&b.id).unwrap().steps[0].id.clone();
    svc.edit(
        &b.id,
        None,
        vec![EditOp::RemoveStep { step_id: step }],
        ai(),
    )
    .unwrap();
    let a = plain(&svc, "A", vec![calls(&b.id)]);
    svc.publish(&a.id, PublishInput::default(), person())
        .unwrap();

    let (manifest, _) = svc
        .export_package(&a.id, &PackageOptions::default())
        .unwrap();
    let ids: Vec<_> = manifest.subflows.iter().map(|s| s.id.clone()).collect();
    assert!(ids.contains(&b.id) && ids.contains(&c.id), "{ids:?}");
}

#[test]
fn files_not_listed_stay_out() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let sub = plain(
        &svc,
        "Sub",
        vec![Step::new("log.message").with_param("message", "s")],
    );
    svc.write_project_file(&sub.id, "input/名簿.xlsx", b"real", false)
        .unwrap();
    let main = plain(
        &svc,
        "Main",
        vec![Step::new("log.message").with_param("message", "m")],
    );
    svc.write_project_file(&main.id, "templates/ひな形.xlsx", b"t", false)
        .unwrap();
    svc.publish(&main.id, PublishInput::default(), person())
        .unwrap();
    // Now (not published) it also calls Sub.
    svc.edit(
        &main.id,
        None,
        vec![EditOp::AddStep {
            step: calls(&sub.id),
            position: Default::default(),
        }],
        ai(),
    )
    .unwrap();

    let published = svc.package_plan(&main.id, PackageContent::Auto).unwrap();
    assert!(!published.current);
    assert!(published.files.iter().all(|f| f.flow_id == main.id));
    let current = svc.package_plan(&main.id, PackageContent::Current).unwrap();
    assert!(current.current);
    assert_eq!(current.file_name, "Main.spx");
    assert!(current.files.iter().any(|f| f.flow_id == sub.id));

    // The dialog sends exactly what it showed and was ticked.
    let only = vec![shikigami_core::package::FileRef {
        flow_id: main.id.clone(),
        path: "templates/ひな形.xlsx".into(),
    }];
    let (manifest, _) = svc
        .export_package(
            &main.id,
            &PackageOptions {
                content: PackageContent::Current,
                include_input: true,
                only: Some(only),
                ..PackageOptions::default()
            },
        )
        .unwrap();
    assert!(
        manifest
            .contents
            .iter()
            .any(|e| e.path.ends_with("templates/ひな形.xlsx"))
    );
    assert!(!manifest.contents.iter().any(|e| e.path.contains("input/")));
}

#[test]
fn an_update_keeps_the_input_files_already_here() {
    let from = tempfile::tempdir().unwrap();
    let svc = service_at(from.path());
    let flow = plain(
        &svc,
        "名簿の取り込み",
        vec![Step::new("log.message").with_param("message", "m")],
    );
    svc.write_project_file(&flow.id, "input/名簿.xlsx", b"sample", false)
        .unwrap();
    svc.write_project_file(&flow.id, "templates/ひな形.xlsx", b"v1", false)
        .unwrap();
    let with_input = PackageOptions {
        content: PackageContent::Current,
        include_input: true,
        ..PackageOptions::default()
    };
    let (_, bytes) = svc.export_package(&flow.id, &with_input).unwrap();

    let to = tempfile::tempdir().unwrap();
    let other = service_at(to.path());
    other.import_file(&bytes, None, ai()).unwrap();
    // First time: the sample comes along. Then this PC puts its own data.
    assert_eq!(
        other
            .read_project_file(&flow.id, "input/名簿.xlsx")
            .unwrap(),
        b"sample"
    );
    other
        .write_project_file(&flow.id, "input/名簿.xlsx", b"ours", true)
        .unwrap();

    svc.write_project_file(&flow.id, "input/名簿.xlsx", b"sample 2", true)
        .unwrap();
    svc.write_project_file(&flow.id, "input/追加.csv", b"new", false)
        .unwrap();
    svc.write_project_file(&flow.id, "templates/ひな形.xlsx", b"v2", true)
        .unwrap();
    rename(&svc, &flow.id, "ひな形を直した");
    let (_, bytes) = svc.export_package(&flow.id, &with_input).unwrap();

    // The sheet says which files stay as they are.
    let existing = other
        .preview_package(&bytes, &[])
        .unwrap()
        .existing
        .unwrap();
    assert_eq!(existing.kept_inputs, ["input/名簿.xlsx"]);

    let updated = other
        .import_file(&bytes, Some(ImportConflict::Update), ai())
        .unwrap();
    assert_eq!(updated.mode, ImportMode::Updated);
    let read = |path: &str| other.read_project_file(&flow.id, path).unwrap();
    assert_eq!(read("input/名簿.xlsx"), b"ours");
    assert_eq!(read("input/追加.csv"), b"new");
    assert_eq!(read("templates/ひな形.xlsx"), b"v2");

    // A copy is a new flow: it gets everything in the file.
    let copied = other
        .import_file(&bytes, Some(ImportConflict::Copy), ai())
        .unwrap();
    assert_eq!(
        other
            .read_project_file(&copied.outcome.flow.id, "input/名簿.xlsx")
            .unwrap(),
        b"sample 2"
    );
}
