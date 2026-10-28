use serde_json::{Value, json};
use shikigami_core::{Scenario, Step, Validator, VarType, VariableDef};
use shikigami_runtime::Runtime;

use super::*;

fn runtime() -> Runtime {
    Runtime::builder().adapter(&MailAdapter::new()).build()
}

#[test]
fn examples_validate() {
    let validator = Validator::new(runtime().registry().clone());
    let defs = definitions();
    assert_eq!(defs.len(), 3);
    for def in &defs {
        assert!(def.step_type.starts_with("mail."));
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
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
    // Nothing is ever sent by these steps.
    assert!(defs.iter().all(|d| d.risk != RiskLevel::Dangerous));
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
    let mut s = Scenario::new("mail");
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
