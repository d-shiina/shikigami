use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use shikigami_core::{Scenario, Step, Validator};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};

use super::*;

/// A stand-in for the Node adapter: answers each request, records the calls
/// and dies on demand. Needs `node` on PATH (as the real adapter does).
const FAKE_ADAPTER: &str = r#"
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = __LOG__;
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  appendFileSync(log, JSON.stringify({ method, params }) + "\n");
  if (method === "click" && params.target?.text === "crash") process.exit(3);
  if (method === "click" && params.target?.text === "missing") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "no element",
      data: { code: "ELEMENT_NOT_FOUND", retryable: true, details: { hint: "look again" } } } }) + "\n");
    return;
  }
  const result = method === "open" ? { url: params.url, title: "fake" } : method === "getTable" ? [{ a: "1" }] : null;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
});
"#;

struct Fake {
    _dir: tempfile::TempDir,
    log: PathBuf,
    runtime: Runtime,
}

fn fake() -> Fake {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fake.mjs");
    let log = dir.path().join("calls.jsonl");
    std::fs::write(
        &script,
        FAKE_ADAPTER.replace("__LOG__", &serde_json::to_string(&log).unwrap()),
    )
    .unwrap();
    let adapter = BrowserAdapter::new(sidecar_config(PathBuf::from("node"), Some(script)));
    let runtime = Runtime::builder().adapter(&adapter).build();
    Fake {
        _dir: dir,
        log,
        runtime,
    }
}

fn calls(log: &Path) -> Vec<Value> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

async fn run(runtime: &Runtime, steps: Vec<Step>) -> RunReport {
    let mut s = Scenario::new("browser");
    s.steps = steps;
    for step in &mut s.steps {
        shikigami_core::ops::assign_missing_ids(step);
    }
    let handle = runtime.start(s, RunOptions::default()).expect("start");
    handle.wait().await.expect("report")
}

fn open(url: &str) -> Step {
    Step::new(types::OPEN).with_param("url", url)
}

fn click(text: &str) -> Step {
    Step::new(types::CLICK).with_param("target", json!({ "text": text }))
}

#[test]
fn every_example_is_a_valid_step() {
    let runtime = Runtime::builder()
        .adapter(&BrowserAdapter::new(sidecar_config("node".into(), None)))
        .build();
    let validator = Validator::new(runtime.registry().clone());
    for (def, _) in step_defs() {
        assert!(!def.examples.is_empty(), "{}", def.step_type);
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
            s.steps = vec![step];
            let report = validator.validate(&s);
            assert_eq!(
                report.error_count(),
                0,
                "{}: {:?}",
                def.step_type,
                report.issues
            );
        }
    }
    // A target needs at least one way to find the element.
    let mut s = Scenario::new("bad");
    s.steps = vec![
        Step::new(types::CLICK)
            .with_id("c")
            .with_param("target", json!({ "nth": 1 })),
    ];
    assert!(!validator.validate(&s).valid);
}

#[tokio::test]
async fn steps_forward_rendered_params_with_the_run_id() {
    let f = fake();
    let report = run(
        &f.runtime,
        vec![open("http://example.test/"), click("送信")],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let calls = calls(&f.log);
    let methods: Vec<&str> = calls
        .iter()
        .map(|c| c["method"].as_str().unwrap())
        .collect();
    // The run's contexts are closed when it ends.
    assert_eq!(methods, ["open", "click", "closeRun"]);
    assert_eq!(calls[0]["params"]["url"], "http://example.test/");
    assert_eq!(calls[1]["params"]["runId"], json!(report.run_id.as_str()));
    assert_eq!(calls[1]["params"]["target"], json!({ "text": "送信" }));
}

#[tokio::test]
async fn adapter_errors_keep_their_code_and_hint() {
    let f = fake();
    let report = run(&f.runtime, vec![open("http://x/"), click("missing")]).await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "ELEMENT_NOT_FOUND");
    assert_eq!(error.details.unwrap()["hint"], "look again");
}

#[tokio::test]
async fn a_crashed_adapter_fails_the_step_and_restarts() {
    let f = fake();
    let report = run(&f.runtime, vec![open("http://x/"), click("crash")]).await;
    assert_eq!(report.error.unwrap().code, "ADAPTER_CRASHED");
    // The next run starts a fresh adapter process.
    let report = run(&f.runtime, vec![open("http://x/")]).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
}

#[tokio::test]
async fn a_missing_adapter_is_reported_without_retrying() {
    let runtime = Runtime::builder()
        .adapter(&BrowserAdapter::new(sidecar_config("node".into(), None)))
        .build();
    let report = run(&runtime, vec![open("http://x/")]).await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "ADAPTER_UNAVAILABLE");
    assert!(
        error.details.unwrap()["hint"]
            .as_str()
            .unwrap()
            .contains("Node.js")
    );
}
