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
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use shikigami_runtime::{BoxFuture, StepError};
use tokio::sync::oneshot;
use windows::Win32::Foundation::{
    CloseHandle, E_ACCESSDENIED, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
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
use windows::Win32::UI::Input::Ime::ImmGetDefaultIMEWnd;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BM_CLICK, GA_ROOT, GetAncestor, GetCursorPos, GetForegroundWindow, GetSystemMetrics,
    GetWindowRect, GetWindowThreadProcessId, InternalGetWindowText, IsIconic, PostMessageW,
    SM_CXDOUBLECLK, SMTO_ABORTIFHUNG, SW_RESTORE, SendMessageTimeoutW, SetCursorPos,
    SetForegroundWindow, ShowWindow, WM_CLOSE, WM_IME_CONTROL, WindowFromPoint,
};
use windows::core::{BSTR, Interface, PWSTR};

use crate::backend::{
    Backend, Capture, Direction, MouseButton, OcrEngine, OcrOptions, Op, ScrollUnit, Text,
};
use crate::bitmap::{Bitmap, Rect};
use crate::bridge::AppBridge;
use crate::capture;
use crate::engine::Engine;
use crate::hover::{self, Hover};
use crate::jab::JavaWindow;
use crate::keys;
use crate::keys::{Chord, Key};
use crate::menu;
use crate::overlay::{Input, Overlay, Raw, held_now};
use crate::roles;
use crate::sap::SapWindow;
use crate::sapgui;
use crate::table::{self, GRID_ROLES, Grid};
use crate::target::{
    ElementQuery, NodeInfo, Point, Target, WindowInfo, WindowQuery, app_allowed, describe,
    pick_element, pick_window, picked_target, render_tree,
};
use crate::vision::OcrLine;

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

impl UiaBackend {
    /// Runs `work` on the UIA thread.
    fn on_thread<T: Send + 'static>(
        &self,
        work: impl FnOnce(Result<&Uia, &StepError>) -> Result<T, StepError> + Send + 'static,
    ) -> BoxFuture<'static, Result<T, StepError>> {
        let (tx, rx) = oneshot::channel();
        let submitted = self.submit(Box::new(move |uia| {
            // The step gave up (timed out, was cancelled or retried) while
            // this request waited in the queue: acting now could click or
            // type after the run moved on, so drop it.
            if tx.is_closed() {
                return;
            }
            let _ = tx.send(work(uia));
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

impl Backend for UiaBackend {
    fn call(&self, op: Op) -> BoxFuture<'static, Result<Value, StepError>> {
        self.on_thread(move |uia| uia.map_err(Clone::clone)?.run(op))
    }

    fn capture(&self, target: Target) -> BoxFuture<'static, Result<Capture, StepError>> {
        self.on_thread(move |uia| uia.map_err(Clone::clone)?.capture(&target))
    }

    fn recognize(
        &self,
        image: Bitmap,
        options: OcrOptions,
    ) -> BoxFuture<'static, Result<Vec<OcrLine>, StepError>> {
        let windows = match options.engine {
            _ if options.accurate => false,
            Some(OcrEngine::Windows) => true,
            Some(OcrEngine::Paddle) => false,
            None => match crate::paddle::engine() {
                Ok(_) => false,
                Err(reason) => {
                    tracing::warn!(%reason, "PaddleOCR is not available; using Windows OCR");
                    true
                }
            },
        };
        if !windows {
            return crate::backend::paddle_recognize(image, options.accurate);
        }
        // Windows OCR needs only the thread's apartment, not UI Automation.
        self.on_thread(move |_| capture::recognize(&image, options.language.as_deref()))
    }

    fn load_image(&self, path: String) -> BoxFuture<'static, Result<Bitmap, StepError>> {
        self.on_thread(move |_| capture::load_image(&path))
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
        let op = match self.via_app(op)? {
            Routed::Done(result) => return Ok(result),
            Routed::Uia(op) => *op,
        };
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
            Op::Scroll {
                target,
                direction,
                amount,
                unit,
            } => self.scroll(&target, direction, amount, unit),
            Op::Wheel {
                target,
                direction,
                notches,
            } => self.wheel(&target, direction, notches),
            Op::Drag { from, to } => self.drag(&from, &to),
            Op::Hover { target } => self.hover(&target),
            Op::Menu { target, path } => self.menu(&target, &path),
            Op::Pick {
                message,
                timeout_ms,
            } => self.pick(message, timeout_ms),
            Op::Highlight { target, ms } => self.highlight(&target, ms),
            Op::Record {
                title,
                hint,
                timeout_ms,
            } => self.record(&title, hint, timeout_ms),
            Op::GetTable { target, max_rows } => self.get_table(&target, max_rows),
            Op::SapTransaction { target, .. } => {
                let (_, window, _) = self.find_window(&target.window)?;
                Err(match Engine::of(&window) {
                    Engine::SapGui => sap_scripting_off(),
                    _ => StepError::permanent(
                        "NOT_SAP_WINDOW",
                        format!("'{}' is not a SAP GUI window", window.title),
                    )
                    .with_details(json!({ "hint": "Target the SAP GUI window (inspect_ui lists it with app sapgui)." })),
                })
            }
        }
    }

    // -- SAP GUI and Java ---------------------------------------------------------

    /// How the window `query` names is reached: through SAP GUI Scripting
    /// or Java Access Bridge when it belongs to such an app and the way in
    /// works, otherwise through UI Automation.
    fn reach(&self, query: &WindowQuery) -> Reach {
        let Ok((el, window, _)) = self.find_window(query) else {
            return Reach::Uia;
        };
        match Engine::of(&window) {
            Engine::Uia => Reach::Uia,
            Engine::SapGui => match SapWindow::attach(window.handle) {
                Some(sap) => Reach::Bridge(Box::new(sap), window, el),
                None => Reach::Unreachable(sap_scripting_off()),
            },
            Engine::Java => match JavaWindow::attach(&window) {
                Ok(java) => Reach::Bridge(Box::new(java), window, el),
                Err(e) => Reach::Unreachable(e),
            },
        }
    }

    /// Carries out `op` through SAP GUI Scripting or Java Access Bridge
    /// when its window is such an app, or hands it (perhaps changed: an
    /// element turned into its place on the screen) back to UI Automation.
    fn via_app(&self, op: Op) -> Result<Routed, StepError> {
        let window = match &op {
            Op::ListWindows | Op::Pick { .. } | Op::Highlight { .. } | Op::Record { .. } => {
                return Ok(Routed::Uia(Box::new(op)));
            }
            Op::Inspect { window, .. } => window,
            Op::Drag { from, .. } => &from.window,
            Op::Probe { target }
            | Op::Click { target }
            | Op::SetValue { target, .. }
            | Op::GetValue { target }
            | Op::Select { target, .. }
            | Op::MouseClick { target, .. }
            | Op::Type { target, .. }
            | Op::Press { target, .. }
            | Op::CloseWindow { target }
            | Op::Scroll { target, .. }
            | Op::Wheel { target, .. }
            | Op::Hover { target }
            | Op::Menu { target, .. }
            | Op::GetTable { target, .. }
            | Op::SapTransaction { target, .. } => &target.window,
        };
        let (app, info, window_el) = match self.reach(window) {
            Reach::Uia => return Ok(Routed::Uia(Box::new(op))),
            Reach::Unreachable(e) => {
                // Elements only the way in could see: say how to open it.
                // The window itself, pictures and inspect_ui (with a note)
                // still work through UI Automation.
                let named = op_target(&op).and_then(|t| t.element.as_ref());
                let blocked = match e.code.as_str() {
                    "SAP_SCRIPTING_OFF" => named
                        .and_then(|e| e.id.as_deref())
                        .is_some_and(sapgui::looks_like_component_id),
                    _ => named.is_some() && !matches!(op, Op::Probe { .. }),
                };
                if blocked {
                    return Err(e);
                }
                return Ok(Routed::Uia(Box::new(op)));
            }
            Reach::Bridge(app, info, el) => (app, info, el),
        };
        let app = app.as_ref();
        let done = Routed::Done;
        Ok(match op {
            Op::Inspect {
                element, max_nodes, ..
            } => {
                let mut result = app.inspect(max_nodes, element.as_ref())?;
                result["app"] = json!(app.app());
                result["window"] = json!({ "title": info.title, "process": info.process, "className": info.class_name });
                done(result)
            }
            Op::SapTransaction { code, .. } => done(app.transaction(&code)?),
            Op::GetTable { target, max_rows } => {
                done(app.table(target.element.as_ref(), max_rows)?)
            }
            Op::Menu { target, path } => {
                if target.element.is_some() {
                    return Err(StepError::permanent(
                        "NOT_SUPPORTED",
                        "in SAP GUI and Java apps desktop.selectMenu walks the menu bar only",
                    )
                    .with_details(json!({ "hint": "Open it with desktop.mouseClick (button: right), then click its item with desktop.mouseClick and target.ocr, or use the menu bar path." })));
                }
                done(app.menu(&path)?)
            }
            op => {
                let Some(element) = op_target(&op).and_then(|t| t.element.clone()) else {
                    // The window itself: UI Automation acts on it.
                    return Ok(Routed::Uia(Box::new(op)));
                };
                match op {
                    Op::Probe { .. } => done(app.probe(&element)),
                    Op::Click { .. } => done(app.click(&element)?),
                    Op::SetValue { text, .. } => {
                        check_app(&text, &info)?;
                        done(app.set_value(&element, &text)?)
                    }
                    Op::GetValue { .. } => done(app.get_value(&element)?),
                    Op::Select { option, .. } => done(app.select(&element, &option)?),
                    Op::Press { target, chord } => {
                        app.focus(&element)?;
                        match app.press(&chord) {
                            Some(result) => done(result?),
                            None => Routed::Uia(Box::new(Op::Press {
                                target: target.window_part_only(),
                                chord,
                            })),
                        }
                    }
                    Op::Type { target, text } => {
                        check_app(&text, &info)?;
                        app.focus(&element)?;
                        Routed::Uia(Box::new(Op::Type {
                            target: target.window_part_only(),
                            text,
                        }))
                    }
                    Op::Scroll {
                        direction: None, ..
                    } => {
                        app.focus(&element)?;
                        done(
                            json!({ "verticalPercent": null, "horizontalPercent": null, "atEnd": false }),
                        )
                    }
                    Op::Scroll { .. } => {
                        return Err(StepError::permanent(
                            "NOT_SUPPORTED",
                            "SAP GUI and Java tables are not scrolled by desktop.scroll",
                        )
                        .with_details(json!({ "hint": "desktop.getTable reads a whole SAP table, ALV grid or Java table; otherwise use desktop.mouseScroll or desktop.press with PageDown." })));
                    }
                    Op::MouseClick {
                        target,
                        button,
                        double,
                    } => Routed::Uia(Box::new(Op::MouseClick {
                        target: self.app_point(app, &target, &window_el)?,
                        button,
                        double,
                    })),
                    Op::Wheel {
                        target,
                        direction,
                        notches,
                    } => Routed::Uia(Box::new(Op::Wheel {
                        target: self.app_point(app, &target, &window_el)?,
                        direction,
                        notches,
                    })),
                    Op::Hover { target } => Routed::Uia(Box::new(Op::Hover {
                        target: self.app_point(app, &target, &window_el)?,
                    })),
                    Op::Drag { from, to } => Routed::Uia(Box::new(Op::Drag {
                        from: self.app_point(app, &from, &window_el)?,
                        to,
                    })),
                    op => Routed::Uia(Box::new(op)),
                }
            }
        })
    }

    /// A target naming an element of a SAP GUI or Java window, as the
    /// place at its centre.
    fn app_point(
        &self,
        app: &dyn AppBridge,
        target: &Target,
        window_el: &IUIAutomationElement,
    ) -> Result<Target, StepError> {
        let Some(element) = &target.element else {
            return Ok(target.clone());
        };
        let (left, top, width, height) = app.screen_rect(element)?;
        // SAFETY: UIA calls on the UIA thread.
        let rect = unsafe { window_el.CurrentBoundingRectangle() }.or_fail()?;
        let mut at = target.window_part_only();
        at.point = Some(crate::target::Point {
            x: left + width / 2 - rect.left,
            y: top + height / 2 - rect.top,
        });
        Ok(at)
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

    // -- pointing on screen ----------------------------------------------------------

    /// Lets the user point at an element (see `Op::Pick`).
    fn pick(&self, message: Option<String>, timeout_ms: u64) -> Result<Value, StepError> {
        let message = message.unwrap_or_else(|| "Click the part to pick (Esc to cancel)".into());
        let overlay = Overlay::pick(message)?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        // SAFETY: plain Win32 call.
        let own = unsafe { GetCurrentProcessId() };
        let mut shown: Option<(i32, i32, i32, i32)> = None;
        // The window frame on screen: its handle, place and title.
        let mut shown_window: Option<TopWindow> = None;
        let mut hover = Hover::new();
        let clicked = loop {
            match overlay.take_input() {
                Some(Input::Clicked(pt)) => break pt,
                Some(Input::Cancelled) => return Ok(json!({ "cancelled": true })),
                None => {}
            }
            if Instant::now() >= deadline {
                return Ok(json!({ "cancelled": true, "timedOut": true }));
            }
            let mut pt = POINT::default();
            // SAFETY: plain Win32 call.
            let moved = unsafe { GetCursorPos(&mut pt) }.is_ok();
            let started = Instant::now();
            // Ask the app under the mouse only when it moved (or now and
            // then while it rests), never faster than the app answers.
            if !moved || !hover.due((pt.x, pt.y), started) {
                std::thread::sleep(hover::TICK);
                continue;
            }
            // SAFETY: UIA call on the UIA thread.
            let under = unsafe { self.automation.ElementFromPoint(pt).ok() };
            hover.looked((pt.x, pt.y), started, started.elapsed());
            if let Some(el) = under {
                // SAFETY: reading the element's current properties.
                let (pid, rect) = unsafe {
                    (
                        el.CurrentProcessId().unwrap_or(0) as u32,
                        el.CurrentBoundingRectangle().ok(),
                    )
                };
                if let Some(rect) = rect.filter(|_| pid != own) {
                    // The window the node will act on: framed too, and
                    // named on the banner, so it is clear which one it is.
                    let window = top_window_at(pt).filter(|w| w.pid != own);
                    let window_changed = window.as_ref().map(TopWindow::key)
                        != shown_window.as_ref().map(TopWindow::key);
                    if window_changed {
                        overlay.window(window.as_ref().map(|w| w.rect));
                        shown_window = window;
                    }
                    let key = rect_key(rect);
                    if shown != Some(key) || window_changed {
                        shown = Some(key);
                        overlay.frame(Some(rect));
                        let title = shown_window.as_ref().map_or("", |w| w.title.as_str());
                        overlay.detail(hover::banner_line(title, &self.describe_live(&el)));
                    }
                }
            }
            std::thread::sleep(hover::TICK);
        };
        // The frame must not be under the click when it is looked up.
        drop(overlay);
        self.picked_at(clicked)
    }

    /// `button "保存"` for the banner, without building a cache.
    fn describe_live(&self, el: &IUIAutomationElement) -> String {
        // SAFETY: reading the element's current properties on the UIA thread.
        unsafe {
            let role = roles::of_control_type(el.CurrentControlType().map(|t| t.0).unwrap_or(0));
            let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
            let id = el
                .CurrentAutomationId()
                .map(|b| b.to_string())
                .unwrap_or_default();
            let mut line = role.to_owned();
            if !name.trim().is_empty() {
                line.push_str(&format!(" \u{300c}{}\u{300d}", name.trim()));
            }
            if !id.is_empty() {
                line.push_str(&format!(" id={id}"));
            }
            line
        }
    }

    /// The target for the element at `pt` on screen.
    fn picked_at(&self, pt: POINT) -> Result<Value, StepError> {
        // SAFETY: UIA call on the UIA thread.
        let el = unsafe { self.automation.ElementFromPoint(pt).or_fail()? };
        self.picked(&el, pt)
    }

    /// The target for `el`; `pt` (on screen) is where to point when it has
    /// nothing better.
    fn picked(&self, el: &IUIAutomationElement, pt: POINT) -> Result<Value, StepError> {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let root = self.automation.GetRootElement().or_fail()?;
            let walker = self.automation.ControlViewWalker().or_fail()?;
            // The top-level window: the last element before the desktop.
            let mut top = el.clone();
            let mut chain = vec![el.clone()];
            for _ in 0..200 {
                let Ok(parent) = walker.GetParentElement(&top) else {
                    break;
                };
                if self
                    .automation
                    .CompareElements(&parent, &root)
                    .map(|b| b.as_bool())
                    .unwrap_or(true)
                {
                    break;
                }
                chain.push(parent.clone());
                top = parent;
            }
            let windows = self.windows()?;
            let same = |a: &IUIAutomationElement, b: &IUIAutomationElement| {
                self.automation
                    .CompareElements(a, b)
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
            };
            let Some(window) = windows.iter().position(|(w, _, _)| same(w, &top)) else {
                return Err(StepError::new(
                    "WINDOW_NOT_FOUND",
                    "the place clicked is not in an app window",
                ));
            };
            let (window_el, info, _) = &windows[window];
            if !self.elevated && is_elevated(info.pid) == Some(true) {
                return Err(elevation_error());
            }
            let tree = self.tree(window_el, FIND_LIMIT)?;
            // The element itself, else its nearest ancestor in the tree.
            let element = chain
                .iter()
                .find_map(|link| tree.iter().position(|(t, _)| same(t, link)))
                .filter(|&i| i > 0);
            let window_rect = window_el.CurrentBoundingRectangle().or_fail()?;
            let point = Point {
                x: pt.x - window_rect.left,
                y: pt.y - window_rect.top,
            };
            let infos: Vec<WindowInfo> = windows.iter().map(|(_, w, _)| w.clone()).collect();
            let nodes: Vec<NodeInfo> = tree.iter().map(|(_, n)| n.clone()).collect();
            let picked = picked_target(&infos, window, &nodes, element, point);
            let rect = match element {
                Some(i) => tree[i].0.CurrentBoundingRectangle().unwrap_or(window_rect),
                None => window_rect,
            };
            let label = element.map_or_else(|| info.title.clone(), |i| describe(&nodes[i]));
            let mut result = json!({
                "target": picked.target,
                "how": picked.how,
                "label": label,
                "window": { "title": info.title, "process": info.process },
                "rect": { "x": rect.left, "y": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top },
            });
            if picked.how == "point" {
                result["note"] = json!(
                    "The part has no id or name, so it is pointed at by its place in the window: it breaks if the layout changes."
                );
            }
            Ok(result)
        }
    }

    /// Records what the user does (see `Op::Record`). Each click and
    /// command key is held back by the hooks until the screen is read (so
    /// the target is the thing clicked, not what the click opened), then
    /// sent on to the app.
    fn record(&self, title: &str, hint: String, timeout_ms: u64) -> Result<Value, StepError> {
        let life = Duration::from_millis(timeout_ms);
        let titled = |n: usize| title.replace("{n}", &n.to_string());
        let overlay = Overlay::record(titled(0), hint, life + Duration::from_secs(60))?;
        let deadline = Instant::now() + life;
        // SAFETY: plain Win32 calls.
        let (own, double_ms, slop) = unsafe {
            (
                GetCurrentProcessId(),
                GetDoubleClickTime(),
                (GetSystemMetrics(SM_CXDOUBLECLK) / 2).max(2),
            )
        };
        let mut rec = Recorder {
            actions: Vec::new(),
            field: None,
            last_click: None,
        };
        let mut timed_out = false;
        loop {
            // The last held-back event has been sent on.
            overlay.processing(false);
            overlay.beat();
            if overlay.typed() {
                self.note_typing(&mut rec, own);
            }
            let Some(raw) = overlay.next_raw() else {
                if Instant::now() >= deadline {
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(8));
                continue;
            };
            let before = rec.actions.len();
            overlay.processing(matches!(raw, Raw::Down { .. } | Raw::Key { .. }));
            match raw {
                Raw::Stop => break,
                Raw::Up { .. } => {}
                Raw::Pass {
                    vk,
                    scan,
                    extended,
                    up,
                } => {
                    replay_raw_key(vk, scan, extended, up);
                    if !up && !keys::is_modifier(vk) {
                        self.note_typing(&mut rec, own);
                    }
                }
                Raw::Down { button, at, time } => {
                    let up = loop {
                        if let Some(up) = overlay.take_up(button) {
                            break up;
                        }
                        overlay.beat();
                        if Instant::now() >= deadline + Duration::from_secs(30) {
                            break at;
                        }
                        std::thread::sleep(Duration::from_millis(4));
                    };
                    // The second click of a double click: sent on at once,
                    // so the app sees a double click.
                    if let Some(last) = rec.last_click.take()
                        && last.button == button
                        && time.wrapping_sub(last.time) <= double_ms
                        && (at.x - last.at.x).abs() <= slop
                        && (at.y - last.at.y).abs() <= slop
                    {
                        replay_click(button, at, up);
                        if let Some(action) = last.action.and_then(|i| rec.actions.get_mut(i)) {
                            action["double"] = json!(true);
                        }
                        continue;
                    }
                    self.flush_field(&mut rec);
                    let action = self.clicked(own, button, at, up, slop);
                    replay_click(button, at, up);
                    let index = action.map(|a| {
                        rec.actions.push(a);
                        rec.actions.len() - 1
                    });
                    rec.last_click = Some(LastClick {
                        button,
                        at,
                        time,
                        action: index,
                    });
                }
                Raw::Key { vk, extended, held } => {
                    // SAFETY: UIA call on the UIA thread.
                    let focused = unsafe { self.automation.GetFocusedElement().ok() };
                    let theirs = focused.as_ref().filter(|el| element_pid(el) != own);
                    let field = theirs.filter(|el| editable(el));
                    let typing_here = field
                        .is_some_and(|el| rec.field.as_ref().is_some_and(|f| self.same(f, el)));
                    if let Some(el) = field
                        && (keys::is_text_edit(vk, held)
                            || (typing_here && keys::is_ime_key(vk, held, ime_open())))
                    {
                        // Paste, undo, kana conversion…: part of the typing,
                        // whose text is read when it ends.
                        replay_key(vk, extended, held);
                        self.keep_field(&mut rec, el.clone());
                        continue;
                    }
                    if let Some(el) = field
                        && typing_here
                        && vk == 0x0D
                        && held == keys::Held::default()
                    {
                        // Enter while typing: confirming the IME's conversion
                        // changes the text (still typing); otherwise it is
                        // the Enter key, after the text typed so far.
                        let typed = self.field_action(el);
                        let mut press = self.element_action(el);
                        let ime = ime_open();
                        replay_key(vk, extended, held);
                        std::thread::sleep(Duration::from_millis(80));
                        // Confirming adds the converted text to what was
                        // there; a submit that clears or closes the field
                        // does not.
                        let grew = match (typed["value"].as_str(), value_of(el)) {
                            (Some(before), Some(after)) => {
                                after.chars().count() > before.chars().count()
                            }
                            _ => false,
                        };
                        if ime && grew {
                            continue;
                        }
                        rec.field = None;
                        push_field(&mut rec, typed);
                        press["kind"] = json!("press");
                        press["key"] = json!("Enter");
                        rec.actions.push(press);
                        overlay.title(titled(rec.actions.len()));
                        continue;
                    }
                    self.flush_field(&mut rec);
                    if let (Some(el), Some(name)) = (theirs, keys::name(vk, held)) {
                        let mut action = self.element_action(el);
                        action["kind"] = json!("press");
                        action["key"] = json!(name);
                        rec.actions.push(action);
                    }
                    replay_key(vk, extended, held);
                }
            }
            if rec.actions.len() != before {
                overlay.title(titled(rec.actions.len()));
            }
        }
        self.flush_field(&mut rec);
        drop(overlay);
        Ok(json!({
            "status": if timed_out { "timedOut" } else { "stopped" },
            "actions": rec.actions,
        }))
    }

    /// What a click at `at` (released at `up`) was, before the app sees it:
    /// `None` for a click on Studio itself.
    fn clicked(
        &self,
        own: u32,
        button: MouseButton,
        at: POINT,
        up: POINT,
        slop: i32,
    ) -> Option<Value> {
        // SAFETY: UIA call on the UIA thread.
        let el = unsafe { self.automation.ElementFromPoint(at).ok()? };
        if element_pid(&el) == own {
            return None;
        }
        let button = match button {
            MouseButton::Left => "left",
            MouseButton::Right => "right",
        };
        if (up.x - at.x).abs() > slop * 2 || (up.y - at.y).abs() > slop * 2 {
            return Some(json!({
                "kind": "drag",
                "button": button,
                "from": { "x": at.x, "y": at.y },
                "to": { "x": up.x, "y": up.y },
            }));
        }
        let mut action = match self.picked(&el, at) {
            Ok(picked) => picked,
            Err(e) => json!({ "failed": { "code": e.code, "message": e.message } }),
        };
        action["kind"] = json!("click");
        action["button"] = json!(button);
        action["double"] = json!(false);
        if editable(&el) {
            action["editable"] = json!(true);
        }
        Some(action)
    }

    /// `{ target, how, label, window, rect }` for an element (a field, the
    /// focus when a key was pressed).
    fn element_action(&self, el: &IUIAutomationElement) -> Value {
        // SAFETY: UIA call on the UIA thread.
        let rect = unsafe { el.CurrentBoundingRectangle().ok() };
        let pt = rect.and_then(|r| center(r).ok()).unwrap_or_default();
        self.picked(el, pt)
            .unwrap_or_else(|e| json!({ "failed": { "code": e.code, "message": e.message } }))
    }

    /// A typing key went down: the focused field is the one being typed in.
    fn note_typing(&self, rec: &mut Recorder, own: u32) {
        // SAFETY: UIA call on the UIA thread.
        let Some(el) = (unsafe { self.automation.GetFocusedElement().ok() }) else {
            return;
        };
        if element_pid(&el) != own {
            self.keep_field(rec, el);
        }
    }

    fn keep_field(&self, rec: &mut Recorder, el: IUIAutomationElement) {
        let same = rec.field.as_ref().is_some_and(|f| self.same(f, &el));
        if !same {
            self.flush_field(rec);
            rec.field = Some(el);
        }
    }

    /// The text typed into the field so far, as one `setValue`.
    fn flush_field(&self, rec: &mut Recorder) {
        let Some(el) = rec.field.take() else {
            return;
        };
        let action = self.field_action(&el);
        push_field(rec, action);
    }

    /// `setValue` with the field's text now (never a password's).
    fn field_action(&self, el: &IUIAutomationElement) -> Value {
        let mut action = self.element_action(el);
        // SAFETY: UIA call on the UIA thread.
        let password = unsafe { el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false) };
        if password {
            action["password"] = json!(true);
        } else {
            match value_of(el) {
                Some(value) => action["value"] = json!(value),
                None => action["unread"] = json!(true),
            }
        }
        action["kind"] = json!("setValue");
        action
    }

    fn same(&self, a: &IUIAutomationElement, b: &IUIAutomationElement) -> bool {
        // SAFETY: UIA call on the UIA thread.
        unsafe {
            self.automation
                .CompareElements(a, b)
                .map(|b| b.as_bool())
                .unwrap_or(false)
        }
    }

    /// Frames the target on screen (see `Op::Highlight`).
    fn highlight(&self, target: &Target, ms: u64) -> Result<Value, StepError> {
        let found = match self.resolve(&target.window_part()) {
            Ok(found) => found,
            Err(e)
                if matches!(
                    e.code.as_str(),
                    "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_GONE"
                ) =>
            {
                return Ok(json!({ "found": false, "code": e.code, "message": e.message }));
            }
            Err(e) => return Err(e),
        };
        // SAFETY: UIA calls on the UIA thread.
        let rect = unsafe {
            let window = found.window_el.CurrentBoundingRectangle().or_fail()?;
            if let Some(p) = target.point {
                const HALF: i32 = 12;
                let (x, y) = (window.left + p.x, window.top + p.y);
                RECT {
                    left: x - HALF,
                    top: y - HALF,
                    right: x + HALF,
                    bottom: y + HALF,
                }
            } else if let Some(r) = &target.region {
                let (x, y) = (window.left + r.x, window.top + r.y);
                RECT {
                    left: x,
                    top: y,
                    right: x + r.width as i32,
                    bottom: y + r.height as i32,
                }
            } else {
                found.el.CurrentBoundingRectangle().or_fail()?
            }
        };
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return Ok(json!({ "found": true, "visible": false }));
        }
        Overlay::flash(rect, Duration::from_millis(ms))?;
        Ok(json!({
            "found": true,
            "visible": true,
            "rect": { "x": rect.left, "y": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top },
        }))
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

    // -- scrolling and menus --------------------------------------------------------

    fn scroll(
        &self,
        target: &Target,
        direction: Option<Direction>,
        amount: u32,
        unit: ScrollUnit,
    ) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let Some(direction) = direction else {
                if !found.is_element {
                    return Err(StepError::invalid_params(
                        "without direction, target.element names what to bring into view; add direction (up, down, top, bottom, ...) to scroll the window",
                    ));
                }
                let p = pattern::<IUIAutomationScrollItemPattern>(
                    &found.el,
                    UIA_ScrollItemPatternId,
                )
                .map_err(|_| {
                    StepError::permanent(
                        "NOT_SUPPORTED",
                        format!("the {} cannot be scrolled into view", found.node.role),
                    )
                    .with_details(json!({
                        "hint": "Scroll its list or pane instead: target that and add direction (e.g. down), or use desktop.mouseScroll."
                    }))
                })?;
                p.ScrollIntoView().map_err(action_error)?;
                return Ok(match self.scroller(&found.el) {
                    Some(s) => scroll_state(&s, None),
                    None => {
                        json!({ "verticalPercent": null, "horizontalPercent": null, "atEnd": false })
                    }
                });
            };
            let scroller = self.scroller(&found.el).ok_or_else(|| {
                StepError::permanent(
                    "NOT_SUPPORTED",
                    format!("the {} has nothing to scroll", found.node.role),
                )
                .with_details(json!({
                    "hint": "Target the list, table or pane that scrolls (inspect_ui), or use desktop.mouseScroll or desktop.press with PageDown."
                }))
            })?;
            match direction {
                Direction::Top | Direction::Bottom => {
                    if scroller
                        .CurrentVerticallyScrollable()
                        .is_ok_and(|b| b.as_bool())
                    {
                        let to = if direction == Direction::Top {
                            0.0
                        } else {
                            100.0
                        };
                        scroller
                            .SetScrollPercent(UIA_ScrollPatternNoScroll, to)
                            .map_err(action_error)?;
                    }
                }
                _ => {
                    let (forward, backward) = match unit {
                        ScrollUnit::Page => {
                            (ScrollAmount_LargeIncrement, ScrollAmount_LargeDecrement)
                        }
                        ScrollUnit::Line => {
                            (ScrollAmount_SmallIncrement, ScrollAmount_SmallDecrement)
                        }
                    };
                    let percent = || scroll_percent(&scroller, direction.is_vertical());
                    for _ in 0..amount {
                        if scroll_state(&scroller, Some(direction))["atEnd"] == json!(true) {
                            break;
                        }
                        let before = percent();
                        let (h, v) = match direction {
                            Direction::Down => (ScrollAmount_NoAmount, forward),
                            Direction::Up => (ScrollAmount_NoAmount, backward),
                            Direction::Right => (forward, ScrollAmount_NoAmount),
                            _ => (backward, ScrollAmount_NoAmount),
                        };
                        scroller.Scroll(h, v).map_err(action_error)?;
                        // A scroll that moved nothing is at its end, whatever
                        // percentage the app reports there.
                        if percent() == before {
                            let mut state = scroll_state(&scroller, Some(direction));
                            state["atEnd"] = json!(true);
                            return Ok(state);
                        }
                    }
                }
            }
            Ok(scroll_state(&scroller, Some(direction)))
        }
    }

    // -- tables -----------------------------------------------------------------------

    /// Reads a grid cell by cell where it supports the Grid pattern (all
    /// rows, also those scrolled out of view), otherwise from its element
    /// tree.
    fn get_table(&self, target: &Target, max_rows: usize) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        let el = self.find_grid(&found)?;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            if let Ok(grid) = pattern::<IUIAutomationGridPattern>(&el, UIA_GridPatternId) {
                let rows = grid.CurrentRowCount().or_fail()?.max(0) as usize;
                let cols = grid.CurrentColumnCount().or_fail()?.max(0) as usize;
                if cols > 0 {
                    let take = rows.min(max_rows);
                    let mut cells = Vec::with_capacity(take);
                    for r in 0..take {
                        let row: Vec<String> = (0..cols)
                            .map(|c| {
                                grid.GetItem(r as i32, c as i32)
                                    .map(|cell| cell_text(&cell))
                                    .unwrap_or_default()
                            })
                            .collect();
                        cells.push(row);
                    }
                    let mut grid = Grid {
                        headers: self.column_headers(&el, cols)?,
                        rows: cells,
                        truncated: rows > max_rows,
                    };
                    grid.drop_blank_columns();
                    return Ok(grid.to_json());
                }
            }
        }
        let nodes: Vec<NodeInfo> = self
            .tree(&el, FIND_LIMIT)?
            .into_iter()
            .map(|(_, n)| n)
            .collect();
        let mut grid = table::grid_from_nodes(&nodes, max_rows);
        if nodes.len() >= FIND_LIMIT && !grid.truncated {
            // The walk stopped before the table's end: the last row may be
            // cut short, and more rows were left out.
            grid.rows.pop();
            grid.truncated = true;
        }
        Ok(grid.to_json())
    }

    /// The grid the target names, or the first one in it (tables and grids
    /// before lists).
    fn find_grid(&self, found: &Found) -> Result<IUIAutomationElement, StepError> {
        if found.is_element && GRID_ROLES.contains(&found.node.role) {
            return Ok(found.el.clone());
        }
        let tree = self.tree(&found.el, FIND_LIMIT)?;
        let first = |roles: &[&str]| {
            tree.iter()
                .find(|(_, n)| roles.contains(&n.role) && !n.offscreen)
                .map(|(el, _)| el.clone())
        };
        first(&["table", "grid"])
            .or_else(|| first(&["list"]))
            .ok_or_else(|| {
                StepError::new("ELEMENT_NOT_FOUND", "no table, grid or list is shown there")
                    .with_details(json!({
                        "hint": "Check inspect_ui for an element with role table, grid or list and target it with element. Grids drawn by the app itself can only be read with desktop.readText."
                    }))
            })
    }

    /// Column names from the Table pattern, or the header items in the
    /// grid's tree.
    fn column_headers(
        &self,
        el: &IUIAutomationElement,
        cols: usize,
    ) -> Result<Vec<String>, StepError> {
        // SAFETY: UIA calls on the UIA thread.
        let from_pattern: Vec<String> = unsafe {
            pattern::<IUIAutomationTablePattern>(el, UIA_TablePatternId)
                .and_then(|t| t.GetCurrentColumnHeaders())
                .map(|headers| {
                    (0..headers.Length().unwrap_or(0))
                        .filter_map(|i| headers.GetElement(i).ok())
                        .map(|h| h.CurrentName().map(|n| n.to_string()).unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default()
        };
        if from_pattern.iter().any(|h| !h.trim().is_empty()) {
            return Ok(from_pattern);
        }
        let headers: Vec<String> = self
            .tree(el, FIND_LIMIT)?
            .into_iter()
            .filter(|(_, n)| n.role == "columnheader")
            .map(|(_, n)| n.name)
            .take(cols)
            .collect();
        Ok(headers)
    }

    /// The scroll pattern of `el` or of the nearest element around it that
    /// can scroll.
    fn scroller(&self, el: &IUIAutomationElement) -> Option<IUIAutomationScrollPattern> {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let walker = self.automation.ControlViewWalker().ok()?;
            let mut current = el.clone();
            for _ in 0..32 {
                if let Ok(p) = pattern::<IUIAutomationScrollPattern>(&current, UIA_ScrollPatternId)
                    && (p.CurrentVerticallyScrollable().is_ok_and(|b| b.as_bool())
                        || p.CurrentHorizontallyScrollable().is_ok_and(|b| b.as_bool()))
                {
                    return Some(p);
                }
                current = walker.GetParentElement(&current).ok()?;
            }
            None
        }
    }

    fn menu(&self, target: &Target, path: &[String]) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            if found.is_element {
                let opened = found
                    .el
                    .cast::<IUIAutomationElement3>()
                    .and_then(|el| el.ShowContextMenu());
                if opened.is_err() {
                    return Err(StepError::permanent(
                        "NOT_SUPPORTED",
                        format!("the {} does not open its context menu without the mouse", found.node.role),
                    )
                    .with_details(json!({
                        "hint": "Open it with desktop.mouseClick (button: right) on the same target, then desktop.selectMenu with only target.window and the same path."
                    })));
                }
            }
            let mut parent: Option<IUIAutomationElement> = None;
            for (i, name) in path.iter().enumerate() {
                let (item, info) = self.wait_menu_item(&found, name, parent.as_ref())?;
                let last = i + 1 == path.len();
                activate_menu_item(&item, &info, last)?;
                parent = Some(item);
            }
        }
        Ok(Value::Null)
    }

    /// The shown menu item `name`, waiting a little for its menu to open.
    fn wait_menu_item(
        &self,
        found: &Found,
        name: &str,
        parent: Option<&IUIAutomationElement>,
    ) -> Result<(IUIAutomationElement, NodeInfo), StepError> {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let mut items = self.menu_items(found, parent)?;
            let infos: Vec<menu::Item> = items.iter().map(|(_, _, item)| item.clone()).collect();
            match menu::pick(name, &infos) {
                Ok(i) if !items[i].2.enabled => {
                    return Err(StepError::permanent(
                        "ELEMENT_DISABLED",
                        format!("the menu item '{}' is greyed out", items[i].2.name),
                    )
                    .with_details(json!({ "hint": "The app does not allow it on this screen now; check the state before this step." })));
                }
                Ok(i) => {
                    let (el, node, _) = items.swap_remove(i);
                    return Ok((el, node));
                }
                Err(e) if e.code == "MENU_ITEM_NOT_FOUND" && std::time::Instant::now() < until => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// The menu items shown now: in menus that popped up (other top-level
    /// windows of the app, and under the item just opened) and in the
    /// window itself (its menu bar), without duplicates.
    fn menu_items(
        &self,
        found: &Found,
        parent: Option<&IUIAutomationElement>,
    ) -> Result<Vec<(IUIAutomationElement, NodeInfo, menu::Item)>, StepError> {
        let mut roots: Vec<(IUIAutomationElement, bool)> = self
            .windows()?
            .into_iter()
            // Only the app's open popup menus (Win32 menus, WinForms and
            // WPF drop-downs), not its other windows with their own menu
            // bars.
            .filter(|(_, w, node)| {
                w.pid == found.window.pid
                    && w.handle != found.window.handle
                    && (node.role == "menu" || matches!(w.class_name.as_str(), "#32768" | "Popup"))
            })
            .map(|(el, _, _)| (el, true))
            .collect();
        if let Some(parent) = parent {
            roots.push((parent.clone(), true));
        }
        roots.push((found.window_el.clone(), false));
        let mut out: Vec<(IUIAutomationElement, NodeInfo, menu::Item)> = Vec::new();
        for (root, popup) in roots {
            for (el, node) in self.tree(&root, FIND_LIMIT)? {
                if node.role != "menuitem" || node.offscreen || node.name.trim().is_empty() {
                    continue;
                }
                // SAFETY: UIA calls on the UIA thread.
                let seen = out.iter().any(|(other, _, _)| unsafe {
                    self.automation
                        .CompareElements(other, &el)
                        .is_ok_and(|same| same.as_bool())
                });
                if seen {
                    continue;
                }
                let item = menu::Item {
                    name: node.name.clone(),
                    popup,
                    enabled: node.enabled,
                };
                out.push((el, node, item));
            }
        }
        Ok(out)
    }

    // -- pictures -------------------------------------------------------------------

    /// A picture of the target's window, from the top-left of its UI
    /// Automation rectangle (the origin of `target.point`). Drawn by the
    /// window itself where it can, so it may stay behind others; otherwise
    /// it is brought to the front and copied from the screen.
    fn capture(&self, target: &Target) -> Result<Capture, StepError> {
        if let Some(element) = &target.element
            && let Reach::Bridge(app, _, window_el) = self.reach(&target.window)
        {
            let (left, top, width, height) = app.screen_rect(element)?;
            let mut capture = self.capture(&target.window_part_only())?;
            // SAFETY: UIA calls on the UIA thread.
            let rect = unsafe { window_el.CurrentBoundingRectangle() }.or_fail()?;
            capture.element = Some(Rect {
                x: left - rect.left,
                y: top - rect.top,
                width: width.max(1) as u32,
                height: height.max(1) as u32,
            });
            return Ok(capture);
        }
        let found = self.resolve(target)?;
        let window = hwnd(found.window.handle);
        // SAFETY: Win32 / UIA calls on the UIA thread.
        unsafe {
            if !window.0.is_null() && IsIconic(window).as_bool() {
                let _ = ShowWindow(window, SW_RESTORE);
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            let rect = found.window_el.CurrentBoundingRectangle().or_fail()?;
            let image = match capture::print_window(window, rect) {
                Some(image) => image,
                None => {
                    self.bring_to_front(&found, false)?;
                    capture::copy_screen(rect)?
                }
            };
            let element = if found.is_element {
                let r = found.el.CurrentBoundingRectangle().or_fail()?;
                if r.right <= r.left || r.bottom <= r.top {
                    return Err(StepError::new(
                        "ELEMENT_NOT_VISIBLE",
                        "the element has no area on screen",
                    ));
                }
                Some(Rect {
                    x: r.left - rect.left,
                    y: r.top - rect.top,
                    width: (r.right - r.left) as u32,
                    height: (r.bottom - r.top) as u32,
                })
            } else {
                None
            };
            Ok(Capture { image, element })
        }
    }

    // -- the real mouse and keyboard ---------------------------------------------

    /// Restores and activates the window, then focuses the element. For
    /// keyboard input the element must really have the focus, or the keys
    /// (perhaps a password) would land in another field.
    fn bring_to_front(&self, found: &Found, keyboard: bool) -> Result<(), StepError> {
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
                let focused = found.el.SetFocus();
                if keyboard && (focused.is_err() || !self.has_focus(&found.el)) {
                    return Err(StepError::permanent(
                        "FOCUS_FAILED",
                        format!("the {} could not be given the keyboard focus", found.node.role),
                    )
                    .with_details(json!({
                        "hint": "Target the input field itself (inspect_ui), or use desktop.setValue / desktop.mouseClick on it first."
                    })));
                }
            }
        }
        Ok(())
    }

    /// Whether `el` or something inside it has the keyboard focus.
    fn has_focus(&self, el: &IUIAutomationElement) -> bool {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let (Ok(mut current), Ok(walker)) = (
                self.automation.GetFocusedElement(),
                self.automation.ControlViewWalker(),
            ) else {
                return false;
            };
            for _ in 0..16 {
                if self
                    .automation
                    .CompareElements(el, &current)
                    .is_ok_and(|same| same.as_bool())
                {
                    return true;
                }
                match walker.GetParentElement(&current) {
                    Ok(parent) => current = parent,
                    Err(_) => return false,
                }
            }
            false
        }
    }

    fn mouse_click(
        &self,
        target: &Target,
        button: MouseButton,
        double: bool,
    ) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        self.bring_to_front(&found, false)?;
        let at = self.mouse_point(&found, target)?;
        // SAFETY: Win32 calls on the UIA thread.
        unsafe {
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

    /// Where on the screen the mouse goes for `target`: its `point` from
    /// the window's top-left, or the element's clickable point (centre).
    fn mouse_point(&self, found: &Found, target: &Target) -> Result<POINT, StepError> {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            Ok(match target.point {
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
            })
        }
    }

    fn hover(&self, target: &Target) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        self.bring_to_front(&found, false)?;
        let at = self.mouse_point(&found, target)?;
        move_to(at)?;
        Ok(Value::Null)
    }

    fn wheel(
        &self,
        target: &Target,
        direction: Direction,
        notches: u32,
    ) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        self.bring_to_front(&found, false)?;
        move_to(self.mouse_point(&found, target)?)?;
        // One notch is WHEEL_DELTA (120); positive is up / right.
        let (flag, delta) = match direction {
            Direction::Up | Direction::Top => (MOUSEEVENTF_WHEEL, 120),
            Direction::Down | Direction::Bottom => (MOUSEEVENTF_WHEEL, -120),
            Direction::Left => (MOUSEEVENTF_HWHEEL, -120),
            Direction::Right => (MOUSEEVENTF_HWHEEL, 120),
        };
        for _ in 0..notches {
            let mut input = mouse(flag);
            input.Anonymous.mi.mouseData = delta as _;
            send(&[input])?;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(Value::Null)
    }

    /// Presses the left button on `from`, moves in small steps (so the app
    /// sees a drag, not a jump) and lets go on `to`. The button is always
    /// released, even when a step in between fails.
    fn drag(&self, from: &Target, to: &Target) -> Result<Value, StepError> {
        let source = self.resolve_enabled(from)?;
        let goal = self.resolve(to)?;
        self.bring_to_front(&source, false)?;
        let a = self.mouse_point(&source, from)?;
        let b = self.mouse_point(&goal, to)?;
        move_to(a)?;
        send(&[mouse(MOUSEEVENTF_LEFTDOWN)])?;
        let pause = |ms| std::thread::sleep(std::time::Duration::from_millis(ms));
        let moved = (|| {
            pause(120);
            const STEPS: i32 = 24;
            for i in 1..=STEPS {
                move_to(POINT {
                    x: a.x + (b.x - a.x) * i / STEPS,
                    y: a.y + (b.y - a.y) * i / STEPS,
                })?;
                pause(15);
            }
            pause(150);
            Ok(())
        })();
        let released = send(&[mouse(MOUSEEVENTF_LEFTUP)]);
        moved.and(released)?;
        Ok(Value::Null)
    }

    fn type_text(&self, target: &Target, text: &Text) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        check_app(text, &found.window)?;
        self.bring_to_front(&found, true)?;
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
        self.bring_to_front(&found, true)?;
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

/// A cell's text: its value where it has one, otherwise its name.
fn cell_text(cell: &IUIAutomationElement) -> String {
    // SAFETY: UIA calls on the UIA thread.
    unsafe {
        let value = pattern::<IUIAutomationValuePattern>(cell, UIA_ValuePatternId)
            .and_then(|p| p.CurrentValue())
            .map(|v| v.to_string())
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| {
                pattern::<IUIAutomationLegacyIAccessiblePattern>(
                    cell,
                    UIA_LegacyIAccessiblePatternId,
                )
                .and_then(|p| p.CurrentValue())
                .map(|v| v.to_string())
                .ok()
                .filter(|v| !v.trim().is_empty())
            });
        let text = value.unwrap_or_else(|| {
            cell.CurrentName()
                .map(|n| n.to_string())
                .unwrap_or_default()
        });
        table::clean_cell(&text)
    }
}

/// Opens a menu item that leads to a submenu, or carries out the last one.
fn activate_menu_item(
    item: &IUIAutomationElement,
    node: &NodeInfo,
    last: bool,
) -> Result<(), StepError> {
    // SAFETY: UIA calls on the UIA thread.
    unsafe {
        if !last
            && let Ok(p) =
                pattern::<IUIAutomationExpandCollapsePattern>(item, UIA_ExpandCollapsePatternId)
        {
            return p.Expand().map_err(action_error);
        }
        let acted = if let Ok(p) = pattern::<IUIAutomationInvokePattern>(item, UIA_InvokePatternId)
        {
            p.Invoke()
        } else if let Ok(p) = pattern::<IUIAutomationTogglePattern>(item, UIA_TogglePatternId) {
            p.Toggle()
        } else if let Ok(p) =
            pattern::<IUIAutomationExpandCollapsePattern>(item, UIA_ExpandCollapsePatternId)
        {
            p.Expand()
        } else if let Ok(p) =
            pattern::<IUIAutomationLegacyIAccessiblePattern>(item, UIA_LegacyIAccessiblePatternId)
        {
            p.DoDefaultAction()
        } else {
            return Err(StepError::permanent(
                "NOT_CLICKABLE",
                format!("the menu item '{}' cannot be chosen without the mouse", node.name),
            )
            .with_details(json!({ "hint": "Open the menu and click the item with desktop.mouseClick (target its role menuitem and name)." })));
        };
        acted.map_err(action_error)
    }
}

/// Where a scrollable area stands: percents (null when it cannot scroll
/// that way) and whether it can go no further in `direction`.
/// How far a scroller is scrolled (0–100), or None when it does not scroll
/// that way.
fn scroll_percent(p: &IUIAutomationScrollPattern, vertical: bool) -> Option<f64> {
    // SAFETY: UIA calls on the UIA thread.
    let (scrollable, percent) = unsafe {
        if vertical {
            (
                p.CurrentVerticallyScrollable(),
                p.CurrentVerticalScrollPercent(),
            )
        } else {
            (
                p.CurrentHorizontallyScrollable(),
                p.CurrentHorizontalScrollPercent(),
            )
        }
    };
    match (scrollable, percent) {
        (Ok(s), Ok(p)) if s.as_bool() && p >= 0.0 => Some(p),
        _ => None,
    }
}

fn scroll_state(p: &IUIAutomationScrollPattern, direction: Option<Direction>) -> Value {
    let (v, h) = (scroll_percent(p, true), scroll_percent(p, false));
    let at_end = match direction {
        None => false,
        Some(d) => {
            let percent = if d.is_vertical() { v } else { h };
            let forward = matches!(d, Direction::Down | Direction::Bottom | Direction::Right);
            match percent {
                None => true,
                // Only the very end: on a long list the last 0.1% can
                // still hide rows (a scroll that moves nothing is caught
                // by the caller).
                Some(p) if forward => p >= 100.0 - 1e-6,
                Some(p) => p <= 1e-6,
            }
        }
    };
    let round = |p: Option<f64>| p.map(|p| (p * 10.0).round() / 10.0);
    json!({ "verticalPercent": round(v), "horizontalPercent": round(h), "atEnd": at_end })
}

/// Moves the cursor and tells the app under it that the mouse moved.
fn move_to(at: POINT) -> Result<(), StepError> {
    // SAFETY: plain Win32 calls.
    unsafe { SetCursorPos(at.x, at.y) }.or_fail()?;
    send(&[mouse(MOUSEEVENTF_MOVE)])
}

/// How a window is reached.
enum Reach {
    Uia,
    Bridge(Box<dyn AppBridge>, WindowInfo, IUIAutomationElement),
    /// SAP GUI or Java, but its way in does not work (why).
    Unreachable(StepError),
}

/// Where an op goes after the SAP GUI / Java check.
enum Routed {
    Done(Value),
    Uia(Box<Op>),
}

/// The target an op acts on (the start of a drag).
fn op_target(op: &Op) -> Option<&Target> {
    match op {
        Op::ListWindows | Op::Inspect { .. } | Op::Pick { .. } | Op::Record { .. } => None,
        Op::Drag { from, .. } => Some(from),
        Op::Highlight { target, .. } => Some(target),
        Op::Probe { target }
        | Op::Click { target }
        | Op::SetValue { target, .. }
        | Op::GetValue { target }
        | Op::Select { target, .. }
        | Op::MouseClick { target, .. }
        | Op::Type { target, .. }
        | Op::Press { target, .. }
        | Op::CloseWindow { target }
        | Op::Scroll { target, .. }
        | Op::Wheel { target, .. }
        | Op::Hover { target }
        | Op::Menu { target, .. }
        | Op::GetTable { target, .. }
        | Op::SapTransaction { target, .. } => Some(target),
    }
}

fn sap_scripting_off() -> StepError {
    StepError::permanent(
        "SAP_SCRIPTING_OFF",
        "SAP GUI Scripting cannot reach this SAP GUI window",
    )
    .with_details(json!({
        "hint": "Ask the user to enable scripting on the SAP server (transaction RZ11: sapgui/user_scripting = TRUE) and in SAP GUI Options > Accessibility & Scripting > Scripting (enable, turn off the notifications), then try again. Without it only the window itself, OCR and images work."
    }))
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

/// What the recorder has seen so far.
struct Recorder {
    actions: Vec<Value>,
    /// The text field being typed in (read when the typing ends).
    field: Option<IUIAutomationElement>,
    last_click: Option<LastClick>,
}

struct LastClick {
    button: MouseButton,
    at: POINT,
    time: u32,
    /// Its place in `actions` (`None` when it was not written down).
    action: Option<usize>,
}

fn element_pid(el: &IUIAutomationElement) -> u32 {
    // SAFETY: UIA call on the UIA thread.
    unsafe { el.CurrentProcessId().unwrap_or(0) as u32 }
}

/// A text field the user can type in.
fn editable(el: &IUIAutomationElement) -> bool {
    // SAFETY: UIA calls on the UIA thread.
    unsafe {
        pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId)
            .and_then(|p| p.CurrentIsReadOnly())
            .is_ok_and(|read_only| !read_only.as_bool())
    }
}

/// Adds a field's `setValue`. A click into the field just before is part
/// of typing into it, so it goes.
fn push_field(rec: &mut Recorder, action: Value) {
    if let Some(last) = rec.actions.last()
        && last["kind"] == "click"
        && last["button"] == "left"
        && last["double"] == false
        && last["target"] == action["target"]
    {
        rec.actions.pop();
        if let Some(click) = rec.last_click.as_mut() {
            click.action = None;
        }
    }
    rec.actions.push(action);
}

/// A field's text now.
fn value_of(el: &IUIAutomationElement) -> Option<String> {
    // SAFETY: UIA calls on the UIA thread.
    unsafe {
        pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId)
            .and_then(|p| p.CurrentValue())
            .map(|v| v.to_string())
            .ok()
    }
}

/// Whether the IME of the window in front is on (Japanese input mode).
fn ime_open() -> bool {
    const IMC_GETOPENSTATUS: usize = 5;
    // SAFETY: plain Win32 calls; the answer is a number.
    unsafe {
        let ime = ImmGetDefaultIMEWnd(GetForegroundWindow());
        if ime.is_invalid() {
            return false;
        }
        let mut open = 0usize;
        let sent = SendMessageTimeoutW(
            ime,
            WM_IME_CONTROL,
            WPARAM(IMC_GETOPENSTATUS),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            100,
            Some(&mut open),
        );
        sent.0 != 0 && open != 0
    }
}

/// Sends on a key that waited in line, as it was.
fn replay_raw_key(vk: u16, scan: u16, extended: bool, up: bool) {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    let _ = send(&[keyboard(vk, scan, flags)]);
}

/// Sends a held-back click on to the app: pressed at `at`, released at `up`.
fn replay_click(button: MouseButton, at: POINT, up: POINT) {
    let (down_flag, up_flag) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    };
    // SAFETY: plain Win32 calls.
    unsafe {
        let mut back = POINT::default();
        let _ = GetCursorPos(&mut back);
        let _ = SetCursorPos(at.x, at.y);
        let _ = send(&[mouse(down_flag)]);
        let _ = SetCursorPos(up.x, up.y);
        let _ = send(&[mouse(up_flag)]);
        // The user may have moved on while the screen was read.
        let _ = SetCursorPos(back.x, back.y);
    }
}

/// Sends a held-back key on to the app. The modifiers are normally still
/// held by the user; any already let go are pressed around the key.
fn replay_key(vk: u16, extended: bool, held: keys::Held) {
    let now = held_now();
    let mut missing = Vec::new();
    for (was, is, vk) in [
        (held.ctrl, now.ctrl, 0x11),
        (held.alt, now.alt, 0x12),
        (held.shift, now.shift, 0x10),
        (held.win, now.win, 0x5B),
    ] {
        if was && !is {
            missing.push(Key {
                vk,
                extended: vk == 0x5B,
            });
        }
    }
    let key = Key { vk, extended };
    let mut inputs: Vec<INPUT> = missing.iter().map(|k| key_event(*k, false)).collect();
    tap(&mut inputs, key);
    inputs.extend(missing.iter().rev().map(|k| key_event(*k, true)));
    let _ = send(&inputs);
}

fn rect_key(rect: RECT) -> (i32, i32, i32, i32) {
    (rect.left, rect.top, rect.right, rect.bottom)
}

/// The top-level window at `pt` on screen, as the picker frames it.
struct TopWindow {
    hwnd: HWND,
    pid: u32,
    /// What is seen of it (without the invisible resize borders).
    rect: RECT,
    title: String,
}

impl TopWindow {
    /// Which window, and where: a change means the frame moves.
    fn key(&self) -> (isize, (i32, i32, i32, i32)) {
        (self.hwnd.0 as isize, rect_key(self.rect))
    }
}

/// The top-level window at `pt`. Only Win32 calls that do not wait for the
/// app (no WM_GETTEXT), so a hung app cannot stall the picker. The picker's
/// own frames and banner let the mouse through, so they are never found.
fn top_window_at(pt: POINT) -> Option<TopWindow> {
    // SAFETY: plain Win32 calls with local buffers.
    unsafe {
        let at = WindowFromPoint(pt);
        if at.is_invalid() {
            return None;
        }
        let top = GetAncestor(at, GA_ROOT);
        let top = if top.is_invalid() { at } else { top };
        let mut pid = 0u32;
        GetWindowThreadProcessId(top, Some(&mut pid));
        let mut rect = RECT::default();
        let seen = DwmGetWindowAttribute(
            top,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut rect).cast(),
            std::mem::size_of::<RECT>() as u32,
        );
        if seen.is_err() || rect.right <= rect.left {
            GetWindowRect(top, &mut rect).ok()?;
        }
        let mut buf = [0u16; 256];
        let n = InternalGetWindowText(top, &mut buf);
        let title =
            String::from_utf16_lossy(&buf[..usize::try_from(n).unwrap_or(0).min(buf.len())]);
        Some(TopWindow {
            hwnd: top,
            pid,
            rect,
            title,
        })
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
    let path = process_path(pid)?;
    path.rsplit(['\\', '/']).next().map(str::to_owned)
}

/// The full path of a process's executable.
pub(crate) fn process_path(pid: u32) -> Option<String> {
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
        Some(String::from_utf16_lossy(&buffer[..len as usize]))
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
