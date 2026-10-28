use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use shikigami_core::secret::{ResolvedSecret, SecretError, SecretProvider, SecretRef};
use shikigami_core::{Scenario, Step, Validator, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};

use super::*;

/// The sample plugin in examples/plugins/hello. Needs `node` on PATH.
fn sample_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/hello")
}

fn runtime(plugin: &Plugin) -> Runtime {
    Runtime::builder().adapter(plugin).build()
}

/// Runs `steps`; every `saveAs` target becomes an output variable.
async fn run(runtime: &Runtime, steps: Vec<Value>) -> RunReport {
    let mut s = Scenario::new("plugin");
    for value in steps {
        let mut step: Step = serde_json::from_value(value).unwrap();
        shikigami_core::ops::assign_missing_ids(&mut step);
        if let Some(name) = &step.save_as {
            s.variables.push(VariableDef {
                direction: VarDirection::Output,
                ..VariableDef::new(name.clone(), VarType::Any)
            });
        }
        s.steps.push(step);
    }
    let report = Validator::new(runtime.registry().clone()).validate(&s);
    assert!(report.valid, "{:?}", report.issues);
    let handle = runtime.start(s, RunOptions::default()).expect("start");
    handle.wait().await.expect("report")
}

/// A plugin folder with `manifest` and a `main.mjs` script.
fn plugin_dir(manifest: Value, script: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(MANIFEST_FILE),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(dir.path().join("main.mjs"), script).unwrap();
    dir
}

fn manifest(name: &str, steps: Value) -> Value {
    json!({
        "manifestVersion": 1,
        "name": name,
        "version": "0.0.1",
        "label": "テスト",
        "command": { "program": "node", "args": ["main.mjs"] },
        "steps": steps,
    })
}

fn echo_step(extra: Value) -> Value {
    let mut step = json!({
        "action": "echo",
        "label": "そのまま返す",
        "description": "Returns its params.",
        "params": {
            "type": "object",
            "properties": { "value": { "type": "string" } },
            "required": ["value"],
            "additionalProperties": false
        },
        "hasOutput": true,
        "examples": [{ "type": "t.echo", "params": { "value": "x" }, "saveAs": "out" }]
    });
    if let (Some(step), Value::Object(extra)) = (step.as_object_mut(), extra) {
        step.extend(extra);
    }
    step
}

/// Echoes params back; `value: "crash"` exits, `value: "fail"` fails.
const ECHO: &str = r#"
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (params.value === "crash") process.exit(3);
  const reply = params.value === "fail"
    ? { error: { code: -32000, message: "no record", data: { code: "RECORD_NOT_FOUND", retryable: false, details: { hint: "check the id" } } } }
    : { result: { method, ...params } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...reply }) + "\n");
});
"#;

#[test]
fn sample_plugin_loads_and_its_steps_are_registered() {
    let plugin = Plugin::load(&sample_dir(), &["browser", "desktop"]).unwrap();
    assert_eq!(plugin.name(), "hello");
    let runtime = runtime(&plugin);
    let greet = runtime.registry().get("hello.greet").unwrap();
    assert!(greet.has_output);
    assert_eq!(greet.risk, shikigami_core::RiskLevel::Safe);
    let append = runtime.registry().get("hello.appendLine").unwrap();
    assert_eq!(
        shikigami_core::resource::resource_keys(
            &append.resources,
            &json!({ "path": r"C:\Data\Log.txt" })
        ),
        vec![r"file:c:\data\log.txt".to_owned()]
    );
}

#[tokio::test]
async fn sample_plugin_runs_steps() {
    let plugin = Plugin::load(&sample_dir(), &[]).unwrap();
    let runtime = runtime(&plugin);
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("log.txt");
    let report = run(
        &runtime,
        vec![
            json!({ "type": "hello.greet", "params": { "name": "佐藤" }, "saveAs": "greeting" }),
            json!({ "type": "hello.appendLine", "params": { "path": file, "text": "{{ greeting }}" }, "saveAs": "lines" }),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["greeting"], "こんにちは、佐藤さん");
    assert_eq!(report.outputs["lines"], 1);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "こんにちは、佐藤さん\n"
    );

    // Errors carry the plugin's code and hint.
    let report = run(
        &runtime,
        vec![json!({ "type": "hello.appendLine", "params": { "path": "log.txt", "text": "x" } })],
    )
    .await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "RELATIVE_PATH");
    assert!(
        error.details.unwrap()["hint"]
            .as_str()
            .unwrap()
            .contains("full path")
    );
}

#[tokio::test]
async fn params_get_run_id_and_a_shorter_timeout() {
    let dir = plugin_dir(manifest("t", json!([echo_step(json!({}))])), ECHO);
    let plugin = Plugin::load(dir.path(), &[]).unwrap();
    let report = run(
        &runtime(&plugin),
        vec![json!({ "type": "t.echo", "params": { "value": "a" }, "timeoutMs": 5000, "saveAs": "out" })],
    )
    .await;
    let out = &report.outputs["out"];
    assert_eq!(out["method"], "echo");
    assert_eq!(out["value"], "a");
    assert_eq!(out["timeoutMs"], 4500);
    assert_eq!(out["runId"], report.run_id.to_string());
}

#[tokio::test]
async fn a_crashing_plugin_fails_the_step_and_restarts() {
    let dir = plugin_dir(manifest("t", json!([echo_step(json!({}))])), ECHO);
    let plugin = Plugin::load(dir.path(), &[]).unwrap();
    let runtime = runtime(&plugin);
    let report = run(
        &runtime,
        vec![json!({ "type": "t.echo", "params": { "value": "crash" } })],
    )
    .await;
    assert_eq!(report.error.unwrap().code, "ADAPTER_CRASHED");
    let report = run(
        &runtime,
        vec![json!({ "type": "t.echo", "params": { "value": "fail" } })],
    )
    .await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "RECORD_NOT_FOUND");
    assert_eq!(error.details.unwrap()["hint"], "check the id");
}

struct OneSecret(Vec<String>);

impl SecretProvider for OneSecret {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError> {
        Ok(ResolvedSecret {
            name: reference.secret.clone(),
            field: reference.field,
            value: "hunter2".into(),
            sites: self.0.clone(),
        })
    }
    fn load_session(&self, _: &str) -> Result<Option<Value>, SecretError> {
        Ok(None)
    }
    fn save_session(&self, _: &str, _: &Value) -> Result<(), SecretError> {
        Ok(())
    }
}

#[tokio::test]
async fn secrets_reach_only_plugins_they_allow_and_stay_masked() {
    let dir = plugin_dir(
        manifest(
            "t",
            json!([echo_step(json!({ "secretParams": ["value"] }))]),
        ),
        ECHO,
    );
    let plugin = Plugin::load(dir.path(), &[]).unwrap();
    let step = json!({ "type": "t.echo", "params": { "value": { "secret": "社内", "field": "password" } }, "saveAs": "out" });

    let web = runtime(&plugin).with_secrets(Arc::new(OneSecret(vec!["https://x.example".into()])));
    let report = run(&web, vec![step.clone()]).await;
    assert_eq!(report.error.unwrap().code, "SECRET_PLUGIN_NOT_ALLOWED");

    let allowed = runtime(&plugin).with_secrets(Arc::new(OneSecret(vec!["plugin:t".into()])));
    let report = run(&allowed, vec![step]).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    // The plugin got the value; the run record shows it masked.
    let out = serde_json::to_string(&report.outputs).unwrap();
    assert!(!out.contains("hunter2"), "{out}");
    assert!(report.outputs["out"]["value"].is_string(), "{out}");

    // Params not listed in secretParams cannot take a secret.
    let plain = plugin_dir(
        manifest(
            "u",
            json!([echo_step(
                json!({ "examples": [{ "type": "u.echo", "params": { "value": "x" } }] })
            )]),
        ),
        ECHO,
    );
    let plugin = Plugin::load(plain.path(), &[]).unwrap();
    let mut s = Scenario::new("x");
    let mut step: Step = serde_json::from_value(
        json!({ "type": "u.echo", "params": { "value": { "secret": "社内", "field": "password" } } }),
    )
    .unwrap();
    shikigami_core::ops::assign_missing_ids(&mut step);
    s.steps.push(step);
    assert!(
        !Validator::new(runtime(&plugin).registry().clone())
            .validate(&s)
            .valid
    );
}

fn problems(manifest: Value) -> Vec<String> {
    let dir = plugin_dir(manifest, "");
    Plugin::load(dir.path(), &["browser"]).unwrap_err().problems
}

#[test]
fn bad_manifests_are_rejected_with_hints() {
    let has = |problems: &[String], text: &str| {
        assert!(
            problems.iter().any(|p| p.contains(text)),
            "{text}: {problems:?}"
        );
    };
    has(
        &problems(manifest("control", json!([echo_step(json!({}))]))),
        "reserved",
    );
    has(
        &problems(manifest("browser", json!([echo_step(json!({}))]))),
        "already used",
    );
    has(
        &problems(manifest("My-Plugin", json!([echo_step(json!({}))]))),
        "not a plugin name",
    );
    has(&problems(manifest("t", json!([]))), "no steps");
    has(
        &problems(manifest(
            "t",
            json!([echo_step(json!({})), echo_step(json!({}))]),
        )),
        "declared twice",
    );
    has(
        &problems(manifest(
            "t",
            json!([echo_step(json!({ "action": "closeRun" }))]),
        )),
        "used by the Runtime",
    );
    has(
        &problems(manifest("t", json!([echo_step(json!({ "examples": [] }))]))),
        "no examples",
    );
    // Examples are validated like scenario steps.
    has(
        &problems(manifest(
            "t",
            json!([echo_step(
                json!({ "examples": [{ "type": "t.echo", "params": { "valeu": "x" } }] })
            )]),
        )),
        "examples/0",
    );
    has(
        &problems(manifest(
            "t",
            json!([echo_step(
                json!({ "resources": [{ "kind": "file", "param": "path" }] })
            )]),
        )),
        "'path' is not a param",
    );
    has(
        &problems(manifest(
            "t",
            json!([echo_step(json!({ "secretParams": ["pw"] }))]),
        )),
        "'pw' is not a param",
    );
    // Unknown fields are typos, not extensions.
    let mut typo = manifest("t", json!([echo_step(json!({}))]));
    typo["comand"] = json!({});
    has(&problems(typo), "unknown field");
}

#[test]
fn discover_loads_folders_of_plugins_and_reports_the_rest() {
    let root = tempfile::tempdir().unwrap();
    let write = |name: &str, manifest: Value| {
        let dir = root.path().join(name);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), manifest.to_string()).unwrap();
    };
    write("a", manifest("t", json!([echo_step(json!({}))])));
    // Same name again: the first one wins.
    write("b", manifest("t", json!([echo_step(json!({}))])));
    write("c", json!({ "name": 1 }));
    std::fs::create_dir(root.path().join("not-a-plugin")).unwrap();

    let found = discover(
        &[
            root.path().to_path_buf(),
            root.path().join("missing"),
            sample_dir(),
        ],
        &["browser"],
    );
    let names: Vec<&str> = found.plugins.iter().map(|p| p.name()).collect();
    assert_eq!(names, ["t", "hello"]);
    assert_eq!(found.problems.len(), 2);
    assert!(found.problems[0].dir.ends_with("b"));
    assert!(found.problems[1].dir.ends_with("c"));
}
