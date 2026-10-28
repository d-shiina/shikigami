use std::io::{Read, Write};

use serde_json::{Value, json};
use shikigami_core::resource::resource_keys;
use shikigami_core::{Scenario, Step, Validator, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};

use super::*;

fn runtime() -> Runtime {
    Runtime::builder().adapter(&WordAdapter::new()).build()
}

fn step(step_type: &str, params: Value) -> Step {
    let mut step = Step::new(step_type);
    for (key, value) in params.as_object().unwrap() {
        step = step.with_param(key, value.clone());
    }
    step
}

async fn run(steps: Vec<Step>) -> RunReport {
    let mut s = Scenario::new("word");
    s.variables.push(VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new("out", VarType::Any)
    });
    s.steps = steps;
    for step in &mut s.steps {
        shikigami_core::ops::assign_missing_ids(step);
    }
    let handle = runtime().start(s, RunOptions::default()).expect("start");
    handle.wait().await.expect("report")
}

const BODY: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>{{宛名}}</w:t></w:r><w:r><w:t xml:space="preserve"> 様</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>{{ 明細.品名 }}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{{ 明細.数量 }}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>合計 {{金額}} 円</w:t></w:r></w:p>
</w:body></w:document>"#;

fn template(dir: &tempfile::TempDir) -> String {
    let path = dir.path().join("テンプレート.docx");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("[Content_Types].xml", options).unwrap();
    zip.write_all(b"<Types/>").unwrap();
    zip.start_file("word/document.xml", options).unwrap();
    zip.write_all(BODY.as_bytes()).unwrap();
    zip.start_file("word/footer1.xml", options).unwrap();
    zip.write_all(r#"<w:ftr><w:p><w:r><w:t>{{ 宛名 }}</w:t></w:r></w:p></w:ftr>"#.as_bytes())
        .unwrap();
    zip.finish().unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn examples_validate_and_both_files_are_locked() {
    let validator = Validator::new(runtime().registry().clone());
    for def in definitions() {
        assert!(def.step_type.starts_with("word."));
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
            s.variables = ["order", "contractText"]
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
    let fill = definitions()
        .into_iter()
        .find(|d| d.step_type == types::FILL_TEMPLATE)
        .unwrap();
    assert_eq!(
        resource_keys(
            &fill.resources,
            &json!({ "template": "C:\\T.docx", "path": "C:\\out.docx" })
        ),
        ["file:c:\\out.docx", "file:c:\\t.docx"]
    );
}

#[tokio::test]
async fn a_template_is_filled_into_a_new_document() {
    let dir = tempfile::tempdir().unwrap();
    let template = template(&dir);
    let out = dir
        .path()
        .join("請求書.docx")
        .to_string_lossy()
        .into_owned();
    let report = run(vec![
        step(
            types::FILL_TEMPLATE,
            json!({ "template": template, "path": out, "values": {
            "宛名": "株式会社サンプル", "金額": 1500,
            "明細": [ { "品名": "りんご", "数量": 3 }, { "品名": "みかん", "数量": 5 } ]
        } }),
        ),
        {
            let mut s = step(types::READ_TEXT, json!({ "path": out }));
            s.save_as = Some("out".into());
            s
        },
    ])
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(
        report.outputs["out"],
        json!("株式会社サンプル 様\nりんご\n3\nみかん\n5\n合計 1500 円")
    );
    // The footer is filled too, other parts are copied, the template is unchanged.
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
    let mut footer = String::new();
    archive
        .by_name("word/footer1.xml")
        .unwrap()
        .read_to_string(&mut footer)
        .unwrap();
    assert!(footer.contains("株式会社サンプル"));
    assert!(archive.by_name("[Content_Types].xml").is_ok());
    let parts = read_parts(&template).unwrap();
    assert!(docx::names(&parts[0].1).contains("宛名"));
    let seen = WordAdapter::new()
        .inspect("s", json!({ "path": template }))
        .await
        .unwrap();
    assert_eq!(
        seen["placeholders"],
        json!(["宛名", "明細.品名", "明細.数量", "金額"])
    );
}

#[tokio::test]
async fn a_missing_value_names_every_placeholder_left() {
    let dir = tempfile::tempdir().unwrap();
    let template = template(&dir);
    let out = dir.path().join("x.docx").to_string_lossy().into_owned();
    let report = run(vec![step(
        types::FILL_TEMPLATE,
        json!({ "template": template, "path": out, "values": { "宛名": "A", "明細": [] } }),
    )])
    .await;
    assert_eq!(report.status, RunStatus::Failed);
    let error = report.error.unwrap();
    assert_eq!(error.code, "TEMPLATE_VALUE_MISSING");
    assert_eq!(error.details.unwrap()["missing"], json!(["金額"]));
    assert!(!std::path::Path::new(&out).exists());

    let report = run(vec![step(
        types::READ_TEXT,
        json!({ "path": dir.path().join("old.doc").to_string_lossy() }),
    )])
    .await;
    assert_eq!(report.error.unwrap().code, "UNSUPPORTED_FORMAT");
}

#[test]
fn a_stopped_attempt_never_replaces_the_document() {
    let dir = tempfile::tempdir().unwrap();
    let template = template(&dir);
    let out = dir.path().join("請求書.docx");
    std::fs::write(&out, b"later attempt").unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let params = json!({ "template": template, "path": out.to_string_lossy(), "values": {
        "宛名": "A", "金額": 1, "明細": []
    } });
    let err = fill_template(&params, &cancel).unwrap_err();
    assert_eq!(err.code, "CANCELLED");
    assert_eq!(std::fs::read(&out).unwrap(), b"later attempt");
    // No temporary file is left behind.
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
}
