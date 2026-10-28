//! `scenario.call`: running another scenario as one step.

use std::time::Duration;

use serde_json::json;
use shikigami_core::registry::scenario::CALL;
use shikigami_core::{OnError, Step, StepId, Subscenario, VarDirection, VarType, VariableDef};

use super::*;

fn var(name: &str, ty: VarType, dir: VarDirection) -> VariableDef {
    VariableDef {
        direction: dir,
        ..VariableDef::new(name, ty)
    }
}

fn set(name: &str, expression: &str) -> Step {
    Step::new("variable.set")
        .with_param("name", name)
        .with_param("expression", expression)
}

fn with_ids(mut s: Scenario, prefix: &str) -> Scenario {
    fn walk(steps: &mut [Step], prefix: &str, n: &mut u32) {
        for step in steps {
            if step.id.is_empty() {
                *n += 1;
                step.id = format!("{prefix}{n}").into();
            }
            for children in step.blocks.values_mut() {
                walk(children, prefix, n);
            }
        }
    }
    walk(&mut s.steps, prefix, &mut 0);
    s
}

/// `tax`: input `amount`, output `taxed = amount * 1.1` (rounded), and a
/// local `scratch` that must not leak out.
fn tax() -> Scenario {
    let mut s = Scenario::new("税込みにする");
    s.id = "scn_tax".into();
    s.variables = vec![
        var("amount", VarType::Number, VarDirection::Input),
        var("taxed", VarType::Number, VarDirection::Output),
    ];
    s.steps = vec![
        set("scratch", "amount * 2"),
        set("taxed", "round(amount * 1.1)"),
    ];
    with_ids(s, "t")
}

fn call(target: &str, inputs: Value, outputs: Value) -> Step {
    Step::new(CALL)
        .with_param("scenario", target)
        .with_param("inputs", inputs)
        .with_param("outputs", outputs)
}

fn caller(steps: Vec<Step>, variables: Vec<VariableDef>) -> Scenario {
    let mut s = Scenario::new("呼ぶ側");
    s.id = "scn_main".into();
    s.variables = variables;
    s.steps = steps;
    with_ids(s, "m")
}

fn subs(list: Vec<Scenario>) -> Vec<Subscenario> {
    list.into_iter()
        .map(|scenario| Subscenario {
            scenario,
            version: None,
        })
        .collect()
}

async fn run_with(
    runtime: &Runtime,
    main: Scenario,
    called: Vec<Scenario>,
) -> (RunReport, Vec<RunEventEnvelope>) {
    let handle = runtime
        .start(
            main,
            RunOptions {
                subscenarios: subs(called),
                ..RunOptions::default()
            },
        )
        .expect("start");
    let mut events = Vec::new();
    let report = handle
        .wait_with(|e| events.push(e.clone()))
        .await
        .expect("wait");
    (report, events)
}

#[tokio::test]
async fn a_call_passes_inputs_and_returns_only_its_outputs() {
    let main = caller(
        vec![
            set("price", "1000"),
            call(
                "scn_tax",
                json!({ "amount": "{{ price }}" }),
                json!({ "taxed": "total" }),
            ),
        ],
        vec![var("total", VarType::Number, VarDirection::Output)],
    );
    let (report, events) = run_with(&Runtime::new(), main, vec![tax()]).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs.get("total"), Some(&json!(1100)));
    assert_eq!(report.subscenarios.len(), 1);
    assert_eq!(report.subscenarios[0].scenario_id.as_str(), "scn_tax");

    // The callee's own variables stay inside it.
    let top_level_vars: Vec<&str> = events
        .iter()
        .filter(|e| e.call_path.is_empty())
        .filter_map(|e| match &e.event {
            RunEvent::VariableChanged { variable, .. } => Some(variable.as_str()),
            _ => None,
        })
        .collect();
    assert!(top_level_vars.contains(&"total"));
    assert!(!top_level_vars.contains(&"scratch"));

    // Events from inside carry the call step, top-level ones do not.
    let inside: Vec<&RunEventEnvelope> = events
        .iter()
        .filter(|e| matches!(&e.event, RunEvent::StepStarted { step_id, .. } if step_id.as_str() == "t2"))
        .collect();
    assert_eq!(inside.len(), 1);
    assert_eq!(inside[0].call_path, vec![StepId::new("m2")]);
}

#[tokio::test]
async fn the_called_scenario_cannot_see_the_callers_variables() {
    let mut leak = Scenario::new("覗く");
    leak.id = "scn_leak".into();
    leak.steps = vec![Step::new("log.message").with_param("message", "{{ secretNote }}")];
    let leak = with_ids(leak, "l");
    let main = caller(
        vec![
            set("secretNote", "'内緒'"),
            call("scn_leak", json!({}), json!({})),
        ],
        vec![],
    );
    // Validation only warns about the unknown name, so the run starts and
    // fails inside the call.
    let (report, _) = run_with(&Runtime::new(), main, vec![leak]).await;
    assert_eq!(report.status, RunStatus::Failed);
    let error = report.error.expect("error");
    assert_eq!(error.code, "EXPR_UNDEFINED_VARIABLE");
    assert_eq!(error.step_id.as_ref().map(StepId::as_str), Some("m2"));
    assert_eq!(error.step_type.as_deref(), Some(CALL));
    let sub = &error.details.expect("details")["subScenario"];
    assert_eq!(sub["scenarioId"], json!("scn_leak"));
    assert_eq!(sub["stepId"], json!("l1"));
}

#[tokio::test]
async fn failures_inside_are_caught_by_the_caller() {
    let mut boom = Scenario::new("失敗する");
    boom.id = "scn_boom".into();
    boom.steps = vec![
        Step::new("control.fail")
            .with_param("message", "だめでした")
            .with_param("code", "NOPE"),
    ];
    let boom = with_ids(boom, "b");

    let mut skipped = call("scn_boom", json!({}), json!({}));
    skipped.on_error = Some(OnError::Continue);
    let main = caller(
        vec![
            Step::new("control.try")
                .with_block("try", vec![call("scn_boom", json!({}), json!({}))])
                .with_block("catch", vec![set("caught", "error.code")]),
            skipped,
            set("after", "lastError.code"),
        ],
        vec![
            var("caught", VarType::String, VarDirection::Output),
            var("after", VarType::String, VarDirection::Output),
        ],
    );
    let (report, _) = run_with(&Runtime::new(), main, vec![boom]).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs.get("caught"), Some(&json!("NOPE")));
    assert_eq!(report.outputs.get("after"), Some(&json!("NOPE")));
}

#[tokio::test]
async fn missing_and_unknown_targets_do_not_start() {
    let main = caller(
        vec![call("scn_tax", json!({}), json!({ "taxed": "total" }))],
        vec![],
    );
    let err = Runtime::new()
        .start(main.clone(), RunOptions::default())
        .err()
        .expect("not provided");
    let codes: Vec<String> =
        serde_json::from_value::<shikigami_core::ValidationReport>(err.details.expect("report"))
            .expect("report")
            .issues
            .into_iter()
            .map(|i| i.code)
            .collect();
    assert!(
        codes.contains(&"CALL_TARGET_NOT_FOUND".to_owned()),
        "{codes:?}"
    );

    let err = Runtime::new()
        .start(
            main,
            RunOptions {
                subscenarios: subs(vec![tax()]),
                ..RunOptions::default()
            },
        )
        .err()
        .expect("amount missing");
    assert!(
        err.details
            .expect("report")
            .to_string()
            .contains("CALL_MISSING_INPUT")
    );
}

#[tokio::test]
async fn nested_calls_report_the_whole_call_path() {
    let mut outer = Scenario::new("外側");
    outer.id = "scn_outer".into();
    outer.variables = vec![
        var("x", VarType::Number, VarDirection::Input),
        var("y", VarType::Number, VarDirection::Output),
    ];
    outer.steps = vec![call(
        "scn_tax",
        json!({ "amount": "{{ x }}" }),
        json!({ "taxed": "y" }),
    )];
    let outer = with_ids(outer, "o");
    let main = caller(
        vec![call(
            "scn_outer",
            json!({ "x": 200 }),
            json!({ "y": "result" }),
        )],
        vec![var("result", VarType::Number, VarDirection::Output)],
    );
    let (report, events) = run_with(&Runtime::new(), main, vec![outer, tax()]).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs.get("result"), Some(&json!(220)));
    let deepest = events
        .iter()
        .find(|e| matches!(&e.event, RunEvent::StepStarted { step_id, .. } if step_id.as_str() == "t1"))
        .expect("inner step ran");
    assert_eq!(
        deepest.call_path,
        vec![StepId::new("m1"), StepId::new("o1")]
    );
}

#[tokio::test]
async fn a_call_times_out_as_a_whole_and_can_be_cancelled() {
    let mut slow = Scenario::new("遅い");
    slow.id = "scn_slow".into();
    slow.steps = vec![Step::new("flow.delay").with_param("ms", 5_000)];
    let slow = with_ids(slow, "w");

    let mut limited = call("scn_slow", json!({}), json!({}));
    limited.timeout_ms = Some(50);
    let main = caller(vec![limited], vec![]);
    let (report, _) = run_with(&Runtime::new(), main, vec![slow.clone()]).await;
    assert_eq!(report.status, RunStatus::Failed);
    let error = report.error.expect("error");
    assert_eq!(error.code, "STEP_TIMEOUT");
    assert_eq!(error.step_id.as_ref().map(StepId::as_str), Some("m1"));

    let main = caller(vec![call("scn_slow", json!({}), json!({}))], vec![]);
    let handle = Runtime::new()
        .start(
            main,
            RunOptions {
                subscenarios: subs(vec![slow]),
                ..RunOptions::default()
            },
        )
        .expect("start");
    let cancel = handle.cancel_token();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
    });
    let report = handle.wait().await.expect("wait");
    assert_eq!(report.status, RunStatus::Cancelled);
}

#[tokio::test]
async fn secrets_found_inside_a_call_stay_masked_outside() {
    let mut login = Scenario::new("ログイン");
    login.id = "scn_login".into();
    login.variables = vec![
        VariableDef {
            secret: true,
            ..var("password", VarType::String, VarDirection::Input)
        },
        var("echo", VarType::String, VarDirection::Output),
    ];
    login.steps = vec![set("echo", "'pw=' + password")];
    let login = with_ids(login, "g");
    let main = caller(
        vec![
            call(
                "scn_login",
                json!({ "password": "{{ pw }}" }),
                json!({ "echo": "echo" }),
            ),
            Step::new("log.message").with_param("message", "{{ echo }}"),
        ],
        vec![
            VariableDef {
                secret: true,
                default: None,
                ..var("pw", VarType::String, VarDirection::Input)
            },
            var("echo", VarType::String, VarDirection::Output),
        ],
    );
    let handle = Runtime::new()
        .start(
            main,
            RunOptions {
                inputs: json!({ "pw": "hunter2-long" })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                subscenarios: subs(vec![login]),
                ..RunOptions::default()
            },
        )
        .expect("start");
    let mut events = Vec::new();
    let report = handle
        .wait_with(|e| events.push(e.clone()))
        .await
        .expect("wait");
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let text = serde_json::to_string(&events).expect("json");
    assert!(!text.contains("hunter2-long"), "{text}");
}
