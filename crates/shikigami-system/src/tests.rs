use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use shikigami_core::secret::{ResolvedSecret, SecretError, SecretProvider, SecretRef};
use shikigami_core::{Scenario, Step, Validator, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

fn runtime() -> Runtime {
    adapters()
        .iter()
        .fold(Runtime::builder(), |b, a| b.adapter(a.as_ref()))
        .build()
}

async fn run(runtime: &Runtime, step_type: &str, params: Value) -> RunReport {
    let mut s = Scenario::new("system");
    s.variables.push(VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new("out", VarType::Any)
    });
    let mut step = Step::new(step_type);
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

#[test]
fn examples_validate() {
    let runtime = runtime();
    let validator = Validator::new(runtime.registry().clone());
    let defs = definitions();
    assert_eq!(defs.len(), 7);
    for def in &defs {
        assert!(runtime.registry().get(&def.step_type).is_some());
        assert!(!def.examples.is_empty(), "{}", def.step_type);
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
            s.variables = [
                "count", "rows", "res", "copied", "answer", "month", "csvPath",
            ]
            .iter()
            .map(|n| VariableDef::new(*n, VarType::Any))
            .collect();
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
}

/// A one-shot HTTP server: records the raw request, answers with `response`.
async fn serve(response: &'static str) -> (String, Arc<Mutex<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(String::new()));
    let record = seen.clone();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = socket.read(&mut chunk).await.unwrap();
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(head_end) = text.find("\r\n\r\n") {
                let length = text[..head_end]
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if buf.len() >= head_end + 4 + length {
                    *record.lock().unwrap() = text;
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    (format!("http://{addr}"), seen)
}

struct ApiToken(Vec<String>);

impl SecretProvider for ApiToken {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError> {
        Ok(ResolvedSecret {
            name: reference.secret.clone(),
            field: reference.field,
            value: match reference.field.as_str() {
                "username" => "robot".into(),
                _ => "tok-123".into(),
            },
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
async fn http_sends_json_and_parses_the_response() {
    let (base, seen) = serve(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 21\r\n\r\n{\"ok\":true,\"id\":\"42\"}",
    )
    .await;
    let report = run(
        &runtime().with_secrets(Arc::new(ApiToken(vec![base.clone()]))),
        types::HTTP_REQUEST,
        json!({
            "method": "POST",
            "url": format!("{base}/orders"),
            "query": { "date": "2026-10-28", "q": "東京" },
            "json": { "name": "山田" },
            "auth": { "secret": "受注API", "field": "password" },
        }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"]["status"], 200);
    assert_eq!(
        report.outputs["out"]["body"],
        json!({ "ok": true, "id": "42" })
    );
    let request = seen.lock().unwrap().clone();
    assert!(
        request.starts_with("POST /orders?date=2026-10-28&q=%E6%9D%B1%E4%BA%AC HTTP/1.1"),
        "{request}"
    );
    assert!(
        request
            .to_lowercase()
            .contains("authorization: bearer tok-123")
    );
    assert!(request.contains("{\"name\":\"山田\"}"));
}

#[tokio::test]
async fn http_refuses_to_send_a_secret_to_another_site() {
    let (base, seen) = serve("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
    let report = run(
        &runtime().with_secrets(Arc::new(ApiToken(vec!["https://api.example.com".into()]))),
        types::HTTP_REQUEST,
        json!({ "url": base, "auth": { "secret": "受注API", "field": "password" } }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "SECRET_SITE_MISMATCH");
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn http_basic_auth_form_and_errors() {
    let (base, seen) = serve(
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 9\r\n\r\nno order!",
    )
    .await;
    let report = run(
        &runtime().with_secrets(Arc::new(ApiToken(vec![base.clone()]))),
        types::HTTP_REQUEST,
        json!({
            "method": "POST",
            "url": base,
            "form": { "a": "x y", "b": 1 },
            "auth": { "secret": "受注API", "field": "password" },
            "authType": "basic",
        }),
    )
    .await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "HTTP_ERROR");
    assert_eq!(error.details.as_ref().unwrap()["status"], 404);
    assert_eq!(error.details.as_ref().unwrap()["body"], "no order!");
    let request = seen.lock().unwrap().clone();
    // robot:tok-123
    assert!(request.contains("Basic cm9ib3Q6dG9rLTEyMw=="), "{request}");
    assert!(request.ends_with("a=x+y&b=1"), "{request}");
}

#[tokio::test]
async fn http_saves_downloads_and_rejects_two_bodies() {
    let (base, _) = serve("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nPDF").await;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("dl/report.pdf").display().to_string();
    let report = run(
        &runtime(),
        types::HTTP_REQUEST,
        json!({ "url": base, "saveTo": target }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"]["body"], json!(target));
    assert_eq!(std::fs::read(&target).unwrap(), b"PDF");

    let report = run(
        &runtime(),
        types::HTTP_REQUEST,
        json!({ "url": "http://127.0.0.1:9/", "json": {}, "body": "x" }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "INVALID_PARAMS");
}

#[tokio::test]
async fn process_runs_and_checks_the_exit_code() {
    let (program, ok, fail) = if cfg!(windows) {
        (
            "cmd",
            vec!["/c", "echo hello & echo err 1>&2"],
            vec!["/c", "exit 3"],
        )
    } else {
        (
            "sh",
            vec!["-c", "echo hello; echo err >&2"],
            vec!["-c", "exit 3"],
        )
    };
    let report = run(
        &runtime(),
        types::PROCESS_RUN,
        json!({ "program": program, "args": ok }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"]["exitCode"], 0);
    assert!(
        report.outputs["out"]["stdout"]
            .as_str()
            .unwrap()
            .contains("hello")
    );
    assert!(
        report.outputs["out"]["stderr"]
            .as_str()
            .unwrap()
            .contains("err")
    );

    let report = run(
        &runtime(),
        types::PROCESS_RUN,
        json!({ "program": program, "args": fail }),
    )
    .await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "PROCESS_FAILED");
    assert_eq!(error.details.unwrap()["exitCode"], 3);
    let report = run(
        &runtime(),
        types::PROCESS_RUN,
        json!({ "program": program, "args": fail, "okExitCodes": [0, 3] }),
    )
    .await;
    assert_eq!(report.outputs["out"]["exitCode"], 3);

    let report = run(
        &runtime(),
        types::PROCESS_RUN,
        json!({ "program": "surely-not-a-program-xyz" }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "PROCESS_NOT_FOUND");
}

#[cfg(not(windows))]
#[tokio::test]
async fn desktop_steps_need_windows() {
    let report = run(&runtime(), types::CLIPBOARD_GET, json!({})).await;
    assert_eq!(report.error.unwrap().code, "PLATFORM_UNSUPPORTED");
    let report = run(&runtime(), types::DIALOG_MESSAGE, json!({ "message": "x" })).await;
    assert_eq!(report.error.unwrap().code, "PLATFORM_UNSUPPORTED");
}

#[tokio::test]
async fn secrets_do_not_follow_redirects_to_other_sites() {
    let (other, other_seen) = serve("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
    let redirect: &'static str = Box::leak(
        format!("HTTP/1.1 302 Found\r\nLocation: {other}/steal\r\nContent-Length: 0\r\n\r\n")
            .into_boxed_str(),
    );
    let (base, _) = serve(redirect).await;
    let report = run(
        &runtime().with_secrets(Arc::new(ApiToken(vec![base.clone()]))),
        types::HTTP_REQUEST,
        json!({
            "url": base,
            "auth": { "secret": "受注API", "field": "password" },
            "authType": "header",
            "authHeader": "X-API-Key",
        }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"]["status"], 302);
    assert!(other_seen.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn process_streams_large_stdin_through_a_filter() {
    let big = "あ".repeat(1_000_000);
    let report = run(
        &runtime(),
        types::PROCESS_RUN,
        json!({ "program": "cat", "stdin": big }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(
        report.outputs["out"]["stdout"].as_str().unwrap().len(),
        big.len()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_timed_out_process_takes_its_children_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.txt");
    let mut s = Scenario::new("system");
    let mut step = Step::new(types::PROCESS_RUN)
        .with_param("program", json!("sh"))
        .with_param(
            "args",
            json!([
                "-c",
                format!("(sleep 1; echo changed > '{}') & wait", target.display())
            ]),
        );
    step.timeout_ms = Some(200);
    shikigami_core::ops::assign_missing_ids(&mut step);
    s.steps = vec![step];
    let report = runtime()
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(report.status, RunStatus::Failed);
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert!(!target.exists(), "a background child outlived the step");
}
