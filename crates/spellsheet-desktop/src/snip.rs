//! 「画面から切り取る」: the screen as it was a moment ago, dimmed, over every
//! monitor; the user drags a rectangle and the part inside comes back
//! bright as they drag. Esc or a right click cancels.
//!
//! The picture is taken before the window opens, so what is cut out is
//! exactly what the app showed (menus and hover states stay as they were).
//! The window runs on a thread of its own with a message loop; the caller
//! waits for the rectangle.

#![allow(unsafe_code)]

use std::cell::RefCell;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use spellsheet_runtime::StepError;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BeginPaint, BitBlt, CLEARTYPE_QUALITY,
    CLIP_DEFAULT_PRECIS, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW,
    CreateSolidBrush, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CENTER, DT_END_ELLIPSIS, DT_NOPREFIX,
    DT_SINGLELINE, DT_VCENTER, DeleteDC, DeleteObject, EndPaint, FF_DONTCARE, FW_SEMIBOLD,
    FillRect, HBITMAP, HDC, HGDIOBJ, InvalidateRect, OUT_DEFAULT_PRECIS, PAINTSTRUCT, SRCCOPY,
    SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, ReleaseCapture, SetCapture, SetFocus, VK_ESCAPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetSystemMetrics, IDC_CROSS,
    LoadCursorW, MSG, PM_REMOVE, PeekMessageW, RegisterClassW, SM_CXSCREEN, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_SHOW, SetForegroundWindow,
    ShowWindow, TranslateMessage, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONUP, WNDCLASSW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};
use windows::core::w;

use crate::bitmap::{Bitmap, Rect};

/// How much of its brightness the screen keeps behind the cutter.
const DIM: u8 = 110;
/// The frame around the rectangle: the logo's blue (BGR).
const FRAME: COLORREF = COLORREF(0x00EB_6325);
/// The banner's background (slate 800) and text (white), BGR.
const BANNER_BG: COLORREF = COLORREF(0x003B_291E);
const BANNER_TEXT: COLORREF = COLORREF(0x00FF_FFFF);
/// Smaller than this is taken for a click, not a drag.
const MIN_SIDE: u32 = 4;

/// Every monitor together, in screen pixels.
pub fn virtual_screen() -> RECT {
    // SAFETY: plain Win32 calls.
    unsafe {
        let (left, top) = (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
        );
        RECT {
            left,
            top,
            right: left + GetSystemMetrics(SM_CXVIRTUALSCREEN),
            bottom: top + GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// Shows `shot` (taken of `screen`) dimmed with `message` on top and waits
/// for the user to drag a rectangle on it: the rectangle in `shot`'s
/// pixels, or `None` when they cancel or `timeout` passes.
pub fn snip(
    shot: Bitmap,
    screen: RECT,
    message: String,
    timeout: Duration,
) -> Result<Option<Rect>, StepError> {
    let (tx, rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("spellsheet-snip".into())
        .spawn(move || {
            let _ = tx.send(run(shot, screen, &message, timeout));
        })
        .map_err(|e| StepError::new("ADAPTER_CRASHED", format!("cannot start the cutter: {e}")))?;
    let result = rx
        .recv()
        .unwrap_or_else(|_| Err("the cutter stopped".to_owned()));
    let _ = thread.join();
    result.map_err(|message| StepError::new("UIA_ERROR", message))
}

/// What the window procedure works with (on the cutter's thread only).
struct State {
    bright: Layer,
    dim: Layer,
    message: Vec<u16>,
    from: Option<(i32, i32)>,
    to: (i32, i32),
    done: Option<Option<Rect>>,
}

impl State {
    fn rect(&self) -> Option<Rect> {
        self.from.map(|from| Rect::spanning(from, self.to))
    }
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// A picture in a memory DC, ready to be copied onto the window.
struct Layer {
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
}

impl Layer {
    /// SAFETY: GDI calls; the objects are released on drop.
    unsafe fn new(image: &Bitmap) -> Option<Self> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: image.width as i32,
                // Negative: rows from the top.
                biHeight: -(image.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let bgra = image.to_bgra();
        // SAFETY: the DIB section holds width × height 32-bit pixels, as
        // many bytes as `bgra`.
        unsafe {
            let dc = CreateCompatibleDC(None);
            let mut bits = std::ptr::null_mut();
            let Ok(bitmap) = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            else {
                let _ = DeleteDC(dc);
                return None;
            };
            if bits.is_null() {
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(dc);
                return None;
            }
            std::ptr::copy_nonoverlapping(bgra.as_ptr(), bits.cast::<u8>(), bgra.len());
            let old = SelectObject(dc, bitmap.into());
            Some(Self { dc, bitmap, old })
        }
    }
}

impl Drop for Layer {
    fn drop(&mut self) {
        // SAFETY: releasing the objects `new` made, in order.
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

fn run(
    shot: Bitmap,
    screen: RECT,
    message: &str,
    timeout: Duration,
) -> Result<Option<Rect>, String> {
    // SAFETY: Win32 calls on this thread, for the window it owns.
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let instance: HINSTANCE = GetModuleHandleW(None)
            .map_err(|e| format!("cutter: {e}"))?
            .into();
        let (Some(bright), Some(dim)) = (Layer::new(&shot), Layer::new(&shot.dimmed(DIM))) else {
            return Err("cannot draw the screen for the cutter".into());
        };
        drop(shot);
        STATE.with(|s| {
            *s.borrow_mut() = Some(State {
                bright,
                dim,
                message: message.encode_utf16().collect(),
                from: None,
                to: (0, 0),
                done: None,
            });
        });
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc_),
            hInstance: instance,
            lpszClassName: w!("SpellSheetSnip"),
            hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
            ..WNDCLASSW::default()
        };
        // A second registration fails harmlessly: the class is the same.
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class.lpszClassName,
            w!("SpellSheet"),
            WS_POPUP,
            screen.left,
            screen.top,
            screen.right - screen.left,
            screen.bottom - screen.top,
            None,
            None,
            Some(instance),
            None,
        )
        .map_err(|e| format!("cannot open the cutter: {e}"))?;
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));

        let deadline = Instant::now() + timeout;
        let result = loop {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if let Some(done) = STATE.with(|s| s.borrow().as_ref().and_then(|s| s.done)) {
                break done;
            }
            // Esc even when another window kept the keyboard.
            if GetAsyncKeyState(i32::from(VK_ESCAPE.0)) as u16 & 0x8000 != 0
                || Instant::now() >= deadline
            {
                break None;
            }
            std::thread::sleep(Duration::from_millis(8));
        };
        let _ = ReleaseCapture();
        let _ = DestroyWindow(hwnd);
        STATE.with(|s| s.borrow_mut().take());
        Ok(result)
    }
}

/// The client point in `lparam` (signed: monitors left of the main one).
fn point(lparam: LPARAM) -> (i32, i32) {
    let x = (lparam.0 & 0xFFFF) as u16 as i16;
    let y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16;
    (i32::from(x), i32::from(y))
}

unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let finish = |done: Option<Rect>| {
        STATE.with(|s| {
            if let Some(s) = s.borrow_mut().as_mut() {
                s.done.get_or_insert(done);
            }
        });
    };
    // SAFETY: handling our own window's messages on its thread.
    unsafe {
        match msg {
            WM_ERASEBKGND => return LRESULT(1),
            WM_PAINT => {
                paint(hwnd);
                return LRESULT(0);
            }
            WM_LBUTTONDOWN => {
                let at = point(lparam);
                STATE.with(|s| {
                    if let Some(s) = s.borrow_mut().as_mut() {
                        s.from = Some(at);
                        s.to = at;
                    }
                });
                SetCapture(hwnd);
                let _ = InvalidateRect(Some(hwnd), None, false);
                return LRESULT(0);
            }
            WM_MOUSEMOVE => {
                let at = point(lparam);
                let dragging = STATE.with(|s| {
                    s.borrow_mut().as_mut().is_some_and(|s| {
                        s.to = at;
                        s.from.is_some()
                    })
                });
                if dragging {
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
                return LRESULT(0);
            }
            WM_LBUTTONUP => {
                let _ = ReleaseCapture();
                let at = point(lparam);
                let rect = STATE.with(|s| {
                    s.borrow_mut().as_mut().and_then(|s| {
                        s.to = at;
                        let rect = s.rect();
                        // A click: start again.
                        if rect.is_some_and(|r| r.width < MIN_SIDE || r.height < MIN_SIDE) {
                            s.from = None;
                            return None;
                        }
                        rect
                    })
                });
                match rect {
                    Some(rect) => finish(Some(rect)),
                    None => {
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                return LRESULT(0);
            }
            WM_RBUTTONUP => {
                finish(None);
                return LRESULT(0);
            }
            WM_KEYDOWN if wparam.0 == usize::from(VK_ESCAPE.0) => {
                finish(None);
                return LRESULT(0);
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

/// The dimmed screen, the rectangle bright with a frame, and the banner,
/// drawn off screen first so dragging does not flicker.
///
/// SAFETY: called inside WM_PAINT of our own window.
unsafe fn paint(hwnd: HWND) {
    // SAFETY: painting our own window; every GDI object is released.
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        STATE.with(|s| {
            let state = s.borrow();
            let Some(state) = state.as_ref() else {
                return;
            };
            let area = ps.rcPaint;
            let (w, h) = (area.right - area.left, area.bottom - area.top);
            if w <= 0 || h <= 0 {
                return;
            }
            let back = CreateCompatibleDC(Some(hdc));
            let canvas = CreateCompatibleBitmap(hdc, w, h);
            let old = SelectObject(back, canvas.into());
            // Everything in `back` is drawn shifted by the area's corner.
            let _ = BitBlt(
                back,
                0,
                0,
                w,
                h,
                Some(state.dim.dc),
                area.left,
                area.top,
                SRCCOPY,
            );
            let frame = CreateSolidBrush(FRAME);
            if let Some(r) = state.rect() {
                let (x, y) = (r.x - area.left, r.y - area.top);
                let (rw, rh) = (r.width as i32, r.height as i32);
                let _ = BitBlt(back, x, y, rw, rh, Some(state.bright.dc), r.x, r.y, SRCCOPY);
                let t = (2 * GetDpiForWindow(hwnd).max(96) / 96) as i32;
                for edge in [
                    RECT {
                        left: x - t,
                        top: y - t,
                        right: x + rw + t,
                        bottom: y,
                    },
                    RECT {
                        left: x - t,
                        top: y + rh,
                        right: x + rw + t,
                        bottom: y + rh + t,
                    },
                    RECT {
                        left: x - t,
                        top: y,
                        right: x,
                        bottom: y + rh,
                    },
                    RECT {
                        left: x + rw,
                        top: y,
                        right: x + rw + t,
                        bottom: y + rh,
                    },
                ] {
                    FillRect(back, &edge, frame);
                }
            }
            banner(hwnd, back, area, &state.message);
            let _ = BitBlt(hdc, area.left, area.top, w, h, Some(back), 0, 0, SRCCOPY);
            let _ = DeleteObject(frame.into());
            SelectObject(back, old);
            let _ = DeleteObject(canvas.into());
            let _ = DeleteDC(back);
        });
        let _ = EndPaint(hwnd, &ps);
    }
}

/// The message at the top of the main monitor (where the virtual screen's
/// origin is not necessarily the window's).
///
/// SAFETY: `dc` is the back buffer of `paint`, offset by `area`.
unsafe fn banner(hwnd: HWND, dc: HDC, area: RECT, message: &[u16]) {
    // SAFETY: GDI calls on the back buffer; the font and brush are released.
    unsafe {
        let scale = GetDpiForWindow(hwnd).max(96) as i32;
        let (width, height) = (560 * scale / 96, 44 * scale / 96);
        // The main monitor starts at screen (0, 0); the window at the
        // virtual screen's corner.
        let origin = virtual_screen();
        let main_width = GetSystemMetrics(SM_CXSCREEN);
        let left = -origin.left + (main_width - width) / 2 - area.left;
        let top = -origin.top + 16 * scale / 96 - area.top;
        let mut rect = RECT {
            left,
            top,
            right: left + width,
            bottom: top + height,
        };
        let bg = CreateSolidBrush(BANNER_BG);
        FillRect(dc, &rect, bg);
        let _ = DeleteObject(bg.into());
        let font = CreateFontW(
            -15 * scale / 96,
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
        );
        let old = SelectObject(dc, HGDIOBJ(font.0));
        let _ = SetBkMode(dc, TRANSPARENT);
        let _ = SetTextColor(dc, BANNER_TEXT);
        rect.left += 12;
        rect.right -= 12;
        crate::overlay::draw_text(
            dc,
            message,
            &mut rect,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX,
        );
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(font.0));
    }
}
