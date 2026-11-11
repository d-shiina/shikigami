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
