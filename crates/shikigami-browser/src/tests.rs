use std::path::{Path, PathBuf};
use std::sync::Arc;

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
const sessions = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  appendFileSync(log, JSON.stringify({ method, params }) + "\n");
  if (method === "click" && params.target?.text === "crash") process.exit(3);
  if (method === "click" && params.target?.text === "missing") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "no element",
      data: { code: "ELEMENT_NOT_FOUND", retryable: true, details: { hint: "look again" } } } }) + "\n");
    return;
  }
  if (method === "open" && params.session) sessions.push(params.session);
  const saved = sessions.splice(0).map((name) => ({ name, state: { cookies: [{ name: "sid", value: "abc" }] } }));
  if (method === "authorize") {
    const state = params.url.includes("forge=") ? "forged" : new URL(params.url).searchParams.get("state");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { url: `${params.redirectUrl}?code=c-1&state=${state}` } }) + "\n");
    return;
  }
  const result = method === "open" ? (sessions.push(...saved.map((s) => s.name)), { url: params.url, title: "fake" })
    : method === "getTable" ? [{ a: "1" }]
    : method === "closeRun" || method === "close" ? { sessions: saved }
    : (sessions.push(...saved.map((s) => s.name)), null);
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
    // The adapter stops each operation just before the step timeout (30 s).
    assert_eq!(calls[1]["params"]["timeoutMs"], json!(29_500));
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

fn vault(dir: &Path) -> Arc<shikigami_secrets::Vault> {
    let vault = shikigami_secrets::Vault::with_key_store(
        dir,
        Box::new(shikigami_secrets::MemoryKeyStore::default()),
    );
    vault
        .set(shikigami_secrets::SecretInput {
            name: "受注".into(),
            username: Some("tanaka".into()),
            password: Some("hunter2".into()),
            sites: Some(vec!["https://orders.example.com/login".into()]),
            ..Default::default()
        })
        .unwrap();
    vault
        .set(shikigami_secrets::SecretInput {
            name: "no-site".into(),
            password: Some("x".into()),
            ..Default::default()
        })
        .unwrap();
    Arc::new(vault)
}

fn fill_secret(name: &str, field: &str) -> Step {
    Step::new(types::FILL)
        .with_param("target", json!({ "label": "パスワード" }))
        .with_param("value", json!({ "secret": name, "field": field }))
}

#[tokio::test]
async fn secrets_go_to_the_adapter_with_their_sites_only() {
    let f = fake();
    let dir = tempfile::tempdir().unwrap();
    let runtime = f.runtime.clone().with_secrets(vault(dir.path()));
    let report = run(
        &runtime,
        vec![
            open("https://orders.example.com/"),
            fill_secret("受注", "password"),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let calls = calls(&f.log);
    assert_eq!(calls[1]["params"]["value"], "hunter2");
    assert_eq!(
        calls[1]["params"]["secret"],
        json!({ "name": "受注", "sites": ["https://orders.example.com"], "sensitive": true })
    );

    // A secret without a site is never typed anywhere.
    let report = run(
        &runtime,
        vec![open("https://x/"), fill_secret("no-site", "password")],
    )
    .await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "SECRET_SITE_NOT_SET");
    assert!(
        error.details.unwrap()["hint"]
            .as_str()
            .unwrap()
            .contains("Studio")
    );
}

#[tokio::test]
async fn logins_are_saved_when_the_run_ends_and_loaded_next_time() {
    let f = fake();
    let dir = tempfile::tempdir().unwrap();
    let secrets = vault(dir.path());
    let runtime = f.runtime.clone().with_secrets(secrets.clone());
    let open_session = || open("https://orders.example.com/").with_param("session", "受注");

    let report = run(&runtime, vec![open_session()]).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    use shikigami_core::secret::SecretProvider;
    let saved = secrets.load_session("受注").unwrap().unwrap();
    assert_eq!(saved["cookies"][0]["value"], "abc");

    run(&runtime, vec![open_session()]).await;
    let calls = calls(&f.log);
    let opens: Vec<&Value> = calls.iter().filter(|c| c["method"] == "open").collect();
    assert!(opens[0]["params"].get("storageState").is_none());
    assert_eq!(opens[1]["params"]["storageState"], saved);
}

/// A one-shot token endpoint: records the request, answers with tokens.
async fn token_endpoint() -> (String, Arc<std::sync::Mutex<String>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(std::sync::Mutex::new(String::new()));
    let record = seen.clone();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = socket.read(&mut chunk).await.unwrap();
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length: usize = text[..end]
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if buf.len() >= end + 4 + length {
                    *record.lock().unwrap() = text;
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        let body = r#"{"access_token":"at-1","refresh_token":"rt-1","expires_in":3600,"token_type":"bearer"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    (base, seen)
}

async fn sign_in(runtime: &Runtime, params: Value) -> RunReport {
    use shikigami_core::{VarDirection, VarType, VariableDef};
    let mut s = Scenario::new("oauth");
    s.variables.push(VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new("out", VarType::Any)
    });
    let mut step = Step::new(types::OAUTH_SIGN_IN);
    for (k, v) in params.as_object().unwrap() {
        step = step.with_param(k, v.clone());
    }
    step.save_as = Some("out".into());
    shikigami_core::ops::assign_missing_ids(&mut step);
    s.steps = vec![step];
    runtime
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap()
}

#[tokio::test]
async fn oauth_sign_in_catches_the_code_and_keeps_the_tokens() {
    use shikigami_core::secret::SecretProvider;
    let f = fake();
    let dir = tempfile::tempdir().unwrap();
    let (token, seen) = token_endpoint().await;
    let secrets = vault(dir.path());
    secrets
        .set(shikigami_secrets::SecretInput {
            name: "Box".into(),
            username: Some("cid".into()),
            password: Some("csecret".into()),
            sites: Some(vec![token.clone()]),
            ..Default::default()
        })
        .unwrap();
    let runtime = f.runtime.clone().with_secrets(secrets.clone());
    let params = json!({
        "secret": "Box",
        "authorizeUrl": "https://account.example.com/authorize",
        "tokenUrl": format!("{token}/token"),
        "redirectUrl": "https://www.example.com/",
        "scope": "root_readonly",
    });

    let report = sign_in(&runtime, params.clone()).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"]["via"], "browser");
    assert!(!report.outputs["out"].to_string().contains("at-1"));
    let authorize = calls(&f.log)
        .into_iter()
        .find(|c| c["method"] == "authorize")
        .unwrap();
    assert_eq!(
        authorize["params"]["redirectUrl"],
        "https://www.example.com/"
    );
    assert!(
        authorize["params"]["url"]
            .as_str()
            .unwrap()
            .contains("code_challenge=")
    );
    let request = seen.lock().unwrap().clone();
    assert!(request.starts_with("POST /token "), "{request}");
    for part in [
        "grant_type=authorization_code",
        "code=c-1",
        "redirect_uri=https%3A%2F%2Fwww.example.com%2F",
        "code_verifier=",
        "client_id=cid",
        "client_secret=csecret",
    ] {
        assert!(request.contains(part), "{part} in {request}");
    }
    let saved = secrets.load_oauth_tokens("Box").unwrap().unwrap();
    assert_eq!(saved["accessToken"], "at-1");
    assert_eq!(saved["refreshToken"], "rt-1");

    // Next time the saved tokens do: no browser, no person.
    let before = calls(&f.log).len();
    let report = sign_in(&runtime, params.clone()).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"]["via"], "saved");
    assert!(
        calls(&f.log)[before..]
            .iter()
            .all(|c| c["method"] != "authorize")
    );
}

#[tokio::test]
async fn oauth_sign_in_rejects_a_forged_state_and_unlisted_token_sites() {
    let f = fake();
    let dir = tempfile::tempdir().unwrap();
    let secrets = vault(dir.path());
    secrets
        .set(shikigami_secrets::SecretInput {
            name: "Box".into(),
            username: Some("cid".into()),
            sites: Some(vec!["https://api.box.com".into()]),
            ..Default::default()
        })
        .unwrap();
    let runtime = f.runtime.clone().with_secrets(secrets);
    let report = sign_in(
        &runtime,
        json!({
            "secret": "Box",
            "authorizeUrl": "https://account.box.com/api/oauth2/authorize",
            "tokenUrl": "https://api.box.com/oauth2/token",
            "redirectUrl": "https://www.example.com/",
            "authorizeParams": { "forge": "1" },
        }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "OAUTH_STATE_MISMATCH");

    // The client secret and the code only go to the secret's sites.
    let report = sign_in(
        &runtime,
        json!({
            "secret": "Box",
            "authorizeUrl": "https://account.box.com/api/oauth2/authorize",
            "tokenUrl": "https://evil.example.com/token",
            "redirectUrl": "https://www.example.com/",
        }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "SECRET_SITE_MISMATCH");
}
