//! What the picker draws on screen and the input it takes: a frame around
//! an element (four thin topmost windows, so the mouse is almost never on
//! them), a banner at the top of the screen, and low-level mouse and
//! keyboard hooks that take the click meant for picking (the app never gets
//! it) and Esc.
//!
//! Everything runs on a thread of its own with a message loop (hooks and
//! windows need one). UI Automation stays on its own thread: this thread
//! only draws and listens.

#![allow(unsafe_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use shikigami_runtime::StepError;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush,
    DEFAULT_CHARSET, DT_CENTER, DT_END_ELLIPSIS, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER,
    DeleteObject, DrawTextW, EndPaint, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HGDIOBJ,
    InvalidateRect, OUT_DEFAULT_PRECIS, PAINTSTRUCT, SelectObject, SetBkMode, SetTextColor,
    TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetClientRect, GetSystemMetrics, HHOOK, HWND_TOPMOST, KBDLLHOOKSTRUCT, LWA_ALPHA, MSG,
    MSLLHOOKSTRUCT, PM_REMOVE, PeekMessageW, RegisterClassW, SM_CXSCREEN, SW_HIDE, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SetLayeredWindowAttributes, SetWindowPos, SetWindowsHookExW, ShowWindow,
    TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_PAINT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::{PCWSTR, w};

/// The frame's colour: the logo's blue (BGR).
const FRAME: COLORREF = COLORREF(0x00EB_6325);
/// The banner's background (slate 800) and text (white), BGR.
const BANNER_BG: COLORREF = COLORREF(0x003B_291E);
const BANNER_TEXT: COLORREF = COLORREF(0x00FF_FFFF);
const BANNER_DIM: COLORREF = COLORREF(0x00E1_D5CB);
const THICKNESS: i32 = 3;

/// What the user did while picking.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Input {
    Clicked(POINT),
    Cancelled,
}

/// Set by the hooks, read by the picker.
static INPUT: Mutex<Option<Input>> = Mutex::new(None);
/// The hooks take clicks only while a picker runs.
static CAPTURING: AtomicBool = AtomicBool::new(false);
/// The button-up after the picking click is taken too.
static SWALLOW_UP: AtomicBool = AtomicBool::new(false);
/// One picker at a time (the hooks are global).
static BUSY: AtomicBool = AtomicBool::new(false);
/// The banner's two lines.
static BANNER: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));

enum Cmd {
    Frame(Option<RECT>),
    Detail(String),
    Close,
}

/// A frame (and, for picking, a banner and the hooks) on screen until dropped.
pub struct Overlay {
    tx: mpsc::Sender<Cmd>,
    thread: Option<JoinHandle<()>>,
    picking: bool,
}

impl Overlay {
    /// Starts picking: a banner with `message`, and the hooks.
    pub fn pick(message: String) -> Result<Self, StepError> {
        if BUSY.swap(true, Ordering::SeqCst) {
            return Err(StepError::permanent(
                "PICK_BUSY",
                "another pick is already waiting for a click",
            ));
        }
        if let Ok(mut input) = INPUT.lock() {
            *input = None;
        }
        if let Ok(mut banner) = BANNER.lock() {
            *banner = (message, String::new());
        }
        SWALLOW_UP.store(false, Ordering::SeqCst);
        match Self::start(true) {
            Ok(overlay) => Ok(overlay),
            Err(e) => {
                BUSY.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    /// Frames `rect` for `duration`, then goes away on its own.
    pub fn flash(rect: RECT, duration: Duration) -> Result<(), StepError> {
        let overlay = Self::start(false)?;
        overlay.frame(Some(rect));
        std::thread::spawn(move || {
            std::thread::sleep(duration);
            drop(overlay);
        });
        Ok(())
    }

    fn start(picking: bool) -> Result<Self, StepError> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("shikigami-overlay".into())
            .spawn(move || run(picking, &rx, &ready_tx))
            .map_err(|e| {
                StepError::new("ADAPTER_CRASHED", format!("cannot start the overlay: {e}"))
            })?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                tx,
                thread: Some(thread),
                picking,
            }),
            Ok(Err(message)) => Err(StepError::new("UIA_ERROR", message)),
            Err(_) => Err(StepError::new("UIA_ERROR", "the overlay did not start")),
        }
    }

    pub fn frame(&self, rect: Option<RECT>) {
        let _ = self.tx.send(Cmd::Frame(rect));
    }

    /// The banner's second line (what is under the mouse).
    pub fn detail(&self, text: String) {
        let _ = self.tx.send(Cmd::Detail(text));
    }

    /// The click or Esc, once.
    pub fn take_input(&self) -> Option<Input> {
        INPUT.lock().ok().and_then(|mut input| input.take())
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Close);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if self.picking {
            CAPTURING.store(false, Ordering::SeqCst);
            BUSY.store(false, Ordering::SeqCst);
        }
    }
}

struct Classes {
    frame: PCWSTR,
    banner: PCWSTR,
}

// SAFETY: the class names are static strings.
unsafe impl Send for Classes {}
unsafe impl Sync for Classes {}

fn classes(instance: HINSTANCE) -> Result<&'static Classes, String> {
    static CLASSES: OnceLock<Result<Classes, String>> = OnceLock::new();
    CLASSES
        .get_or_init(|| {
            // SAFETY: registering window classes with static names and procedures.
            unsafe {
                let frame = WNDCLASSW {
                    lpfnWndProc: Some(frame_proc),
                    hInstance: instance,
                    lpszClassName: w!("ShikigamiPickFrame"),
                    hbrBackground: CreateSolidBrush(FRAME),
                    ..WNDCLASSW::default()
                };
                let banner = WNDCLASSW {
                    lpfnWndProc: Some(banner_proc),
                    hInstance: instance,
                    lpszClassName: w!("ShikigamiPickBanner"),
                    hbrBackground: CreateSolidBrush(BANNER_BG),
                    ..WNDCLASSW::default()
                };
                if RegisterClassW(&frame) == 0 || RegisterClassW(&banner) == 0 {
                    return Err("cannot register the overlay's window classes".into());
                }
                Ok(Classes {
                    frame: frame.lpszClassName,
                    banner: banner.lpszClassName,
                })
            }
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn run(picking: bool, rx: &mpsc::Receiver<Cmd>, ready: &mpsc::Sender<Result<(), String>>) {
    // SAFETY: Win32 calls on this thread, for windows and hooks it owns.
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let instance: HINSTANCE = match GetModuleHandleW(None) {
            Ok(module) => module.into(),
            Err(e) => {
                let _ = ready.send(Err(format!("overlay: {e}")));
                return;
            }
        };
        let classes = match classes(instance) {
            Ok(classes) => classes,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let style =
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED;
        let window = |class: PCWSTR| {
            let hwnd = CreateWindowExW(
                style,
                class,
                w!(""),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance),
                None,
            )
            .ok()?;
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
            Some(hwnd)
        };
        let edges: Vec<HWND> = (0..4).filter_map(|_| window(classes.frame)).collect();
        let banner = if picking {
            window(classes.banner)
        } else {
            None
        };
        let mut hooks: Vec<HHOOK> = Vec::new();
        if picking {
            for (id, proc_) in [
                (
                    WH_MOUSE_LL,
                    mouse_proc as unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT,
                ),
                (WH_KEYBOARD_LL, keyboard_proc),
            ] {
                match SetWindowsHookExW(id, Some(proc_), Some(instance), 0) {
                    Ok(hook) => hooks.push(hook),
                    Err(e) => {
                        for hook in hooks {
                            let _ = UnhookWindowsHookEx(hook);
                        }
                        let _ = ready.send(Err(format!("cannot watch the mouse: {e}")));
                        return;
                    }
                }
            }
            CAPTURING.store(true, Ordering::SeqCst);
        }
        if let Some(banner) = banner {
            let scale = GetDpiForWindow(banner).max(96) as i32;
            let width = 640 * scale / 96;
            let height = 64 * scale / 96;
            let screen = GetSystemMetrics(SM_CXSCREEN);
            let _ = SetWindowPos(
                banner,
                Some(HWND_TOPMOST),
                (screen - width) / 2,
                16 * scale / 96,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
        let _ = ready.send(Ok(()));

        let started = Instant::now();
        'running: loop {
            loop {
                match rx.try_recv() {
                    Ok(Cmd::Frame(Some(rect))) => place_frame(&edges, rect),
                    Ok(Cmd::Frame(None)) => {
                        for edge in &edges {
                            let _ = ShowWindow(*edge, SW_HIDE);
                        }
                    }
                    Ok(Cmd::Detail(text)) => {
                        if let Ok(mut lines) = BANNER.lock() {
                            lines.1 = text;
                        }
                        if let Some(banner) = banner {
                            let _ = InvalidateRect(Some(banner), None, true);
                        }
                    }
                    Ok(Cmd::Close) | Err(mpsc::TryRecvError::Disconnected) => break 'running,
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            // Never outlive a lost owner by much.
            if started.elapsed() > Duration::from_secs(15 * 60) {
                break;
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        // Only the picker owns the hooks: a highlight that ends while a
        // picker runs must not stop it from taking the click.
        if picking {
            CAPTURING.store(false, Ordering::SeqCst);
        }
        for hook in hooks {
            let _ = UnhookWindowsHookEx(hook);
        }
        for hwnd in edges.into_iter().chain(banner) {
            let _ = DestroyWindow(hwnd);
        }
    }
}

/// Puts the four edges just outside `rect`.
fn place_frame(edges: &[HWND], rect: RECT) {
    let (l, t, r, b) = (
        rect.left - THICKNESS,
        rect.top - THICKNESS,
        rect.right + THICKNESS,
        rect.bottom + THICKNESS,
    );
    let sides = [
        (l, t, r - l, THICKNESS),
        (l, b - THICKNESS, r - l, THICKNESS),
        (l, t, THICKNESS, b - t),
        (r - THICKNESS, t, THICKNESS, b - t),
    ];
    for (edge, (x, y, w, h)) in edges.iter().zip(sides) {
        // SAFETY: moving windows this thread owns.
        unsafe {
            let _ = SetWindowPos(
                *edge,
                Some(HWND_TOPMOST),
                x,
                y,
                w.max(1),
                h.max(1),
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

unsafe extern "system" fn frame_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: the default handling of our own window's messages.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

unsafe extern "system" fn banner_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg != WM_PAINT {
        // SAFETY: the default handling of our own window's messages.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    // SAFETY: painting our own window inside WM_PAINT.
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        let scale = GetDpiForWindow(hwnd).max(96) as i32;
        let (first, second) = BANNER.lock().map(|b| b.clone()).unwrap_or_default();
        let font = |size: i32, weight: u32| {
            CreateFontW(
                -size * scale / 96,
                0,
                0,
                0,
                weight as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                FF_DONTCARE.0 as u32,
                w!("Yu Gothic UI"),
            )
        };
        let mut client = RECT::default();
        let _ = GetClientRect(hwnd, &mut client);
        let half = (client.bottom - client.top) / 2;
        let _ = SetBkMode(hdc, TRANSPARENT);
        let flags = DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX;
        for (text, size, weight, color, top) in [
            (first, 15, FW_SEMIBOLD.0, BANNER_TEXT, client.top + 4),
            (second, 13, FW_NORMAL.0, BANNER_DIM, client.top + half - 2),
        ] {
            let f = font(size, weight);
            let old = SelectObject(hdc, HGDIOBJ(f.0));
            let _ = SetTextColor(hdc, color);
            let mut line = RECT {
                left: client.left + 12,
                top,
                right: client.right - 12,
                bottom: top + half,
            };
            let mut text = wide(&text);
            DrawTextW(hdc, &mut text, &mut line, flags);
            SelectObject(hdc, old);
            let _ = DeleteObject(HGDIOBJ(f.0));
        }
        let _ = EndPaint(hwnd, &ps);
    }
    LRESULT(0)
}

fn set_input(input: Input) {
    if let Ok(mut slot) = INPUT.lock() {
        slot.get_or_insert(input);
    }
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && CAPTURING.load(Ordering::SeqCst) {
        match wparam.0 as u32 {
            WM_LBUTTONDOWN => {
                // SAFETY: for mouse messages lparam points at an MSLLHOOKSTRUCT.
                let pt = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
                set_input(Input::Clicked(pt));
                SWALLOW_UP.store(true, Ordering::SeqCst);
                return LRESULT(1);
            }
            WM_RBUTTONDOWN => {
                set_input(Input::Cancelled);
                SWALLOW_UP.store(true, Ordering::SeqCst);
                return LRESULT(1);
            }
            WM_LBUTTONUP | WM_RBUTTONUP if SWALLOW_UP.swap(false, Ordering::SeqCst) => {
                return LRESULT(1);
            }
            _ => {}
        }
    } else if code >= 0
        && matches!(wparam.0 as u32, WM_LBUTTONUP | WM_RBUTTONUP)
        && SWALLOW_UP.swap(false, Ordering::SeqCst)
    {
        return LRESULT(1);
    }
    // SAFETY: passing the event on, as every hook must.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0
        && CAPTURING.load(Ordering::SeqCst)
        && matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN)
    {
        // SAFETY: for keyboard messages lparam points at a KBDLLHOOKSTRUCT.
        let vk = unsafe { (*(lparam.0 as *const KBDLLHOOKSTRUCT)).vkCode };
        if vk == u32::from(VK_ESCAPE.0) {
            set_input(Input::Cancelled);
            return LRESULT(1);
        }
    }
    // SAFETY: passing the event on, as every hook must.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
