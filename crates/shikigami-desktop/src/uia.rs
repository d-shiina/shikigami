//! The Windows backend: Microsoft UI Automation.
//!
//! All UIA calls run on one dedicated thread without windows, joined to the
//! multithreaded apartment, as Microsoft recommends for UIA clients (calls
//! from a UI thread can hang, and Studio's own window may be the target).
//! Steps send requests to it over a queue. Element references never leave
//! the thread: each request names its target and resolves it again.
//! Connection and transaction timeouts keep an app that stopped responding
//! from blocking the thread for long.
//!
//! This is the only module that may use `unsafe` (every Windows API call).

#![allow(unsafe_code)]

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, mpsc};

use serde_json::{Value, json};
use shikigami_runtime::{BoxFuture, StepError};
use tokio::sync::oneshot;
use windows::Win32::Foundation::{
    CloseHandle, E_ACCESSDENIED, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM,
};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEINPUT, SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BM_CLICK, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, PostMessageW, SW_RESTORE,
    SetCursorPos, SetForegroundWindow, ShowWindow, WM_CLOSE,
};
use windows::core::{BSTR, Interface, PWSTR};

use crate::backend::{Backend, MouseButton, Op, Text};
use crate::engine::Engine;
use crate::keys::{Chord, Key};
use crate::roles;
use crate::target::{
    ElementQuery, NodeInfo, Target, WindowInfo, WindowQuery, app_allowed, pick_element,
    pick_window, render_tree,
};

/// Most elements read from one window when looking for a target.
const FIND_LIMIT: usize = 20_000;
const CONNECTION_TIMEOUT_MS: u32 = 2_000;
const TRANSACTION_TIMEOUT_MS: u32 = 10_000;

type Job = Box<dyn FnOnce(Result<&Uia, &StepError>) + Send>;

/// UI Automation on its own thread, started on first use.
pub struct UiaBackend {
    queue: Mutex<Option<mpsc::Sender<Job>>>,
}

impl UiaBackend {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(None),
        }
    }

    fn submit(&self, job: Job) -> Result<(), StepError> {
        let mut queue = self
            .queue
            .lock()
            .map_err(|_| StepError::new("ADAPTER_CRASHED", "the UI Automation queue is broken"))?;
        let job = match queue.as_ref() {
            Some(tx) => match tx.send(job) {
                Ok(()) => return Ok(()),
                Err(mpsc::SendError(job)) => job,
            },
            None => job,
        };
        // First use, or the thread is gone: start it (again).
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("shikigami-uia".into())
            .spawn(move || worker(rx))
            .map_err(|e| {
                StepError::new(
                    "ADAPTER_CRASHED",
                    format!("cannot start the UI Automation thread: {e}"),
                )
            })?;
        tx.send(job)
            .map_err(|_| StepError::new("ADAPTER_CRASHED", "the UI Automation thread stopped"))?;
        *queue = Some(tx);
        Ok(())
    }
}

impl Backend for UiaBackend {
    fn call(&self, op: Op) -> BoxFuture<'static, Result<Value, StepError>> {
        let (tx, rx) = oneshot::channel();
        let submitted = self.submit(Box::new(move |uia| {
            let result = match uia {
                Ok(uia) => uia.run(op),
                Err(e) => Err(e.clone()),
            };
            let _ = tx.send(result);
        }));
        Box::pin(async move {
            submitted?;
            rx.await.unwrap_or_else(|_| {
                Err(StepError::new(
                    "ADAPTER_CRASHED",
                    "the UI Automation thread stopped during the operation",
                ))
            })
        })
    }
}

fn worker(rx: mpsc::Receiver<Job>) {
    // SAFETY (whole thread): plain Win32 / COM calls on this thread's own
    // apartment; interface pointers never leave it.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        // UIA reports physical pixels; mouse input must use the same.
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let uia = Uia::new();
    for job in rx {
        let uia = uia.as_ref();
        if catch_unwind(AssertUnwindSafe(|| job(uia))).is_err() {
            tracing::error!("a UI Automation request panicked");
        }
    }
}

/// A COM / UIA failure as a step error with a fix hint.
fn fail(e: windows::core::Error) -> StepError {
    let code = e.code();
    let hint = |code: &str, message: &str, retryable: bool, hint: &str| {
        let error = if retryable {
            StepError::new(code, message)
        } else {
            StepError::permanent(code, message)
        };
        error.with_details(json!({ "hint": hint }))
    };
    match code.0 as u32 {
        UIA_E_ELEMENTNOTAVAILABLE => StepError::new("ELEMENT_GONE", "the element disappeared"),
        UIA_E_ELEMENTNOTENABLED => StepError::new("ELEMENT_DISABLED", "the element is disabled"),
        UIA_E_TIMEOUT => hint(
            "APP_NOT_RESPONDING",
            "the application did not answer UI Automation in time",
            true,
            "The app may be busy or hung. Wait for it (desktop.waitFor) or raise timeoutMs.",
        ),
        UIA_E_NOTSUPPORTED | UIA_E_INVALIDOPERATION => StepError::permanent(
            "NOT_SUPPORTED",
            format!("the element does not support this: {e}"),
        ),
        _ if code == E_ACCESSDENIED => elevation_error(),
        _ => StepError::new("UIA_ERROR", format!("UI Automation: {e}")),
    }
}

fn elevation_error() -> StepError {
    StepError::permanent(
        "ELEVATION_REQUIRED",
        "the app runs as administrator, and Windows blocks other programs from operating it",
    )
    .with_details(json!({
        "hint": "Start the app normally (not as administrator), or run Shikigami as administrator too."
    }))
}

trait OrFail<T> {
    fn or_fail(self) -> Result<T, StepError>;
}

impl<T> OrFail<T> for windows::core::Result<T> {
    fn or_fail(self) -> Result<T, StepError> {
        self.map_err(fail)
    }
}

const CACHED: &[UIA_PROPERTY_ID] = &[
    UIA_NamePropertyId,
    UIA_AutomationIdPropertyId,
    UIA_ControlTypePropertyId,
    UIA_ClassNamePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_IsPasswordPropertyId,
    UIA_ProcessIdPropertyId,
    UIA_NativeWindowHandlePropertyId,
    UIA_ValueValuePropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
];

struct Uia {
    automation: IUIAutomation,
    control_view: IUIAutomationCondition,
    /// Properties of the elements found.
    element_cache: IUIAutomationCacheRequest,
    /// Properties and children of a whole subtree, in one round trip.
    tree_cache: IUIAutomationCacheRequest,
    elevated: bool,
}

/// A target resolved on the UIA thread.
struct Found {
    window: WindowInfo,
    window_el: IUIAutomationElement,
    window_node: NodeInfo,
    el: IUIAutomationElement,
    node: NodeInfo,
    /// The target names an element (not just the window).
    is_element: bool,
}

impl Uia {
    fn new() -> Result<Self, StepError> {
        // SAFETY: COM is initialised on this thread (see `worker`).
        unsafe {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                    .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
                    .map_err(|e| {
                        StepError::permanent(
                            "UIA_UNAVAILABLE",
                            format!("UI Automation is not available: {e}"),
                        )
                    })?;
            if let Ok(a2) = automation.cast::<IUIAutomation2>() {
                let _ = a2.SetConnectionTimeout(CONNECTION_TIMEOUT_MS);
                let _ = a2.SetTransactionTimeout(TRANSACTION_TIMEOUT_MS);
            }
            let control_view = automation.ControlViewCondition().or_fail()?;
            let cache = |scope: TreeScope| -> windows::core::Result<IUIAutomationCacheRequest> {
                let request = automation.CreateCacheRequest()?;
                for property in CACHED {
                    request.AddProperty(*property)?;
                }
                request.SetTreeFilter(&control_view)?;
                request.SetTreeScope(scope)?;
                Ok(request)
            };
            let element_cache = cache(TreeScope_Element).or_fail()?;
            let tree_cache = cache(TreeScope_Subtree).or_fail()?;
            Ok(Self {
                elevated: is_elevated(GetCurrentProcessId()).unwrap_or(false),
                automation,
                control_view,
                element_cache,
                tree_cache,
            })
        }
    }

    fn run(&self, op: Op) -> Result<Value, StepError> {
        match op {
            Op::ListWindows => self.list_windows(),
            Op::Inspect {
                window,
                element,
                max_nodes,
            } => self.inspect(&window, element.as_ref(), max_nodes),
            Op::Probe { target } => self.probe(&target),
            Op::Click { target } => self.click(&target),
            Op::SetValue { target, text } => self.set_value(&target, &text),
            Op::GetValue { target } => self.get_value(&target),
            Op::Select { target, option } => self.select(&target, &option),
            Op::MouseClick {
                target,
                button,
                double,
            } => self.mouse_click(&target, button, double),
            Op::Type { target, text } => self.type_text(&target, &text),
            Op::Press { target, chord } => self.press(&target, &chord),
            Op::CloseWindow { target } => self.close_window(&target),
        }
    }

    // -- finding ----------------------------------------------------------------

    fn windows(&self) -> Result<Vec<(IUIAutomationElement, WindowInfo, NodeInfo)>, StepError> {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let root = self.automation.GetRootElement().or_fail()?;
            let found = root
                .FindAllBuildCache(TreeScope_Children, &self.control_view, &self.element_cache)
                .or_fail()?;
            let mut names = HashMap::new();
            let mut out = Vec::new();
            for i in 0..found.Length().or_fail()? {
                let Ok(el) = found.GetElement(i) else {
                    continue;
                };
                let node = node_info(&el, 0);
                let pid = el.CachedProcessId().unwrap_or(0) as u32;
                let process = names
                    .entry(pid)
                    .or_insert_with(|| process_name(pid).unwrap_or_default())
                    .clone();
                let handle = el
                    .CachedNativeWindowHandle()
                    .map(|h| h.0 as isize)
                    .unwrap_or(0);
                let window = WindowInfo {
                    title: node.name.clone(),
                    process,
                    pid,
                    class_name: node.class_name.clone(),
                    handle,
                };
                out.push((el, window, node));
            }
            Ok(out)
        }
    }

    fn find_window(
        &self,
        query: &WindowQuery,
    ) -> Result<(IUIAutomationElement, WindowInfo, NodeInfo), StepError> {
        let mut windows = self.windows()?;
        let infos: Vec<WindowInfo> = windows.iter().map(|(_, w, _)| w.clone()).collect();
        let index = pick_window(query, &infos)?;
        let found = windows.swap_remove(index);
        if !self.elevated && is_elevated(found.1.pid) == Some(true) {
            return Err(elevation_error());
        }
        Ok(found)
    }

    /// The subtree under `root` (included, depth 0) in document order.
    fn tree(
        &self,
        root: &IUIAutomationElement,
        limit: usize,
    ) -> Result<Vec<(IUIAutomationElement, NodeInfo)>, StepError> {
        // SAFETY: UIA calls on the UIA thread.
        let cached = unsafe { root.BuildUpdatedCache(&self.tree_cache) }.or_fail()?;
        let mut out = Vec::new();
        walk(&cached, 0, limit, &mut out);
        Ok(out)
    }

    fn resolve(&self, target: &Target) -> Result<Found, StepError> {
        let (window_el, window, window_node) = self.find_window(&target.window)?;
        let Some(query) = &target.element else {
            return Ok(Found {
                el: window_el.clone(),
                node: window_node.clone(),
                is_element: false,
                window,
                window_el,
                window_node,
            });
        };
        let mut tree = self.tree(&window_el, FIND_LIMIT)?;
        let nodes: Vec<NodeInfo> = tree.iter().map(|(_, n)| n.clone()).collect();
        let index = pick_element(query, &nodes)?;
        let (el, node) = tree.swap_remove(index);
        Ok(Found {
            window,
            window_el,
            window_node,
            el,
            node,
            is_element: true,
        })
    }

    /// Like `resolve`, but waits (via the step's retry loop) for a
    /// disabled element to become enabled.
    fn resolve_enabled(&self, target: &Target) -> Result<Found, StepError> {
        let found = self.resolve(target)?;
        if !found.node.enabled {
            return Err(StepError::new("ELEMENT_DISABLED", "the element is disabled")
                .with_details(json!({ "hint": "The step waits until it is enabled; check the screen's state (inspect_ui) if it never is." })));
        }
        Ok(found)
    }

    // -- inspecting -------------------------------------------------------------

    fn list_windows(&self) -> Result<Value, StepError> {
        let windows: Vec<Value> = self
            .windows()?
            .into_iter()
            .filter(|(_, w, _)| !w.title.trim().is_empty())
            .map(|(_, w, n)| {
                let mut entry = json!({
                    "title": w.title,
                    "process": w.process,
                    "className": w.class_name,
                    "app": Engine::of(&w).as_str(),
                });
                if n.offscreen {
                    entry["minimized"] = Value::Bool(true);
                }
                entry
            })
            .collect();
        Ok(Value::Array(windows))
    }

    fn inspect(
        &self,
        query: &WindowQuery,
        element: Option<&ElementQuery>,
        max_nodes: usize,
    ) -> Result<Value, StepError> {
        let (window_el, window, _) = self.find_window(query)?;
        let root = match element {
            None => window_el,
            Some(element) => {
                let mut tree = self.tree(&window_el, FIND_LIMIT)?;
                let nodes: Vec<NodeInfo> = tree.iter().map(|(_, n)| n.clone()).collect();
                let index = pick_element(element, &nodes)?;
                tree.swap_remove(index).0
            }
        };
        let nodes: Vec<NodeInfo> = self
            .tree(&root, FIND_LIMIT)?
            .into_iter()
            .map(|(_, n)| n)
            .collect();
        let engine = Engine::of(&window);
        let mut result = json!({
            "backend": "uia",
            "app": engine.as_str(),
            "window": { "title": window.title, "process": window.process, "className": window.class_name },
            "snapshot": render_tree(&nodes, max_nodes),
            "hint": "Target an element as { \"window\": { \"process\": \"<process>\" }, \"element\": { \"id\": \"<id>\" } }, or with role + name when it has no id.",
        });
        if let Some(note) = engine.note() {
            result["note"] = Value::String(note.into());
        }
        Ok(result)
    }

    fn probe(&self, target: &Target) -> Result<Value, StepError> {
        match self.resolve(target) {
            Ok(found) => Ok(json!({
                "found": true,
                // A minimized window still counts as open.
                "visible": !found.is_element || !found.node.offscreen,
                "enabled": found.node.enabled && found.window_node.enabled,
            })),
            Err(e)
                if matches!(
                    e.code.as_str(),
                    "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_GONE"
                ) =>
            {
                Ok(json!({ "found": false, "visible": false, "enabled": false }))
            }
            Err(e) => Err(e),
        }
    }

    // -- acting without the mouse -------------------------------------------------

    fn click(&self, target: &Target) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        let el = &found.el;
        // SAFETY: UIA / Win32 calls on the UIA thread.
        unsafe {
            // A classic Win32 button runs its handler inside the click, so a
            // dialog it opens would block UIA until it closes; posting the
            // click returns at once.
            if found.node.class_name == "Button"
                && found.node.role == "button"
                && let Ok(hwnd) = el.CachedNativeWindowHandle()
                && !hwnd.0.is_null()
            {
                PostMessageW(Some(hwnd), BM_CLICK, WPARAM(0), LPARAM(0)).or_fail()?;
                return Ok(Value::Null);
            }
            let acted = if let Ok(p) =
                pattern::<IUIAutomationInvokePattern>(el, UIA_InvokePatternId)
            {
                p.Invoke()
            } else if let Ok(p) = pattern::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId) {
                p.Toggle()
            } else if let Ok(p) =
                pattern::<IUIAutomationSelectionItemPattern>(el, UIA_SelectionItemPatternId)
            {
                p.Select()
            } else if let Ok(p) =
                pattern::<IUIAutomationExpandCollapsePattern>(el, UIA_ExpandCollapsePatternId)
            {
                if p.CurrentExpandCollapseState() == Ok(ExpandCollapseState_Expanded) {
                    p.Collapse()
                } else {
                    p.Expand()
                }
            } else if let Ok(p) =
                pattern::<IUIAutomationLegacyIAccessiblePattern>(el, UIA_LegacyIAccessiblePatternId)
            {
                p.DoDefaultAction()
            } else {
                return Err(StepError::permanent(
                    "NOT_CLICKABLE",
                    format!(
                        "the {} cannot be clicked without the mouse",
                        found.node.role
                    ),
                )
                .with_details(json!({ "hint": "Use desktop.mouseClick with the same target." })));
            };
            acted.map_err(action_error)?;
        }
        Ok(Value::Null)
    }

    fn set_value(&self, target: &Target, text: &Text) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        check_app(text, &found.window)?;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let p = pattern::<IUIAutomationValuePattern>(&found.el, UIA_ValuePatternId).map_err(
                |_| {
                    StepError::permanent(
                        "NOT_SUPPORTED",
                        format!("the {} does not take a value", found.node.role),
                    )
                    .with_details(
                        json!({ "hint": "Use desktop.type to type into it with the keyboard." }),
                    )
                },
            )?;
            if p.CurrentIsReadOnly().is_ok_and(|r| r.as_bool()) {
                return Err(StepError::permanent("READ_ONLY", "the field is read-only"));
            }
            p.SetValue(&BSTR::from(text.value.as_str()))
                .map_err(action_error)?;
        }
        Ok(Value::Null)
    }

    fn get_value(&self, target: &Target) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        let node = &found.node;
        if node.password {
            return Err(StepError::permanent(
                "PASSWORD_FIELD",
                "password fields cannot be read",
            ));
        }
        if let Some(checked) = node.checked {
            return Ok(Value::Bool(checked));
        }
        // SAFETY: UIA calls on the UIA thread.
        let value = unsafe {
            pattern::<IUIAutomationValuePattern>(&found.el, UIA_ValuePatternId)
                .and_then(|p| p.CurrentValue())
                .map(|v| v.to_string())
                .ok()
        };
        Ok(Value::String(value.unwrap_or_else(|| node.name.clone())))
    }

    fn select(&self, target: &Target, option: &str) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        let el = &found.el;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let expander =
                pattern::<IUIAutomationExpandCollapsePattern>(el, UIA_ExpandCollapsePatternId).ok();
            if let Some(p) = &expander {
                let _ = p.Expand();
            }
            let options: Vec<(IUIAutomationElement, NodeInfo)> = self
                .tree(el, FIND_LIMIT)?
                .into_iter()
                .skip(1)
                .filter(|(_, n)| {
                    matches!(
                        n.role,
                        "listitem" | "treeitem" | "row" | "tab" | "menuitem" | "radio"
                    )
                })
                .collect();
            let exact: Vec<usize> = (0..options.len())
                .filter(|&i| options[i].1.name == option)
                .collect();
            let partial: Vec<usize> = (0..options.len())
                .filter(|&i| {
                    options[i]
                        .1
                        .name
                        .to_lowercase()
                        .contains(&option.to_lowercase())
                })
                .collect();
            let chosen = match (exact.as_slice(), partial.as_slice()) {
                ([i, ..], _) | ([], [i]) => Some(*i),
                _ => None,
            };
            let result = match chosen {
                Some(i) => {
                    let item = &options[i].0;
                    if let Ok(p) =
                        pattern::<IUIAutomationSelectionItemPattern>(item, UIA_SelectionItemPatternId)
                    {
                        p.Select().map_err(action_error)
                    } else if let Ok(p) = pattern::<IUIAutomationInvokePattern>(item, UIA_InvokePatternId) {
                        p.Invoke().map_err(action_error)
                    } else {
                        Err(StepError::permanent("NOT_SUPPORTED", "the option cannot be selected"))
                    }
                }
                None => match pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId) {
                    // An editable combo box with no list: type the value.
                    Ok(p) if options.is_empty() && !p.CurrentIsReadOnly().is_ok_and(|r| r.as_bool()) => {
                        p.SetValue(&BSTR::from(option)).map_err(action_error)
                    }
                    _ => Err(StepError::new(
                        "OPTION_NOT_FOUND",
                        format!("no option named '{option}'"),
                    )
                    .with_details(json!({
                        "hint": if partial.len() > 1 { "Several options contain this text: write the full name." } else { "Use one of the options listed." },
                        "options": options.iter().take(50).map(|(_, n)| n.name.clone()).collect::<Vec<_>>(),
                    }))),
                },
            };
            if let Some(p) = &expander
                && p.CurrentExpandCollapseState() == Ok(ExpandCollapseState_Expanded)
            {
                let _ = p.Collapse();
            }
            result?;
        }
        Ok(Value::Null)
    }

    fn close_window(&self, target: &Target) -> Result<Value, StepError> {
        let (window_el, window, _) = self.find_window(&target.window)?;
        // SAFETY: UIA / Win32 calls on the UIA thread.
        unsafe {
            match pattern::<IUIAutomationWindowPattern>(&window_el, UIA_WindowPatternId) {
                Ok(p) => p.Close().map_err(action_error)?,
                Err(_) => PostMessageW(Some(hwnd(window.handle)), WM_CLOSE, WPARAM(0), LPARAM(0))
                    .or_fail()?,
            }
        }
        Ok(Value::Null)
    }

    // -- the real mouse and keyboard ---------------------------------------------

    /// Restores and activates the window, then focuses the element.
    fn bring_to_front(&self, found: &Found) -> Result<(), StepError> {
        let window = hwnd(found.window.handle);
        // SAFETY: Win32 / UIA calls on the UIA thread.
        unsafe {
            if !window.0.is_null() {
                if IsIconic(window).as_bool() {
                    let _ = ShowWindow(window, SW_RESTORE);
                }
                if GetForegroundWindow() != window {
                    // Windows lets the process that sent the last input
                    // choose the foreground window.
                    let _ = send(&[mouse(MOUSEEVENTF_MOVE)]);
                    let _ = SetForegroundWindow(window);
                }
            }
            if foreground_pid() != found.window.pid {
                let _ = found.window_el.SetFocus();
            }
            if foreground_pid() != found.window.pid {
                return Err(StepError::new(
                    "FOREGROUND_DENIED",
                    "Windows did not let Shikigami bring the window to the front",
                )
                .with_details(json!({
                    "hint": "Keep the screen unlocked and do not use the PC while desktop steps run. desktop.click and desktop.setValue work without bringing the window to the front."
                })));
            }
            if found.is_element {
                let _ = found.el.SetFocus();
            }
        }
        Ok(())
    }

    fn mouse_click(
        &self,
        target: &Target,
        button: MouseButton,
        double: bool,
    ) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        self.bring_to_front(&found)?;
        // SAFETY: Win32 / UIA calls on the UIA thread.
        unsafe {
            let at = match target.point {
                Some(p) => {
                    let rect = found.window_el.CurrentBoundingRectangle().or_fail()?;
                    POINT {
                        x: rect.left + p.x,
                        y: rect.top + p.y,
                    }
                }
                None => {
                    let mut point = POINT::default();
                    match found.el.GetClickablePoint(&mut point) {
                        Ok(got) if got.as_bool() => point,
                        _ => center(found.el.CurrentBoundingRectangle().or_fail()?)?,
                    }
                }
            };
            SetCursorPos(at.x, at.y).or_fail()?;
            let (down, up) = match button {
                MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            };
            let mut inputs = vec![mouse(down), mouse(up)];
            if double {
                inputs.extend([mouse(down), mouse(up)]);
            }
            send(&inputs)?;
        }
        Ok(Value::Null)
    }

    fn type_text(&self, target: &Target, text: &Text) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        check_app(text, &found.window)?;
        self.bring_to_front(&found)?;
        let mut inputs = Vec::new();
        for unit in text.value.encode_utf16() {
            match unit {
                0x0D => {}
                0x0A => tap(
                    &mut inputs,
                    Key {
                        vk: 0x0D,
                        extended: false,
                    },
                ),
                0x09 => tap(
                    &mut inputs,
                    Key {
                        vk: 0x09,
                        extended: false,
                    },
                ),
                _ => {
                    inputs.push(keyboard(0, unit, KEYEVENTF_UNICODE));
                    inputs.push(keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
            }
        }
        send(&inputs)?;
        Ok(Value::Null)
    }

    fn press(&self, target: &Target, chord: &Chord) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        self.bring_to_front(&found)?;
        let mut inputs = Vec::new();
        for m in &chord.modifiers {
            inputs.push(key_event(*m, false));
        }
        tap(&mut inputs, chord.key);
        for m in chord.modifiers.iter().rev() {
            inputs.push(key_event(*m, true));
        }
        send(&inputs)?;
        Ok(Value::Null)
    }
}

/// A pattern of `el`, or an error when it does not support it.
unsafe fn pattern<T: Interface>(
    el: &IUIAutomationElement,
    id: UIA_PATTERN_ID,
) -> windows::core::Result<T> {
    // SAFETY: called on the UIA thread.
    unsafe { el.GetCurrentPatternAs::<T>(id) }
}

/// A failed action. A timeout here may still have acted (the app was slow
/// to answer), so it is not retried: a retry could click twice.
fn action_error(e: windows::core::Error) -> StepError {
    let mut error = fail(e);
    if error.code == "APP_NOT_RESPONDING" {
        error.retryable = false;
        error.details = Some(json!({
            "hint": "The app did not answer in time; the action may still have happened. Check the screen (inspect_ui) before repeating it."
        }));
    }
    error
}

fn check_app(text: &Text, window: &WindowInfo) -> Result<(), StepError> {
    match &text.allowed_apps {
        Some(apps) if !app_allowed(apps, &window.process) => Err(StepError::permanent(
            "SECRET_APP_MISMATCH",
            format!(
                "this secret may not be typed into {} (registered for {})",
                window.process,
                apps.join(", ")
            ),
        )
        .with_details(json!({
            "hint": format!("If this app is right, ask the user to add app:{} to the secret's sites in Studio.", window.process)
        }))),
        _ => Ok(()),
    }
}

fn walk(
    el: &IUIAutomationElement,
    depth: usize,
    limit: usize,
    out: &mut Vec<(IUIAutomationElement, NodeInfo)>,
) {
    if out.len() >= limit {
        return;
    }
    out.push((el.clone(), node_info(el, depth)));
    // SAFETY: cached children of an element built on the UIA thread.
    unsafe {
        let Ok(children) = el.GetCachedChildren() else {
            return;
        };
        let count = children.Length().unwrap_or(0);
        for i in 0..count {
            if let Ok(child) = children.GetElement(i) {
                walk(&child, depth + 1, limit, out);
            }
        }
    }
}

/// The cached properties of `el` (see `CACHED`).
fn node_info(el: &IUIAutomationElement, depth: usize) -> NodeInfo {
    // SAFETY: reads cached properties on the UIA thread.
    unsafe {
        let text = |r: windows::core::Result<BSTR>| r.map(|b| b.to_string()).unwrap_or_default();
        let role = roles::of_control_type(el.CachedControlType().map(|t| t.0).unwrap_or(0));
        let cached = |id| el.GetCachedPropertyValue(id).ok();
        let toggle = cached(UIA_ToggleToggleStatePropertyId)
            .and_then(|v| i32::try_from(&v).ok())
            .map(|state| state == ToggleState_On.0);
        let selected =
            cached(UIA_SelectionItemIsSelectedPropertyId).and_then(|v| bool::try_from(&v).ok());
        NodeInfo {
            depth,
            name: text(el.CachedName()),
            id: text(el.CachedAutomationId()),
            role,
            class_name: text(el.CachedClassName()),
            enabled: el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
            offscreen: el.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false),
            password: el.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false),
            value: cached(UIA_ValueValuePropertyId)
                .and_then(|v| BSTR::try_from(&v).ok())
                .map(|b| b.to_string()),
            checked: match role {
                "checkbox" => toggle,
                "radio" => selected,
                _ => toggle.filter(|_| role == "button"),
            },
        }
    }
}

fn hwnd(handle: isize) -> HWND {
    HWND(handle as *mut core::ffi::c_void)
}

fn center(rect: RECT) -> Result<POINT, StepError> {
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return Err(
            StepError::new("ELEMENT_NOT_VISIBLE", "the element has no area on screen")
                .with_details(
                    json!({ "hint": "Scroll it into view or open the screen it is on first." }),
                ),
        );
    }
    Ok(POINT {
        x: (rect.left + rect.right) / 2,
        y: (rect.top + rect.bottom) / 2,
    })
}

fn foreground_pid() -> u32 {
    let mut pid = 0;
    // SAFETY: plain Win32 calls.
    unsafe {
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid));
    }
    pid
}

fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                ..MOUSEINPUT::default()
            },
        },
    }
}

fn keyboard(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_event(key: Key, up: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if key.extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    keyboard(key.vk, 0, flags)
}

fn tap(inputs: &mut Vec<INPUT>, key: Key) {
    inputs.push(key_event(key, false));
    inputs.push(key_event(key, true));
}

fn send(inputs: &[INPUT]) -> Result<(), StepError> {
    // SAFETY: SendInput reads the slice it is given.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if (sent as usize) < inputs.len() {
        return Err(StepError::new(
            "INPUT_BLOCKED",
            "Windows did not accept the mouse / keyboard input",
        )
        .with_details(json!({
            "hint": "The screen may be locked, or the app runs as administrator. Keep the session unlocked while desktop steps run."
        })));
    }
    Ok(())
}

/// The executable name of a process (`billing.exe`).
fn process_name(pid: u32) -> Option<String> {
    // SAFETY: the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        ok.ok()?;
        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_owned)
    }
}

/// Whether a process runs elevated (as administrator); `Some(true)` also
/// when its token cannot be read, which is what an elevated process looks
/// like to a normal one.
fn is_elevated(pid: u32) -> Option<bool> {
    // SAFETY: handles are closed before returning.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
        let _ = CloseHandle(process);
        if let Err(e) = opened {
            return (e.code() == E_ACCESSDENIED).then_some(true);
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0;
        let read = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        let _ = CloseHandle(token);
        read.ok()?;
        Some(elevation.TokenIsElevated != 0)
    }
}
