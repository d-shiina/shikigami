//! UI Automation against a real app (Windows only; runs in CI): starts
//! Notepad, finds its text area, writes and reads it back without the
//! mouse or keyboard, then takes its picture, reads it with OCR and finds a
//! part of the picture again.

#![cfg(windows)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::{Value, json};
use shikigami_core::{Flow, Step, VarDirection, VarType, VariableDef};
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
    let mut s = Flow::new("notepad");
    for name in ["pid", "text", "scrolled"] {
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

    // Scrolling without the mouse: a long text, then to its end and back.
    let long: String = (1..=300).map(|i| format!("line {i}\r\n")).collect();
    s.steps = vec![
        step(
            types::SET_VALUE,
            json!({ "target": edit, "value": long }),
            None,
        ),
        step(
            types::SCROLL,
            json!({ "target": edit, "direction": "bottom" }),
            Some("text"),
        ),
        step(
            types::SCROLL,
            json!({ "target": edit, "direction": "up", "amount": 2 }),
            Some("scrolled"),
        ),
    ];
    let report = runtime
        .start(s.clone(), RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    eprintln!("scroll: {:?} {:?}", report.outputs, report.error);
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["text"]["atEnd"], json!(true));
    assert!(
        report.outputs["scrolled"]["verticalPercent"]
            .as_f64()
            .unwrap()
            < 100.0
    );

    // The window itself: placed and sized, then maximized.
    s.steps = vec![
        step(
            types::SET_WINDOW,
            json!({ "target": { "window": window }, "state": "normal", "x": 40, "y": 30, "width": 640, "height": 480, "front": true }),
            Some("text"),
        ),
        step(
            types::SET_WINDOW,
            json!({ "target": { "window": window }, "state": "maximized" }),
            Some("scrolled"),
        ),
        step(
            types::SET_WINDOW,
            json!({ "target": { "window": window }, "state": "normal" }),
            None,
        ),
    ];
    let report = runtime
        .start(s.clone(), RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    eprintln!("window: {:?} {:?}", report.outputs, report.error);
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["text"]["state"], json!("normal"));
    assert_eq!(report.outputs["text"]["width"], json!(640));
    assert_eq!(report.outputs["text"]["x"], json!(40));
    assert_eq!(report.outputs["scrolled"]["state"], json!("maximized"));

    // The menu bar: Help > About Notepad opens a dialog (a modal one: the
    // step must not wait for it to close).
    let about = json!({ "window": { "process": "notepad.exe", "title": "About" } });
    s.steps = vec![
        step(
            types::SELECT_MENU,
            json!({ "target": { "window": window }, "path": ["Help", "About Notepad"] }),
            None,
        ),
        step(types::WAIT_FOR, json!({ "target": about }), None),
        step(types::CLOSE_WINDOW, json!({ "target": about }), None),
    ];
    let report = runtime
        .start(s.clone(), RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);

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

/// A WinForms window drawn by PowerShell (every Windows has it, and the
/// CI's Notepad has no classic Edit): a menu bar, a long text to scroll,
/// a DataGridView and a list view read with desktop.getTable.
#[tokio::test]
async fn winforms_menus_scrolling_and_tables() {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Shikigami Grid Test'
$f.Width = 600; $f.Height = 500
$g = New-Object System.Windows.Forms.DataGridView
$g.Name = 'grid'; $g.Dock = 'Top'; $g.Height = 200
[void]$g.Columns.Add('no', '番号')
[void]$g.Columns.Add('amount', '金額')
[void]$g.Rows.Add('A-1', '1,200')
[void]$g.Rows.Add('A-2', '300')
$l = New-Object System.Windows.Forms.ListView
$l.Name = 'files'; $l.View = 'Details'; $l.Dock = 'Bottom'; $l.Height = 200
[void]$l.Columns.Add('名前', 100)
[void]$l.Columns.Add('サイズ', 100)
$i = New-Object System.Windows.Forms.ListViewItem('a.txt')
[void]$i.SubItems.Add('1 KB')
[void]$l.Items.Add($i)
$t = New-Object System.Windows.Forms.TextBox
$t.Name = 'memo'; $t.Multiline = $true; $t.ScrollBars = 'Vertical'; $t.Dock = 'Fill'
$m = New-Object System.Windows.Forms.MenuStrip
$file = New-Object System.Windows.Forms.ToolStripMenuItem('ファイル(&F)')
$write = New-Object System.Windows.Forms.ToolStripMenuItem('メモを書く(&W)...')
$write.add_Click({ $t.Text = 'menu ok' })
[void]$file.DropDownItems.Add($write)
[void]$m.Items.Add($file)
$f.Controls.Add($t); $f.Controls.Add($g); $f.Controls.Add($l); $f.Controls.Add($m)
$f.MainMenuStrip = $m
[System.Windows.Forms.Application]::Run($f)
"#;
    let path = std::env::temp_dir().join("shikigami-grid-test.ps1");
    let mut bytes = b"\xEF\xBB\xBF".to_vec();
    bytes.extend_from_slice(script.as_bytes());
    std::fs::write(&path, bytes).unwrap();

    let long: String = (1..=300).map(|i| format!("line {i}\r\n")).collect();
    let adapter = DesktopAdapter::new();
    let runtime = Runtime::builder().adapter(&adapter).build();
    let mut s = Flow::new("grids");
    for name in ["pid", "grid", "files", "memo", "scrolled"] {
        s.variables.push(VariableDef {
            direction: VarDirection::Output,
            ..VariableDef::new(name, VarType::Any)
        });
    }
    let window = json!({ "title": "Shikigami Grid Test" });
    s.steps = vec![
        step(
            types::LAUNCH,
            json!({ "path": "powershell.exe", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.display().to_string()] }),
            Some("pid"),
        ),
        step(
            types::GET_TABLE,
            json!({ "target": { "window": window } }),
            Some("grid"),
        ),
        step(
            types::GET_TABLE,
            json!({ "target": { "window": window, "element": { "id": "files" } } }),
            Some("files"),
        ),
        step(
            types::SELECT_MENU,
            json!({ "target": { "window": window }, "path": ["ファイル", "メモを書く"] }),
            None,
        ),
        step(
            types::GET_VALUE,
            json!({ "target": { "window": window, "element": { "id": "memo" } } }),
            Some("memo"),
        ),
        step(
            types::SET_VALUE,
            json!({ "target": { "window": window, "element": { "id": "memo" } }, "value": long }),
            None,
        ),
        step(
            types::SCROLL,
            json!({ "target": { "window": window, "element": { "id": "memo" } }, "direction": "bottom" }),
            Some("scrolled"),
        ),
    ];
    let report = runtime
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    let tree = adapter
        .inspect("smoke", json!({ "window": window }))
        .await
        .map(|t| t["snapshot"].as_str().unwrap_or_default().to_owned());
    eprintln!("{tree:?}\n{:?}\n{:?}", report.outputs, report.error);
    if let Some(pid) = report.outputs["pid"]["pid"].as_u64() {
        kill(pid);
    }
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(
        report.outputs["grid"],
        json!([{ "番号": "A-1", "金額": "1,200" }, { "番号": "A-2", "金額": "300" }])
    );
    assert_eq!(
        report.outputs["files"],
        json!([{ "名前": "a.txt", "サイズ": "1 KB" }])
    );
    assert_eq!(report.outputs["memo"], json!("menu ok"));
    assert_eq!(report.outputs["scrolled"]["atEnd"], json!(true));
}
