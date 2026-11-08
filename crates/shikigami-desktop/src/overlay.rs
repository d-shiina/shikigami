//! What the picker and the recorder draw on screen and the input they take:
//! a frame around an element (four thin topmost windows, so the mouse is
//! almost never on them), while picking a tag beside each frame saying what
//! it is (the window: how it will be found; the part: its name) and a small
//! banner (how to stop) at the bottom of the screen, while recording a
//! banner at the top of the screen, and low-level
//! mouse and keyboard hooks. Picking takes the click meant for picking (the
//! app never gets it) and Esc. Recording holds back each click and command
//! key until the recorder has looked at the screen, then the recorder sends
//! it on (see `uia::record`); a click on the banner stops the recording.
//!
//! Everything runs on a thread of its own with a message loop (hooks and
//! windows need one). UI Automation stays on its own thread: this thread
//! only draws and listens.

#![allow(unsafe_code)]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use shikigami_runtime::StepError;

use crate::backend::MouseButton;
use crate::hover;
use crate::keys::{self, Held};
use windows::Win32::Foundation::{
    COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush,
    DEFAULT_CHARSET, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER,
    DeleteObject, DrawTextW, EndPaint, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, GetDC, GetMonitorInfoW,
    GetTextExtentPoint32W, HFONT, HGDIOBJ, InvalidateRect, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    MonitorFromPoint, MonitorFromRect, OUT_DEFAULT_PRECIS, PAINTSTRUCT, ReleaseDC, SelectObject,
    SetBkMode, SetTextColor, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_ESCAPE, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetClientRect, GetCursorPos, GetMessageW, GetSystemMetrics, HHOOK, HWND_TOPMOST,
    KBDLLHOOKSTRUCT, KillTimer, LLKHF_EXTENDED, LLKHF_INJECTED, LLMHF_INJECTED, LWA_ALPHA, MSG,
    MSLLHOOKSTRUCT, PostThreadMessageW, RegisterClassW, SM_CXSCREEN, SW_HIDE, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetLayeredWindowAttributes, SetTimer, SetWindowPos,
    SetWindowsHookExW, ShowWindow, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL,
    WH_MOUSE_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_PAINT,
    WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER, WNDCLASSW, WS_EX_LAYERED,
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
/// The frame of the window the picked part belongs to (the window the node
/// will act on): the logo's orange (BGR), drawn just inside the window so it
/// stays on screen when the window is maximised, and so the part's blue
/// frame (outside the part) still shows when the part is the whole window.
const WINDOW_FRAME: COLORREF = COLORREF(0x0000_8CF5);
const WINDOW_THICKNESS: i32 = 4;
/// The tags' text (white) on the frame's colour.
const TAG_TEXT: COLORREF = COLORREF(0x00FF_FFFF);
/// The picker's banner (how to stop), and the tags, in 96-DPI pixels.
const PICK_BANNER_SIZE: (i32, i32) = (360, 34);
const TAG_HEIGHT: i32 = 24;
const TAG_PADDING: i32 = 10;
const TAG_FONT: i32 = 13;
/// The longest tag, in 96-DPI pixels (longer text ends in …).
const TAG_MAX_WIDTH: i32 = 560;

/// What the user did while recording, in order. Times are the system's
/// tick count in milliseconds (`MSLLHOOKSTRUCT::time`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Raw {
    Down {
        button: MouseButton,
        at: POINT,
        time: u32,
    },
    Up {
        button: MouseButton,
        at: POINT,
    },
    /// A command key (see `keys::is_command`), held back.
    Key {
        vk: u16,
        extended: bool,
        held: Held,
    },
    /// Any other key, held back only because something before it still
    /// waits to be sent on (so it cannot overtake a Tab or a click).
    Pass {
        vk: u16,
        scan: u16,
        extended: bool,
        up: bool,
    },
    /// The banner was clicked.
    Stop,
}

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
/// The hooks hold back clicks and command keys while a recorder runs.
static RECORDING: AtomicBool = AtomicBool::new(false);
/// What the recorder has not taken yet.
static RAW: Mutex<VecDeque<Raw>> = Mutex::new(VecDeque::new());
/// Set while the recorder is reading the screen for a held-back event: the
/// keys after it wait in line too.
static PROCESSING: AtomicBool = AtomicBool::new(false);
/// Set when a key that is typing (not a command) goes down.
static TYPED: AtomicBool = AtomicBool::new(false);
/// The recorder's last sign of life (tick count): when it stops answering,
/// the hooks let everything through rather than swallow the user's input.
static BEAT: AtomicU64 = AtomicU64::new(0);
const BEAT_LOST_MS: u64 = 15_000;
/// The command keys held back, so their key-up is held back too.
static HELD_BACK: Mutex<Vec<u32>> = Mutex::new(Vec::new());
/// Where the banner is on screen (left, top, right, bottom).
static BANNER_AT: Mutex<(i32, i32, i32, i32)> = Mutex::new((0, 0, 0, 0));
/// One picker or recorder at a time (the hooks are global).
static BUSY: AtomicBool = AtomicBool::new(false);
/// The banner's two lines.
static BANNER: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));
/// The tags' text: the window's, then the part's.
static TAGS: Mutex<[String; 2]> = Mutex::new([String::new(), String::new()]);
const WINDOW_TAG: usize = 0;
const PART_TAG: usize = 1;

enum Cmd {
    Frame(Option<RECT>),
    Window(Option<RECT>),
    /// A tag (`WINDOW_TAG` / `PART_TAG`) beside a rectangle on screen.
    Tag(usize, Option<(RECT, String)>),
    /// Where the mouse is, for the picker's banner to keep out of its way.
    Mouse(POINT),
    Title(String),
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Flash,
    Pick,
    Record,
}

/// A frame (and, for picking, a banner and the hooks) on screen until dropped.
pub struct Overlay {
    tx: mpsc::Sender<Cmd>,
    /// The overlay thread's id, to wake it for a command.
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
    mode: Mode,
}

/// Posted to the overlay thread when a command is waiting in its channel.
const WM_WAKE: u32 = WM_APP + 1;

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
        match Self::start(Mode::Pick, Duration::from_secs(15 * 60)) {
            Ok(overlay) => Ok(overlay),
            Err(e) => {
                BUSY.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    /// Starts recording for at most `life`: a banner (`title`, `hint`) that
    /// stops the recording when clicked, and the hooks.
    pub fn record(title: String, hint: String, life: Duration) -> Result<Self, StepError> {
        if BUSY.swap(true, Ordering::SeqCst) {
            return Err(StepError::permanent(
                "PICK_BUSY",
                "a pick or a recording is already running",
            ));
        }
        if let Ok(mut raw) = RAW.lock() {
            raw.clear();
        }
        if let Ok(mut held) = HELD_BACK.lock() {
            held.clear();
        }
        if let Ok(mut banner) = BANNER.lock() {
            *banner = (title, hint);
        }
        TYPED.store(false, Ordering::SeqCst);
        SWALLOW_UP.store(false, Ordering::SeqCst);
        beat();
        match Self::start(Mode::Record, life) {
            Ok(overlay) => Ok(overlay),
            Err(e) => {
                BUSY.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    /// Frames `rect` for `duration`, then goes away on its own.
    pub fn flash(rect: RECT, duration: Duration) -> Result<(), StepError> {
        let overlay = Self::start(Mode::Flash, duration + Duration::from_secs(5))?;
        overlay.frame(Some(rect));
        std::thread::spawn(move || {
            std::thread::sleep(duration);
            drop(overlay);
        });
        Ok(())
    }

    fn start(mode: Mode, life: Duration) -> Result<Self, StepError> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("shikigami-overlay".into())
            .spawn(move || run(mode, life, &rx, &ready_tx))
            .map_err(|e| {
                StepError::new("ADAPTER_CRASHED", format!("cannot start the overlay: {e}"))
            })?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(thread_id)) => Ok(Self {
                tx,
                thread_id,
                thread: Some(thread),
                mode,
            }),
            Ok(Err(message)) => Err(StepError::new("UIA_ERROR", message)),
            Err(_) => Err(StepError::new("UIA_ERROR", "the overlay did not start")),
        }
    }

    /// Hands `cmd` to the overlay thread and wakes it.
    fn send(&self, cmd: Cmd) {
        if self.tx.send(cmd).is_ok() {
            // SAFETY: plain Win32 call; the thread made its queue before it said it was ready.
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_WAKE, WPARAM(0), LPARAM(0)) };
        }
    }

    pub fn frame(&self, rect: Option<RECT>) {
        self.send(Cmd::Frame(rect));
    }

    /// Frames the window the part under the mouse is in (`None` hides it).
    pub fn window(&self, rect: Option<RECT>) {
        self.send(Cmd::Window(rect));
    }

    /// Names the window on a tag at its frame (`None` hides it).
    pub fn window_tag(&self, tag: Option<(RECT, String)>) {
        self.send(Cmd::Tag(WINDOW_TAG, tag));
    }

    /// Names the part on a tag beside its frame (`None` hides it).
    pub fn part_tag(&self, tag: Option<(RECT, String)>) {
        self.send(Cmd::Tag(PART_TAG, tag));
    }

    /// Where the mouse is now (the picker's banner moves out of its way).
    pub fn mouse(&self, at: POINT) {
        self.send(Cmd::Mouse(at));
    }

    /// The banner's first line.
    pub fn title(&self, text: String) {
        self.send(Cmd::Title(text));
    }

    /// The next thing the user did while recording.
    pub fn next_raw(&self) -> Option<Raw> {
        RAW.lock().ok().and_then(|mut raw| raw.pop_front())
    }

    /// The release of `button`, once the hooks have seen it (other events
    /// stay queued).
    pub fn take_up(&self, button: MouseButton) -> Option<POINT> {
        let mut raw = RAW.lock().ok()?;
        let i = raw
            .iter()
            .position(|r| matches!(r, Raw::Up { button: b, .. } if *b == button))?;
        match raw.remove(i) {
            Some(Raw::Up { at, .. }) => Some(at),
            _ => None,
        }
    }

    /// While set, every key waits in line behind the events held back.
    pub fn processing(&self, on: bool) {
        PROCESSING.store(on, Ordering::SeqCst);
    }

    /// Whether a typing key went down since the last call.
    pub fn typed(&self) -> bool {
        TYPED.swap(false, Ordering::SeqCst)
    }

    /// Tells the hooks the recorder is still there.
    pub fn beat(&self) {
        beat();
    }

    /// The click or Esc, once.
    pub fn take_input(&self) -> Option<Input> {
        INPUT.lock().ok().and_then(|mut input| input.take())
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        self.send(Cmd::Close);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        match self.mode {
            Mode::Pick => CAPTURING.store(false, Ordering::SeqCst),
            Mode::Record => RECORDING.store(false, Ordering::SeqCst),
            Mode::Flash => return,
        }
        BUSY.store(false, Ordering::SeqCst);
    }
}

struct Classes {
    frame: PCWSTR,
    window: PCWSTR,
    banner: PCWSTR,
    window_tag: PCWSTR,
    part_tag: PCWSTR,
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
                let window = WNDCLASSW {
                    lpfnWndProc: Some(frame_proc),
                    hInstance: instance,
                    lpszClassName: w!("ShikigamiPickWindowFrame"),
                    hbrBackground: CreateSolidBrush(WINDOW_FRAME),
                    ..WNDCLASSW::default()
                };
                let banner = WNDCLASSW {
                    lpfnWndProc: Some(banner_proc),
                    hInstance: instance,
                    lpszClassName: w!("ShikigamiPickBanner"),
                    hbrBackground: CreateSolidBrush(BANNER_BG),
                    ..WNDCLASSW::default()
                };
                let window_tag = WNDCLASSW {
                    lpfnWndProc: Some(window_tag_proc),
                    hInstance: instance,
                    lpszClassName: w!("ShikigamiPickWindowTag"),
                    hbrBackground: CreateSolidBrush(WINDOW_FRAME),
                    ..WNDCLASSW::default()
                };
                let part_tag = WNDCLASSW {
                    lpfnWndProc: Some(part_tag_proc),
                    hInstance: instance,
                    lpszClassName: w!("ShikigamiPickPartTag"),
                    hbrBackground: CreateSolidBrush(FRAME),
                    ..WNDCLASSW::default()
                };
                if RegisterClassW(&frame) == 0
                    || RegisterClassW(&window) == 0
                    || RegisterClassW(&banner) == 0
                    || RegisterClassW(&window_tag) == 0
                    || RegisterClassW(&part_tag) == 0
                {
                    return Err("cannot register the overlay's window classes".into());
                }
                Ok(Classes {
                    frame: frame.lpszClassName,
                    window: window.lpszClassName,
                    banner: banner.lpszClassName,
                    window_tag: window_tag.lpszClassName,
                    part_tag: part_tag.lpszClassName,
                })
            }
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn beat() {
    // SAFETY: plain Win32 call.
    BEAT.store(unsafe { GetTickCount64() }, Ordering::SeqCst);
}

fn run(
    mode: Mode,
    life: Duration,
    rx: &mpsc::Receiver<Cmd>,
    ready: &mpsc::Sender<Result<u32, String>>,
) {
    let picking = mode == Mode::Pick;
    let hooked = mode != Mode::Flash;
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
        // The window's frame first: windows made later start above it, so
        // the part's frame stays on top where the two meet.
        let window_edges: Vec<HWND> = if picking {
            (0..4).filter_map(|_| window(classes.window)).collect()
        } else {
            Vec::new()
        };
        let edges: Vec<HWND> = (0..4).filter_map(|_| window(classes.frame)).collect();
        // The tags last, above both frames.
        let tags: Vec<HWND> = if picking {
            [classes.window_tag, classes.part_tag]
                .into_iter()
                .filter_map(window)
                .collect()
        } else {
            Vec::new()
        };
        if let Ok(mut texts) = TAGS.lock() {
            *texts = [String::new(), String::new()];
        }
        let banner = if hooked { window(classes.banner) } else { None };
        let mut hooks: Vec<HHOOK> = Vec::new();
        if hooked {
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
            if picking {
                CAPTURING.store(true, Ordering::SeqCst);
            } else {
                RECORDING.store(true, Ordering::SeqCst);
            }
        }
        if let Some(banner) = banner
            && picking
        {
            let mut at = POINT::default();
            let _ = GetCursorPos(&mut at);
            place_pick_banner(banner, at);
        } else if let Some(banner) = banner {
            let scale = GetDpiForWindow(banner).max(96) as i32;
            let width = 640 * scale / 96;
            let height = 64 * scale / 96;
            let screen = GetSystemMetrics(SM_CXSCREEN);
            let (left, top) = ((screen - width) / 2, 16 * scale / 96);
            let _ = SetWindowPos(
                banner,
                Some(HWND_TOPMOST),
                left,
                top,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            if let Ok(mut at) = BANNER_AT.lock() {
                *at = (left, top, left + width, top + height);
            }
        }
        // Wakes the loop now and then, so it never outlives a lost owner by much.
        let timer = SetTimer(None, 0, 500, None);
        let _ = ready.send(Ok(GetCurrentThreadId()));

        let started = Instant::now();
        // GetMessage, not a loop that peeks and then waits: Windows calls
        // the low-level hooks by sending this thread a message for every
        // mouse move and key, and waits for the answer before the cursor
        // moves on. Only a thread that sits in GetMessage answers each one
        // at once. The earlier loops (a sleep, then a wait with a timeout)
        // answered some of them only when the wait ran out, so a fast mouse
        // queued up moves faster than they were answered and the cursor
        // crawled, until Windows gave up on the hooks. Commands from the
        // picker come through the channel with a WM_WAKE posted after them.
        let mut msg = MSG::default();
        'running: loop {
            let got = GetMessageW(&mut msg, None, 0, 0);
            if got.0 <= 0 {
                break;
            }
            if msg.hwnd.0.is_null() && (msg.message == WM_WAKE || msg.message == WM_TIMER) {
                // A thread message: commands, or the timer.
            } else {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
                continue;
            }
            // Never outlive a lost owner by much.
            if started.elapsed() > life {
                break;
            }
            loop {
                match rx.try_recv() {
                    Ok(Cmd::Frame(Some(rect))) => {
                        place_edges(&edges, frame_sides(rect, THICKNESS, false));
                    }
                    Ok(Cmd::Window(Some(rect))) => {
                        place_edges(&window_edges, frame_sides(rect, WINDOW_THICKNESS, true));
                        // Keep the part's frame above the window's.
                        for edge in &edges {
                            let _ = SetWindowPos(
                                *edge,
                                Some(HWND_TOPMOST),
                                0,
                                0,
                                0,
                                0,
                                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                            );
                        }
                    }
                    Ok(Cmd::Frame(None)) => {
                        for edge in &edges {
                            let _ = ShowWindow(*edge, SW_HIDE);
                        }
                    }
                    Ok(Cmd::Window(None)) => {
                        for edge in &window_edges {
                            let _ = ShowWindow(*edge, SW_HIDE);
                        }
                    }
                    Ok(Cmd::Tag(which, tag)) => {
                        if let Some(hwnd) = tags.get(which) {
                            place_tag(*hwnd, which, tag);
                        }
                    }
                    Ok(Cmd::Mouse(at)) => {
                        if let Some(banner) = banner
                            && picking
                        {
                            place_pick_banner(banner, at);
                        }
                    }
                    Ok(Cmd::Title(text)) => {
                        if let Ok(mut lines) = BANNER.lock() {
                            lines.0 = text;
                        }
                        if let Some(banner) = banner {
                            let _ = InvalidateRect(Some(banner), None, true);
                        }
                    }
                    Ok(Cmd::Close) | Err(mpsc::TryRecvError::Disconnected) => break 'running,
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
        }
        if timer != 0 {
            let _ = KillTimer(None, timer);
        }
        // Only the picker owns the hooks: a highlight that ends while a
        // picker runs must not stop it from taking the click.
        match mode {
            Mode::Pick => CAPTURING.store(false, Ordering::SeqCst),
            Mode::Record => RECORDING.store(false, Ordering::SeqCst),
            Mode::Flash => {}
        }
        for hook in hooks {
            let _ = UnhookWindowsHookEx(hook);
        }
        for hwnd in edges
            .into_iter()
            .chain(window_edges)
            .chain(tags)
            .chain(banner)
        {
            let _ = DestroyWindow(hwnd);
        }
    }
}

/// The screen (whole, and without the taskbar) of the monitor at `at`.
fn monitor_at(monitor: windows::Win32::Graphics::Gdi::HMONITOR) -> Option<(RECT, RECT)> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..MONITORINFO::default()
    };
    // SAFETY: plain Win32 call with a local struct.
    unsafe { GetMonitorInfoW(monitor, &mut info) }
        .as_bool()
        .then_some((info.rcMonitor, info.rcWork))
}

fn rect_tuple(rect: RECT) -> hover::Rect {
    (rect.left, rect.top, rect.right, rect.bottom)
}

/// Puts the picker's small banner at the bottom of the screen the mouse is
/// on, or at the top while the mouse is near that spot.
fn place_pick_banner(banner: HWND, mouse: POINT) {
    // SAFETY: moving a window this thread owns.
    unsafe {
        let Some((_, work)) = monitor_at(MonitorFromPoint(mouse, MONITOR_DEFAULTTONEAREST)) else {
            return;
        };
        let scale = GetDpiForWindow(banner).max(96) as i32;
        let size = (
            PICK_BANNER_SIZE.0 * scale / 96,
            PICK_BANNER_SIZE.1 * scale / 96,
        );
        let (x, y) =
            hover::pick_banner_at(rect_tuple(work), size, (mouse.x, mouse.y), 16 * scale / 96);
        let mut now = RECT::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(banner, &mut now);
        if (now.left, now.top, now.right - now.left) == (x, y, size.0) {
            return;
        }
        let _ = SetWindowPos(
            banner,
            Some(HWND_TOPMOST),
            x,
            y,
            size.0,
            size.1,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        if let Ok(mut at) = BANNER_AT.lock() {
            *at = (x, y, x + size.0, y + size.1);
        }
    }
}

/// The tags' font at `scale` (DPI).
fn tag_font(scale: i32) -> HFONT {
    // SAFETY: plain GDI call; the caller deletes the font.
    unsafe {
        CreateFontW(
            -TAG_FONT * scale / 96,
            0,
            0,
            0,
            FW_SEMIBOLD.0 as i32,
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
    }
}

/// Shows tag `which` (window or part) with its text beside `anchor`, or
/// hides it.
fn place_tag(hwnd: HWND, which: usize, tag: Option<(RECT, String)>) {
    // SAFETY: Win32 calls on a window this thread owns.
    unsafe {
        let Some((anchor, text)) = tag.filter(|(_, text)| !text.trim().is_empty()) else {
            let _ = ShowWindow(hwnd, SW_HIDE);
            return;
        };
        if let Ok(mut texts) = TAGS.lock() {
            texts[which].clone_from(&text);
        }
        let scale = GetDpiForWindow(hwnd).max(96) as i32;
        // The text's width in the tag's font.
        let mut extent = SIZE::default();
        let dc = GetDC(Some(hwnd));
        if !dc.is_invalid() {
            let font = tag_font(scale);
            let old = SelectObject(dc, HGDIOBJ(font.0));
            let buffer = wide(&text);
            if !buffer.is_empty() {
                let _ = GetTextExtentPoint32W(dc, &buffer, &mut extent);
            }
            SelectObject(dc, old);
            let _ = DeleteObject(HGDIOBJ(font.0));
            ReleaseDC(Some(hwnd), dc);
        }
        let width = (extent.cx + 2 * TAG_PADDING * scale / 96).min(TAG_MAX_WIDTH * scale / 96);
        let size = (width.max(1), TAG_HEIGHT * scale / 96);
        let Some((screen, work)) = monitor_at(MonitorFromRect(&anchor, MONITOR_DEFAULTTONEAREST))
        else {
            let _ = ShowWindow(hwnd, SW_HIDE);
            return;
        };
        let (x, y) = if which == WINDOW_TAG {
            hover::window_tag_at(
                rect_tuple(anchor),
                size,
                rect_tuple(screen),
                WINDOW_THICKNESS,
            )
        } else {
            hover::part_tag_at(rect_tuple(anchor), size, rect_tuple(work), 4 * scale / 96)
        };
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            x,
            y,
            size.0,
            size.1,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        let _ = InvalidateRect(Some(hwnd), None, true);
    }
}

/// The four sides of a frame around `rect` (see [`hover::frame_sides`]).
fn frame_sides(rect: RECT, thickness: i32, inside: bool) -> [(i32, i32, i32, i32); 4] {
    hover::frame_sides(
        (rect.left, rect.top, rect.right, rect.bottom),
        thickness,
        inside,
    )
}

/// Puts the four edge windows at `sides` (x, y, width, height).
fn place_edges(edges: &[HWND], sides: [(i32, i32, i32, i32); 4]) {
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

/// `DrawTextW` of `text`, made safe for what it does with the buffer.
///
/// An empty line (the banner's second line before the mouse is over
/// anything) is not drawn at all: an empty `Vec` points at no memory (a
/// dangling address), and DrawTextW with `DT_END_ELLIPSIS` read from it and
/// crashed Studio inside USER32 (0xc0000005, then 0xc000041d: the banner's
/// first paint, as soon as the picker started). Other text is copied into a
/// buffer with spare room and a NUL after it, so a read just past the end
/// stays inside the buffer.
///
/// SAFETY: `hdc` is a device context being painted.
pub(crate) unsafe fn draw_text(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    text: &[u16],
    rect: &mut RECT,
    flags: windows::Win32::Graphics::Gdi::DRAW_TEXT_FORMAT,
) {
    if text.is_empty() {
        return;
    }
    let mut buffer = Vec::with_capacity(text.len() + 8);
    buffer.extend_from_slice(text);
    buffer.resize(text.len() + 8, 0);
    // SAFETY: the caller's; the slice is valid for its length and more.
    unsafe {
        DrawTextW(hdc, &mut buffer[..text.len()], rect, flags);
    }
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

unsafe extern "system" fn window_tag_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: the arguments Windows gave this window procedure.
    guarded(
        "tag",
        || unsafe { paint_tag(hwnd, WINDOW_TAG, msg, wparam, lparam) },
        || unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    )
}

unsafe extern "system" fn part_tag_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: the arguments Windows gave this window procedure.
    guarded(
        "tag",
        || unsafe { paint_tag(hwnd, PART_TAG, msg, wparam, lparam) },
        || unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    )
}

unsafe fn paint_tag(hwnd: HWND, which: usize, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg != WM_PAINT {
        // SAFETY: the default handling of our own window's messages.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    // SAFETY: painting our own window inside WM_PAINT.
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        let scale = GetDpiForWindow(hwnd).max(96) as i32;
        let text = TAGS.lock().map(|t| t[which].clone()).unwrap_or_default();
        let mut client = RECT::default();
        let _ = GetClientRect(hwnd, &mut client);
        let _ = SetBkMode(hdc, TRANSPARENT);
        let font = tag_font(scale);
        let old = SelectObject(hdc, HGDIOBJ(font.0));
        let _ = SetTextColor(hdc, TAG_TEXT);
        let pad = TAG_PADDING * scale / 96;
        let mut line = RECT {
            left: client.left + pad,
            top: client.top,
            right: client.right - pad / 2,
            bottom: client.bottom,
        };
        let flags = DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX;
        draw_text(hdc, &wide(&text), &mut line, flags);
        SelectObject(hdc, old);
        let _ = DeleteObject(HGDIOBJ(font.0));
        let _ = EndPaint(hwnd, &ps);
    }
    LRESULT(0)
}

unsafe extern "system" fn banner_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: the arguments Windows gave this window procedure.
    guarded(
        "banner",
        || unsafe { paint_banner(hwnd, msg, wparam, lparam) },
        || unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    )
}

/// Runs a callback Windows calls (hook, window procedure). A panic must not
/// leave it: unwinding out of an `extern "system"` function aborts the whole
/// app (Studio closes with no message). It is written to the log, and
/// `fallback` answers Windows instead (the event passes on untouched).
fn guarded(
    what: &str,
    body: impl FnOnce() -> LRESULT,
    fallback: impl FnOnce() -> LRESULT,
) -> LRESULT {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|s| (*s).to_owned())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            tracing::error!(%message, "the picker's {what} panicked; the event was passed on");
            fallback()
        }
    }
}

unsafe fn paint_banner(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
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
        // One line (the picker's banner): in the middle of it.
        let single = second.is_empty();
        let half = if single {
            client.bottom - client.top
        } else {
            half
        };
        for (text, size, weight, color, top) in [
            (
                first,
                if single { 13 } else { 15 },
                FW_SEMIBOLD.0,
                BANNER_TEXT,
                client.top + if single { 0 } else { 4 },
            ),
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
            draw_text(hdc, &wide(&text), &mut line, flags);
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

/// Whether the recorder still answers (else the hooks let input through).
fn recorder_alive() -> bool {
    // SAFETY: plain Win32 call.
    let now = unsafe { GetTickCount64() };
    now.saturating_sub(BEAT.load(Ordering::SeqCst)) < BEAT_LOST_MS
}

fn push_raw(raw: Raw) {
    if let Ok(mut queue) = RAW.lock() {
        queue.push_back(raw);
    }
}

fn on_banner(pt: POINT) -> bool {
    BANNER_AT.lock().is_ok_and(|at| {
        let (l, t, r, b) = *at;
        pt.x >= l && pt.x < r && pt.y >= t && pt.y < b
    })
}

/// Recording: holds back clicks (the recorder sends them on), stops on a
/// click on the banner. `None` passes the event on.
fn record_mouse(msg: u32, info: &MSLLHOOKSTRUCT) -> Option<LRESULT> {
    if info.flags & LLMHF_INJECTED != 0 || !recorder_alive() {
        return None;
    }
    let button = match msg {
        WM_LBUTTONDOWN | WM_LBUTTONUP => MouseButton::Left,
        WM_RBUTTONDOWN | WM_RBUTTONUP => MouseButton::Right,
        _ => return None,
    };
    match msg {
        WM_LBUTTONDOWN | WM_RBUTTONDOWN => {
            if on_banner(info.pt) {
                push_raw(Raw::Stop);
                SWALLOW_UP.store(true, Ordering::SeqCst);
            } else {
                push_raw(Raw::Down {
                    button,
                    at: info.pt,
                    time: info.time,
                });
            }
        }
        _ => {
            if !SWALLOW_UP.swap(false, Ordering::SeqCst) {
                push_raw(Raw::Up {
                    button,
                    at: info.pt,
                });
            }
        }
    }
    Some(LRESULT(1))
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: the arguments Windows gave this hook.
    guarded(
        "mouse hook",
        || unsafe { on_mouse(code, wparam, lparam) },
        || unsafe { CallNextHookEx(None, code, wparam, lparam) },
    )
}

unsafe fn on_mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && RECORDING.load(Ordering::SeqCst) {
        // SAFETY: for mouse messages lparam points at an MSLLHOOKSTRUCT.
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        if let Some(result) = record_mouse(wparam.0 as u32, info) {
            return result;
        }
    } else if code >= 0 && CAPTURING.load(Ordering::SeqCst) {
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

fn down(vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY) -> bool {
    // SAFETY: plain Win32 call.
    unsafe { GetAsyncKeyState(i32::from(vk.0)) < 0 }
}

/// The modifier keys held now.
pub fn held_now() -> Held {
    Held {
        ctrl: down(VK_CONTROL),
        alt: down(VK_MENU),
        shift: down(VK_SHIFT),
        win: down(VK_LWIN) || down(VK_RWIN),
    }
}

/// Recording: holds back command keys (the recorder sends them on) and
/// notes typing. `None` passes the event on.
fn record_key(msg: u32, info: &KBDLLHOOKSTRUCT) -> Option<LRESULT> {
    if info.flags.0 & LLKHF_INJECTED.0 != 0 || !recorder_alive() {
        return None;
    }
    let vk = info.vkCode;
    let Ok(code) = u16::try_from(vk) else {
        return None;
    };
    let extended = info.flags.0 & LLKHF_EXTENDED.0 != 0;
    // Something held back is not sent on yet: this key waits behind it.
    let in_line = |up: bool| {
        let waiting =
            PROCESSING.load(Ordering::SeqCst) || RAW.lock().is_ok_and(|queue| !queue.is_empty());
        if !waiting {
            return None;
        }
        push_raw(Raw::Pass {
            vk: code,
            scan: u16::try_from(info.scanCode).unwrap_or(0),
            extended,
            up,
        });
        Some(LRESULT(1))
    };
    match msg {
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            let held = held_now();
            if keys::is_command(code, held) {
                push_raw(Raw::Key {
                    vk: code,
                    extended,
                    held,
                });
                if let Ok(mut back) = HELD_BACK.lock()
                    && !back.contains(&vk)
                {
                    back.push(vk);
                }
                return Some(LRESULT(1));
            }
            if let Some(held) = in_line(false) {
                return Some(held);
            }
            if !keys::is_modifier(code) {
                TYPED.store(true, Ordering::SeqCst);
            }
            None
        }
        WM_KEYUP | WM_SYSKEYUP => {
            if let Ok(mut back) = HELD_BACK.lock()
                && let Some(i) = back.iter().position(|v| *v == vk)
            {
                back.remove(i);
                return Some(LRESULT(1));
            }
            in_line(true)
        }
        _ => None,
    }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: the arguments Windows gave this hook.
    guarded(
        "keyboard hook",
        || unsafe { on_key(code, wparam, lparam) },
        || unsafe { CallNextHookEx(None, code, wparam, lparam) },
    )
}

unsafe fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && RECORDING.load(Ordering::SeqCst) {
        // SAFETY: for keyboard messages lparam points at a KBDLLHOOKSTRUCT.
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if let Some(result) = record_key(wparam.0 as u32, info) {
            return result;
        }
        // SAFETY: passing the event on, as every hook must.
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Gdi::{CreateCompatibleDC, DeleteDC};

    /// The banner's lines, empty or not, draw without touching memory they
    /// do not own (the picker crashed Studio on its first paint).
    #[test]
    fn banner_lines_draw_empty_and_long() {
        // SAFETY: a memory DC made and released here.
        unsafe {
            let dc = CreateCompatibleDC(None);
            let flags = DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX;
            let long = "［請求書 - Excel］ button「保存」".repeat(40);
            for text in ["", "a", long.as_str()] {
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: 120,
                    bottom: 20,
                };
                draw_text(dc, &wide(text), &mut rect, flags);
            }
            let _ = DeleteDC(dc);
        }
    }
}
