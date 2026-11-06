use serde_json::{Value, json};
use shikigami_core::{Flow, Step, Validator, VarType, VariableDef};
use shikigami_runtime::Runtime;

use super::*;

fn runtime() -> Runtime {
    Runtime::builder().adapter(&MailAdapter::new()).build()
}

#[test]
fn examples_validate() {
    let validator = Validator::new(runtime().registry().clone());
    let defs = definitions();
    assert_eq!(defs.len(), 4);
    for def in &defs {
        assert!(def.step_type.starts_with("mail."));
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Flow::new("example");
            s.variables = ["order", "invoice", "mails", "mail", "files"]
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
    // Only mail.send sends, and it is approved like other outside effects.
    for def in &defs {
        assert_eq!(
            def.risk == RiskLevel::Dangerous,
            def.step_type == types::SEND,
            "{}",
            def.step_type
        );
    }
}

fn draft(params: Value) -> Result<Draft, StepError> {
    match parse(Kind::CreateDraft, &params)? {
        Request::Draft(d) => Ok(d),
        _ => unreachable!(),
    }
}

#[test]
fn drafts_check_addresses_and_attachments() {
    let d = draft(json!({ "to": ["a@example.jp", ""], "cc": ["b@example.jp"], "subject": "件名", "body": "本文" })).unwrap();
    assert_eq!(d.to, ["a@example.jp"]);
    assert_eq!(d.cc, ["b@example.jp"]);
    assert!(!d.html);
    for bad in [
        json!(["山田"]),
        json!(["a@b"]),
        json!(["a@x.jp; b@x.jp"]),
        json!([]),
    ] {
        let e = draft(json!({ "to": bad, "subject": "s" })).unwrap_err();
        assert_eq!(e.code, "INVALID_ADDRESS", "{bad}");
    }
    let e =
        draft(json!({ "to": ["a@x.jp"], "subject": "s", "attachments": ["/no/such/file.pdf"] }))
            .unwrap_err();
    assert_eq!(e.code, "FILE_NOT_FOUND");
}

#[test]
fn list_filters_and_attachment_names() {
    let Ok(Request::List(q)) = parse(
        Kind::List,
        &json!({ "subjectContains": "請求書", "fromContains": "SAMPLE", "limit": 9999 }),
    ) else {
        panic!("list");
    };
    assert_eq!(q.limit, MAX_LIMIT);
    assert!(q.include_body);
    assert!(matches(
        &q,
        "【請求書】10月分",
        "株式会社サンプル",
        "billing@sample.co.jp"
    ));
    assert!(!matches(
        &q,
        "ご案内",
        "株式会社サンプル",
        "billing@sample.co.jp"
    ));
    assert!(!matches(&q, "請求書", "別の会社", "x@other.jp"));

    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        free_name(dir.path(), "請求書.pdf"),
        dir.path().join("請求書.pdf")
    );
    std::fs::write(dir.path().join("請求書.pdf"), b"").unwrap();
    assert_eq!(
        free_name(dir.path(), "請求書.pdf"),
        dir.path().join("請求書 (2).pdf")
    );
    // A name from outside cannot leave the folder.
    assert_eq!(
        free_name(dir.path(), "..\\..\\evil.exe"),
        dir.path().join("evil.exe")
    );
    assert_eq!(free_name(dir.path(), ".."), dir.path().join("attachment"));
}

#[cfg(not(windows))]
#[tokio::test]
async fn mail_needs_windows() {
    let mut s = Flow::new("mail");
    s.steps = vec![Step::new(types::LIST)];
    shikigami_core::ops::assign_missing_ids(&mut s.steps[0]);
    let report = runtime()
        .start(s, shikigami_runtime::RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(report.error.unwrap().code, "PLATFORM_UNSUPPORTED");
}

// -- mail.send ----------------------------------------------------------------

use std::sync::{Arc, Mutex};

use shikigami_core::secret::{ResolvedSecret, SecretError, SecretProvider, SecretRef};
use shikigami_core::{VarDirection, VariableDef as Var};
use shikigami_runtime::{RunOptions, RunReport, RunStatus};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[test]
fn the_way_of_sending_is_read_strictly() {
    assert_eq!(send::Via::parse(&json!({})).unwrap(), send::Via::Outlook);
    let e = send::Via::parse(&json!({ "server": "smtp.x.jp" })).unwrap_err();
    assert!(e.message.contains("server"), "{}", e.message);
    let send::Via::Smtp(smtp) = send::Via::parse(
        &json!({ "via": "smtp", "server": "SMTP.Example.co.jp", "from": "r@example.co.jp" }),
    )
    .unwrap() else {
        panic!("smtp");
    };
    assert_eq!(
        (smtp.host.as_str(), smtp.port, smtp.security),
        ("smtp.example.co.jp", 587, send::Security::StartTls)
    );
    let send::Via::Smtp(smtp) =
        send::Via::parse(&json!({ "via": "smtp", "server": "smtp.x.jp:465", "from": "r@x.jp" }))
            .unwrap()
    else {
        panic!("smtp");
    };
    assert_eq!((smtp.port, smtp.security), (465, send::Security::Tls));
    assert!(send::Via::parse(&json!({ "via": "smtp", "server": "smtp.x.jp" })).is_err());
    assert!(send::Via::parse(&json!({ "via": "microsoft365" })).is_err());
    assert_eq!(
        send::Via::parse(&json!({ "via": "microsoft365", "account": { "secret": "M365", "field": "accessToken" } })).unwrap(),
        send::Via::Microsoft365 { account: "M365".into() }
    );
}

fn sample(dir: &std::path::Path) -> Draft {
    let path = dir.join("請求書.pdf");
    std::fs::write(&path, b"%PDF\x00\xff\xfe").unwrap();
    Draft {
        to: vec!["keiri@example.co.jp".into()],
        cc: vec![],
        bcc: vec!["audit@example.co.jp".into()],
        subject: "請求書送付のご案内".into(),
        body: "山田様\n請求書をお送りします。".into(),
        html: false,
        attachments: vec![path.display().to_string()],
    }
}

#[test]
fn graph_messages_carry_recipients_and_files() {
    let dir = tempfile::tempdir().unwrap();
    let body = send::graph_message(&sample(dir.path())).unwrap();
    let message = &body["message"];
    assert_eq!(
        message["toRecipients"][0]["emailAddress"]["address"],
        "keiri@example.co.jp"
    );
    assert_eq!(
        message["bccRecipients"][0]["emailAddress"]["address"],
        "audit@example.co.jp"
    );
    assert_eq!(message["body"]["contentType"], "Text");
    assert_eq!(message["attachments"][0]["name"], "請求書.pdf");
    assert_eq!(message["attachments"][0]["contentBytes"], "JVBERgD//g==");
    assert_eq!(body["saveToSentItems"], true);
}

#[test]
fn graph_messages_must_fit_in_one_request() {
    let dir = tempfile::tempdir().unwrap();
    let mut draft = sample(dir.path());
    // Attachments under the 3 MB guess, but with the body the request is too big.
    std::fs::write(&draft.attachments[0], vec![0u8; 2_900_000]).unwrap();
    assert!(send::graph_message(&draft).is_ok());
    draft.body = "あ".repeat(100_000);
    let e = send::graph_message(&draft).unwrap_err();
    assert_eq!(e.code, "MAIL_ATTACHMENT_TOO_LARGE");
    assert!(!e.retryable);
}

#[tokio::test]
async fn a_send_whose_answer_is_lost_is_never_retried() {
    // The server reads the whole request, then hangs up without answering:
    // the message may have gone out.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 8192];
        let _ = socket.read(&mut buf).await;
        drop(socket);
    });
    let url = format!("http://{addr}/v1.0/me/sendMail");
    let e = send::graph_send(&url, "tok", &json!({})).await.unwrap_err();
    assert_eq!(e.code, "MAIL_DELIVERY_UNKNOWN");
    assert!(!e.retryable);

    // Nothing listening: nothing was sent, so a retry is safe.
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = closed.local_addr().unwrap();
    drop(closed);
    let url = format!("http://{addr}/v1.0/me/sendMail");
    let e = send::graph_send(&url, "tok", &json!({})).await.unwrap_err();
    assert_eq!(e.code, "MAIL_SERVER_UNREACHABLE");
    assert!(e.retryable);

    // A server error may come after the message was taken.
    let (url, _) = http_server("500 Internal Server Error").await;
    let e = send::graph_send(&url, "tok", &json!({})).await.unwrap_err();
    assert!(!e.retryable);
    let (url, _) = http_server("503 Service Unavailable").await;
    let e = send::graph_send(&url, "tok", &json!({})).await.unwrap_err();
    assert!(e.retryable);
}

/// A one-request HTTP server answering `status`; gives what it was sent.
async fn http_server(status: &'static str) -> (String, Arc<Mutex<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(String::new()));
    let keep = seen.clone();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = socket.read(&mut buf).await.unwrap();
            data.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&data).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    *keep.lock().unwrap() = text;
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        let response =
            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    (format!("http://{addr}/v1.0/me/sendMail"), seen)
}

#[tokio::test]
async fn graph_send_posts_with_the_token_and_names_refusals() {
    let (url, seen) = http_server("202 Accepted").await;
    send::graph_send(
        &url,
        "tok-123",
        &json!({ "message": { "subject": "件名" } }),
    )
    .await
    .unwrap();
    let request = seen.lock().unwrap().clone();
    assert!(request.starts_with("POST /v1.0/me/sendMail"), "{request}");
    assert!(
        request
            .to_lowercase()
            .contains("authorization: bearer tok-123")
    );
    assert!(request.contains("件名"));

    let (url, _) = http_server("403 Forbidden").await;
    let e = send::graph_send(&url, "tok", &json!({})).await.unwrap_err();
    assert_eq!(e.code, "MAIL_PERMISSION_DENIED");
}

/// A tiny SMTP server that takes one message without TLS or a login;
/// gives the DATA it received.
async fn smtp_server() -> (u16, Arc<Mutex<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(String::new()));
    let keep = seen.clone();
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let (read, mut write) = socket.into_split();
        let mut lines = BufReader::new(read).lines();
        write.write_all(b"220 test ESMTP\r\n").await.unwrap();
        let mut in_data = false;
        let mut data = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if in_data {
                if line == "." {
                    in_data = false;
                    write.write_all(b"250 queued\r\n").await.unwrap();
                } else {
                    data.push_str(&line);
                    data.push('\n');
                }
                continue;
            }
            let command = line.to_uppercase();
            let reply: &[u8] = if command.starts_with("EHLO") {
                b"250-test\r\n250 8BITMIME\r\n"
            } else if command.starts_with("DATA") {
                in_data = true;
                b"354 go\r\n"
            } else if command.starts_with("QUIT") {
                write.write_all(b"221 bye\r\n").await.unwrap();
                break;
            } else {
                b"250 ok\r\n"
            };
            write.write_all(reply).await.unwrap();
        }
        *keep.lock().unwrap() = data;
    });
    (port, seen)
}

#[tokio::test]
async fn smtp_sends_mime_with_the_attachment() {
    let dir = tempfile::tempdir().unwrap();
    let (port, seen) = smtp_server().await;
    let smtp = send::Smtp {
        host: "127.0.0.1".into(),
        port,
        security: send::Security::None,
        from: "robot@example.co.jp".into(),
    };
    send::smtp_send(&smtp, None, &sample(dir.path()), 10_000)
        .await
        .unwrap();
    let data = seen.lock().unwrap().clone();
    assert!(data.contains("From: robot@example.co.jp"), "{data}");
    assert!(data.contains("To: keiri@example.co.jp"), "{data}");
    // Bcc never shows in the message itself.
    assert!(!data.contains("audit@example.co.jp"), "{data}");
    // The subject is encoded (RFC 2047), the attachment named and in base64.
    assert!(data.contains("Subject: =?utf-8?"), "{data}");
    assert!(data.contains("JVBERgD//g=="), "{data}");
}

struct Login(Vec<String>);

impl SecretProvider for Login {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError> {
        Ok(ResolvedSecret {
            name: reference.secret.clone(),
            field: reference.field,
            value: "robot-secret".into(),
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

async fn run_send(sites: Vec<String>, params: Value) -> RunReport {
    let mut s = Flow::new("mail");
    s.variables.push(Var {
        direction: VarDirection::Output,
        ..Var::new("out", VarType::Any)
    });
    let mut step = Step::new(types::SEND);
    for (k, v) in params.as_object().unwrap() {
        step = step.with_param(k, v.clone());
    }
    step.save_as = Some("out".into());
    shikigami_core::ops::assign_missing_ids(&mut step);
    s.steps = vec![step];
    runtime()
        .with_secrets(Arc::new(Login(sites)))
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap()
}

#[tokio::test]
async fn an_smtp_login_goes_only_to_its_server_and_only_over_tls() {
    let login = |server: &str, security: &str| {
        json!({
            "via": "smtp", "server": server, "security": security, "from": "robot@example.co.jp",
            "user": { "secret": "社内メール", "field": "username" },
            "password": { "secret": "社内メール", "field": "password" },
            "to": ["keiri@example.co.jp"], "subject": "日次",
        })
    };
    let report = run_send(
        vec!["smtp:mail.example.co.jp".into()],
        login("evil.example.com", "starttls"),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "SECRET_SITE_MISMATCH");
    let report = run_send(
        vec!["smtp:127.0.0.1".into()],
        login("127.0.0.1:2525", "none"),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "MAIL_INSECURE_LOGIN");

    // A company relay that takes mail without a login.
    let (port, seen) = smtp_server().await;
    let report = run_send(
        vec![],
        json!({
            "via": "smtp", "server": format!("127.0.0.1:{port}"), "security": "none", "from": "robot@example.co.jp",
            "to": ["keiri@example.co.jp"], "subject": "日次", "body": "終わりました",
        }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!({ "via": "smtp" }));
    assert!(seen.lock().unwrap().contains("To: keiri@example.co.jp"));
}

#[tokio::test]
async fn a_secret_in_user_is_checked_like_the_password() {
    let report = run_send(
        vec!["smtp:mail.example.co.jp".into()],
        json!({
            "via": "smtp", "server": "evil.example.com", "from": "robot@example.co.jp",
            "user": { "secret": "社内メール", "field": "password" },
            "to": ["keiri@example.co.jp"], "subject": "日次",
        }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "SECRET_SITE_MISMATCH");
}

#[tokio::test]
async fn a_send_cut_off_by_the_step_time_is_never_sent_twice() {
    // A server that takes the whole message and then never says "queued".
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let connections = Arc::new(Mutex::new(0u32));
    let count = connections.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            *count.lock().unwrap() += 1;
            tokio::spawn(async move {
                let (read, mut write) = socket.into_split();
                let mut lines = BufReader::new(read).lines();
                write.write_all(b"220 test ESMTP\r\n").await.unwrap();
                let mut in_data = false;
                while let Ok(Some(line)) = lines.next_line().await {
                    if in_data {
                        continue;
                    }
                    let command = line.to_uppercase();
                    let reply: &[u8] = if command.starts_with("EHLO") {
                        b"250-test\r\n250 8BITMIME\r\n"
                    } else if command.starts_with("DATA") {
                        in_data = true;
                        b"354 go\r\n"
                    } else {
                        b"250 ok\r\n"
                    };
                    write.write_all(reply).await.unwrap();
                }
            });
        }
    });
    let mut s = Flow::new("mail");
    let mut step = Step::new(types::SEND);
    let params = json!({
        "via": "smtp", "server": format!("127.0.0.1:{port}"), "security": "none",
        "from": "robot@example.co.jp", "to": ["keiri@example.co.jp"], "subject": "日次",
    });
    for (k, v) in params.as_object().unwrap() {
        step = step.with_param(k, v.clone());
    }
    step.timeout_ms = Some(3_000);
    step.retry = Some(shikigami_core::model::RetryPolicy {
        max_attempts: 3,
        backoff_ms: 10,
        backoff_multiplier: 1.0,
    });
    shikigami_core::ops::assign_missing_ids(&mut step);
    s.steps = vec![step];
    let report = runtime()
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(report.error.unwrap().code, "MAIL_DELIVERY_UNKNOWN");
    assert_eq!(*connections.lock().unwrap(), 1);
}

#[test]
fn a_send_ends_before_the_step_time() {
    assert_eq!(send::send_limit_ms(60_000), 59_000);
    assert_eq!(send::send_limit_ms(1_000), 500);
}

#[tokio::test]
async fn an_smtp_connection_cut_after_the_message_is_never_retried() {
    let dir = tempfile::tempdir().unwrap();
    // The server takes the whole message, then hangs up without "queued".
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let (read, mut write) = socket.into_split();
        let mut lines = BufReader::new(read).lines();
        write.write_all(b"220 test ESMTP\r\n").await.unwrap();
        let mut in_data = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if in_data {
                if line == "." {
                    break;
                }
                continue;
            }
            let command = line.to_uppercase();
            let reply: &[u8] = if command.starts_with("EHLO") {
                b"250-test\r\n250 8BITMIME\r\n"
            } else if command.starts_with("DATA") {
                in_data = true;
                b"354 go\r\n"
            } else {
                b"250 ok\r\n"
            };
            write.write_all(reply).await.unwrap();
        }
    });
    let smtp = |port| send::Smtp {
        host: "127.0.0.1".into(),
        port,
        security: send::Security::None,
        from: "robot@example.co.jp".into(),
    };
    let e = send::smtp_send(&smtp(port), None, &sample(dir.path()), 10_000)
        .await
        .unwrap_err();
    assert_eq!(e.code, "MAIL_DELIVERY_UNKNOWN", "{}", e.message);
    assert!(!e.retryable);

    // Nothing listening: nothing was sent, so a retry is safe.
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let e = send::smtp_send(&smtp(port), None, &sample(dir.path()), 10_000)
        .await
        .unwrap_err();
    assert_eq!(e.code, "MAIL_SERVER_UNREACHABLE", "{}", e.message);
    assert!(e.retryable);
}
