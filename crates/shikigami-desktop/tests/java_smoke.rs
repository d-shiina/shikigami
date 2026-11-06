//! Java Access Bridge against a real Swing window (Windows only; runs in
//! CI, where the runners have JDKs): switches the bridge on, starts a
//! small Swing app and drives it with the usual desktop steps.

#![cfg(windows)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use serde_json::{Value, json};
use shikigami_core::{Scenario, Step, VarDirection, VarType, VariableDef};
use shikigami_desktop::{DesktopAdapter, types};
use shikigami_runtime::{Adapter, RunOptions, RunStatus, Runtime};

const APP: &str = r#"
import javax.swing.*;
import java.awt.*;

public class ShikigamiJavaTest {
    public static void main(String[] args) throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            JFrame f = new JFrame("Shikigami Java Test");
            JTextField name = new JTextField(12);
            name.getAccessibleContext().setAccessibleName("氏名");
            JLabel out = new JLabel("-");
            out.getAccessibleContext().setAccessibleName("結果");
            JButton ok = new JButton("登録");
            ok.addActionListener(e -> out.setText("登録:" + name.getText()));
            JCheckBox mail = new JCheckBox("メール送信");
            JTable table = new JTable(
                new Object[][] { { "A-1", "1,200" }, { "A-2", "300" } },
                new Object[] { "番号", "金額" });
            JMenuBar bar = new JMenuBar();
            JMenu file = new JMenu("ファイル");
            JMenuItem clear = new JMenuItem("消去");
            clear.addActionListener(e -> out.setText("消去しました"));
            file.add(clear);
            bar.add(file);
            f.setJMenuBar(bar);
            JPanel top = new JPanel();
            top.add(name); top.add(ok); top.add(mail); top.add(out);
            f.add(top, BorderLayout.NORTH);
            f.add(new JScrollPane(table), BorderLayout.CENTER);
            f.setSize(640, 400);
            f.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
            f.setVisible(true);
        });
    }
}
"#;

/// Java source with every non-ASCII character as a \u escape, so the
/// compiler's default encoding does not matter.
fn ascii(source: &str) -> String {
    source
        .encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii() => c.to_string(),
            _ => format!("\\u{u:04x}"),
        })
        .collect()
}

/// A JDK that can run a source file (11 or later).
fn jdk() -> Option<PathBuf> {
    [
        "JAVA_HOME_21_X64",
        "JAVA_HOME_17_X64",
        "JAVA_HOME_11_X64",
        "JAVA_HOME",
    ]
    .iter()
    .filter_map(std::env::var_os)
    .map(|home| PathBuf::from(home).join("bin"))
    .find(|bin| bin.join("java.exe").exists() && bin.join("jabswitch.exe").exists())
}

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
async fn swing_through_the_access_bridge() {
    let Some(bin) = jdk() else {
        eprintln!("skipped: no JDK 11+ with jabswitch");
        return;
    };
    let status = std::process::Command::new(bin.join("jabswitch.exe"))
        .arg("-enable")
        .status()
        .expect("jabswitch");
    assert!(status.success());
    let dir = std::env::temp_dir().join("shikigami-java-test");
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("ShikigamiJavaTest.java");
    std::fs::write(&source, ascii(APP)).unwrap();

    let adapter = DesktopAdapter::new();
    let runtime = Runtime::builder().adapter(&adapter).build();
    let mut s = Scenario::new("java");
    for name in ["pid", "after", "mail", "rows", "cleared"] {
        s.variables.push(VariableDef {
            direction: VarDirection::Output,
            ..VariableDef::new(name, VarType::Any)
        });
    }
    let window = json!({ "title": "Shikigami Java Test" });
    let el = |role: &str, name: &str| json!({ "window": window, "element": { "role": role, "name": name } });
    s.steps = vec![
        step(
            types::LAUNCH,
            json!({ "path": bin.join("java.exe").display().to_string(), "args": [source.display().to_string()] }),
            Some("pid"),
        ),
        step(
            types::SET_VALUE,
            json!({ "target": el("textbox", "氏名"), "value": "山田" }),
            None,
        ),
        step(
            types::CLICK,
            json!({ "target": el("button", "登録") }),
            None,
        ),
        step(
            types::GET_VALUE,
            json!({ "target": el("text", "結果") }),
            Some("after"),
        ),
        step(
            types::CLICK,
            json!({ "target": el("checkbox", "メール送信") }),
            None,
        ),
        step(
            types::GET_VALUE,
            json!({ "target": el("checkbox", "メール送信") }),
            Some("mail"),
        ),
        step(
            types::GET_TABLE,
            json!({ "target": { "window": window } }),
            Some("rows"),
        ),
        step(
            types::SELECT_MENU,
            json!({ "target": { "window": window }, "path": ["ファイル", "消去"] }),
            None,
        ),
        step(
            types::GET_VALUE,
            json!({ "target": el("text", "結果") }),
            Some("cleared"),
        ),
    ];
    // The JVM takes a while to start.
    for step in &mut s.steps {
        step.timeout_ms = Some(60_000);
    }
    let report = runtime
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    let tree = adapter.inspect("java", json!({ "window": window })).await;
    eprintln!("{tree:?}\n{:?}\n{:?}", report.outputs, report.error);
    if let Some(pid) = report.outputs["pid"]["pid"].as_u64() {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .status();
    }
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["after"], json!("登録:山田"));
    assert_eq!(report.outputs["mail"], json!(true));
    assert_eq!(
        report.outputs["rows"],
        json!([{ "番号": "A-1", "金額": "1,200" }, { "番号": "A-2", "金額": "300" }])
    );
    assert_eq!(report.outputs["cleared"], json!("消去しました"));
    assert_eq!(tree.unwrap()["app"], json!("java"));
}
