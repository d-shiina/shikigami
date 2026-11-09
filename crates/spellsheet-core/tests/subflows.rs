#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::json;
use spellsheet_core::{
    Actor, ActorKind, ChangeNote, FileStore, FlowService, ImportConflict, NewFlow, Step, StepId,
    StepRegistry, SubflowImport, VarDirection, VarType, VariableDef,
};

fn service_at(root: &std::path::Path) -> FlowService {
    let store = FileStore::open_with_local(root, root, false).expect("store");
    FlowService::new(store, StepRegistry::with_builtins())
}

fn actor() -> Actor {
    Actor::named(ActorKind::Mcp, "test")
}

fn set(id: &str, name: &str, expression: &str) -> Step {
    Step::new("variable.set")
        .with_id(id)
        .with_param("name", name)
        .with_param("expression", expression)
}

fn var(name: &str, ty: VarType, direction: VarDirection) -> VariableDef {
    VariableDef {
        direction,
        ..VariableDef::new(name, ty)
    }
}

fn create(
    svc: &FlowService,
    name: &str,
    variables: Vec<VariableDef>,
    steps: Vec<Step>,
) -> spellsheet_core::Flow {
    svc.create(
        NewFlow {
            name: name.into(),
            variables,
            steps,
            ..Default::default()
        },
        actor(),
    )
    .expect("create")
    .flow
}

fn call(target: &spellsheet_core::FlowId) -> Step {
    Step::new("flow.call")
        .with_param("flow", target.as_str())
        .with_param("inputs", json!({ "amount": 10 }))
        .with_param("outputs", json!({ "taxed": "total" }))
}

fn tax(svc: &FlowService) -> spellsheet_core::Flow {
    create(
        svc,
        "税込み",
        vec![
            var("amount", VarType::Number, VarDirection::Input),
            var("taxed", VarType::Number, VarDirection::Output),
        ],
        vec![set("stp_t", "taxed", "amount * 1.1")],
    )
}

#[test]
fn a_called_flow_cannot_be_deleted_and_is_listed_as_a_subflow() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let callee = tax(&svc);
    let main = create(&svc, "本体", vec![], vec![call(&callee.id)]);
    assert!(svc.validate(&main).valid, "{:?}", svc.validate(&main));

    let err = svc.delete(&callee.id, None, actor()).unwrap_err();
    assert_eq!(err.code(), "FLOW_IN_USE");
    assert_eq!(err.details().unwrap()["callers"][0]["id"], json!(main.id));

    let subs = svc.subflows(&main).unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].flow.id, callee.id);
    assert_eq!(svc.callers(&callee.id).unwrap()[0].id, main.id);

    // Without the caller it can go.
    svc.delete(&main.id, None, actor()).unwrap();
    svc.delete(&callee.id, None, actor()).unwrap();
}

#[test]
fn bundles_carry_their_subflows() {
    let from = tempfile::tempdir().unwrap();
    let svc = service_at(from.path());
    let callee = tax(&svc);
    let main = create(&svc, "本体", vec![], vec![call(&callee.id)]);
    let bundle = serde_json::to_value(svc.export(&main.id, false).unwrap()).unwrap();
    assert_eq!(bundle["subflows"][0]["id"], json!(callee.id));

    let to = tempfile::tempdir().unwrap();
    let other = service_at(to.path());
    let outcome = other.import_bundle(bundle.clone(), None, actor()).unwrap();
    assert!(
        outcome.outcome.validation.valid,
        "{:?}",
        outcome.outcome.validation
    );
    assert_eq!(outcome.subflows[0].mode, SubflowImport::Created);

    // Importing again: the sub-flow is kept unless asked to update.
    let again = other
        .import_bundle(bundle.clone(), Some(ImportConflict::Copy), actor())
        .unwrap();
    assert_eq!(again.subflows[0].mode, SubflowImport::Kept);
    let update = other
        .import_bundle(bundle, Some(ImportConflict::Update), actor())
        .unwrap();
    assert_eq!(update.subflows[0].mode, SubflowImport::Updated);
}

#[test]
fn extracting_steps_creates_a_flow_and_one_undoable_edit() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let main = create(
        &svc,
        "請求",
        vec![var("total", VarType::Number, VarDirection::Output)],
        vec![
            set("stp_a", "price", "100"),
            set("stp_b", "taxed", "price * 1.1"),
            set("stp_c", "total", "taxed + 5"),
        ],
    );
    let outcome = svc
        .extract_subflow(
            &main.id,
            Some(main.revision),
            &[StepId::new("stp_b")],
            "税込みにする",
            actor(),
            ChangeNote::default(),
        )
        .unwrap();
    let caller = &outcome.caller.flow;
    assert!(
        outcome.caller.validation.valid,
        "{:?}",
        outcome.caller.validation
    );
    assert_eq!(caller.steps.len(), 3);
    assert_eq!(caller.steps[1].step_type, "flow.call");
    assert_eq!(caller.steps[1].id, outcome.call_step_id);
    assert_eq!(
        caller.steps[1].params["flow"],
        json!(outcome.subflow.flow.id)
    );
    assert_eq!(
        caller.steps[1].params["inputs"],
        json!({ "price": "{{ price }}" })
    );
    assert_eq!(
        caller.steps[1].params["outputs"],
        json!({ "taxed": "taxed" })
    );
    // `price` was only assigned before the call; it is declared now so it
    // always has a value to pass. `taxed` only comes out of the call.
    assert!(caller.variable("price").is_some());
    assert!(caller.variable("taxed").is_none());
    assert_eq!(outcome.subflow.flow.steps[0].id.as_str(), "stp_b");

    // One undo puts the steps back.
    let undone = svc.undo(&main.id, None, actor()).unwrap();
    assert_eq!(undone.flow.steps[1].id.as_str(), "stp_b");
    assert!(undone.flow.variable("price").is_none());

    let err = svc
        .extract_subflow(
            &main.id,
            Some(main.revision),
            &[StepId::new("stp_a")],
            "x",
            actor(),
            ChangeNote::default(),
        )
        .unwrap_err();
    assert_eq!(err.code(), "REVISION_CONFLICT");
}

#[test]
fn a_bundles_own_subflows_lead_to_the_workspace_ones_they_call() {
    let dir = tempfile::tempdir().unwrap();
    let svc = service_at(dir.path());
    let tax = tax(&svc);
    // `wrap` is only in the bundle; it calls `tax` from the workspace.
    let mut wrap = spellsheet_core::Flow::new("包む");
    wrap.id = "scn_wrap".into();
    wrap.steps = vec![call(&tax.id).with_id("w1")];
    wrap.variables = vec![var("total", VarType::Number, VarDirection::Output)];
    let mut main = spellsheet_core::Flow::new("本体");
    main.steps = vec![
        Step::new("flow.call")
            .with_id("m1")
            .with_param("flow", "scn_wrap"),
    ];
    assert!(
        svc.validate_bundled(&main, std::slice::from_ref(&wrap))
            .valid
    );
    let ids: Vec<String> = svc
        .subflows_bundled(&main, &[wrap])
        .unwrap()
        .into_iter()
        .map(|s| s.flow.id.as_str().to_owned())
        .collect();
    assert!(ids.contains(&"scn_wrap".to_owned()), "{ids:?}");
    assert!(ids.contains(&tax.id.as_str().to_owned()), "{ids:?}");
}
