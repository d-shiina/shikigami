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
    assert_eq!(defs.len(), 20);
    for def in &defs {
        assert!(def.step_type.starts_with("desktop.") || def.step_type.starts_with("sap."));
        assert!(!def.examples.is_empty(), "{}", def.step_type);
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
            s.variables = [
                "customerCode",
                "orderNo",
                "outDir",
                "total",
                "confirmShown",
                "scrolled",
                "orders",
                "status",
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
    assert_eq!(keys(types::SCROLL), ["window:billing"]);
    assert_eq!(keys(types::SELECT_MENU), ["window:billing"]);
    for t in [
        types::MOUSE_CLICK,
        types::TYPE,
        types::PRESS,
        types::MOUSE_SCROLL,
        types::HOVER,
    ] {
        assert_eq!(keys(t), ["desktop.input", "window:billing"], "{t}");
    }
    let drag = defs.iter().find(|d| d.step_type == types::DRAG).unwrap();
    assert_eq!(
        resource_keys(
            &drag.resources,
            &json!({ "target": save_button(), "to": { "window": { "process": "explorer.exe" } } })
        ),
        ["desktop.input", "window:billing", "window:explorer"]
    );
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
fn recorded_keys_are_named_as_press_reads_them() {
    use keys::Held;
    let ctrl = Held {
        ctrl: true,
        ..Held::default()
    };
    let ctrl_shift = Held {
        shift: true,
        ..ctrl
    };
    assert_eq!(
        keys::name(0x53, ctrl_shift).as_deref(),
        Some("Control+Shift+S")
    );
    assert_eq!(keys::name(0x0D, Held::default()).as_deref(), Some("Enter"));
    assert_eq!(keys::name(0x1B, Held::default()).as_deref(), Some("Escape"));
    assert_eq!(keys::name(0x74, Held::default()).as_deref(), Some("F5"));
    assert_eq!(keys::name(0x28, ctrl).as_deref(), Some("Control+ArrowDown"));
    assert_eq!(keys::name(0xE5, Held::default()), None);
    for vk in [0x53, 0x0D, 0x1B, 0x74, 0x28, 0x31] {
        let name = keys::name(vk, ctrl_shift).unwrap();
        assert_eq!(keys::parse(&name).unwrap().key.vk, vk, "{name}");
    }
    // Typing is read from the field; commands are written down.
    assert!(!keys::is_command(0x41, Held::default()));
    assert!(!keys::is_command(0x11, ctrl));
    assert!(keys::is_command(0x0D, Held::default()));
    assert!(keys::is_command(0x53, ctrl));
    assert!(keys::is_text_edit(0x56, ctrl));
    assert!(!keys::is_text_edit(0x53, ctrl));
    // Kana conversion and cancelling it belong to the typing.
    assert!(keys::is_ime_key(0x76, Held::default(), false));
    assert!(keys::is_ime_key(0x1B, Held::default(), true));
    assert!(!keys::is_ime_key(0x1B, Held::default(), false));
    assert!(!keys::is_ime_key(0x74, Held::default(), true));
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

#[tokio::test]
async fn scrolling_dragging_and_menus_reach_the_backend() {
    let backend = Scripted::new(vec![
        Ok(json!({ "verticalPercent": 100.0, "horizontalPercent": null, "atEnd": true })),
        Ok(Value::Null),
        Ok(Value::Null),
        Ok(Value::Null),
    ]);
    let list = json!({ "window": { "process": "billing.exe" }, "element": { "id": "lst" } });
    let report = run(
        &runtime(backend.clone()),
        vec![
            step(
                types::SCROLL,
                json!({ "target": list, "direction": "down", "amount": 2, "unit": "line" }),
            )
            .saving("out"),
            step(
                types::DRAG,
                json!({ "target": list, "to": { "window": { "title": "Explorer" }, "point": { "x": 5, "y": 6 } } }),
            ),
            step(
                types::SELECT_MENU,
                json!({ "target": { "window": { "process": "notepad.exe" } }, "path": ["ファイル", "名前を付けて保存"] }),
            ),
            step(types::MOUSE_SCROLL, json!({ "target": list, "direction": "up" })),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"]["atEnd"], json!(true));
    let calls = backend.calls();
    assert!(matches!(
        &calls[0],
        Op::Scroll {
            direction: Some(backend::Direction::Down),
            amount: 2,
            unit: backend::ScrollUnit::Line,
            ..
        }
    ));
    let Op::Drag { to, .. } = &calls[1] else {
        panic!("{calls:?}")
    };
    assert_eq!(to.point.unwrap().x, 5);
    let Op::Menu { path, .. } = &calls[2] else {
        panic!("{calls:?}")
    };
    assert_eq!(path, &["ファイル", "名前を付けて保存"]);
    assert!(matches!(
        &calls[3],
        Op::Wheel {
            direction: backend::Direction::Up,
            notches: 3,
            ..
        }
    ));
}

#[tokio::test]
async fn bad_scroll_and_menu_params_fail_before_the_backend() {
    let backend = Scripted::new(vec![]);
    let list = json!({ "window": { "process": "billing.exe" }, "element": { "id": "lst" } });
    for bad in [
        step(
            types::MOUSE_SCROLL,
            json!({ "target": list, "direction": "top" }),
        ),
        step(
            types::SCROLL,
            json!({ "target": list, "direction": "down", "amount": 0 }),
        ),
        step(types::SELECT_MENU, json!({ "target": list, "path": [] })),
    ] {
        let mut s = Scenario::new("bad");
        s.steps = vec![bad];
        for step in &mut s.steps {
            shikigami_core::ops::assign_missing_ids(step);
        }
        // Refused when the run starts (schema) or by the step itself.
        if let Ok(handle) = runtime(backend.clone()).start(s, RunOptions::default()) {
            assert_eq!(handle.wait().await.unwrap().status, RunStatus::Failed);
        }
    }
    assert!(backend.calls().is_empty());
}

#[test]
fn menu_items_match_as_people_read_them() {
    use crate::menu::{Item, normalize, pick};
    assert_eq!(normalize("ファイル(&F)"), "ファイル");
    assert_eq!(
        normalize("名前を付けて保存(&A)...\tCtrl+Shift+S"),
        "名前を付けて保存"
    );
    assert_eq!(normalize("&Save As…"), "save as");
    assert_eq!(normalize("保存（S）"), "保存");
    // Brackets that are part of the name stay.
    assert_eq!(normalize("印刷 (A4)"), "印刷 (a4)");
    let item = |name: &str, popup: bool| Item {
        name: name.into(),
        popup,
        enabled: true,
    };
    let items = [
        item("ファイル(F)", false),
        item("編集(E)", false),
        item("新規(N)\tCtrl+N", true),
        item("名前を付けて保存(A)...", true),
        item("保存(S)", true),
    ];
    assert_eq!(pick("ファイル", &items).unwrap(), 0);
    assert_eq!(pick("名前を付けて", &items).unwrap(), 3);
    assert_eq!(pick("保存", &items).unwrap(), 4);
    assert_eq!(
        pick("印刷", &items).unwrap_err().code,
        "MENU_ITEM_NOT_FOUND"
    );
    // An open menu wins over the menu bar.
    let both = [item("表示", false), item("表示", true)];
    assert_eq!(pick("表示", &both).unwrap(), 1);
    let twice = [item("削除する", true), item("すべて削除する", true)];
    assert_eq!(
        pick("削除", &twice).unwrap_err().code,
        "MENU_ITEM_AMBIGUOUS"
    );
}

#[test]
fn a_picked_element_gets_the_sturdiest_target() {
    use crate::target::{Point, picked_target};
    let at = Point { x: 5, y: 6 };
    let windows = vec![
        window("請求システム", "billing.exe"),
        window("メモ帳", "notepad.exe"),
    ];
    let nodes = vec![
        node(0, "window", "請求システム", ""),
        node(1, "button", "保存", "btnSave"),
        node(1, "button", "閉じる", ""),
        node(1, "button", "閉じる", ""),
        node(1, "pane", "", "row"),
        node(1, "pane", "", "row"),
        node(1, "pane", "", ""),
    ];
    let pick = |element| picked_target(&windows, 0, &nodes, element, at);

    let by_id = pick(Some(1));
    assert_eq!(by_id.how, "id");
    assert_eq!(
        by_id.target,
        json!({ "window": { "process": "billing.exe" }, "element": { "id": "btnSave" } })
    );

    let second = pick(Some(3));
    assert_eq!(second.how, "nth");
    assert_eq!(
        second.target["element"],
        json!({ "role": "button", "name": "閉じる", "exact": true, "nth": 1 })
    );

    assert_eq!(
        pick(Some(5)).target["element"],
        json!({ "id": "row", "nth": 1 })
    );

    let drawn = pick(Some(6));
    assert_eq!(drawn.how, "point");
    assert_eq!(drawn.target["point"], json!({ "x": 5, "y": 6 }));

    assert_eq!(pick(None).how, "window");

    // The same app twice: the title tells the windows apart.
    let two = vec![
        window("請求 - A社", "billing.exe"),
        window("請求 - B社", "billing.exe"),
    ];
    let picked = picked_target(&two, 1, &nodes, Some(1), at);
    assert_eq!(
        picked.target["window"],
        json!({ "process": "billing.exe", "title": "請求 - B社", "exact": true })
    );
    // Every picked target finds the element it was built from.
    for i in 1..nodes.len() - 1 {
        let target: crate::target::Target = serde_json::from_value(pick(Some(i)).target).unwrap();
        assert_eq!(
            pick_element(target.element.as_ref().unwrap(), &nodes).unwrap(),
            i
        );
    }
}

#[test]
fn grids_become_lists_of_records() {
    use crate::table::{Grid, clean_cell};
    let grid = Grid {
        headers: vec!["受注番号".into(), "".into(), "金額".into(), "金額".into()],
        rows: vec![
            vec!["A-1".into(), "x".into(), "1,200".into(), "100".into()],
            vec!["".into(), " ".into()],
            vec!["A-2".into()],
        ],
        truncated: false,
    };
    assert_eq!(
        grid.records(),
        vec![
            json!({ "受注番号": "A-1", "列2": "x", "金額": "1,200", "金額 2": "100" }),
            json!({ "受注番号": "A-2", "列2": "", "金額": "", "金額 2": "" }),
        ]
    );
    assert_eq!(Grid::from_json(&grid.to_json()).unwrap(), grid);
    assert_eq!(clean_cell(" (null) "), "");
    assert_eq!(clean_cell(" 東京 "), "東京");
}

#[tokio::test]
async fn get_table_returns_records_and_refuses_silent_truncation() {
    let grid = |truncated: bool| {
        Ok(
            json!({ "headers": ["品名", "数量"], "rows": [["りんご", "3"]], "truncated": truncated }),
        )
    };
    let backend = Scripted::new(vec![grid(false), grid(true), grid(true)]);
    let rt = runtime(backend.clone());
    let target = json!({ "window": { "process": "billing.exe" } });
    let read = |extra: Value| {
        let mut params = json!({ "target": target });
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        vec![step(types::GET_TABLE, params).saving("out")]
    };
    let report = run(&rt, read(json!({}))).await;
    assert_eq!(
        report.outputs["out"],
        json!([{ "品名": "りんご", "数量": "3" }])
    );
    let report = run(&rt, read(json!({}))).await;
    assert_eq!(report.error.unwrap().code, "TABLE_TOO_LARGE");
    let report = run(&rt, read(json!({ "maxRows": 1 }))).await;
    assert_eq!(report.status, RunStatus::Succeeded);
    let Op::GetTable { max_rows, .. } = &backend.calls()[2] else {
        panic!()
    };
    assert_eq!(*max_rows, 1);
}

#[test]
fn grids_are_read_from_their_element_tree() {
    use crate::table::grid_from_nodes;
    let cell = |depth: usize, role: &'static str, name: &str, value: Option<&str>| NodeInfo {
        depth,
        role,
        name: name.into(),
        value: value.map(Into::into),
        enabled: true,
        ..NodeInfo::default()
    };
    // WinForms DataGridView: a top row of header cells, a row header cell
    // first in every row, "(null)" for empty cells.
    let winforms = vec![
        cell(0, "table", "受注", None),
        cell(1, "row", "Top Row", None),
        cell(2, "columnheader", "", None),
        cell(2, "columnheader", "番号", None),
        cell(2, "columnheader", "金額", None),
        cell(1, "row", "Row 0", None),
        cell(2, "columnheader", "", None),
        cell(2, "custom", "番号 Row 0", Some("A-1")),
        cell(2, "custom", "金額 Row 0", Some("1,200")),
        cell(1, "row", "Row 1", None),
        cell(2, "columnheader", "", None),
        cell(2, "custom", "番号 Row 1", Some("(null)")),
        cell(2, "custom", "金額 Row 1", Some("(null)")),
        cell(1, "scrollbar", "", None),
    ];
    let grid = grid_from_nodes(&winforms, 100);
    assert_eq!(grid.headers, ["番号", "金額"]);
    // A WinForms DataGridView as UI Automation shows it: rows as custom
    // elements, a row header first, the cells as rows.
    let datagridview = vec![
        cell(0, "table", "DataGridView", None),
        cell(1, "custom", "Top Row", None),
        cell(2, "header", "Top Left Header Cell", None),
        cell(2, "header", "番号", None),
        cell(2, "header", "金額", None),
        cell(1, "custom", "Row 0", None),
        cell(2, "header", "Row 0", None),
        cell(2, "row", "番号 Row 0", Some("A-1")),
        cell(2, "row", "金額 Row 0", Some("1,200")),
        cell(1, "custom", "Row 1", None),
        cell(2, "header", "Row 1", None),
        cell(2, "row", "番号 Row 1", Some("(null)")),
        cell(2, "row", "金額 Row 1", Some("(null)")),
        cell(1, "scrollbar", "", None),
    ];
    let real = grid_from_nodes(&datagridview, 100);
    assert_eq!(real.headers, ["番号", "金額"]);
    assert_eq!(
        real.records(),
        vec![json!({ "番号": "A-1", "金額": "1,200" })]
    );
    assert_eq!(
        grid.records(),
        vec![json!({ "番号": "A-1", "金額": "1,200" })]
    );
    // A Win32 list view: a header bar, the first column as the item's name.
    let list_view = vec![
        cell(0, "list", "", None),
        cell(1, "header", "", None),
        cell(2, "columnheader", "名前", None),
        cell(2, "columnheader", "サイズ", None),
        cell(1, "listitem", "a.txt", None),
        cell(2, "text", "1 KB", None),
        cell(1, "listitem", "b.txt", None),
        cell(2, "text", "2 KB", None),
    ];
    let grid = grid_from_nodes(&list_view, 1);
    assert!(grid.truncated);
    assert_eq!(
        grid.records(),
        vec![json!({ "名前": "a.txt", "サイズ": "1 KB" })]
    );
    // The same text in the first two columns stays in both.
    let same = vec![
        cell(0, "list", "", None),
        cell(1, "header", "", None),
        cell(2, "columnheader", "出発", None),
        cell(2, "columnheader", "到着", None),
        cell(1, "listitem", "東京", None),
        cell(2, "text", "東京", None),
    ];
    assert_eq!(
        grid_from_nodes(&same, 10).records(),
        vec![json!({ "出発": "東京", "到着": "東京" })]
    );
    // A plain list: one column of item names.
    let plain = vec![
        cell(0, "list", "", None),
        cell(1, "listitem", "東京", None),
        cell(1, "listitem", "大阪", None),
    ];
    assert_eq!(
        grid_from_nodes(&plain, 10).records(),
        vec![json!({ "列1": "東京" }), json!({ "列1": "大阪" })]
    );
}

#[test]
fn sap_gui_words_map_to_desktop_ones() {
    use crate::sapgui::{component_id, looks_like_component_id, role, vkey};
    assert_eq!(role("GuiCTextField", ""), "textbox");
    assert_eq!(role("GuiButton", ""), "button");
    assert_eq!(role("GuiShell", "GridView"), "grid");
    assert_eq!(role("GuiTableControl", ""), "table");
    assert_eq!(role("GuiSomethingNew", ""), "custom");
    // Every SAP role is one of the shared roles.
    for kind in [
        "GuiTextField",
        "GuiTab",
        "GuiStatusbar",
        "GuiUserArea",
        "GuiBox",
    ] {
        assert!(roles::control_type(role(kind, "")).is_some(), "{kind}");
    }
    assert_eq!(
        component_id("wnd[0]", "usr/txtRSYST-BNAME"),
        "wnd[0]/usr/txtRSYST-BNAME"
    );
    assert_eq!(
        component_id("wnd[1]", "wnd[0]/tbar[0]/okcd"),
        "wnd[0]/tbar[0]/okcd"
    );
    assert_eq!(
        component_id("wnd[0]", "/app/con[0]/ses[1]/wnd[1]/usr/btnOK"),
        "wnd[1]/usr/btnOK"
    );
    assert_eq!(component_id("", "/app/con[0]/ses[0]/wnd[0]"), "wnd[0]");
    assert!(looks_like_component_id("wnd[0]/usr/txtA"));
    assert!(!looks_like_component_id("btnSave"));
    let key = |text: &str| vkey(&keys::parse(text).unwrap());
    assert_eq!(key("Enter"), Some(0));
    assert_eq!(key("F3"), Some(3));
    assert_eq!(key("Shift+F2"), Some(14));
    assert_eq!(key("Control+F1"), Some(25));
    assert_eq!(key("Control+Shift+F12"), Some(48));
    assert_eq!(key("Control+S"), Some(11));
    assert_eq!(key("Escape"), Some(12));
    assert_eq!(key("PageDown"), Some(82));
    assert_eq!(key("Alt+F4"), None);
    assert_eq!(key("Tab"), None);
}

#[test]
fn java_words_map_to_desktop_ones() {
    use crate::jabmap::{has_state, role, wide};
    for (java, shared) in [
        ("push button", "button"),
        ("text", "textbox"),
        ("password text", "textbox"),
        ("check box", "checkbox"),
        ("menu", "menuitem"),
        ("table", "table"),
        ("label", "text"),
        ("something new", "custom"),
    ] {
        assert_eq!(role(java), shared, "{java}");
        assert!(roles::control_type(shared).is_some(), "{shared}");
    }
    assert!(has_state(
        "enabled,focusable,visible,showing,checked",
        "checked"
    ));
    assert!(!has_state("enabled,unchecked", "checked"));
    let mut buffer = [0u16; 8];
    for (i, c) in "登録".encode_utf16().enumerate() {
        buffer[i] = c;
    }
    assert_eq!(wide(&buffer), "登録");
}
