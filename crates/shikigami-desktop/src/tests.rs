use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::{Value, json};
use shikigami_core::resource::resource_keys;
use shikigami_core::secret::{ResolvedSecret, SecretError, SecretProvider, SecretRef};
use shikigami_core::{Scenario, Step, Validator, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};

use super::*;
use crate::engine::Engine;
use crate::target::{NodeInfo, WindowInfo, app_allowed, pick_element, pick_window, render_tree};

/// A backend that records each request and answers from a script (then
/// `null`).
#[derive(Default)]
struct Scripted {
    calls: Mutex<Vec<Op>>,
    answers: Mutex<VecDeque<Result<Value, StepError>>>,
}

impl Scripted {
    fn new(answers: Vec<Result<Value, StepError>>) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::default(),
            answers: Mutex::new(answers.into()),
        })
    }

    fn calls(&self) -> Vec<Op> {
        self.calls.lock().unwrap().clone()
    }
}

impl Backend for Scripted {
    fn call(&self, op: Op) -> BoxFuture<'static, Result<Value, StepError>> {
        self.calls.lock().unwrap().push(op);
        let answer = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(Value::Null));
        Box::pin(async move { answer })
    }
}

fn runtime(backend: Arc<Scripted>) -> Runtime {
    Runtime::builder()
        .adapter(&DesktopAdapter::with_backend(backend))
        .build()
}

async fn run(runtime: &Runtime, steps: Vec<Step>) -> RunReport {
    let mut s = Scenario::new("desktop");
    s.variables.push(VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new("out", VarType::Any)
    });
    s.steps = steps;
    for step in &mut s.steps {
        shikigami_core::ops::assign_missing_ids(step);
    }
    let handle = runtime.start(s, RunOptions::default()).expect("start");
    handle.wait().await.expect("report")
}

fn save_button() -> Value {
    json!({ "window": { "process": "billing.exe" }, "element": { "id": "btnSave" } })
}

trait Saving {
    fn saving(self, name: &str) -> Self;
}

impl Saving for Step {
    fn saving(mut self, name: &str) -> Self {
        self.save_as = Some(name.into());
        self
    }
}

fn step(step_type: &str, params: Value) -> Step {
    let mut step = Step::new(step_type);
    for (key, value) in params.as_object().unwrap() {
        step = step.with_param(key, value.clone());
    }
    step
}

#[test]
fn examples_validate_and_targets_are_checked() {
    let runtime = runtime(Scripted::new(vec![]));
    let validator = Validator::new(runtime.registry().clone());
    let defs = definitions();
    assert_eq!(defs.len(), 11);
    for def in &defs {
        assert!(def.step_type.starts_with("desktop."));
        assert!(!def.examples.is_empty(), "{}", def.step_type);
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
            s.variables = ["customerCode", "orderNo", "outDir", "total", "confirmShown"]
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
    let invalid = |target: Value| {
        let mut s = Scenario::new("bad");
        s.steps = vec![step(types::CLICK, json!({ "target": target })).with_id("c")];
        !validator.validate(&s).valid
    };
    // A window needs a title or process; roles come from the shared list.
    assert!(invalid(json!({ "window": {} })));
    assert!(invalid(
        json!({ "window": { "process": "a.exe" }, "element": { "role": "knob" } })
    ));
    assert!(invalid(
        json!({ "window": { "process": "a.exe" }, "element": {} })
    ));
    // Coordinates only on mouse steps.
    assert!(invalid(
        json!({ "window": { "process": "a.exe" }, "point": { "x": 1, "y": 2 } })
    ));
    assert!(!invalid(save_button()));
}

#[test]
fn only_mouse_and_keyboard_steps_take_the_input_lock() {
    let defs = definitions();
    let keys = |step_type: &str| {
        let def = defs.iter().find(|d| d.step_type == step_type).unwrap();
        resource_keys(&def.resources, &json!({ "target": save_button() }))
    };
    assert_eq!(keys(types::CLICK), ["window:billing"]);
    assert_eq!(keys(types::SET_VALUE), ["window:billing"]);
    for t in [types::MOUSE_CLICK, types::TYPE, types::PRESS] {
        assert_eq!(keys(t), ["desktop.input", "window:billing"], "{t}");
    }
    assert!(keys(types::LAUNCH).is_empty());
}

#[tokio::test]
async fn steps_wait_for_their_target_to_appear() {
    let not_yet = || Err(StepError::new("ELEMENT_NOT_FOUND", "not yet"));
    let backend = Scripted::new(vec![not_yet(), not_yet(), Ok(Value::Null)]);
    let report = run(
        &runtime(backend.clone()),
        vec![step(types::CLICK, json!({ "target": save_button() }))],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let calls = backend.calls();
    assert_eq!(calls.len(), 3);
    let Op::Click { target } = &calls[0] else {
        panic!("{calls:?}")
    };
    assert_eq!(target.window.process.as_deref(), Some("billing.exe"));
    assert_eq!(
        target.element.as_ref().unwrap().id.as_deref(),
        Some("btnSave")
    );
}

#[tokio::test]
async fn other_errors_fail_at_once() {
    let backend = Scripted::new(vec![Err(StepError::permanent("ELEMENT_AMBIGUOUS", "2"))]);
    let report = run(
        &runtime(backend.clone()),
        vec![step(types::CLICK, json!({ "target": save_button() }))],
    )
    .await;
    assert_eq!(report.status, RunStatus::Failed);
    assert_eq!(report.error.unwrap().code, "ELEMENT_AMBIGUOUS");
    assert_eq!(backend.calls().len(), 1);
}

#[tokio::test]
async fn values_and_keys_reach_the_backend() {
    let backend = Scripted::new(vec![Ok(Value::Null), Ok(json!("1,200")), Ok(Value::Null)]);
    let target = || json!({ "window": { "title": "請求" }, "element": { "id": "txt" } });
    let report = run(
        &runtime(backend.clone()),
        vec![
            step(
                types::SET_VALUE,
                json!({ "target": target(), "value": "{{ 40 + 2 }}" }),
            ),
            step(types::GET_VALUE, json!({ "target": target() })).saving("out"),
            step(
                types::PRESS,
                json!({ "target": target(), "key": "Control+S" }),
            ),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!("1,200"));
    let calls = backend.calls();
    let Op::SetValue { text, .. } = &calls[0] else {
        panic!()
    };
    assert_eq!(text.value, "42");
    assert!(text.allowed_apps.is_none());
    let Op::Press { chord, .. } = &calls[2] else {
        panic!()
    };
    assert_eq!(
        chord.modifiers,
        [keys::Key {
            vk: 0x11,
            extended: false
        }]
    );
    assert_eq!(chord.key.vk, u16::from(b'S'));
}

#[tokio::test]
async fn wait_for_hidden_polls_until_gone() {
    let shown = || Ok(json!({ "found": true, "visible": true, "enabled": true }));
    let gone = Ok(json!({ "found": false, "visible": false, "enabled": false }));
    let backend = Scripted::new(vec![shown(), shown(), gone]);
    let dialog = json!({ "window": { "title": "処理中" } });
    let report = run(
        &runtime(backend.clone()),
        vec![step(
            types::WAIT_FOR,
            json!({ "target": dialog, "state": "hidden" }),
        )],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(backend.calls().len(), 3);
}

#[tokio::test]
async fn is_visible_is_false_instead_of_failing() {
    let backend = Scripted::new(vec![Ok(json!({ "found": false }))]);
    let report = run(
        &runtime(backend),
        vec![
            step(
                types::IS_VISIBLE,
                json!({ "target": { "window": { "title": "確認" } }, "waitMs": 0 }),
            )
            .saving("out"),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!(false));
}

/// One secret, 「請求」, registered for the given sites.
struct OneSecret(Vec<String>);

impl SecretProvider for OneSecret {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError> {
        Ok(ResolvedSecret {
            name: reference.secret.clone(),
            field: reference.field,
            value: "hunter2".into(),
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
async fn secrets_go_only_to_registered_apps() {
    let password = || {
        step(
            types::SET_VALUE,
            json!({ "target": save_button(), "value": { "secret": "請求", "field": "password" } }),
        )
    };
    // Registered for a web site only: refused before anything is typed.
    let backend = Scripted::new(vec![]);
    let web = runtime(backend.clone()).with_secrets(Arc::new(OneSecret(vec![
        "https://billing.example.com".into(),
    ])));
    let report = run(&web, vec![password()]).await;
    assert_eq!(report.error.unwrap().code, "SECRET_APP_NOT_SET");
    assert!(backend.calls().is_empty());

    let backend = Scripted::new(vec![]);
    let app =
        runtime(backend.clone()).with_secrets(Arc::new(OneSecret(vec!["app:billing.exe".into()])));
    let report = run(&app, vec![password()]).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let Op::SetValue { text, .. } = &backend.calls()[0] else {
        panic!()
    };
    assert_eq!(text.value, "hunter2");
    assert_eq!(
        text.allowed_apps.as_deref(),
        Some(&["app:billing.exe".to_owned()][..])
    );
    assert!(!format!("{text:?}").contains("hunter2"));
}

#[tokio::test]
async fn inspect_lists_windows_or_reads_one() {
    let backend = Scripted::new(vec![Ok(json!([{ "title": "メモ帳" }])), Ok(json!({}))]);
    let adapter = DesktopAdapter::with_backend(backend.clone());
    let listed = adapter.inspect("s", json!({})).await.unwrap();
    assert_eq!(listed["windows"][0]["title"], "メモ帳");
    adapter
        .inspect(
            "s",
            json!({ "window": { "process": "notepad.exe" }, "maxNodes": 50 }),
        )
        .await
        .unwrap();
    let calls = backend.calls();
    assert_eq!(calls[0], Op::ListWindows);
    let Op::Inspect {
        window, max_nodes, ..
    } = &calls[1]
    else {
        panic!()
    };
    assert_eq!(window.process.as_deref(), Some("notepad.exe"));
    assert_eq!(*max_nodes, 50);
}

#[cfg(not(windows))]
#[tokio::test]
async fn other_platforms_say_so() {
    let runtime = Runtime::builder().adapter(&DesktopAdapter::new()).build();
    let report = run(
        &runtime,
        vec![step(types::CLICK, json!({ "target": save_button() }))],
    )
    .await;
    assert_eq!(report.error.unwrap().code, "PLATFORM_UNSUPPORTED");
}

// -- pure parts ----------------------------------------------------------------

fn window(title: &str, process: &str) -> WindowInfo {
    WindowInfo {
        title: title.into(),
        process: process.into(),
        pid: 1,
        class_name: "Window".into(),
        handle: 0,
    }
}

fn query(value: Value) -> target::WindowQuery {
    serde_json::from_value(value).unwrap()
}

#[test]
fn windows_match_by_title_and_process() {
    let windows = [
        window("請求システム - 一覧", "Billing.exe"),
        window("請求システム - 編集", "billing.exe"),
        window("無題 - メモ帳", "notepad.exe"),
    ];
    let pick = |q: Value| pick_window(&query(q), &windows);
    assert_eq!(pick(json!({ "title": "メモ帳" })).unwrap(), 2);
    assert_eq!(pick(json!({ "process": "NOTEPAD" })).unwrap(), 2);
    assert_eq!(
        pick(json!({ "title": "編集", "process": "billing.exe" })).unwrap(),
        1
    );
    assert_eq!(
        pick(json!({ "process": "billing.exe", "nth": 1 })).unwrap(),
        1
    );

    let many = pick(json!({ "process": "billing.exe" })).unwrap_err();
    assert_eq!(many.code, "WINDOW_AMBIGUOUS");
    assert!(!many.retryable);
    assert_eq!(
        many.details.unwrap()["matches"].as_array().unwrap().len(),
        2
    );

    let none = pick(json!({ "title": "Excel" })).unwrap_err();
    assert_eq!(none.code, "WINDOW_NOT_FOUND");
    assert!(none.retryable);
    assert_eq!(
        none.details.unwrap()["openWindows"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(pick(json!({ "title": "請求システム", "exact": true })).is_err());
}

fn node(depth: usize, role: &'static str, name: &str, id: &str) -> NodeInfo {
    NodeInfo {
        depth,
        name: name.into(),
        id: id.into(),
        role,
        enabled: true,
        ..NodeInfo::default()
    }
}

#[test]
fn elements_match_and_render_as_inspect_shows_them() {
    let mut password = node(2, "textbox", "パスワード", "txtPassword");
    password.password = true;
    password.value = Some("secret".into());
    let mut total = node(2, "textbox", "合計", "txtTotal");
    total.value = Some("1,200".into());
    let mut agree = node(2, "checkbox", "同意する", "");
    agree.checked = Some(true);
    agree.enabled = false;
    let nodes = vec![
        node(0, "window", "請求システム", ""),
        node(1, "pane", "", ""),
        node(2, "button", "保存", "btnSave"),
        node(2, "button", "保存して閉じる", "btnSaveClose"),
        password,
        total,
        agree,
    ];
    let element = |q: Value| pick_element(&serde_json::from_value(q).unwrap(), &nodes);
    assert_eq!(element(json!({ "id": "btnSave" })).unwrap(), 2);
    assert_eq!(
        element(json!({ "role": "button", "name": "保存", "exact": true })).unwrap(),
        2
    );
    assert_eq!(
        element(json!({ "role": "button", "name": "保存" }))
            .unwrap_err()
            .code,
        "ELEMENT_AMBIGUOUS"
    );
    assert_eq!(
        element(json!({ "role": "button", "name": "保存", "nth": 1 })).unwrap(),
        3
    );
    // The window itself is not one of its elements.
    assert_eq!(
        element(json!({ "role": "window" })).unwrap_err().code,
        "ELEMENT_NOT_FOUND"
    );

    let tree = render_tree(&nodes, 100);
    assert_eq!(
        tree,
        "- window \"請求システム\"\n  - pane\n    - button \"保存\" id=btnSave\n    - button \"保存して閉じる\" id=btnSaveClose\n    - textbox \"パスワード\" id=txtPassword [password]\n    - textbox \"合計\" id=txtTotal value=\"1,200\"\n    - checkbox \"同意する\" [checked] [disabled]\n"
    );
    assert!(!tree.contains("secret"));
    assert!(
        render_tree(&nodes, 2)
            .ends_with("… (5 more elements: pass `element` to inspect one part of the window)\n")
    );
}

#[test]
fn keys_use_browser_names() {
    let chord = keys::parse("Shift+ArrowDown").unwrap();
    assert_eq!(chord.modifiers[0].vk, 0x10);
    assert_eq!(
        chord.key,
        keys::Key {
            vk: 0x28,
            extended: true
        }
    );
    assert_eq!(keys::parse("F5").unwrap().key.vk, 0x74);
    assert_eq!(keys::parse("Alt+F4").unwrap().key.vk, 0x73);
    assert_eq!(keys::parse("enter").unwrap().key.vk, 0x0D);
    assert_eq!(keys::parse("a").unwrap().key.vk, u16::from(b'A'));
    for bad in ["", "Hyper+A", "Control+", "こんにちは", "F25"] {
        assert_eq!(
            keys::parse(bad).unwrap_err().code,
            "INVALID_PARAMS",
            "{bad}"
        );
    }
}

#[test]
fn sap_and_java_windows_are_recognised() {
    let mut sap = window("SAP Easy Access", "saplogon.exe");
    sap.class_name = "SAP_FRONTEND_SESSION".into();
    assert_eq!(Engine::of(&sap), Engine::SapGui);
    let mut java = window("受注管理", "javaw.exe");
    java.class_name = "SunAwtFrame".into();
    assert_eq!(Engine::of(&java), Engine::Java);
    assert_eq!(Engine::of(&window("メモ帳", "notepad.exe")), Engine::Uia);
    assert!(Engine::Uia.note().is_none());
    assert!(Engine::SapGui.note().unwrap().contains("user_scripting"));
}

#[test]
fn secret_apps_are_exe_names() {
    let sites = ["https://x.example".to_owned(), "app:Billing.exe".to_owned()];
    assert!(app_allowed(&sites, "billing.exe"));
    assert!(app_allowed(&sites, "BILLING"));
    assert!(!app_allowed(&sites, "notepad.exe"));
}

#[test]
fn every_role_maps_both_ways() {
    for name in roles::names() {
        let id = roles::control_type(name).unwrap();
        assert_eq!(roles::of_control_type(id), name);
    }
    assert_eq!(roles::of_control_type(1), "custom");
}
