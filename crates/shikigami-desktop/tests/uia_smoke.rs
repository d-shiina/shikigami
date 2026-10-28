//! UI Automation against a real app (Windows only; runs in CI): starts
//! Notepad, finds its text area, writes and reads it back without the
//! mouse or keyboard.

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
            json!({ "target": edit, "value": "式神 smoke test" }),
            None,
        ),
        step(types::GET_VALUE, json!({ "target": edit }), Some("text")),
    ];
    let report = runtime
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    kill(pid);
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["text"], json!("式神 smoke test"));
}

fn kill(pid: u64) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status();
}
