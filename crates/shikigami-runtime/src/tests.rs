use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde_json::json;
use shikigami_core::registry::{RiskLevel, StepCategory};
use shikigami_core::{RetryPolicy, Step, VarDirection, VarType, VariableDef};

use super::*;

fn scenario(steps: Vec<Step>) -> Scenario {
    let mut s = Scenario::new("test");
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

async fn run(runtime: &Runtime, s: Scenario, inputs: Value) -> (RunReport, Vec<RunEventEnvelope>) {
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
async fn runs_the_example_scenario_without_ai() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/invoice-summary.json");
    let text = std::fs::read_to_string(path).expect("example");
    let s = shikigami_core::migrate::parse_scenario(&text).expect("parse");
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
    let mut s = scenario(vec![]);
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
async fn invalid_scenarios_do_not_start() {
    let s = scenario(vec![Step::new("control.if")]);
    let err = Runtime::new()
        .start(s, RunOptions::default())
        .err()
        .expect("invalid");
    assert_eq!(err.code, "VALIDATION_FAILED");
}

#[tokio::test]
async fn loops_with_break_and_continue() {
    let mut s = scenario(vec![
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
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["acc"], json!("023"));
    assert_eq!(report.outputs["n"], json!(3));
}

#[tokio::test]
async fn infinite_loops_are_bounded() {
    let s = scenario(vec![
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
    let mut s = scenario(vec![
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
    let s = scenario(vec![
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
    let mut s = scenario(vec![step]);
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
    let (report, _) = run(&flaky_runtime(), scenario(vec![step.clone()]), json!({})).await;
    assert_eq!(
        report.error.map(|e| e.code),
        Some("ELEMENT_NOT_FOUND".into())
    );

    step.on_error = Some(OnError::Continue);
    let mut s = scenario(vec![step, set("code", "lastError.code")]);
    s.variables
        .push(var("code", VarType::String, VarDirection::Output, None));
    let (report, _) = run(&flaky_runtime(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(report.outputs["code"], json!("ELEMENT_NOT_FOUND"));
}

#[tokio::test]
async fn steps_time_out() {
    let mut step = Step::new("test.flaky").with_param("sleepMs", 5_000);
    step.timeout_ms = Some(20);
    let (report, _) = run(&flaky_runtime(), scenario(vec![step]), json!({})).await;
    assert_eq!(report.error.map(|e| e.code), Some("STEP_TIMEOUT".into()));
}

#[tokio::test]
async fn runs_can_be_cancelled_mid_step() {
    let s = scenario(vec![
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
    let mut s = scenario(vec![
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
async fn disabled_steps_are_skipped() {
    let mut skipped = log("skipped");
    skipped.disabled = true;
    let (_, events) = run(
        &Runtime::new(),
        scenario(vec![skipped, log("ran")]),
        json!({}),
    )
    .await;
    assert_eq!(logs(&events), ["ran"]);
}

#[tokio::test]
async fn run_records_round_trip() {
    let dir = tempfile::tempdir().expect("tmp");
    let handle = Runtime::new()
        .start(scenario(vec![log("hello")]), RunOptions::default())
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
    let mut s = scenario(vec![
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
    let s = scenario(vec![parallel(vec![
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
    let s = scenario(vec![parallel(vec![fail(), fail()])]);
    let err = flaky_runtime()
        .start(s, RunOptions::default())
        .err()
        .expect("invalid");
    assert!(err.details.unwrap().to_string().contains("lastError"));
}

#[tokio::test]
async fn a_failing_branch_cancels_the_others() {
    let s = scenario(vec![parallel(vec![
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
    let s = scenario(vec![
        parallel(vec![delay(150), delay(150)]).with_param("maxConcurrency", 1),
    ]);
    let started = std::time::Instant::now();
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert!(started.elapsed() >= Duration::from_millis(300));
}

#[tokio::test]
async fn break_cannot_leave_a_parallel_branch() {
    let s = scenario(vec![
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
        step_type: "test.click".into(),
        label: "click".into(),
        params_schema: json!({ "type": "object" }),
        has_output: false,
        resources: vec![ResourceDef::Static(DESKTOP_INPUT.into())],
        secret_params: vec![],
        default_timeout_ms: None,
        ..flaky_def()
    };
    let runtime = Runtime::builder()
        .register(def, Shared(mouse.clone()))
        .build();
    let click = || Step::new("test.click");
    let s = || {
        scenario(vec![parallel(vec![
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
        step_type: "test.writeFile".into(),
        label: "write".into(),
        params_schema: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        has_output: false,
        resources: vec![ResourceDef::file("path")],
        secret_params: vec![],
        default_timeout_ms: None,
        ..flaky_def()
    };
    let runtime = Runtime::builder()
        .register(def, Shared(writer.clone()))
        .build();
    let write = |path: &str| Step::new("test.writeFile").with_param("path", path);

    // Different spellings of one file (one via a template) never overlap...
    let mut s = scenario(vec![parallel(vec![
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
    let s = scenario(vec![parallel(vec![
        write(r"C:\Data\a.xlsx"),
        write(r"C:\Data\b.xlsx"),
    ])]);
    let (report, _) = run(&runtime, s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(writer.peak.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn queued_branches_do_not_start_after_a_failure() {
    let s = scenario(vec![
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
    let s = scenario(vec![parallel((0..16).map(|_| branch()).collect())]);
    let (report, events) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
    let expected: Vec<u64> = (0..seqs.len() as u64).collect();
    assert_eq!(seqs, expected);
}

#[tokio::test]
async fn numeric_params_take_an_integer_or_a_template() {
    let mut s = scenario(vec![
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
    let mut s = scenario(vec![wait_until("n >= 3", vec![set("n", "n + 1")])]);
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
    let (report, _) = run(&Runtime::new(), scenario(vec![wait.clone()]), json!({})).await;
    let error = report.error.expect("timeout");
    assert_eq!(error.code, "WAIT_TIMEOUT");
    let details = error.details.unwrap();
    assert!(details["elapsedMs"].as_u64().unwrap() >= 200);
    assert!(details["polls"].as_u64().unwrap() >= 3);

    wait.on_error = Some(OnError::Continue);
    let mut s = scenario(vec![wait, set("code", "lastError.code")]);
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
    let mut s = scenario(vec![step]);
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
    let mut s = scenario(vec![step]);
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
    let s = scenario(vec![
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
    let s = shikigami_core::migrate::parse_scenario(&text).expect("parse");
    let (report, _) = run(&Runtime::new(), s, json!({})).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["total"], json!(348700));
    assert_eq!(report.outputs["taxed"][1], json!(165000));
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
    let mut s = scenario(vec![
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
    let mut s = scenario(vec![set("greeting", "'pw=' + password")]);
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
        reference: &shikigami_core::secret::SecretRef,
    ) -> Result<shikigami_core::secret::ResolvedSecret, shikigami_core::secret::SecretError> {
        if reference.secret != "受注" {
            return Err(shikigami_core::secret::SecretError::new(
                "SECRET_NOT_FOUND",
                "no such secret",
            ));
        }
        Ok(shikigami_core::secret::ResolvedSecret {
            name: reference.secret.clone(),
            field: reference.field,
            value: match reference.field {
                shikigami_core::secret::SecretField::Username => "tanaka".into(),
                _ => "hunter2".into(),
            },
            sites: vec!["https://example.com".into()],
        })
    }

    fn load_session(
        &self,
        _name: &str,
    ) -> Result<Option<Value>, shikigami_core::secret::SecretError> {
        Ok(None)
    }

    fn save_session(
        &self,
        _name: &str,
        _state: &Value,
    ) -> Result<(), shikigami_core::secret::SecretError> {
        Ok(())
    }
}

/// Test input step: types `value` (a secret or text) and echoes it to the
/// log and the output, as a careless adapter might.
fn typing_def() -> StepTypeDef {
    StepTypeDef {
        step_type: "test.type".into(),
        params_schema: json!({ "type": "object", "properties": { "value": shikigami_core::secret::text_or_secret_schema("text") } }),
        has_output: true,
        secret_params: vec!["value".into()],
        default_timeout_ms: Some(50),
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
    let mut s = scenario(vec![
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
}

#[tokio::test]
async fn large_values_are_recorded_as_a_preview() {
    let s = scenario(vec![
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
    let mut s = scenario(vec![parallel(vec![
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
    let s = scenario(vec![step]);
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
    let mut s = scenario(vec![
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
    let all = serde_json::to_string(&events).expect("json");
    assert!(!all.contains("s3cr3t") && !all.contains("4821"));
}

#[tokio::test]
async fn missing_secrets_fail_the_step_with_a_hint() {
    let mut s =
        scenario(vec![Step::new("test.type").with_param(
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
    let mut s = scenario(vec![Step::new("test.type").with_param("value", "slow")]);
    // The scenario default is long; the step type's own 50 ms wins.
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
    /// Swap in this scenario, then send the command.
    Swap(Box<Scenario>, DebugCommand),
}

/// Runs `s` interactively, answering each pause with `answer(n, event)`
/// (`n` counts pauses from 0). Returns the report, every event and the
/// pauses as (step, reason).
async fn debug_run(
    runtime: &Runtime,
    s: Scenario,
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
                Answer::Swap(scenario, command) => {
                    control.update_scenario(*scenario).expect("swap");
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
    let s = scenario(vec![set("n", "41"), fail("boom"), set("n", "n + 1")]);
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
    assert_eq!(error.expect("error").code, "SCENARIO_FAILED");
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
    let s = scenario(vec![
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
    let s = scenario(vec![log("a"), fail("boom"), log("c"), log("d")]);
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
    let mut s = scenario(vec![wait]);
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
async fn skip_leaves_the_failed_step_undone() {
    let s = scenario(vec![fail("boom"), log("after")]);
    let (report, events, _) = debug_run(&Runtime::new(), s, debug_options(&[]), |_, _| {
        Answer::Send(DebugCommand::Skip)
    })
    .await;
    assert_eq!(report.status, RunStatus::Succeeded);
    assert!(logs(&events).contains(&"after".to_owned()));
}

#[tokio::test]
async fn abort_fails_the_run_without_pausing_again_further_out() {
    let s = scenario(vec![
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
    let s = scenario(vec![
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
    let s = scenario(vec![
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
    let s = scenario(vec![fail("boom")]);
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
    let s = scenario(vec![
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
    let s = scenario(vec![
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
    let s = scenario(vec![
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
    let s = scenario(vec![
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
            let err = control.update_scenario(moved.clone()).expect_err("refused");
            assert_eq!(err.code, "RESUME_INCOMPATIBLE");
            assert_eq!(control.revision(), revision);
            control.send(DebugCommand::Abort).expect("abort");
        }
    }
    assert_eq!(handle.wait().await.expect("wait").status, RunStatus::Failed);
}

#[tokio::test]
async fn resuming_commands_need_a_pause_and_cancel_ends_a_paused_run() {
    let s = scenario(vec![log("a")]);
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
    let s = scenario(vec![Step::new("control.parallel").with_block(
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
