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
            project_dir: None,
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

#[tokio::test]
async fn a_failed_call_still_hands_back_what_it_assigned() {
    let mut half = Scenario::new("途中で失敗");
    half.id = "scn_half".into();
    half.variables = vec![
        var("x", VarType::Number, VarDirection::Output),
        var("y", VarType::String, VarDirection::Output),
    ];
    half.steps = vec![
        set("x", "1"),
        Step::new("control.fail")
            .with_param("message", "だめ")
            .with_param("code", "NOPE"),
    ];
    let half = with_ids(half, "h");
    let main = caller(
        vec![
            set("y", "'keep'"),
            Step::new("control.try")
                .with_block(
                    "try",
                    vec![call("scn_half", json!({}), json!({ "x": "x", "y": "y" }))],
                )
                .with_block("catch", vec![set("seen", "x")]),
        ],
        vec![
            var("seen", VarType::Number, VarDirection::Output),
            var("y", VarType::String, VarDirection::Output),
        ],
    );
    let (report, _) = run_with(&Runtime::new(), main, vec![half]).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs.get("seen"), Some(&json!(1)));
    // `y` was never assigned inside, so the caller's value stays.
    assert_eq!(report.outputs.get("y"), Some(&json!("keep")));
}

/// Starts `main` interactively and answers each pause with the next of
/// `commands`, returning where it paused (`callPath/stepId`) and the report.
async fn debug_run(
    main: Scenario,
    called: Vec<Scenario>,
    options: crate::DebugOptions,
    commands: Vec<crate::DebugCommand>,
) -> (Vec<String>, RunReport) {
    let mut handle = Runtime::new()
        .start(
            main,
            RunOptions {
                subscenarios: subs(called),
                debug: Some(options),
                ..RunOptions::default()
            },
        )
        .expect("start");
    let control = handle.debug_control().expect("debug control");
    let mut commands = commands.into_iter();
    let mut paused_at = Vec::new();
    while let Some(event) = tokio::time::timeout(Duration::from_secs(5), handle.next_event())
        .await
        .expect("the run stalled")
    {
        if let RunEvent::Paused { step_id, .. } = &event.event {
            let mut at: Vec<String> = event.call_path.iter().map(ToString::to_string).collect();
            at.push(step_id.to_string());
            paused_at.push(at.join("/"));
            let command = commands.next().unwrap_or(crate::DebugCommand::Continue);
            control.send(command).expect("resume");
        }
    }
    (paused_at, handle.wait().await.expect("wait"))
}

fn broken() -> Scenario {
    let mut broken = Scenario::new("壊れている");
    broken.id = "scn_broken".into();
    broken.steps = vec![Step::new("control.fail").with_param("message", "boom")];
    with_ids(broken, "b")
}

#[tokio::test]
async fn an_interactive_run_pauses_on_an_error_inside_the_callee() {
    let main = caller(
        vec![call("scn_broken", json!({}), json!({})), set("after", "1")],
        vec![],
    );
    let options = crate::DebugOptions {
        pause_on_error: true,
        ..Default::default()
    };
    let (paused_at, report) = debug_run(
        main,
        vec![broken()],
        options,
        vec![crate::DebugCommand::Skip],
    )
    .await;
    // Where it failed, not the call step; skipped there, the call goes on.
    assert_eq!(paused_at, vec!["m1/b1".to_owned()]);
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
}

#[tokio::test]
async fn giving_up_inside_a_call_does_not_pause_again_at_the_call() {
    let main = caller(vec![call("scn_broken", json!({}), json!({}))], vec![]);
    let options = crate::DebugOptions {
        pause_on_error: true,
        ..Default::default()
    };
    let (paused_at, report) = debug_run(
        main,
        vec![broken()],
        options,
        vec![crate::DebugCommand::Abort],
    )
    .await;
    assert_eq!(paused_at, vec!["m1/b1".to_owned()]);
    assert_eq!(report.status, RunStatus::Failed);
}

#[tokio::test]
async fn errors_a_call_handles_do_not_pause_inside_it() {
    let mut handled = call("scn_broken", json!({}), json!({}));
    handled.on_error = Some(OnError::Continue);
    let main = caller(vec![handled, set("after", "1")], vec![]);
    let options = crate::DebugOptions {
        pause_on_error: true,
        ..Default::default()
    };
    let (paused_at, report) = debug_run(main, vec![broken()], options, vec![]).await;
    assert!(paused_at.is_empty(), "{paused_at:?}");
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
}

#[tokio::test]
async fn stepping_goes_into_a_call_and_back_out() {
    let main = caller(
        vec![
            set("price", "1000"),
            call(
                "scn_tax",
                json!({ "amount": "{{ price }}" }),
                json!({ "taxed": "total" }),
            ),
            set("after", "1"),
        ],
        vec![],
    );
    use crate::DebugCommand::{StepInto, StepOut, StepOver};
    let start = || crate::DebugOptions {
        pause_at_start: true,
        ..Default::default()
    };
    // Into the call, one step inside, then out to the step after it.
    let (paused_at, report) = debug_run(
        main.clone(),
        vec![tax()],
        start(),
        vec![
            StepOver,
            StepInto,
            StepOver,
            StepOut,
            crate::DebugCommand::Continue,
        ],
    )
    .await;
    assert_eq!(paused_at, vec!["m1", "m2", "m2/t1", "m2/t2", "m3"]);
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    // Over the call: nothing inside stops.
    let (paused_at, _) = debug_run(
        main,
        vec![tax()],
        start(),
        vec![StepOver, StepOver, StepOver, crate::DebugCommand::Continue],
    )
    .await;
    assert_eq!(paused_at, vec!["m1", "m2", "m3"]);
}

#[tokio::test]
async fn breakpoints_inside_a_called_scenario_pause() {
    let main = caller(
        vec![call("scn_tax", json!({ "amount": 1 }), json!({}))],
        vec![],
    );
    let options = crate::DebugOptions {
        // `t2` alone would be a step of the caller's.
        breakpoints: vec!["scn_tax/t2".into(), "t1".into()],
        ..Default::default()
    };
    let (paused_at, report) = debug_run(main, vec![tax()], options, vec![]).await;
    assert_eq!(paused_at, vec!["m1/t2".to_owned()]);
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
}
