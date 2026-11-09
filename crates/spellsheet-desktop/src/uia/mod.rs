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
use spellsheet_runtime::{BoxFuture, StepError};
use tokio::sync::oneshot;
use windows::Win32::Foundation::{
    CloseHandle, E_ACCESSDENIED, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
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
use windows::Win32::UI::Input::Ime::ImmGetDefaultIMEWnd;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BM_CLICK, EnumWindows, GA_ROOT, GetAncestor, GetCursorPos, GetForegroundWindow,
    GetSystemMetrics, GetWindowRect, GetWindowThreadProcessId, InternalGetWindowText, IsIconic,
    IsWindowVisible, IsZoomed, PostMessageW, SM_CXDOUBLECLK, SMTO_ABORTIFHUNG, SW_MAXIMIZE,
    SW_MINIMIZE, SW_RESTORE, SWP_NOACTIVATE, SWP_NOZORDER, SendMessageTimeoutW, SetCursorPos,
    SetForegroundWindow, SetWindowPos, ShowWindow, WM_CLOSE, WM_IME_CONTROL, WindowFromPoint,
};
use windows::core::{BSTR, Interface, PWSTR};

use crate::backend::{
    Backend, Bounds, Capture, Direction, MouseButton, OcrEngine, OcrOptions, Op, ScrollUnit, Text,
    WindowState,
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
use crate::snip;
use crate::table::{self, GRID_ROLES, Grid};
use crate::target::{
    ElementQuery, NodeInfo, Point, Target, WindowInfo, WindowQuery, app_allowed, app_label,
    describe, describe_window, pick_element, pick_window, picked_target, render_tree,
    window_choices,
};
use crate::vision::OcrLine;

mod actions;
mod input;
mod pick;
mod tables;

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
            .name("spellsheet-uia".into())
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
        let windows = match &options.engine {
            _ if options.accurate => false,
            Some(OcrEngine::Windows) => true,
            Some(OcrEngine::Paddle) => false,
            Some(OcrEngine::Other(name)) => {
                return crate::backend::other_recognize(name, image, options.clone());
            }
            None => match crate::paddle::engine() {
                Ok(_) => false,
                Err(reason) => {
                    tracing::warn!(%reason, "PaddleOCR is not available; using Windows OCR");
                    true
                }
            },
        };
        if !windows {
            return crate::backend::paddle_recognize(image, options.accurate, options.kind);
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
        "hint": "Start the app normally (not as administrator), or run SpellSheet as administrator too."
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
            Op::SetWindow {
                target,
                state,
                front,
                bounds,
            } => self.set_window(&target, state, front, bounds),
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
                labels,
                window_only,
            } => self.pick(message, timeout_ms, &labels, window_only),
            Op::Snip {
                message,
                timeout_ms,
            } => self.snip(message, timeout_ms),
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
            Op::ListWindows
            | Op::Pick { .. }
            | Op::Snip { .. }
            | Op::Highlight { .. }
            | Op::Record { .. } => {
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
            | Op::SetWindow { target, .. }
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
        Op::ListWindows
        | Op::Inspect { .. }
        | Op::Pick { .. }
        | Op::Snip { .. }
        | Op::Record { .. } => None,
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
        | Op::SetWindow { target, .. }
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
            "hint": format!("If this app is right, ask the user to add app:{} to the secret's sites in Writer.", window.process)
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

/// The visible top-level windows, as UI Automation lists them under the
/// desktop, by plain Win32 calls that never wait for the apps.
fn open_windows() -> Vec<WindowInfo> {
    unsafe extern "system" fn each(hwnd: HWND, found: LPARAM) -> windows::core::BOOL {
        // SAFETY: `found` is the Vec passed to EnumWindows below, alive for the call.
        let found = unsafe { &mut *(found.0 as *mut Vec<HWND>) };
        found.push(hwnd);
        true.into()
    }
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `handles`, which outlives the call.
    let _ = unsafe { EnumWindows(Some(each), LPARAM((&raw mut handles) as isize)) };
    let mut names: HashMap<u32, String> = HashMap::new();
    let mut out = Vec::new();
    for hwnd in handles {
        // SAFETY: plain Win32 calls with local buffers.
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                continue;
            }
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&raw mut cloaked).cast(),
                std::mem::size_of::<u32>() as u32,
            );
            if cloaked != 0 {
                continue;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let mut buf = [0u16; 256];
            let n = InternalGetWindowText(hwnd, &mut buf);
            let title =
                String::from_utf16_lossy(&buf[..usize::try_from(n).unwrap_or(0).min(buf.len())]);
            let process = names
                .entry(pid)
                .or_insert_with(|| process_name(pid).unwrap_or_default())
                .clone();
            out.push(WindowInfo {
                title,
                process,
                pid,
                class_name: String::new(),
                handle: hwnd.0 as isize,
            });
        }
    }
    out
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
