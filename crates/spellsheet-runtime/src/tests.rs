use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde_json::json;
use spellsheet_core::registry::{RiskLevel, StepCategory};
use spellsheet_core::{RetryPolicy, Step, VarDirection, VarType, VariableDef};

use super::*;

fn flow(steps: Vec<Step>) -> Flow {
    let mut s = Flow::new("test");
    s.steps = steps;
    let mut n = 0;
    for step in s.steps.iter_mut() {
        assign_ids(step, &mut n);
    }
    s
}

fn assign_ids(step: &mut Step, n: &mut u32) {
    if step.id.is_empty() {
        *n += 1;
        step.id = format!("s{n}").into();
    }
    for children in step.blocks.values_mut() {
        for c in children {
            assign_ids(c, n);
        }
    }
}

fn var(name: &str, ty: VarType, dir: VarDirection, default: Option<Value>) -> VariableDef {
    VariableDef {
        direction: dir,
        default,
        ..VariableDef::new(name, ty)
    }
}

fn set(name: &str, expression: &str) -> Step {
    Step::new("variable.set")
        .with_param("name", name)
        .with_param("expression", expression)
}

fn log(message: &str) -> Step {
    Step::new("log.message").with_param("message", message)
}

async fn run(runtime: &Runtime, s: Flow, inputs: Value) -> (RunReport, Vec<RunEventEnvelope>) {
    let inputs = inputs.as_object().cloned().unwrap_or_default();
    let handle = runtime
        .start(
            s,
            RunOptions {
                inputs,
                run_id: None,
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

fn logs(events: &[RunEventEnvelope]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::Log { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// Test adapter step type: fails until the given attempt, then returns the attempt number.
fn flaky_def() -> StepTypeDef {
    StepTypeDef {
        targets: Vec::new(),
        step_type: "test.flaky".into(),
        category: StepCategory::Other,
        label: "flaky".into(),
        description: String::new(),
        params_schema: json!({ "type": "object", "properties": { "succeedOn": { "type": "integer" }, "sleepMs": { "type": "integer" } } }),
        blocks: vec![],
        has_output: true,
        expression_params: vec![],
        binds_variables: vec![],
        risk: RiskLevel::Safe,
        examples: vec![],
        resources: vec![],
        secret_params: vec![],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        path_params: Vec::new(),
    }
}

struct Flaky(AtomicU32);

impl ActionHandler for Flaky {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            if let Some(ms) = input.params.get("sleepMs").and_then(Value::as_u64) {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            let succeed_on = input
                .params
                .get("succeedOn")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            if u64::from(input.attempt) >= succeed_on {
                Ok(json!(input.attempt))
            } else {
                Err(StepError::new("ELEMENT_NOT_FOUND", "not yet"))
            }
        })
    }
}

fn flaky_runtime() -> Runtime {
    Runtime::builder()
        .register(flaky_def(), Flaky(AtomicU32::new(0)))
        .build()
}

#[tokio::test]
async fn runs_the_example_flow_without_ai() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/invoice-summary.json");
    let text = std::fs::read_to_string(path).expect("example");
    let s = spellsheet_core::migrate::parse_flow(&text).expect("parse");
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs.get("total"), Some(&json!(170000)));
    assert_eq!(report.outputs.get("flagged"), Some(&json!(["INV-002"])));
    let logs = logs(&events);
    assert_eq!(
        logs.first().map(String::as_str),
        Some("3 件の請求書を処理します")
    );
    assert!(logs.iter().any(|l| l.contains("INV-002 (150000 円)")));
    // Events are strictly ordered.
    assert!(events.windows(2).all(|w| w[0].seq < w[1].seq));
    assert!(matches!(
        events.last().map(|e| &e.event),
        Some(RunEvent::RunFinished { .. })
    ));
}

#[tokio::test]
async fn inputs_are_type_checked() {
    let mut s = flow(vec![]);
    s.variables
        .push(var("n", VarType::Number, VarDirection::Input, None));
    let (report, _) = run(&Runtime::new(), s.clone(), json!({})).await;
    assert_eq!(report.error.map(|e| e.code), Some("MISSING_INPUT".into()));
    let (report, _) = run(&Runtime::new(), s.clone(), json!({ "n": "x" })).await;
    assert_eq!(report.error.map(|e| e.code), Some("INVALID_INPUT".into()));
    let (report, _) = run(&Runtime::new(), s, json!({ "n": 1, "zzz": 2 })).await;
    assert_eq!(report.error.map(|e| e.code), Some("UNKNOWN_INPUT".into()));
}

#[tokio::test]
async fn invalid_flows_do_not_start() {
    let s = flow(vec![Step::new("control.if")]);
    let err = Runtime::new()
        .start(s, RunOptions::default())
        .err()
        .expect("invalid");
    assert_eq!(err.code, "VALIDATION_FAILED");
}

#[tokio::test]
async fn japanese_variable_names_run_end_to_end() {
    let mut s = flow(vec![
        set("合計金額", "0"),
        Step::new("control.forEach")
            .with_param("items", "受注一覧")
            .with_param("itemVar", "受注")
            .with_block("body", vec![set("合計金額", "合計金額 + num(受注.金額)")]),
        Step::new("variable.set")
            .with_param("name", "表示")
            .with_param("value", "{{ 宛名 }} 様：合計 {{ 合計金額 }} 円"),
    ]);
    s.variables
        .push(var("受注一覧", VarType::Array, VarDirection::Input, None));
    s.variables
        .push(var("宛名", VarType::String, VarDirection::Input, None));
    s.variables
        .push(var("合計金額", VarType::Number, VarDirection::Output, None));
    s.variables
        .push(var("表示", VarType::String, VarDirection::Output, None));
    let inputs = json!({ "受注一覧": [{ "金額": "100" }, { "金額": "250" }], "宛名": "山田" });
    let (report, _) = run(&Runtime::new(), s, inputs).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["合計金額"], json!(350));
    assert_eq!(report.outputs["表示"], json!("山田 様：合計 350 円"));
}

#[tokio::test]
async fn loops_with_break_and_continue() {
    let mut s = flow(vec![
        set("acc", "''"),
        Step::new("control.repeat")
            .with_param("count", 10)
            .with_param("indexVar", "i")
            .with_block(
                "body",
                vec![
                    Step::new("control.if")
                        .with_param("condition", "i == 1")
                        .with_block("then", vec![Step::new("control.continue")]),
                    Step::new("control.if")
                        .with_param("condition", "i >= 4")
                        .with_block("then", vec![Step::new("control.break")]),
                    set("acc", "acc + i"),
                ],
            ),
        set("n", "0"),
        Step::new("control.while")
            .with_param("condition", "n < 3")
            .with_block("body", vec![set("n", "n + 1")]),
    ]);
    s.variables
        .push(var("acc", VarType::String, VarDirection::Output, None));
    s.variables
        .push(var("n", VarType::Number, VarDirection::Output, None));
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["acc"], json!("023"));
    assert_eq!(report.outputs["n"], json!(3));
    // Each loop says which round it starts and how its rounds ended (Studio shows it on the frame).
    let rounds: Vec<(u64, Option<u64>)> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::LoopRound { round, total, .. } => Some((*round, *total)),
            _ => None,
        })
        .collect();
    assert_eq!(
        rounds,
        vec![
            (1, Some(10)),
            (2, Some(10)),
            (3, Some(10)),
            (4, Some(10)),
            (5, Some(10)),
            (1, None),
            (2, None),
            (3, None),
        ]
    );
    let ended: Vec<(u64, Option<u64>, bool)> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::LoopEnded {
                rounds,
                total,
                left_early,
                ..
            } => Some((*rounds, *total, *left_early)),
            _ => None,
        })
        .collect();
    assert_eq!(ended, vec![(5, Some(10), true), (3, None, false)]);
}

#[tokio::test]
async fn for_each_reports_its_rounds() {
    let s = flow(vec![
        Step::new("control.forEach")
            .with_param("items", "[1, 2, 3]")
            .with_param("itemVar", "x")
            .with_block("body", vec![log("{{ x }}")]),
        Step::new("control.forEach")
            .with_param("items", "[]")
            .with_param("itemVar", "x")
            .with_block("body", vec![log("never")]),
    ]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let ended: Vec<(u64, Option<u64>, bool)> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::LoopEnded {
                rounds,
                total,
                left_early,
                ..
            } => Some((*rounds, *total, *left_early)),
            _ => None,
        })
        .collect();
    assert_eq!(ended, vec![(3, Some(3), false), (0, Some(0), false)]);
}

#[tokio::test]
async fn switch_runs_the_first_matching_case_or_default() {
    let case = |values: Option<Value>, condition: Option<&str>, message: &str| {
        let mut step = Step::new("control.case").with_block("body", vec![log(message)]);
        if let Some(values) = values {
            step = step.with_param("values", values);
        }
        if let Some(condition) = condition {
            step = step.with_param("condition", condition);
        }
        step
    };
    let switch = || {
        Step::new("control.switch")
            .with_param("value", "kind")
            .with_block(
                "cases",
                vec![
                    case(Some(json!(["A", "B"])), None, "AB"),
                    case(Some(json!(["{{ special }}"])), None, "special"),
                    case(Some(json!([1])), None, "one"),
                    // Like `Case Is >= 10`; the earlier cases win when both match.
                    case(None, Some("kind >= 10"), "big"),
                    {
                        let mut off = case(Some(json!([5])), None, "disabled");
                        off.disabled = true;
                        off
                    },
                ],
            )
            .with_block("default", vec![log("default: {{ kind }}")])
    };
    for (kind, expected) in [
        (json!("B"), "AB"),
        (json!("S"), "special"),
        (json!(1.0), "one"),
        (json!(25), "big"),
        (json!(5), "default: 5"),
        (json!(3), "default: 3"),
    ] {
        let mut s = flow(vec![switch()]);
        s.variables
            .push(var("kind", VarType::Any, VarDirection::Input, None));
        s.variables.push(var(
            "special",
            VarType::String,
            VarDirection::Local,
            Some(json!("S")),
        ));
        let (report, events) = run(&Runtime::new(), s, json!({ "kind": kind })).await;
        assert_eq!(
            report.status,
            RunStatus::Succeeded,
            "{kind}: {:?}",
            report.error
        );
        assert_eq!(logs(&events), [expected], "{kind}");
    }

    // The case that ran is reported as a step of its own; the others are not.
    let mut s = flow(vec![switch()]);
    s.variables
        .push(var("kind", VarType::Any, VarDirection::Input, None));
    s.variables.push(var(
        "special",
        VarType::String,
        VarDirection::Local,
        Some(json!("S")),
    ));
    let (_, events) = run(&Runtime::new(), s, json!({ "kind": 1 })).await;
    let started: Vec<String> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::StepStarted { step_type, .. } => Some(step_type.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(started, ["control.switch", "control.case", "log.message"]);
}

#[tokio::test]
async fn infinite_loops_are_bounded() {
    let s = flow(vec![
        Step::new("control.while")
            .with_param("condition", "true")
            .with_param("maxIterations", 5),
    ]);
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(
        report.error.map(|e| e.code),
        Some("LOOP_LIMIT_EXCEEDED".into())
    );
}

#[tokio::test]
async fn try_catch_finally() {
    let mut s = flow(vec![
        Step::new("control.try")
            .with_param("errorVar", "err")
            .with_block(
                "try",
                vec![
                    log("before"),
                    Step::new("control.fail")
                        .with_param("message", "boom")
                        .with_param("code", "MY_ERROR")
                        .with_id("failing"),
                    log("never"),
                ],
            )
            .with_block("catch", vec![set("caught", "err.code + ':' + err.stepId")])
            .with_block("finally", vec![log("cleanup")]),
    ]);
    s.variables
        .push(var("caught", VarType::String, VarDirection::Output, None));
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(report.outputs["caught"], json!("MY_ERROR:failing"));
    let logs = logs(&events);
    assert!(logs.contains(&"cleanup".to_string()));
    assert!(!logs.contains(&"never".to_string()));
}

#[tokio::test]
async fn failures_record_the_failing_step() {
    let s = flow(vec![
        Step::new("control.if")
            .with_param("condition", "true")
            .with_block("then", vec![set("x", "undefinedThing + 1").with_id("bad")]),
    ]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Failed);
    let error = report.error.expect("error");
    assert_eq!(error.code, "EXPR_UNDEFINED_VARIABLE");
    assert_eq!(error.step_id.as_ref().map(|s| s.as_str()), Some("bad"));
    assert_eq!(error.step_type.as_deref(), Some("variable.set"));
    // The failing step reports the error; the enclosing `if` is marked failed without duplicating it.
    let finished: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::StepFinished {
                step_id,
                outcome,
                error,
                ..
            } => Some((step_id.to_string(), *outcome, error.is_some())),
            _ => None,
        })
        .collect();
    assert_eq!(
        finished,
        [
            ("bad".into(), StepOutcome::Failed, true),
            ("s1".into(), StepOutcome::Failed, false)
        ]
    );
}

#[tokio::test]
async fn retries_with_backoff_then_saves_output() {
    let mut step = Step::new("test.flaky").with_param("succeedOn", 3);
    step.retry = Some(RetryPolicy {
        max_attempts: 3,
        backoff_ms: 1,
        backoff_multiplier: 2.0,
    });
    step.save_as = Some("attempts".into());
    let mut s = flow(vec![step]);
    s.variables
        .push(var("attempts", VarType::Number, VarDirection::Output, None));
    let (report, events) = run(&flaky_runtime(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["attempts"], json!(3));
    let retries = events
        .iter()
        .filter(|e| {
            matches!(
                e.event,
                RunEvent::StepFinished {
                    will_retry: true,
                    ..
                }
            )
        })
        .count();
    assert_eq!(retries, 2);
}

#[tokio::test]
async fn retries_exhausted_fail_and_on_error_continue_records_last_error() {
    let mut step = Step::new("test.flaky").with_param("succeedOn", 5);
    step.retry = Some(RetryPolicy {
        max_attempts: 2,
        backoff_ms: 1,
        backoff_multiplier: 1.0,
    });
    let (report, _) = run(&flaky_runtime(), flow(vec![step.clone()]), json!({})).await;
    assert_eq!(
        report.error.map(|e| e.code),
        Some("ELEMENT_NOT_FOUND".into())
    );

    step.on_error = Some(OnError::Continue);
    let mut s = flow(vec![step, set("code", "lastError.code")]);
    s.variables
        .push(var("code", VarType::String, VarDirection::Output, None));
    let (report, _) = run(&flaky_runtime(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(report.outputs["code"], json!("ELEMENT_NOT_FOUND"));
}

/// A group whose body fails on its first `fails` runs: it counts its runs in `n`.
fn retried_group(fails: u32, max_attempts: u32) -> Flow {
    let mut group = Step::new("control.group").with_block(
        "body",
        vec![
            set("n", "n + 1"),
            Step::new("control.if")
                .with_param("condition", format!("n <= {fails}"))
                .with_block("then", vec![fail("not yet")]),
            log("signed in"),
        ],
    );
    group.retry = Some(RetryPolicy {
        max_attempts,
        backoff_ms: 1,
        backoff_multiplier: 1.0,
    });
    let mut s = flow(vec![group]);
    s.variables.push(var(
        "n",
        VarType::Number,
        VarDirection::Output,
        Some(json!(0)),
    ));
    s
}

#[tokio::test]
async fn a_group_with_retry_runs_its_body_again_from_the_start() {
    let (report, events) = run(&Runtime::builder().build(), retried_group(2, 3), json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["n"], json!(3));
    let logs = logs(&events);
    assert_eq!(
        logs.iter()
            .filter(|l| l.contains("最初からやり直します"))
            .count(),
        2
    );
    assert_eq!(logs.iter().filter(|l| *l == "signed in").count(), 1);

    // Out of attempts, the last failure is the group's.
    let (report, _) = run(&Runtime::builder().build(), retried_group(5, 2), json!({})).await;
    assert_eq!(report.status, RunStatus::Failed);
    assert_eq!(report.error.map(|e| e.message), Some("not yet".into()));
}

#[tokio::test]
async fn steps_time_out() {
    let mut step = Step::new("test.flaky").with_param("sleepMs", 5_000);
    step.timeout_ms = Some(20);
    let (report, _) = run(&flaky_runtime(), flow(vec![step]), json!({})).await;
    assert_eq!(report.error.map(|e| e.code), Some("STEP_TIMEOUT".into()));
}

#[tokio::test]
async fn runs_can_be_cancelled_mid_step() {
    let s = flow(vec![
        Step::new("flow.delay").with_param("ms", 60_000),
        log("never"),
    ]);
    let mut handle = Runtime::new()
        .start(s, RunOptions::default())
        .expect("start");
    // Wait until the delay step has started.
    while let Some(e) = handle.next_event().await {
        if matches!(e.event, RunEvent::StepStarted { .. }) {
            break;
        }
    }
    let snapshot = handle.snapshot().expect("snapshot");
    assert_eq!(snapshot.status, RunStatus::Running);
    assert_eq!(
        snapshot.current_step.as_ref().map(|s| s.as_str()),
        Some("s1")
    );
    handle.cancel();
    let report = tokio::time::timeout(Duration::from_secs(5), handle.wait())
        .await
        .expect("finished")
        .expect("report");
    assert_eq!(report.status, RunStatus::Cancelled);
}

#[tokio::test]
async fn secrets_are_masked_in_logs_errors_and_outputs() {
    let mut s = flow(vec![
        log("password is {{ password }}"),
        Step::new("control.fail").with_param("message", "login failed with {{ password }}"),
    ]);
    let mut password = var("password", VarType::String, VarDirection::InOut, None);
    password.secret = true;
    s.variables.push(password);
    let (report, events) = run(&Runtime::new(), s, json!({ "password": "hunter2" })).await;
    assert_eq!(logs(&events), ["password is ***"]);
    assert_eq!(
        report.error.expect("error").message,
        "login failed with ***"
    );
    assert_eq!(report.outputs["password"], json!("***"));
    let all = serde_json::to_string(&events).expect("json");
    assert!(!all.contains("hunter2"));
}

#[tokio::test]
async fn personal_data_is_masked_like_secrets() {
    let mut s = flow(vec![
        set("first", "customers[0]"),
        log("calling {{ first.name }} at {{ first.phone }}"),
        Step::new("control.fail").with_param("message", "no answer from {{ first.name }}"),
    ]);
    let mut customers = var("customers", VarType::Array, VarDirection::Input, None);
    customers.personal = true;
    s.variables = vec![customers];
    let (report, events) = run(
        &Runtime::new(),
        s,
        json!({ "customers": [{ "name": "山田花子さん", "phone": "090-1234-5678" }] }),
    )
    .await;
    assert_eq!(logs(&events), ["calling *** at ***"]);
    assert_eq!(report.error.expect("error").message, "no answer from ***");
    assert_eq!(
        changes(&events)[..2],
        [
            change("customers", json!("***"), None),
            change(
                "first",
                json!({ "name": "***", "phone": "***" }),
                Some("s1")
            ),
        ]
    );
    let all = serde_json::to_string(&events).expect("json");
    assert!(!all.contains("山田") && !all.contains("1234"), "{all}");
}

#[tokio::test]
async fn disabled_steps_are_skipped() {
    let mut skipped = log("skipped");
    skipped.disabled = true;
    let (_, events) = run(&Runtime::new(), flow(vec![skipped, log("ran")]), json!({})).await;
    assert_eq!(logs(&events), ["ran"]);
}

#[tokio::test]
async fn run_records_round_trip() {
    let dir = tempfile::tempdir().expect("tmp");
    let handle = Runtime::new()
        .start(flow(vec![log("hello")]), RunOptions::default())
        .expect("start");
    let run_id = handle.run_id.clone();
    let mut recorder = record::RunRecorder::create(dir.path(), &run_id).expect("recorder");
    let report = handle
        .wait_with(|e| recorder.write_event(e).expect("write"))
        .await
        .expect("report");
    recorder.finish(&report).expect("finish");

    assert_eq!(
        record::list_runs(dir.path()).expect("list"),
        std::slice::from_ref(&run_id)
    );
    assert_eq!(
        record::read_report(dir.path(), &run_id).expect("read"),
        Some(report)
    );
    let events = record::read_events(dir.path(), &run_id).expect("events");
    assert_eq!(logs(&events), ["hello"]);
}

#[test]
fn committed_run_schema_is_up_to_date() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schemas/run-api.schema.json");
    let expected = serde_json::to_string_pretty(&run_api_schema()).expect("json") + "\n";
    let actual = std::fs::read_to_string(path).unwrap_or_default();
    assert!(
        actual == expected,
        "schemas/run-api.schema.json is outdated; run `pnpm schema:generate`"
    );
}

fn delay(ms: u64) -> Step {
    Step::new("flow.delay").with_param("ms", ms)
}

fn group(steps: Vec<Step>) -> Step {
    Step::new("control.group").with_block("body", steps)
}

fn parallel(branches: Vec<Step>) -> Step {
    Step::new("control.parallel").with_block("branches", branches)
}

fn outputs(names: &[&str]) -> Vec<VariableDef> {
    names
        .iter()
        .map(|n| var(n, VarType::Any, VarDirection::Output, None))
        .collect()
}

#[tokio::test]
async fn parallel_branches_run_concurrently_and_merge_variables() {
    let mut s = flow(vec![
        set("shared", "1"),
        parallel(vec![
            group(vec![delay(200), set("a", "shared + 1")]),
            group(vec![delay(200), set("b", "shared + 2")]),
            set("c", "3"),
        ]),
        set("sum", "a + b + c"),
    ]);
    s.variables = outputs(&["a", "b", "c", "sum"]);
    let started = std::time::Instant::now();
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    let elapsed = started.elapsed();
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["sum"], json!(8));
    assert!(elapsed < Duration::from_millis(380), "took {elapsed:?}");
}

#[tokio::test]
async fn parallel_branches_writing_the_same_variable_differently_conflict() {
    // Rejected by validation before the run starts...
    let s = flow(vec![parallel(vec![
        set("x", "1"),
        group(vec![set("x", "2")]),
    ])]);
    let err = Runtime::new()
        .start(s, RunOptions::default())
        .err()
        .expect("invalid");
    assert!(
        err.details
            .unwrap()
            .to_string()
            .contains("PARALLEL_VARIABLE_CONFLICT")
    );

    // Swallowed errors write `lastError`, so they count as writes too.
    let fail = || {
        let mut step = Step::new("test.flaky").with_param("succeedOn", 9);
        step.on_error = Some(OnError::Continue);
        step
    };
    let s = flow(vec![parallel(vec![fail(), fail()])]);
    let err = flaky_runtime()
        .start(s, RunOptions::default())
        .err()
        .expect("invalid");
    assert!(err.details.unwrap().to_string().contains("lastError"));
}

#[tokio::test]
async fn a_failing_branch_cancels_the_others() {
    let s = flow(vec![parallel(vec![
        Step::new("control.fail").with_param("message", "boom"),
        group(vec![delay(5_000), log("late")]),
    ])]);
    let started = std::time::Instant::now();
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Failed);
    assert_eq!(report.error.unwrap().message, "boom");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!logs(&events).contains(&"late".to_owned()));
}

#[tokio::test]
async fn max_concurrency_limits_branches() {
    let s = flow(vec![
        parallel(vec![delay(150), delay(150)]).with_param("maxConcurrency", 1),
    ]);
    let started = std::time::Instant::now();
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert!(started.elapsed() >= Duration::from_millis(300));
}

#[tokio::test]
async fn break_cannot_leave_a_parallel_branch() {
    let s = flow(vec![
        Step::new("control.repeat")
            .with_param("count", 3)
            .with_block("body", vec![parallel(vec![Step::new("control.break")])]),
    ]);
    let err = Runtime::new()
        .start(s, RunOptions::default())
        .err()
        .expect("must not start");
    assert_eq!(err.code, "VALIDATION_FAILED");
    assert!(err.details.unwrap().to_string().contains("NOT_IN_LOOP"));
}

/// Test adapter that pretends to move the real mouse: records how many
/// instances run at the same time.
struct FakeMouse {
    active: AtomicU32,
    peak: AtomicU32,
}

impl ActionHandler for FakeMouse {
    fn execute<'a>(&'a self, _input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(Value::Null)
        })
    }
}

#[tokio::test]
async fn desktop_input_is_exclusive_across_branches_and_runs() {
    let mouse = Arc::new(FakeMouse {
        active: AtomicU32::new(0),
        peak: AtomicU32::new(0),
    });
    struct Shared(Arc<FakeMouse>);
    impl ActionHandler for Shared {
        fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
            self.0.execute(input)
        }
    }
    let def = StepTypeDef {
        targets: Vec::new(),
        step_type: "test.click".into(),
        label: "click".into(),
        params_schema: json!({ "type": "object" }),
        has_output: false,
        resources: vec![ResourceDef::Static(DESKTOP_INPUT.into())],
        secret_params: vec![],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        ..flaky_def()
    };
    let runtime = Runtime::builder()
        .register(def, Shared(mouse.clone()))
        .build();
    let click = || Step::new("test.click");
    let s = || {
        flow(vec![parallel(vec![
            click(),
            click(),
            group(vec![click(), delay(10)]),
        ])])
    };
    let (a, b) = tokio::join!(run(&runtime, s(), json!({})), run(&runtime, s(), json!({})));
    assert_eq!(a.0.status, RunStatus::Succeeded);
    assert_eq!(b.0.status, RunStatus::Succeeded);
    assert_eq!(mouse.peak.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn steps_on_the_same_file_take_turns() {
    let writer = Arc::new(FakeMouse {
        active: AtomicU32::new(0),
        peak: AtomicU32::new(0),
    });
    struct Shared(Arc<FakeMouse>);
    impl ActionHandler for Shared {
        fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
            self.0.execute(input)
        }
    }
    let def = StepTypeDef {
        targets: Vec::new(),
        step_type: "test.writeFile".into(),
        label: "write".into(),
        params_schema: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        has_output: false,
        resources: vec![ResourceDef::file("path")],
        secret_params: vec![],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        ..flaky_def()
    };
    let runtime = Runtime::builder()
        .register(def, Shared(writer.clone()))
        .build();
    let write = |path: &str| Step::new("test.writeFile").with_param("path", path);

    // Different spellings of one file (one via a template) never overlap...
    let mut s = flow(vec![parallel(vec![
        write(r"C:\Data\Book.xlsx"),
        write("c:/data/./book.XLSX"),
        write("{{ dir }}\\book.xlsx"),
    ])]);
    s.variables = vec![var(
        "dir",
        VarType::String,
        VarDirection::Local,
        Some(json!(r"C:\Data")),
    )];
    let (report, _) = run(&runtime, s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(writer.peak.load(Ordering::SeqCst), 1);

    // ...while different files run at the same time.
    let s = flow(vec![parallel(vec![
        write(r"C:\Data\a.xlsx"),
        write(r"C:\Data\b.xlsx"),
    ])]);
    let (report, _) = run(&runtime, s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(writer.peak.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn queued_branches_do_not_start_after_a_failure() {
    let s = flow(vec![
        parallel(vec![
            Step::new("control.fail").with_param("message", "boom"),
            log("queued"),
        ])
        .with_param("maxConcurrency", 1),
    ]);
    for _ in 0..20 {
        let (report, events) = run(&Runtime::new(), s.clone(), json!({})).await;
        assert_eq!(report.status, RunStatus::Failed);
        assert!(!logs(&events).contains(&"queued".to_owned()));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn events_from_parallel_branches_arrive_in_seq_order() {
    let branch = || group((0..20).map(|i| log(&format!("m{i}"))).collect());
    let s = flow(vec![parallel((0..16).map(|_| branch()).collect())]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
    let expected: Vec<u64> = (0..seqs.len() as u64).collect();
    assert_eq!(seqs, expected);
}

#[tokio::test]
async fn numeric_params_take_an_integer_or_a_template() {
    let mut s = flow(vec![
        Step::new("control.repeat")
            .with_param("count", "{{ n }}")
            .with_block("body", vec![set("hits", "hits + 1")]),
        delay(0).with_param("ms", "{{ n - 3 }}"),
    ]);
    s.variables = vec![
        var("n", VarType::Number, VarDirection::Input, Some(json!(3))),
        var(
            "hits",
            VarType::Number,
            VarDirection::Output,
            Some(json!(0)),
        ),
    ];
    let (report, _) = run(&Runtime::new(), s.clone(), json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["hits"], json!(3));

    // A bare expression is not a template: rejected before running, with a hint.
    s.steps[0].params.insert("count".into(), json!("n"));
    let err = Runtime::new()
        .start(s, RunOptions::default())
        .err()
        .expect("invalid");
    let details = err.details.unwrap().to_string();
    assert!(details.contains("INVALID_PARAMS"));
    assert!(details.contains("{{ retryCount }}"), "{details}");
}

fn wait_until(condition: &str, check: Vec<Step>) -> Step {
    Step::new("wait.until")
        .with_param("condition", condition)
        .with_param("intervalMs", 50)
        .with_block("check", check)
}

#[tokio::test]
async fn wait_until_runs_the_check_until_the_condition_holds() {
    let mut s = flow(vec![wait_until("n >= 3", vec![set("n", "n + 1")])]);
    s.variables = vec![var(
        "n",
        VarType::Number,
        VarDirection::Output,
        Some(json!(0)),
    )];
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["n"], json!(3));
}

#[tokio::test]
async fn wait_until_fails_with_wait_timeout_and_can_be_skipped() {
    let mut wait = wait_until("false", vec![]);
    wait.timeout_ms = Some(200);
    let (report, _) = run(&Runtime::new(), flow(vec![wait.clone()]), json!({})).await;
    let error = report.error.expect("timeout");
    assert_eq!(error.code, "WAIT_TIMEOUT");
    let details = error.details.unwrap();
    assert!(details["elapsedMs"].as_u64().unwrap() >= 200);
    assert!(details["polls"].as_u64().unwrap() >= 3);

    wait.on_error = Some(OnError::Continue);
    let mut s = flow(vec![wait, set("code", "lastError.code")]);
    s.variables = vec![var("code", VarType::String, VarDirection::Output, None)];
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(report.outputs["code"], json!("WAIT_TIMEOUT"));
}

fn for_each(items: &str, body: Vec<Step>) -> Step {
    Step::new("control.forEach")
        .with_param("items", items)
        .with_param("itemVar", "item")
        .with_block("body", body)
}

#[tokio::test]
async fn for_each_collects_one_value_per_item() {
    let mut step = for_each(
        "[1, 2, 3, 4]",
        vec![
            Step::new("control.if")
                .with_param("condition", "item == 3")
                .with_block(
                    "then",
                    vec![set("doubled", "0"), Step::new("control.continue")],
                ),
            set("doubled", "item * 2"),
        ],
    )
    .with_param("collect", "doubled");
    step.save_as = Some("out".into());
    let mut s = flow(vec![step]);
    s.variables = outputs(&["out"]);
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!([2, 4, 0, 8]));
}

#[tokio::test]
async fn concurrent_for_each_runs_items_at_once_and_keeps_order() {
    let mut step = for_each(
        "[5, 4, 3, 2, 1, 0, 9, 8]",
        vec![delay(100), set("doubled", "item * 2")],
    )
    .with_param("collect", "doubled")
    .with_param("concurrency", "{{ workers }}");
    step.save_as = Some("out".into());
    let mut s = flow(vec![step]);
    s.variables = outputs(&["out"]);
    s.variables.push(var(
        "workers",
        VarType::Number,
        VarDirection::Input,
        Some(json!(4)),
    ));
    let started = std::time::Instant::now();
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!([10, 8, 6, 4, 2, 0, 18, 16]));
    // 8 items x 100 ms with 4 at a time: about 200 ms, not 800 ms.
    assert!(started.elapsed() < Duration::from_millis(600));
}

#[tokio::test]
async fn concurrent_for_each_stops_at_the_first_failure() {
    let s = flow(vec![
        for_each(
            "[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]",
            vec![
                Step::new("control.if")
                    .with_param("condition", "item == 2")
                    .with_block(
                        "then",
                        vec![Step::new("control.fail").with_param("message", "bad {{ item }}")],
                    ),
                delay(50),
                log("done {{ item }}"),
            ],
        )
        .with_param("concurrency", 2),
    ]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Failed);
    let error = report.error.unwrap();
    assert_eq!(error.message, "bad 2");
    assert_eq!(error.details.unwrap()["index"], json!(2));
    // Items after the failure never start.
    assert!(!logs(&events).iter().any(|l| l == "done 9"));
}

#[tokio::test]
async fn runs_the_batch_example() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/batch-demo.json");
    let text = std::fs::read_to_string(path).expect("example");
    let s = spellsheet_core::migrate::parse_flow(&text).expect("parse");
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["total"], json!(348700));
    assert_eq!(report.outputs["taxed"][1], json!(165000));
}

/// Removes `durationMs` everywhere, so tests can search event text for values.
fn drop_durations(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("durationMs");
            map.values_mut().for_each(drop_durations);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_durations),
        _ => {}
    }
}

/// `(variable, value, stepId)` of every `variableChanged` event, in order.
fn changes(events: &[RunEventEnvelope]) -> Vec<(String, Value, Option<String>)> {
    events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::VariableChanged {
                variable,
                value,
                step_id,
                ..
            } => Some((
                variable.clone(),
                value.clone(),
                step_id.as_ref().map(|s| s.as_str().to_owned()),
            )),
            _ => None,
        })
        .collect()
}

fn change(variable: &str, value: Value, step_id: Option<&str>) -> (String, Value, Option<String>) {
    (variable.to_owned(), value, step_id.map(str::to_owned))
}

#[tokio::test]
async fn variable_changes_are_reported_with_the_assigning_step() {
    let mut s = flow(vec![
        set("total", "price * 2"),
        Step::new("control.repeat")
            .with_param("count", 2)
            .with_param("indexVar", "i")
            .with_block("body", vec![set("total", "total + i")]),
    ]);
    s.variables = vec![
        var("price", VarType::Number, VarDirection::Input, None),
        var(
            "total",
            VarType::Number,
            VarDirection::Output,
            Some(json!(0)),
        ),
    ];
    let (report, events) = run(&Runtime::new(), s, json!({ "price": 10 })).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert!(matches!(events[0].event, RunEvent::RunStarted { .. }));
    assert_eq!(
        changes(&events),
        [
            change("price", json!(10), None),
            change("total", json!(0), None),
            change("total", json!(20), Some("s1")),
            change("i", json!(0), Some("s2")),
            change("total", json!(20), Some("s3")),
            change("i", json!(1), Some("s2")),
            change("total", json!(21), Some("s3")),
        ]
    );
    // Each change sits between its step's started and finished events.
    let seq_of = |pred: &dyn Fn(&RunEvent) -> bool| {
        events.iter().find(|e| pred(&e.event)).expect("event").seq
    };
    let started =
        seq_of(&|e| matches!(e, RunEvent::StepStarted { step_id, .. } if step_id.as_str() == "s1"));
    let changed = seq_of(
        &|e| matches!(e, RunEvent::VariableChanged { step_id: Some(id), .. } if id.as_str() == "s1"),
    );
    let finished = seq_of(
        &|e| matches!(e, RunEvent::StepFinished { step_id, .. } if step_id.as_str() == "s1"),
    );
    assert!(started < changed && changed < finished);
}

#[tokio::test]
async fn variable_changes_hide_secrets() {
    let mut s = flow(vec![set("greeting", "'pw=' + password")]);
    let mut password = var("password", VarType::String, VarDirection::Input, None);
    password.secret = true;
    s.variables.push(password);
    let (_, events) = run(&Runtime::new(), s, json!({ "password": "hunter2" })).await;
    let secret_flags: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::VariableChanged {
                variable, secret, ..
            } => Some((variable.as_str(), *secret)),
            _ => None,
        })
        .collect();
    assert_eq!(secret_flags, [("password", true), ("greeting", false)]);
    assert_eq!(
        changes(&events),
        [
            change("password", json!("***"), None),
            change("greeting", json!("pw=***"), Some("s1")),
        ]
    );
    let all = serde_json::to_string(&events).expect("json");
    assert!(!all.contains("hunter2"));
}

// ---------------------------------------------------------------------------
// Secrets

struct MemorySecrets;

impl SecretProvider for MemorySecrets {
    fn resolve(
        &self,
        reference: &spellsheet_core::secret::SecretRef,
    ) -> Result<spellsheet_core::secret::ResolvedSecret, spellsheet_core::secret::SecretError> {
        if reference.secret != "受注" {
            return Err(spellsheet_core::secret::SecretError::new(
                "SECRET_NOT_FOUND",
                "no such secret",
            ));
        }
        Ok(spellsheet_core::secret::ResolvedSecret {
            name: reference.secret.clone(),
            field: reference.field,
            value: match reference.field {
                spellsheet_core::secret::SecretField::Username => "tanaka".into(),
                _ => "hunter2".into(),
            },
            sites: vec!["https://example.com".into()],
        })
    }

    fn load_session(
        &self,
        _name: &str,
    ) -> Result<Option<Value>, spellsheet_core::secret::SecretError> {
        Ok(None)
    }

    fn save_session(
        &self,
        _name: &str,
        _state: &Value,
    ) -> Result<(), spellsheet_core::secret::SecretError> {
        Ok(())
    }
}

/// Test input step: types `value` (a secret or text) and echoes it to the
/// log and the output, as a careless adapter might.
fn typing_def() -> StepTypeDef {
    StepTypeDef {
        targets: Vec::new(),
        step_type: "test.type".into(),
        params_schema: json!({ "type": "object", "properties": { "value": spellsheet_core::secret::text_or_secret_schema("text") } }),
        has_output: true,
        secret_params: vec!["value".into()],
        default_timeout_ms: Some(50),
        deprecated: None,
        plugin: None,
        ..flaky_def()
    }
}

struct Typing;

impl ActionHandler for Typing {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let value = input.params.get("value").cloned().unwrap_or(Value::Null);
            let text = match input.resolve_secret(&value)? {
                Some(secret) => secret.value,
                None => value.as_str().unwrap_or_default().to_owned(),
            };
            if text == "slow" {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            input.log(LogLevel::Info, format!("typed {text}"));
            Ok(json!({ "typed": text, "limit": input.timeout_ms }))
        })
    }
}

fn typing_runtime() -> Runtime {
    Runtime::builder().register(typing_def(), Typing).build()
}

#[tokio::test]
async fn secrets_are_resolved_for_steps_and_masked_everywhere() {
    let runtime = typing_runtime().with_secrets(Arc::new(MemorySecrets));
    let mut s = flow(vec![
        Step {
            save_as: Some("user".into()),
            ..Step::new("test.type")
                .with_param("value", json!({ "secret": "受注", "field": "username" }))
        },
        Step {
            save_as: Some("typed".into()),
            ..Step::new("test.type")
                .with_param("value", json!({ "secret": "受注", "field": "password" }))
        },
    ]);
    s.variables
        .push(var("typed", VarType::Any, VarDirection::Output, None));
    s.variables
        .push(var("user", VarType::Any, VarDirection::Output, None));
    let (report, events) = run(&runtime, s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    // User names stay readable; passwords never leave the step.
    assert_eq!(logs(&events), ["typed tanaka", "typed ***"]);
    assert_eq!(report.outputs["typed"]["typed"], json!("***"));
    assert_eq!(report.outputs["user"]["typed"], json!("tanaka"));
    let all = serde_json::to_string(&events).unwrap();
    assert!(!all.contains("hunter2"));
    // The report names the secrets used, for the audit trail.
    assert_eq!(report.secrets_used, ["受注"]);
    assert!(!serde_json::to_string(&report).unwrap().contains("hunter2"));
}

#[tokio::test]
async fn the_account_is_picked_when_the_run_starts() {
    let runtime = typing_runtime().with_secrets(Arc::new(MemorySecrets));
    let mut s = flow(vec![
        Step::new("test.type").with_param(
            "value",
            json!({ "secret": "{{ account }}", "field": "username" }),
        ),
        Step::new("test.type").with_param(
            "value",
            json!({ "secret": "{{ account }}", "field": "password" }),
        ),
    ]);
    let mut account = var("account", VarType::String, VarDirection::Input, None);
    account.choices = vec![json!("受注"), json!("申請")];
    s.variables.push(account);
    let (report, events) = run(&runtime, s.clone(), json!({ "account": "受注" })).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(logs(&events), ["typed tanaka", "typed ***"]);
    assert_eq!(report.secrets_used, ["受注"]);
    // Only the listed accounts are taken.
    let (report, _) = run(&runtime, s, json!({ "account": "他の人" })).await;
    assert_eq!(report.error.map(|e| e.code), Some("INVALID_INPUT".into()));
}

#[tokio::test]
async fn large_values_are_recorded_as_a_preview() {
    let s = flow(vec![
        Step::new("variable.set")
            .with_param("name", "text")
            .with_param("value", "あ".repeat(1500)),
        set("rows", "[1, 2, 3]"),
        Step::new("variable.set")
            .with_param("name", "big")
            .with_param("value", json!(vec!["0123456789"; 200])),
    ]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let recorded: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::VariableChanged {
                value, truncated, ..
            } => Some((value.clone(), *truncated)),
            _ => None,
        })
        .collect();
    assert_eq!(recorded.len(), 3);
    let (text, truncated) = &recorded[0];
    assert!(truncated);
    assert_eq!(text.as_str().expect("string").chars().count(), 1001);
    assert_eq!(recorded[1], (json!([1, 2, 3]), false));
    let (big, truncated) = &recorded[2];
    assert!(truncated);
    let big = big.as_str().expect("json text preview");
    assert!(big.starts_with("[\"0123456789\",") && big.ends_with('…'));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_branches_report_their_own_changes_once() {
    let mut s = flow(vec![parallel(vec![
        group(vec![delay(30), set("a", "1")]),
        group(vec![set("b", "2")]),
    ])]);
    s.variables = outputs(&["a", "b"]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let after_inputs: Vec<_> = changes(&events)
        .into_iter()
        .filter(|(_, _, step)| step.is_some())
        .collect();
    // b's branch has no delay, so it changes first; the merge adds nothing.
    assert_eq!(
        after_inputs,
        [
            change("b", json!(2), Some("s6")),
            change("a", json!(1), Some("s4")),
        ]
    );
    assert!(events.windows(2).all(|w| w[0].seq + 1 == w[1].seq));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_for_each_reports_each_iteration() {
    let mut step = for_each("[3, 1, 2]", vec![delay(20), set("doubled", "item * 2")])
        .with_param("concurrency", 3);
    step.id = "loop".into();
    step.save_as = Some("out".into());
    let s = flow(vec![step]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let mut recorded: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::VariableChanged {
                variable,
                value,
                step_id,
                iteration,
                ..
            } => Some((
                *iteration,
                variable.as_str(),
                value.as_f64(),
                step_id.as_ref().map(|s| s.as_str()),
            )),
            _ => None,
        })
        .collect();
    // The loop's own result comes last, outside any iteration.
    assert_eq!(recorded.pop(), Some((None, "out", None, Some("loop"))));
    // Iterations interleave, but each one's changes carry its item index.
    recorded.sort_by_key(|(iteration, variable, ..)| (*iteration, *variable));
    assert_eq!(
        recorded,
        [
            (Some(0), "doubled", Some(6.0), Some("s2")),
            (Some(0), "item", Some(3.0), Some("loop")),
            (Some(1), "doubled", Some(2.0), Some("s2")),
            (Some(1), "item", Some(1.0), Some("loop")),
            (Some(2), "doubled", Some(4.0), Some("s2")),
            (Some(2), "item", Some(2.0), Some("loop")),
        ]
    );
    assert!(events.windows(2).all(|w| w[0].seq + 1 == w[1].seq));
}

#[tokio::test]
async fn variable_changes_mask_secrets_copied_anywhere() {
    let mut s = flow(vec![
        set("pin_copy", "pin"),
        set("user_copy", "login.user"),
        set("id_copy", "login.id"),
    ]);
    let mut pin = var("pin", VarType::Number, VarDirection::Input, None);
    pin.secret = true;
    let mut login = var("login", VarType::Object, VarDirection::Input, None);
    login.secret = true;
    // Declared before the secrets it contains.
    s.variables = vec![
        var("header", VarType::String, VarDirection::Input, None),
        pin,
        login,
    ];
    let (report, events) = run(
        &Runtime::new(),
        s,
        json!({
            "header": "Bearer s3cr3t-token",
            "pin": 4821,
            "login": { "user": "s3cr3t-token", "id": 7 },
        }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(
        changes(&events),
        [
            change("header", json!("Bearer ***"), None),
            change("pin", json!("***"), None),
            change("login", json!("***"), None),
            change("pin_copy", json!("***"), Some("s1")),
            change("user_copy", json!("***"), Some("s2")),
            // Too short to mask by substring without blanking other text.
            change("id_copy", json!(7), Some("s3")),
        ]
    );
    // Only what the events carry: the envelope's time and run id, and
    // durations, are random and can contain the digits by chance.
    let all = events
        .iter()
        .map(|e| {
            let mut v = serde_json::to_value(&e.event).expect("json");
            drop_durations(&mut v);
            v.to_string()
        })
        .collect::<String>();
    assert!(!all.contains("s3cr3t") && !all.contains("4821"), "{all}");
}

#[tokio::test]
async fn missing_secrets_fail_the_step_with_a_hint() {
    let mut s =
        flow(vec![Step::new("test.type").with_param(
            "value",
            json!({ "secret": "受注", "field": "password" }),
        )]);
    let (report, _) = run(&typing_runtime(), s.clone(), json!({})).await;
    assert_eq!(report.error.unwrap().code, "SECRETS_UNAVAILABLE");

    s.steps[0] = Step::new("test.type")
        .with_param("value", json!({ "secret": "other", "field": "password" }));
    s.steps[0].id = "s1".into();
    let runtime = typing_runtime().with_secrets(Arc::new(MemorySecrets));
    let (report, _) = run(&runtime, s, json!({})).await;
    assert_eq!(report.error.unwrap().code, "SECRET_NOT_FOUND");
}

#[tokio::test]
async fn step_types_can_set_their_own_default_timeout() {
    let mut s = flow(vec![Step::new("test.type").with_param("value", "slow")]);
    // The flow default is long; the step type's own 50 ms wins.
    s.settings.default_timeout_ms = Some(60_000);
    let (report, _) = run(&typing_runtime(), s, json!({})).await;
    assert_eq!(report.error.unwrap().code, "STEP_TIMEOUT");
}

// -- interactive runs ---------------------------------------------------------

fn debug_options(breakpoints: &[&str]) -> RunOptions {
    RunOptions {
        debug: Some(DebugOptions {
            pause_on_error: true,
            breakpoints: breakpoints.iter().map(|&id| id.into()).collect(),
            pause_at_start: false,
        }),
        ..RunOptions::default()
    }
}

fn fail(message: &str) -> Step {
    Step::new("control.fail").with_param("message", message)
}

/// What a test does at a pause.
enum Answer {
    Send(DebugCommand),
    /// Swap in this flow, then send the command.
    Swap(Box<Flow>, DebugCommand),
}

/// Runs `s` interactively, answering each pause with `answer(n, event)`
/// (`n` counts pauses from 0). Returns the report, every event and the
/// pauses as (step, reason).
async fn debug_run(
    runtime: &Runtime,
    s: Flow,
    options: RunOptions,
    mut answer: impl FnMut(usize, &RunEvent) -> Answer,
) -> (RunReport, Vec<RunEventEnvelope>, Vec<(String, PauseReason)>) {
    let mut handle = runtime.start(s, options).expect("start");
    let control = handle.debug_control().expect("debug control");
    let mut events = Vec::new();
    let mut pauses = Vec::new();
    while let Some(event) = tokio::time::timeout(Duration::from_secs(5), handle.next_event())
        .await
        .expect("the run stalled")
    {
        if let RunEvent::Paused {
            step_id, reason, ..
        } = &event.event
        {
            assert!(control.is_paused());
            pauses.push((step_id.to_string(), *reason));
            assert!(pauses.len() < 10, "paused over and over: {pauses:?}");
            match answer(pauses.len() - 1, &event.event) {
                Answer::Send(command) => control.send(command).expect("command"),
                Answer::Swap(flow, command) => {
                    control.update_flow(*flow).expect("swap");
                    control.send(command).expect("command");
                }
            }
        }
        events.push(event);
    }
    let report = handle.wait().await.expect("wait");
    (report, events, pauses)
}

#[tokio::test]
async fn an_unhandled_error_pauses_and_a_fixed_step_resumes_with_the_variables() {
    let s = flow(vec![set("n", "41"), fail("boom"), set("n", "n + 1")]);
    let mut fixed = s.clone();
    fixed.revision += 1;
    fixed.steps[1] = log("fixed {{ n }}");
    fixed.steps[1].id = "s2".into();
    let mut paused_with = None;
    let (report, events, pauses) = debug_run(&Runtime::new(), s, debug_options(&[]), |_, event| {
        paused_with = Some(event.clone());
        Answer::Swap(Box::new(fixed.clone()), DebugCommand::Retry)
    })
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(pauses, vec![("s2".to_owned(), PauseReason::Error)]);
    let Some(RunEvent::Paused {
        error, variables, ..
    }) = paused_with
    else {
        panic!("no pause");
    };
    assert_eq!(error.expect("error").code, "FLOW_FAILED");
    assert_eq!(variables.get("n"), Some(&json!(41)));
    assert!(logs(&events).contains(&"fixed 41".to_owned()));
    assert!(events.iter().any(|e| matches!(
        e.event,
        RunEvent::Resumed {
            action: ResumeAction::Retry,
            revision: Some(_)
        }
    )));
}

#[tokio::test]
async fn retry_runs_steps_inserted_before_the_failed_one() {
    // The AI adds the missing step in front of the one that failed.
    let s = flow(vec![
        set("ready", "false"),
        Step::new("control.if")
            .with_param("condition", "!ready")
            .with_block("then", vec![fail("not ready")]),
    ]);
    let mut fixed = s.clone();
    fixed.revision += 1;
    let mut insert = log("inserted");
    insert.id = "new".into();
    let then = fixed.steps[1].blocks.get_mut("then").expect("then");
    then.insert(0, insert);
    then[1] = log("fixed");
    then[1].id = "s3".into();
    let (report, events, pauses) = debug_run(&Runtime::new(), s, debug_options(&[]), |_, _| {
        Answer::Swap(Box::new(fixed.clone()), DebugCommand::Continue)
    })
    .await;
    assert_eq!(pauses, vec![("s3".to_owned(), PauseReason::Error)]);
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    // The `if` already chose its branch; the new step in it runs first.
    assert_eq!(logs(&events), ["inserted", "fixed"]);
}

#[tokio::test]
async fn skipping_a_step_the_fix_removed_goes_on_with_the_rest() {
    let s = flow(vec![log("a"), fail("boom"), log("c"), log("d")]);
    let mut fixed = s.clone();
    fixed.revision += 1;
    fixed.steps.remove(1);
    let (report, events, _) = debug_run(&Runtime::new(), s, debug_options(&[]), |_, _| {
        Answer::Swap(Box::new(fixed.clone()), DebugCommand::Skip)
    })
    .await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(
        logs(&events)
            .iter()
            .filter(|l| *l == "c" || *l == "d")
            .count(),
        2
    );
}

#[tokio::test]
async fn time_paused_inside_a_wait_does_not_count_towards_its_timeout() {
    let mut wait = Step::new("wait.until")
        .with_param("condition", "n >= 2")
        .with_block("check", vec![set("n", "n + 1")]);
    wait.timeout_ms = Some(100);
    let mut s = flow(vec![wait]);
    s.variables = vec![var(
        "n",
        VarType::Number,
        VarDirection::Local,
        Some(json!(0)),
    )];
    let mut handle = Runtime::new()
        .start(s, debug_options(&["s2"]))
        .expect("start");
    let control = handle.debug_control().expect("control");
    while let Some(event) = handle.next_event().await {
        match event.event {
            RunEvent::Paused {
                reason: PauseReason::Error,
                ..
            } => control.send(DebugCommand::Abort).expect("abort"),
            RunEvent::Paused { .. } => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                control.send(DebugCommand::Continue).expect("continue");
            }
            _ => {}
        }
    }
    let report = handle.wait().await.expect("wait");
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
}

#[tokio::test]
async fn a_value_set_while_paused_is_what_the_next_steps_read() {
    let mut s = flow(vec![set("n", "41"), log("n = {{ n }}")]);
    let mut pin = var("pin", VarType::String, VarDirection::Local, None);
    pin.secret = true;
    s.variables.push(pin);
    let mut handle = Runtime::new()
        .start(s, debug_options(&["s2"]))
        .expect("start");
    let control = handle.debug_control().expect("control");
    let set_variable = |name: &str, value: Value| DebugCommand::SetVariable {
        name: name.into(),
        value,
    };
    // Not paused yet: nothing to set.
    let early = control.send(set_variable("n", json!(1)));
    let mut events = Vec::new();
    while let Some(event) = tokio::time::timeout(Duration::from_secs(5), handle.next_event())
        .await
        .expect("the run stalled")
    {
        if let RunEvent::Paused { .. } = event.event {
            let refused = |name: &str| {
                control
                    .send(set_variable(name, json!("0000")))
                    .expect_err("refused")
                    .code
            };
            assert_eq!(refused("pin"), "VARIABLE_NOT_EDITABLE");
            assert_eq!(refused("nowhere"), "VARIABLE_NOT_EDITABLE");
            control.send(set_variable("n", json!(100))).expect("set");
            control.send(DebugCommand::Continue).expect("continue");
        }
        events.push(event);
    }
    let report = handle.wait().await.expect("wait");
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    if let Err(e) = early {
        assert_eq!(e.code, "RUN_NOT_PAUSED");
    }
    assert!(logs(&events).contains(&"n = 100".to_owned()));
    // Reported like any other change, before the run resumes.
    let paused = events
        .iter()
        .position(|e| matches!(e.event, RunEvent::Paused { .. }))
        .expect("paused");
    let resumed = events
        .iter()
        .position(|e| matches!(e.event, RunEvent::Resumed { .. }))
        .expect("resumed");
    assert!(events[paused..resumed].iter().any(|e| matches!(
        &e.event,
        RunEvent::VariableChanged { variable, value, step_id: None, .. }
            if variable == "n" && value == &json!(100)
    )));
}

#[tokio::test]
async fn skip_leaves_the_failed_step_undone() {
    let s = flow(vec![fail("boom"), log("after")]);
    let (report, events, _) = debug_run(&Runtime::new(), s, debug_options(&[]), |_, _| {
        Answer::Send(DebugCommand::Skip)
    })
    .await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert!(logs(&events).contains(&"after".to_owned()));
}

#[tokio::test]
async fn abort_fails_the_run_without_pausing_again_further_out() {
    let s = flow(vec![
        Step::new("control.group").with_block("body", vec![fail("boom")]),
        log("after"),
    ]);
    let (report, events, pauses) = debug_run(&Runtime::new(), s, debug_options(&[]), |_, _| {
        Answer::Send(DebugCommand::Abort)
    })
    .await;
    assert_eq!(pauses.len(), 1);
    assert_eq!(report.status, RunStatus::Failed);
    assert_eq!(report.error.expect("error").message, "boom");
    assert!(!logs(&events).contains(&"after".to_owned()));
}

#[tokio::test]
async fn handled_errors_do_not_pause() {
    let mut on_error = fail("ignored");
    on_error.step_type = "wait.until".into();
    let s = flow(vec![
        Step::new("control.try")
            .with_block("try", vec![fail("caught")])
            .with_block("catch", vec![log("in catch")]),
        log("after"),
    ]);
    let (report, _, pauses) = debug_run(&Runtime::new(), s, debug_options(&[]), |_, _| {
        Answer::Send(DebugCommand::Abort)
    })
    .await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert!(pauses.is_empty());

    // A try without catch only has a finally: the error is not handled.
    let s = flow(vec![
        Step::new("control.try")
            .with_block("try", vec![fail("not caught")])
            .with_block("finally", vec![log("finally")]),
    ]);
    let (report, _, pauses) = debug_run(&Runtime::new(), s, debug_options(&[]), |_, _| {
        Answer::Send(DebugCommand::Abort)
    })
    .await;
    assert_eq!(pauses.len(), 1);
    assert_eq!(report.status, RunStatus::Failed);
}

#[tokio::test]
async fn unattended_runs_still_fail_without_pausing() {
    let s = flow(vec![fail("boom")]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Failed);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e.event, RunEvent::Paused { .. }))
    );
}

#[tokio::test]
async fn breakpoints_and_step_commands_walk_the_tree() {
    // s1 group { s2, s3 }, s4
    let s = flow(vec![
        Step::new("control.group").with_block("body", vec![log("a"), log("b")]),
        log("c"),
    ]);
    let commands = [
        DebugCommand::StepInto, // at s1 (breakpoint) -> s2
        DebugCommand::StepOver, // at s2 -> s3
        DebugCommand::StepOut,  // at s3 -> s4
        DebugCommand::Continue, // at s4 -> end
    ];
    let (report, _, pauses) = debug_run(&Runtime::new(), s, debug_options(&["s1"]), |n, _| {
        Answer::Send(commands[n].clone())
    })
    .await;
    assert_eq!(report.status, RunStatus::Succeeded);
    let ids: Vec<&str> = pauses.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, ["s1", "s2", "s3", "s4"]);
    assert_eq!(pauses[0].1, PauseReason::Breakpoint);
    assert_eq!(pauses[1].1, PauseReason::Step);

    // Step over a block runs all of it.
    let s = flow(vec![
        Step::new("control.group").with_block("body", vec![log("a"), log("b")]),
        log("c"),
    ]);
    let (_, _, pauses) = debug_run(&Runtime::new(), s, debug_options(&["s1"]), |n, _| {
        Answer::Send(if n == 0 {
            DebugCommand::StepOver
        } else {
            DebugCommand::Continue
        })
    })
    .await;
    let ids: Vec<&str> = pauses.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, ["s1", "s4"]);
}

#[tokio::test]
async fn a_breakpoint_in_a_loop_pauses_every_iteration() {
    let s = flow(vec![
        Step::new("control.repeat")
            .with_param("count", 3)
            .with_block("body", vec![log("x")]),
    ]);
    let (report, _, pauses) = debug_run(&Runtime::new(), s, debug_options(&["s2"]), |_, _| {
        Answer::Send(DebugCommand::Continue)
    })
    .await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(pauses.len(), 3);
}

#[tokio::test]
async fn swaps_that_lose_the_paused_position_are_refused() {
    let s = flow(vec![
        Step::new("control.group").with_block("body", vec![log("a"), fail("boom")]),
    ]);
    let revision = s.revision;
    let mut moved = s.clone();
    moved.revision += 1;
    // The block the run is in no longer has the step it already finished.
    moved.steps[0]
        .blocks
        .get_mut("body")
        .expect("body")
        .remove(0);
    let mut handle = Runtime::new().start(s, debug_options(&[])).expect("start");
    let control = handle.debug_control().expect("control");
    while let Some(event) = handle.next_event().await {
        if matches!(event.event, RunEvent::Paused { .. }) {
            let err = control.update_flow(moved.clone()).expect_err("refused");
            assert_eq!(err.code, "RESUME_INCOMPATIBLE");
            assert_eq!(control.revision(), revision);
            control.send(DebugCommand::Abort).expect("abort");
        }
    }
    assert_eq!(handle.wait().await.expect("wait").status, RunStatus::Failed);
}

#[tokio::test]
async fn a_fix_inside_a_switch_case_is_taken_while_paused() {
    // s1 switch { cases: [s2 case { s3 fail }] }, s4
    let switch = |message: &str| {
        flow(vec![
            Step::new("control.switch")
                .with_param("value", "'A'")
                .with_block(
                    "cases",
                    vec![
                        Step::new("control.case")
                            .with_param("values", json!(["A"]))
                            .with_block("body", vec![fail(message)]),
                    ],
                ),
            log("after"),
        ])
    };
    let s = switch("boom");
    let mut fixed = s.clone();
    fixed.revision += 1;
    fixed.steps[0].blocks.get_mut("cases").expect("cases")[0]
        .blocks
        .get_mut("body")
        .expect("body")[0] = log("fixed").with_id("s3");
    let mut handle = Runtime::new().start(s, debug_options(&[])).expect("start");
    let control = handle.debug_control().expect("control");
    let mut events = Vec::new();
    while let Some(event) = handle.next_event().await {
        if matches!(event.event, RunEvent::Paused { .. }) {
            assert!(control.update_flow(fixed.clone()).expect("taken"));
            control.send(DebugCommand::Retry).expect("retry");
        }
        events.push(event);
    }
    assert_eq!(
        handle.wait().await.expect("wait").status,
        RunStatus::Succeeded
    );
    assert_eq!(logs(&events), ["fixed", "after"]);
}

#[tokio::test]
async fn resuming_commands_need_a_pause_and_cancel_ends_a_paused_run() {
    let s = flow(vec![log("a")]);
    let mut options = debug_options(&[]);
    if let Some(debug) = options.debug.as_mut() {
        debug.pause_at_start = true;
    }
    let mut handle = Runtime::new().start(s, options).expect("start");
    let control = handle.debug_control().expect("control");
    while let Some(event) = handle.next_event().await {
        if let RunEvent::Paused { reason, .. } = event.event {
            assert_eq!(reason, PauseReason::Step);
            assert_eq!(
                control.send(DebugCommand::Retry).expect_err("retry").code,
                "NOTHING_TO_RETRY"
            );
            handle.cancel();
        }
    }
    assert_eq!(
        handle.wait().await.expect("wait").status,
        RunStatus::Cancelled
    );
    assert_eq!(
        control
            .send(DebugCommand::Continue)
            .expect_err("not paused")
            .code,
        "RUN_NOT_PAUSED"
    );
}

#[tokio::test]
async fn errors_in_parallel_branches_pause_at_the_parallel_step() {
    let flaky = flaky_runtime();
    let s = flow(vec![Step::new("control.parallel").with_block(
        "branches",
        vec![log("a"), Step::new("test.flaky").with_param("succeedOn", 2)],
    )]);
    let mut fixed = s.clone();
    fixed.revision += 1;
    fixed.steps[0].blocks.get_mut("branches").expect("branches")[1]
        .params
        .insert("succeedOn".into(), json!(1));
    // The retry runs the whole parallel step again, as fixed.
    let (report, _, pauses) = debug_run(&flaky, s, debug_options(&[]), |_, _| {
        Answer::Swap(Box::new(fixed.clone()), DebugCommand::Retry)
    })
    .await;
    assert_eq!(pauses, vec![("s1".to_owned(), PauseReason::Error)]);
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
}

/// A step that "opens" its `url` param: counts how often it really ran.
fn opener_def() -> StepTypeDef {
    StepTypeDef {
        step_type: "test.open".into(),
        params_schema: json!({ "type": "object", "properties": { "url": { "type": "string" } } }),
        has_output: false,
        targets: vec![spellsheet_core::TargetDef::site("url")],
        ..flaky_def()
    }
}

#[tokio::test]
async fn policy_sites_are_checked_after_templates_render() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = spellsheet_core::Policy::path(dir.path());
    std::fs::write(&path, r#"{ "sites": ["https://order.example.co.jp"] }"#).expect("write");
    let opened = Arc::new(Flaky(AtomicU32::new(0)));
    struct Shared(Arc<Flaky>);
    impl ActionHandler for Shared {
        fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
            self.0.execute(input)
        }
    }
    let runtime = Runtime::builder()
        .register(opener_def(), Shared(opened.clone()))
        .build()
        .with_policy(path.clone());
    let mut s = flow(vec![
        Step::new("test.open").with_param("url", "https://order.example.co.jp/list"),
        Step::new("test.open").with_param("url", "{{ next }}"),
    ]);
    s.variables.push(var(
        "next",
        VarType::String,
        VarDirection::Input,
        Some(json!("https://evil.example/steal")),
    ));
    let (report, _) = run(&runtime, s.clone(), json!({})).await;
    assert_eq!(report.status, RunStatus::Failed);
    let error = report.error.expect("error");
    assert_eq!(error.code, "SITE_NOT_ALLOWED");
    assert_eq!(error.step_id.as_ref().map(|s| s.as_str()), Some("s2"));
    assert_eq!(
        opened.0.load(Ordering::SeqCst),
        1,
        "the refused step never ran"
    );

    // A broken policy stops the run instead of allowing everything.
    std::fs::write(&path, "{ not json").expect("write");
    let e = runtime
        .start(s, RunOptions::default())
        .err()
        .expect("refused");
    assert_eq!(e.code, "POLICY_INVALID");
}

/// Writes `text` to `path` (as the step got it, after resolving).
struct WriteFile;
impl ActionHandler for WriteFile {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let path = input.params["path"].as_str().unwrap_or_default().to_owned();
            let text = input.params["text"].as_str().unwrap_or_default().to_owned();
            if let Some(dir) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(dir).map_err(|e| StepError::new("IO", e.to_string()))?;
            }
            std::fs::write(&path, text).map_err(|e| StepError::new("IO", e.to_string()))?;
            Ok(json!(path))
        })
    }
}

fn write_file_runtime() -> Runtime {
    let def = StepTypeDef {
        step_type: "test.writeFile".into(),
        label: "ファイルに書く".into(),
        params_schema: json!({ "type": "object" }),
        has_output: true,
        resources: vec![],
        secret_params: vec![],
        path_params: vec!["path".into()],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        risk: RiskLevel::Interactive,
        ..flaky_def()
    };
    Runtime::builder().register(def, WriteFile).build()
}

async fn run_project(
    runtime: &Runtime,
    s: Flow,
    options: RunOptions,
) -> (RunReport, Vec<RunEventEnvelope>) {
    let mut handle = runtime.start(s, options).expect("start");
    let mut events = Vec::new();
    while let Some(e) = handle.next_event().await {
        events.push(e);
    }
    (handle.wait().await.expect("report"), events)
}

#[tokio::test]
async fn relative_paths_are_resolved_from_each_flows_folder() {
    let main_dir = tempfile::tempdir().unwrap();
    let sub_dir = tempfile::tempdir().unwrap();
    let runtime = write_file_runtime();
    let write = |path: &str| {
        Step::new("test.writeFile")
            .with_param("path", path)
            .with_param("text", "x")
    };
    let mut sub = flow(vec![write("output/from-sub.txt")]);
    sub.id = "scn_sub".into();
    let s = flow(vec![
        write("output/{{ 'a' }}.txt"),
        Step::new("flow.call").with_param("flow", "scn_sub"),
    ]);
    let (report, _) = run_project(
        &runtime,
        s,
        RunOptions {
            project_dir: Some(main_dir.path().to_path_buf()),
            subflows: vec![Subflow {
                flow: sub,
                version: None,
                project_dir: Some(sub_dir.path().to_path_buf()),
            }],
            ..RunOptions::default()
        },
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert!(main_dir.path().join("output").join("a.txt").is_file());
    assert!(sub_dir.path().join("output").join("from-sub.txt").is_file());
    // Not a full run: no log.
    assert!(!main_dir.path().join("logs").exists());
}

#[tokio::test]
async fn the_report_names_the_files_a_run_wrote_with_their_stamp() {
    let main_dir = tempfile::tempdir().unwrap();
    let sub_dir = tempfile::tempdir().unwrap();
    let runtime = write_file_runtime();
    let write = |path: &str| {
        Step::new("test.writeFile")
            .with_param("path", path)
            .with_param("text", "abc")
    };
    let mut sub = flow(vec![write("output/from-sub.txt")]);
    sub.id = "scn_sub".into();
    let call = Step::new("flow.call").with_param("flow", "scn_sub");
    let s = flow(vec![
        write("output/a.txt"),
        write("output/a.txt"),
        // Logging stays inside the run.
        Step::new("log.message").with_param("message", "done"),
        call,
    ]);
    let (report, _) = run_project(
        &runtime,
        s,
        RunOptions {
            project_dir: Some(main_dir.path().to_path_buf()),
            subflows: vec![Subflow {
                flow: sub,
                version: None,
                project_dir: Some(sub_dir.path().to_path_buf()),
            }],
            ..RunOptions::default()
        },
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.touched.len(), 2, "{:#?}", report.touched);
    let main = &report.touched[0];
    assert_eq!(
        std::path::Path::new(&main.target),
        main_dir.path().join("output").join("a.txt")
    );
    assert_eq!(main.count, 2);
    assert!(!main.reads);
    assert_eq!(main.step_types, vec!["test.writeFile"]);
    let stamp = main.file.as_ref().expect("stamped");
    assert_eq!(stamp.size, 3);
    assert_eq!(
        stamp.sha256.as_deref(),
        Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    );
    let inner = &report.touched[1];
    assert!(inner.target.ends_with("from-sub.txt"));
    // flow() numbers the steps: the call is the fourth.
    assert_eq!(inner.call_path, vec![StepId::new("s4")]);
    // Without a browser there is no last page.
    assert!(report.last_screen.is_none());
}

#[tokio::test]
async fn a_full_run_starts_with_work_emptied_and_writes_a_log() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir_all(work.join("old")).unwrap();
    std::fs::write(work.join("stale.csv"), "x").unwrap();
    let runtime = write_file_runtime();
    let s = flow(vec![
        Step::new("test.writeFile")
            .with_param("path", "work/new.csv")
            .with_param("text", "y"),
        Step::new("control.fail").with_param("message", "締め日がありません"),
    ]);
    let options = || RunOptions {
        project_dir: Some(dir.path().to_path_buf()),
        full_run: true,
        ..RunOptions::default()
    };
    let (report, _) = run_project(&runtime, s.clone(), options()).await;
    assert_eq!(report.status, RunStatus::Failed);
    let mut left: Vec<String> = std::fs::read_dir(&work)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, ["new.csv"]);

    let logs: Vec<std::path::PathBuf> = std::fs::read_dir(dir.path().join("logs"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(logs.len(), 1);
    let name = logs[0].file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.ends_with("_failed.log"), "{name}");
    let text = std::fs::read_to_string(&logs[0]).unwrap();
    assert!(text.contains("START test"), "{text}");
    assert!(text.contains("ファイルに書く"), "{text}");
    assert!(text.contains("締め日がありません"), "{text}");
    assert!(text.contains("END FAILED"), "{text}");

    // keepWork leaves work/ as it is.
    let mut keep = s;
    keep.settings.keep_work = true;
    std::fs::write(work.join("keep.csv"), "x").unwrap();
    run_project(&runtime, keep, options()).await;
    assert!(work.join("keep.csv").is_file());
}

#[tokio::test]
async fn the_origin_of_a_run_is_recorded() {
    let runtime = Runtime::new();
    let handle = runtime
        .start(
            flow(vec![set("x", "1")]),
            RunOptions {
                origin: RunOrigin::new(RunTrigger::Schedule).requested_by("毎朝 8 時"),
                ..RunOptions::default()
            },
        )
        .expect("start");
    let mut events = Vec::new();
    let report = handle.wait_with(|e| events.push(e.clone())).await.unwrap();
    assert_eq!(report.origin.trigger, Some(RunTrigger::Schedule));
    assert_eq!(report.origin.requested_by.as_deref(), Some("毎朝 8 時"));
    assert_eq!(report.origin.machine, event::machine_name());
    match &events[0].event {
        RunEvent::RunStarted { origin, .. } => assert_eq!(origin, &report.origin),
        other => panic!("first event {other:?}"),
    }
    // Records written before origins existed still read.
    let mut old = serde_json::to_value(&report).unwrap();
    old.as_object_mut().unwrap().remove("origin");
    let old: RunReport = serde_json::from_value(old).unwrap();
    assert!(old.origin.is_empty());
}

fn click_def() -> StepTypeDef {
    StepTypeDef {
        targets: Vec::new(),
        step_type: "test.click".into(),
        label: "click".into(),
        params_schema: json!({ "type": "object" }),
        has_output: false,
        resources: vec![ResourceDef::Static(DESKTOP_INPUT.into())],
        secret_params: vec![],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        ..flaky_def()
    }
}

#[tokio::test]
async fn desktop_input_is_exclusive_across_processes() {
    let mouse = Arc::new(FakeMouse {
        active: AtomicU32::new(0),
        peak: AtomicU32::new(0),
    });
    struct Shared(Arc<FakeMouse>);
    impl ActionHandler for Shared {
        fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
            self.0.execute(input)
        }
    }
    let locks = tempfile::tempdir().unwrap();
    // Two Runtimes stand for two processes (Studio and the CLI): they share
    // nothing but the lock folder.
    let runtime = || {
        Runtime::builder()
            .register(click_def(), Shared(mouse.clone()))
            .build()
            .with_pc_locks(locks.path().to_path_buf())
    };
    let (a, b) = (runtime(), runtime());
    let s = || flow(vec![Step::new("test.click"), Step::new("test.click")]);
    let (ra, rb) = tokio::join!(run(&a, s(), json!({})), run(&b, s(), json!({})));
    assert_eq!(ra.0.status, RunStatus::Succeeded);
    assert_eq!(rb.0.status, RunStatus::Succeeded);
    assert_eq!(mouse.peak.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn desktop_input_also_waits_for_processes_from_before_the_rename() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("spellsheet-locks");
    let legacy = root
        .path()
        .join(spellsheet_core::paths::legacy_spelling("spellsheet-locks"));
    std::fs::create_dir_all(&legacy).unwrap();
    // An older worker holds the mouse and keyboard under the old folder.
    let held = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(legacy.join(format!("{}.lock", crate::DESKTOP_INPUT)))
        .unwrap();
    held.lock().unwrap();
    let runtime = Runtime::builder()
        .register(
            click_def(),
            FakeMouse {
                active: AtomicU32::new(0),
                peak: AtomicU32::new(0),
            },
        )
        .build()
        .with_pc_locks(dir);
    let blocked = tokio::time::timeout(
        Duration::from_millis(500),
        run(&runtime, flow(vec![Step::new("test.click")]), json!({})),
    )
    .await;
    assert!(blocked.is_err(), "ran while the old process held the lock");
    held.unlock().unwrap();
    let (report, _) = run(&runtime, flow(vec![Step::new("test.click")]), json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
}

#[tokio::test]
async fn desktop_steps_stop_while_the_screen_is_locked() {
    let runtime = Runtime::builder()
        .register(
            click_def(),
            FakeMouse {
                active: AtomicU32::new(0),
                peak: AtomicU32::new(0),
            },
        )
        .desktop_probe(Arc::new(|| Some("the screen is locked".into())))
        .build();
    let (report, _) = run(&runtime, flow(vec![Step::new("test.click")]), json!({})).await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "DESKTOP_UNAVAILABLE");
    assert_eq!(error.step_id.as_ref().map(|s| s.as_str()), Some("s1"));
    // Steps without the mouse and keyboard are not affected.
    let (report, _) = run(&runtime, flow(vec![log("ok")]), json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
}

#[tokio::test(start_paused = true)]
async fn desktop_steps_wait_for_the_unlock_when_the_policy_says_so() {
    // Locked for the first three looks, then unlocked.
    let looks = Arc::new(AtomicU32::new(0));
    let probe: DesktopProbe = {
        let looks = looks.clone();
        Arc::new(move || (looks.fetch_add(1, Ordering::SeqCst) < 3).then(|| "locked".to_owned()))
    };
    let dir = tempfile::tempdir().unwrap();
    let policy = dir.path().join("policy.json");
    std::fs::write(&policy, r#"{ "desktop": { "waitUnlockedMinutes": 1 } }"#).unwrap();
    let runtime = || {
        Runtime::builder()
            .register(
                click_def(),
                FakeMouse {
                    active: AtomicU32::new(0),
                    peak: AtomicU32::new(0),
                },
            )
            .desktop_probe(probe.clone())
            .build()
    };
    let waiting = runtime().with_policy(policy.clone());
    let (report, events) = run(&waiting, flow(vec![Step::new("test.click")]), json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    let said: Vec<_> = logs(&events)
        .into_iter()
        .filter(|l| l.contains("ロックが解かれる"))
        .collect();
    assert_eq!(said.len(), 1, "{said:?}");
    // Without the wait: stops at once, as before.
    looks.store(0, Ordering::SeqCst);
    std::fs::write(&policy, r#"{ "desktop": { "waitUnlockedMinutes": 0 } }"#).unwrap();
    let (report, _) = run(&waiting, flow(vec![Step::new("test.click")]), json!({})).await;
    assert_eq!(report.error.unwrap().code, "DESKTOP_UNAVAILABLE");
}

#[tokio::test]
async fn runs_with_desktop_input_keep_the_screen_awake_until_they_end() {
    struct Held(Arc<AtomicU32>);
    impl Drop for Held {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let held = Arc::new(AtomicU32::new(0));
    let asked = Arc::new(AtomicU32::new(0));
    let keep: KeepAwake = {
        let (held, asked) = (held.clone(), asked.clone());
        Arc::new(move || {
            held.fetch_add(1, Ordering::SeqCst);
            asked.fetch_add(1, Ordering::SeqCst);
            Box::new(Held(held.clone()))
        })
    };
    let runtime = Runtime::builder()
        .register(
            click_def(),
            FakeMouse {
                active: AtomicU32::new(0),
                peak: AtomicU32::new(0),
            },
        )
        .keep_awake(keep)
        .build();
    // Only files and logs: the screen may sleep.
    let (report, _) = run(&runtime, flow(vec![log("ok")]), json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(asked.load(Ordering::SeqCst), 0);
    // A mouse node, even nested: held for the run, released at its end.
    let nested = flow(vec![
        log("first"),
        Step::new("control.try").with_block("try", vec![Step::new("test.click")]),
    ]);
    let (report, _) = run(&runtime, nested, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    assert_eq!(held.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn finally_still_runs_when_a_run_is_cancelled() {
    let s = flow(vec![
        Step::new("control.try")
            .with_block("try", vec![delay(60_000)])
            .with_block(
                "finally",
                vec![log("closing the app"), delay(10), log("closed")],
            ),
        log("never"),
    ]);
    let mut handle = Runtime::new()
        .start(s, RunOptions::default())
        .expect("start");
    while let Some(e) = handle.next_event().await {
        if matches!(e.event, RunEvent::StepStarted { .. }) {
            break;
        }
    }
    handle.cancel();
    let mut events = Vec::new();
    let report = tokio::time::timeout(
        Duration::from_secs(5),
        handle.wait_with(|e| events.push(e.clone())),
    )
    .await
    .expect("finishes")
    .unwrap();
    assert_eq!(report.status, RunStatus::Cancelled);
    let logs = logs(&events);
    assert!(logs.contains(&"closing the app".to_string()));
    assert!(logs.contains(&"closed".to_string()));
    assert!(!logs.contains(&"never".to_string()));
}

#[tokio::test(start_paused = true)]
async fn a_nested_finally_does_not_extend_the_cleanup_deadline() {
    let inner = Step::new("control.try")
        .with_block("try", vec![delay(600_000)])
        .with_block("finally", vec![delay(600_000), log("inner done")]);
    let s = flow(vec![
        Step::new("control.try")
            .with_block("try", vec![delay(600_000)])
            .with_block("finally", vec![inner]),
    ]);
    let mut handle = Runtime::new()
        .start(s, RunOptions::default())
        .expect("start");
    while let Some(e) = handle.next_event().await {
        if matches!(e.event, RunEvent::StepStarted { .. }) {
            break;
        }
    }
    let started = tokio::time::Instant::now();
    handle.cancel();
    let mut events = Vec::new();
    let report = handle.wait_with(|e| events.push(e.clone())).await.unwrap();
    assert_eq!(report.status, RunStatus::Cancelled);
    // One grace period for all the cleanup, not one per nested `try`.
    assert!(started.elapsed() <= crate::exec::FINALLY_GRACE + Duration::from_secs(2));
    assert!(!logs(&events).contains(&"inner done".to_string()));
}

#[tokio::test]
async fn stopping_again_ends_the_finally_at_once() {
    let s = flow(vec![
        Step::new("control.try")
            .with_block("try", vec![delay(600_000)])
            .with_block(
                "finally",
                vec![log("closing"), delay(600_000), log("closed")],
            ),
    ]);
    let mut handle = Runtime::new()
        .start(s, RunOptions::default())
        .expect("start");
    while let Some(e) = handle.next_event().await {
        if matches!(e.event, RunEvent::StepStarted { .. }) {
            break;
        }
    }
    handle.cancel();
    let mut events = Vec::new();
    while let Some(e) = handle.next_event().await {
        let closing = matches!(&e.event, RunEvent::Log { message, .. } if message == "closing");
        events.push(e);
        if closing {
            break;
        }
    }
    // The clean-up waits; the second press does not.
    handle.cancel();
    let report = tokio::time::timeout(
        Duration::from_secs(5),
        handle.wait_with(|e| events.push(e.clone())),
    )
    .await
    .expect("the second stop ends the finally")
    .unwrap();
    assert_eq!(report.status, RunStatus::Cancelled);
    assert!(!logs(&events).contains(&"closed".to_string()));
}

#[tokio::test(start_paused = true)]
async fn an_adapter_that_never_closes_does_not_hold_a_stopped_run() {
    let runtime = Runtime::builder()
        .on_run_finished(Arc::new(|_| Box::pin(std::future::pending())))
        .build();
    let mut handle = runtime
        .start(flow(vec![delay(600_000)]), RunOptions::default())
        .expect("start");
    while let Some(e) = handle.next_event().await {
        if matches!(e.event, RunEvent::StepStarted { .. }) {
            break;
        }
    }
    handle.cancel();
    let started = tokio::time::Instant::now();
    let report = handle.wait().await.unwrap();
    assert_eq!(report.status, RunStatus::Cancelled);
    assert!(started.elapsed() <= Duration::from_secs(20));
}

#[tokio::test]
async fn a_group_that_will_try_again_does_not_pause_until_its_last_attempt() {
    // Two failures, two attempts: the first is retried quietly, the second pauses.
    let (report, _, pauses) = debug_run(
        &Runtime::new(),
        retried_group(5, 2),
        debug_options(&[]),
        |_, _| Answer::Send(DebugCommand::Abort),
    )
    .await;
    assert_eq!(pauses.len(), 1);
    assert_eq!(report.status, RunStatus::Failed);
    // It paused on the second run of the body.
    assert_eq!(report.outputs["n"], json!(2));
}

fn fake_def(step_type: &str) -> StepTypeDef {
    StepTypeDef {
        step_type: step_type.into(),
        params_schema: json!({ "type": "object" }),
        has_output: false,
        ..flaky_def()
    }
}

/// `test` fails; `browser.screenshot` writes its `path` and remembers the params.
struct Screen(Arc<std::sync::Mutex<Vec<Value>>>);

impl ActionHandler for Screen {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            if input.step_type.ends_with(".screenshot") {
                let path = input.params["path"].as_str().unwrap().to_owned();
                std::fs::write(&path, b"png").unwrap();
                self.0.lock().unwrap().push(input.params);
                Ok(json!(path))
            } else {
                Err(StepError::permanent("ELEMENT_NOT_FOUND", "no such button"))
            }
        })
    }
}

#[tokio::test]
async fn a_failed_browser_step_leaves_a_picture_of_the_page_beside_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let shots = Arc::new(std::sync::Mutex::new(Vec::new()));
    let runtime = Runtime::builder()
        .register(fake_def("browser.click"), Screen(shots.clone()))
        .register(fake_def("browser.screenshot"), Screen(shots.clone()))
        .build();
    let mut s = flow(vec![
        Step::new("browser.click").with_param("context", "{{ ctx }}"),
    ]);
    s.variables.push(var(
        "ctx",
        VarType::String,
        VarDirection::Local,
        Some(json!("受注")),
    ));
    let options = || RunOptions {
        project_dir: Some(dir.path().to_path_buf()),
        full_run: true,
        ..RunOptions::default()
    };
    let (report, _) = run_project(&runtime, s.clone(), options()).await;
    assert_eq!(report.status, RunStatus::Failed);
    let error = report.error.unwrap();
    let shot = error.details.as_ref().unwrap()["screenshot"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(shot.ends_with("_failed.png"), "{shot}");
    assert!(std::path::Path::new(&shot).is_file());
    assert_eq!(shots.lock().unwrap()[0]["context"], json!("受注"));
    let log = std::fs::read_dir(dir.path().join("logs"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "log"))
        .unwrap();
    assert_eq!(log.with_extension("png").display().to_string(), shot);

    // A run without a log (a single step an AI tries) takes no picture.
    let (report, _) = run_project(&runtime, s.clone(), RunOptions::default()).await;
    assert!(report.error.unwrap().details.is_none());
    assert_eq!(shots.lock().unwrap().len(), 1);

    // A step that fails inside a called flow leaves one too, of the context
    // it rendered with the called flow's variables.
    let mut sub = flow(vec![
        Step::new("browser.click").with_param("context", "{{ ctx }}"),
    ]);
    sub.id = "scn_sub".into();
    sub.variables.push(var(
        "ctx",
        VarType::String,
        VarDirection::Local,
        Some(json!("共通")),
    ));
    let mut caller = flow(vec![Step::new("flow.call").with_param("flow", "scn_sub")]);
    caller.variables = s.variables.clone();
    let (report, _) = run_project(
        &runtime,
        caller,
        RunOptions {
            subflows: vec![Subflow {
                flow: sub,
                version: None,
                project_dir: None,
            }],
            ..options()
        },
    )
    .await;
    assert_eq!(report.status, RunStatus::Failed);
    assert!(report.error.unwrap().details.unwrap()["screenshot"].is_string());
    assert_eq!(shots.lock().unwrap()[1]["context"], json!("共通"));
}

#[tokio::test]
async fn a_run_can_start_at_a_chosen_step() {
    let mut s = flow(vec![
        set("x", "1"),
        Step::new("control.group")
            .with_block("body", vec![log("before"), set("y", "x + 1"), log("after")]),
        log("end"),
    ]);
    for name in ["x", "y"] {
        s.variables.push(var(
            name,
            VarType::Number,
            VarDirection::Output,
            Some(json!(0)),
        ));
    }
    let start = s.steps[1].blocks["body"][1].id.clone();
    let handle = Runtime::new()
        .start(
            s.clone(),
            RunOptions {
                start_at: Some(start.clone()),
                start_values: json!({ "x": 5, "nope": 1 }).as_object().cloned().unwrap(),
                ..RunOptions::default()
            },
        )
        .expect("start");
    let mut events = Vec::new();
    let report = handle.wait_with(|e| events.push(e.clone())).await.unwrap();
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    // x = 1 never ran: the earlier run's 5 is used.
    assert_eq!(report.outputs["x"], json!(5));
    assert_eq!(report.outputs["y"], json!(6));
    let logs = logs(&events);
    assert!(logs[0].contains("から実行します"), "{logs:?}");
    assert_eq!(&logs[1..], ["after", "end"]);

    let mut inside_loop = s.clone();
    inside_loop.steps = vec![
        Step::new("control.repeat")
            .with_id("r")
            .with_param("count", 2)
            .with_block("body", vec![log("x").with_id("in")]),
    ];
    let error = Runtime::new()
        .start(
            inside_loop,
            RunOptions {
                start_at: Some("in".into()),
                ..RunOptions::default()
            },
        )
        .err()
        .expect("refused");
    assert_eq!(error.code, "START_INSIDE_BLOCK");
}

#[tokio::test]
async fn a_start_restores_inputs_and_values_steps_saved() {
    let mut s = flow(vec![set("z", "1"), set("w", "z + 1")]);
    s.variables
        .push(var("who", VarType::String, VarDirection::Input, None));
    s.variables.push(var(
        "w",
        VarType::Number,
        VarDirection::Output,
        Some(json!(0)),
    ));
    let start = s.steps[1].id.clone();
    let report = Runtime::new()
        .start(
            s,
            RunOptions {
                start_at: Some(start),
                // `who` is required and `z` is not declared (set by a step).
                start_values: json!({ "who": "佐藤", "z": 4 })
                    .as_object()
                    .cloned()
                    .unwrap(),
                ..RunOptions::default()
            },
        )
        .expect("start")
        .wait()
        .await
        .expect("wait");
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["w"], json!(5));
}

#[tokio::test]
async fn a_flow_swapped_in_while_paused_still_starts_at_the_chosen_step() {
    let s = flow(vec![log("a"), log("b")]);
    let start = s.steps[1].id.clone();
    let mut edited = s.clone();
    edited.revision += 1;
    edited.steps.push(log("c").with_id("c"));
    let mut options = debug_options(&[]);
    if let Some(debug) = options.debug.as_mut() {
        debug.pause_at_start = true;
    }
    options.start_at = Some(start);
    let mut handle = Runtime::new().start(s, options).expect("start");
    let control = handle.debug_control().expect("control");
    let mut events = Vec::new();
    let mut swapped = false;
    while let Some(event) = handle.next_event().await {
        if matches!(event.event, RunEvent::Paused { .. }) {
            if !swapped {
                // Studio sends the whole stored flow, with the step before.
                assert!(control.update_flow(edited.clone()).expect("taken"));
                swapped = true;
            }
            control.send(DebugCommand::Continue).expect("continue");
        }
        events.push(event);
    }
    assert_eq!(
        handle.wait().await.expect("wait").status,
        RunStatus::Succeeded
    );
    let logs = logs(&events);
    assert_eq!(&logs[1..], ["b", "c"], "{logs:?}");
}

#[tokio::test]
async fn a_finished_run_becomes_a_test_case_that_passes() {
    let mut s = flow(vec![set("doubled", "n * 2")]);
    s.variables = vec![
        var("n", VarType::Number, VarDirection::Input, Some(json!(1))),
        VariableDef {
            secret: true,
            ..var("pass", VarType::String, VarDirection::Input, None)
        },
        var("doubled", VarType::Number, VarDirection::Output, None),
        var("tmp", VarType::Number, VarDirection::Local, Some(json!(0))),
    ];
    let runtime = Runtime::new();
    let (report, events) = run(&runtime, s.clone(), json!({ "n": 21, "pass": "p" })).await;
    let (case, left_out) = testing::case_from_run(&s, &events, &report);
    assert_eq!(case.inputs, *json!({ "n": 21 }).as_object().unwrap());
    assert_eq!(left_out, ["pass"]);
    assert_eq!(
        case.expect.outputs,
        *json!({ "doubled": 42 }).as_object().unwrap()
    );

    let dir = tempfile::tempdir().unwrap();
    let policy = dir.path().join("policy.json");
    let records = testing::Records {
        workspace: dir.path(),
        policy: &policy,
    };
    let interrupt = testing::Interrupt::default();
    // The secret input is not kept in the case: a person passes it.
    let mut inputs = case.inputs.clone();
    inputs.insert("pass".into(), json!("p"));
    let options = RunOptions {
        inputs: inputs.clone(),
        ..RunOptions::default()
    };
    let result = testing::run_case(
        &runtime,
        records,
        &interrupt,
        "21",
        &case,
        s.clone(),
        options,
    )
    .await
    .unwrap();
    assert!(result.passed, "{:?}", result.mismatches);

    // A stopped suite cancels what starts after it.
    interrupt.stop();
    let records = testing::Records {
        workspace: dir.path(),
        policy: &policy,
    };
    let options = RunOptions {
        inputs,
        ..RunOptions::default()
    };
    let result = testing::run_case(&runtime, records, &interrupt, "21", &case, s, options)
        .await
        .unwrap();
    assert_eq!(result.status, RunStatus::Cancelled);
}

#[tokio::test]
async fn a_started_step_says_how_long_it_waits_and_when_it_gives_up() {
    let mut delay = Step::new("flow.delay").with_param("ms", 20);
    delay.timeout_ms = Some(5_000);
    let s = flow(vec![
        delay,
        Step::new("log.message").with_param("message", "x"),
    ]);
    let (_, events) = run(&Runtime::new(), s, json!({})).await;
    let started: Vec<(String, Option<u64>, Option<u64>)> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::StepStarted {
                step_type,
                wait_ms,
                limit_ms,
                ..
            } => Some((step_type.clone(), *wait_ms, *limit_ms)),
            _ => None,
        })
        .collect();
    assert_eq!(
        started,
        [
            ("flow.delay".to_string(), Some(20), Some(5_000)),
            (
                "log.message".to_string(),
                None,
                Some(crate::exec::DEFAULT_TIMEOUT_MS)
            ),
        ]
    );
}

/// A stand-in for a cloud storage plugin: `downloadFolder` writes
/// 受注.csv into `to`, `upload` records what it was sent.
struct FakeStorage {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
}
impl ActionHandler for FakeStorage {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((input.step_type.clone(), input.params.clone()));
            if input.step_type == "store.downloadFolder" {
                let to = std::path::PathBuf::from(input.params["to"].as_str().unwrap_or_default());
                std::fs::create_dir_all(&to).map_err(|e| StepError::new("IO", e.to_string()))?;
                std::fs::write(to.join("受注.csv"), "a,b")
                    .map_err(|e| StepError::new("IO", e.to_string()))?;
                return Ok(json!({ "files": [{ "name": "受注.csv" }] }));
            }
            if input.params["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("bad.txt"))
            {
                return Err(StepError::permanent("STORE_FULL", "the storage is full"));
            }
            Ok(json!({ "id": "1" }))
        })
    }
}

fn storage_runtime(calls: &Arc<Mutex<Vec<(String, Value)>>>) -> Runtime {
    let def = |step_type: &str, path: &str| StepTypeDef {
        step_type: step_type.into(),
        label: step_type.into(),
        params_schema: json!({ "type": "object" }),
        has_output: true,
        resources: vec![],
        secret_params: vec![],
        path_params: vec![path.into()],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        ..flaky_def()
    };
    let write = StepTypeDef {
        step_type: "test.writeFile".into(),
        label: "ファイルに書く".into(),
        params_schema: json!({ "type": "object" }),
        has_output: true,
        resources: vec![],
        secret_params: vec![],
        path_params: vec!["path".into()],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        ..flaky_def()
    };
    Runtime::builder()
        .register(
            def("store.downloadFolder", "to"),
            FakeStorage {
                calls: calls.clone(),
            },
        )
        .register(
            def("store.upload", "path"),
            FakeStorage {
                calls: calls.clone(),
            },
        )
        .register(write, WriteFile)
        .build()
}

#[tokio::test]
async fn a_folder_set_to_cloud_storage_fetches_input_first_and_sends_what_the_run_wrote() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("config")).unwrap();
    std::fs::create_dir_all(dir.path().join("output")).unwrap();
    std::fs::write(dir.path().join("output").join("old.txt"), "earlier run").unwrap();
    std::fs::write(
        dir.path().join("config").join("cloud.json"),
        r#"{"format":"spellsheet.cloud",
            "input":{"service":"store","label":"Store","secret":"S","folder":"経理/受注","pattern":"*.csv"},
            "output":{"service":"store","label":"Store","secret":"S","folder":"経理/結果"}}"#,
    )
    .unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let runtime = storage_runtime(&calls);
    let s = flow(vec![
        Step::new("test.writeFile")
            .with_param("path", "output/結果.txt")
            .with_param("text", "done"),
    ]);
    let options = || RunOptions {
        project_dir: Some(dir.path().to_path_buf()),
        full_run: true,
        ..RunOptions::default()
    };
    let (report, events) = run_project(&runtime, s, options()).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("input").join("受注.csv")).unwrap(),
        "a,b"
    );
    let calls_made = calls.lock().unwrap().clone();
    assert_eq!(calls_made.len(), 2, "{calls_made:?}");
    assert_eq!(calls_made[0].0, "store.downloadFolder");
    assert_eq!(calls_made[0].1["folder"], "経理/受注");
    assert_eq!(calls_made[0].1["pattern"], "*.csv");
    assert_eq!(
        calls_made[0].1["account"],
        json!({ "secret": "S", "field": "accessToken" })
    );
    // Only the file this run wrote is sent, not the earlier run's.
    assert_eq!(calls_made[1].0, "store.upload");
    assert!(
        calls_made[1].1["path"]
            .as_str()
            .unwrap()
            .ends_with("結果.txt")
    );
    assert_eq!(calls_made[1].1["folder"], "経理/結果");
    let logs: Vec<String> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::Log { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect();
    assert!(
        logs.iter()
            .any(|m| m.contains("Store の 経理/受注 から input/ に 1 ファイルを取得しました")),
        "{logs:?}"
    );
    assert!(
        logs.iter()
            .any(|m| m.contains("output/ の 1 ファイルを Store の 経理/結果 に送りました")),
        "{logs:?}"
    );

    // A failed upload fails the run, named as the transfer.
    std::fs::write(dir.path().join("output").join("bad.txt"), "x").unwrap();
    let bad = flow(vec![
        Step::new("test.writeFile")
            .with_param("path", "output/bad.txt")
            .with_param("text", "changed"),
    ]);
    let (report, _) = run_project(&runtime, bad, options()).await;
    assert_eq!(report.status, RunStatus::Failed);
    let error = report.error.unwrap();
    assert_eq!(error.code, "STORE_FULL");
    assert_eq!(
        error.step_label.as_deref(),
        Some("output/ のファイルを Store の 経理/結果 に送信")
    );
}

#[tokio::test]
async fn a_folder_set_to_a_storage_without_its_custom_node_fails_before_the_first_node() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("config")).unwrap();
    std::fs::write(
        dir.path().join("config").join("cloud.json"),
        r#"{"format":"spellsheet.cloud","input":{"service":"box","label":"Box","secret":"Box","folder":"経理"}}"#,
    )
    .unwrap();
    let runtime = write_file_runtime();
    let s = flow(vec![
        Step::new("test.writeFile")
            .with_param("path", "output/a.txt")
            .with_param("text", "x"),
    ]);
    let (report, _) = run_project(
        &runtime,
        s,
        RunOptions {
            project_dir: Some(dir.path().to_path_buf()),
            full_run: true,
            ..RunOptions::default()
        },
    )
    .await;
    assert_eq!(report.status, RunStatus::Failed);
    assert_eq!(report.error.unwrap().code, "CLOUD_NODE_MISSING");
    assert!(!dir.path().join("output").join("a.txt").exists());
}
