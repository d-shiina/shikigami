//! UI Automation against a real app (Windows only; runs in CI): starts
//! Notepad, finds its text area, writes and reads it back without the
//! mouse or keyboard, then takes its picture, reads it with OCR and finds a
//! part of the picture again.

#![cfg(windows)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::{Value, json};
use shikigami_core::{Scenario, Step, VarDirection, VarType, VariableDef};
use shikigami_desktop::{DesktopAdapter, types};
use shikigami_runtime::{Adapter, RunOptions, RunStatus, Runtime};

fn step(step_type: &str, params: Value, save_as: Option<&str>) -> Step {
    let mut step = Step::new(step_type);
    for (key, value) in params.as_object().unwrap() {
        step = step.with_param(key, value.clone());
    }
    step.save_as = save_as.map(Into::into);
    shikigami_core::ops::assign_missing_ids(&mut step);
    step
}

#[tokio::test]
async fn notepad_round_trip() {
    let adapter = DesktopAdapter::new();
    let windows = adapter
        .inspect("smoke", json!({}))
        .await
        .expect("list windows");
    assert!(windows["windows"].is_array(), "{windows}");

    let runtime = Runtime::builder().adapter(&adapter).build();
    let mut s = Scenario::new("notepad");
    for name in ["pid", "text"] {
        s.variables.push(VariableDef {
            direction: VarDirection::Output,
            ..VariableDef::new(name, VarType::Any)
        });
    }
    let window = json!({ "process": "notepad.exe" });
    let edit = json!({ "window": window, "element": { "className": "Edit" } });
    s.steps = vec![
        step(types::LAUNCH, json!({ "path": "notepad.exe" }), Some("pid")),
        step(
            types::WAIT_FOR,
            json!({ "target": { "window": window } }),
            None,
        ),
    ];
    let report = runtime
        .start(s.clone(), RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let pid = report.outputs["pid"]["pid"].as_u64().unwrap();

    let tree = adapter
        .inspect("smoke", json!({ "window": window }))
        .await
        .expect("inspect notepad");
    let snapshot = tree["snapshot"].as_str().unwrap_or_default().to_owned();
    eprintln!("{snapshot}");
    if !snapshot.contains("textbox") {
        // The Windows 11 Notepad has no classic Edit control.
        kill(pid);
        eprintln!("skipped: this Notepad has no Edit control");
        return;
    }

    s.steps = vec![
        step(
            types::SET_VALUE,
            json!({ "target": edit, "value": "日本語 smoke test" }),
            None,
        ),
        step(types::GET_VALUE, json!({ "target": edit }), Some("text")),
    ];
    let report = runtime
        .start(s.clone(), RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["text"], json!("日本語 smoke test"));

    // The picture of the window, and OCR on it where an OCR pack is
    // installed (the result is printed; CI images differ in languages).
    let dir = std::env::var_os("SHIKIGAMI_SNAPSHOT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let _ = std::fs::create_dir_all(&dir);
    let shot = dir.join("notepad.png").display().to_string();
    s.steps = vec![
        step(
            types::SCREENSHOT,
            json!({ "target": { "window": window }, "path": shot }),
            None,
        ),
        step(
            types::READ_TEXT,
            json!({ "target": { "window": window } }),
            Some("text"),
        ),
    ];
    let report = runtime
        .start(s.clone(), RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    let picture = std::fs::read(&shot).expect("screenshot written");
    assert!(picture.starts_with(b"\x89PNG"));
    match &report.error {
        Some(e) if e.code == "OCR_LANGUAGE_MISSING" => eprintln!("OCR skipped: {e:?}"),
        _ => {
            assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
            eprintln!("OCR read: {}", report.outputs["text"]);
            // The words OCR found are on the window's picture: cut one out
            // and find it again as an image target.
            if let Some(line) = report.outputs["text"]["lines"]
                .as_array()
                .and_then(|l| l.first())
            {
                let cut = dir.join("notepad-cut.png").display().to_string();
                s.steps = vec![
                    step(
                        types::SCREENSHOT,
                        json!({ "target": { "window": window, "region": { "x": line["x"], "y": line["y"], "width": line["width"], "height": line["height"] } }, "path": cut }),
                        None,
                    ),
                    step(
                        types::IS_VISIBLE,
                        json!({ "target": { "window": window, "image": { "path": cut, "threshold": 0.95 } }, "waitMs": 0 }),
                        Some("text"),
                    ),
                ];
                let report = runtime
                    .start(s, RunOptions::default())
                    .unwrap()
                    .wait()
                    .await
                    .unwrap();
                assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
                assert_eq!(report.outputs["text"], json!(true));
            }
        }
    }
    kill(pid);
}

fn kill(pid: u64) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status();
}
