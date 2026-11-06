//! Edge IE mode through UI Automation (Windows only; an experiment run by
//! CI with the IE mode policies set): does a page that Edge shows on the
//! Internet Explorer engine list its elements, and do desktop.* steps work
//! on them? Ignored by default; CI runs it with `--ignored` and reports what
//! it saw as annotations.

#![cfg(windows)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use shikigami_core::{Scenario, Step};
use shikigami_desktop::{DesktopAdapter, types};
use shikigami_runtime::{Adapter, RunOptions, Runtime};

const PAGE: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\"><title>IE mode check</title></head><body>\
<h1>Order entry</h1><label for=\"q\">Customer</label><input id=\"q\" type=\"text\">\
<button id=\"b\" onclick=\"document.getElementById('r').innerText = 'Pressed ' + document.getElementById('q').value\">Register</button>\
<p id=\"m\"></p><p id=\"r\">Not yet</p>\
<script>document.getElementById('m').innerText = 'engine ' + (document.documentMode ? 'IE' + document.documentMode : 'Chromium');</script>\
</body></html>";

/// A GitHub annotation, so the result can be read without the log.
fn report(kind: &str, title: &str, text: &str) {
    let body: String = text.chars().take(6000).collect();
    println!(
        "::{kind} title={title}::{}",
        body.replace('%', "%25")
            .replace('\r', "")
            .replace('\n', "%0A")
    );
}

fn serve() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:8799").expect("port 8799");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{PAGE}",
                PAGE.len()
            );
        }
    });
    8799
}

fn step(step_type: &str, params: Value) -> Step {
    let mut step = Step::new(step_type);
    for (key, value) in params.as_object().unwrap() {
        step = step.with_param(key, value.clone());
    }
    shikigami_core::ops::assign_missing_ids(&mut step);
    step
}

async fn run(runtime: &Runtime, steps: Vec<Step>) -> String {
    let mut s = Scenario::new("ie");
    s.steps = steps;
    let report = runtime
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    format!("{:?} {:?}", report.status, report.error)
}

#[tokio::test]
#[ignore = "needs the Edge IE mode policies; CI runs it on purpose"]
async fn edge_ie_mode_page_through_ui_automation() {
    let port = serve();
    let edge = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    .into_iter()
    .find(|p| std::path::Path::new(p).is_file())
    .expect("Edge is installed");
    let profile = std::env::temp_dir().join("shikigami-ie-mode-profile");
    let mut child = std::process::Command::new(edge)
        .args([
            "--internet-explorer-integration=iemode".to_owned(),
            "--ie-mode-force".to_owned(),
            "--no-first-run".to_owned(),
            "--no-default-browser-check".to_owned(),
            format!("--user-data-dir={}", profile.display()),
            format!("http://127.0.0.1:{port}/"),
        ])
        .spawn()
        .expect("start Edge");

    let adapter = DesktopAdapter::new();
    // The first run found the window titled "Untitled - Profile 1 - Microsoft
    // Edge", so find it by its program and read the title from the tree.
    let window = json!({ "process": "msedge.exe" });
    let started = Instant::now();
    let mut snapshot = String::new();
    while started.elapsed() < Duration::from_secs(90) {
        if let Ok(tree) = adapter
            .inspect("ie", json!({ "window": window, "maxNodes": 400 }))
            .await
        {
            snapshot = tree["snapshot"].as_str().unwrap_or_default().to_owned();
            if snapshot.contains("engine") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let windows = adapter.inspect("ie", json!({})).await.unwrap_or_default();
    report("notice", "IE mode: windows", &windows.to_string());
    report("notice", "IE mode: tree of the Edge window", &snapshot);
    // A picture of the window, uploaded by CI, shows what Edge displayed.
    if let Ok(dir) = std::env::var("SHIKIGAMI_IE_SHOTS") {
        let _ = std::fs::create_dir_all(&dir);
        let path = std::path::Path::new(&dir).join("edge.png");
        let runtime = Runtime::builder().adapter(&adapter).build();
        let shot = run(
            &runtime,
            vec![step(
                types::SCREENSHOT,
                json!({ "target": { "window": window }, "path": path.display().to_string() }),
            )],
        )
        .await;
        report("notice", "IE mode: screenshot", &shot);
    }
    let engine = if snapshot.contains("engine IE") {
        "IE"
    } else if snapshot.contains("engine Chromium") {
        "Chromium (IE mode did not turn on)"
    } else {
        "unknown (page text not in the tree)"
    };

    let runtime = Runtime::builder().adapter(&adapter).build();
    let field = json!({ "window": window, "element": { "name": "Customer" } });
    let button = json!({ "window": window, "element": { "role": "button", "name": "Register" } });
    let set = run(
        &runtime,
        vec![step(
            types::SET_VALUE,
            json!({ "target": field, "value": "Aoba" }),
        )],
    )
    .await;
    let click = run(
        &runtime,
        vec![step(types::CLICK, json!({ "target": button }))],
    )
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after = adapter
        .inspect("ie", json!({ "window": window, "maxNodes": 400 }))
        .await
        .map(|t| t["snapshot"].as_str().unwrap_or_default().to_owned())
        .unwrap_or_default();
    report(
        "notice",
        "IE mode: result",
        &format!(
            "engine: {engine}\nsetValue: {set}\nclick: {click}\npressed seen: {}\n{after}",
            after.contains("Pressed Aoba")
        ),
    );
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::process::Command::new("taskkill")
        .args(["/IM", "msedge.exe", "/F"])
        .status();
}
