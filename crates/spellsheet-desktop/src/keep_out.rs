//! Writer's run band: the strip that shows a run while Writer is minimised.
//!
//! The band sits on the screen the flow works on, so it must never get in a
//! flow's way:
//! - [`shield`] keeps it out of screen captures (image search, OCR, the
//!   手順書's pictures) and stops it taking the focus when it is clicked, so
//!   typing still goes to the app the flow works in;
//! - [`clear`] is called before every real mouse action: when the point is
//!   on (or next to) the band, the band moves to the other edge of its
//!   screen first (bottom ↔ top), so the click lands on the app.
//!
//! Only one band at a time: [`set`] names it, `set(None)` forgets it.

#![allow(unsafe_code)]

use std::sync::Mutex;

/// The band's window handle (an `HWND` as an integer), when it is up.
static BAND: Mutex<Option<isize>> = Mutex::new(None);

/// Room kept between a mouse point and the band: a click a few pixels off
/// its edge still counts as on it (the cursor, a drag's path).
pub const MARGIN: i32 = 12;
/// Gap between the band and the edge of the work area it sits on.
pub const EDGE_GAP: i32 = 12;

/// Names the band (`None` when it is gone).
pub fn set(hwnd: Option<isize>) {
    if let Ok(mut band) = BAND.lock() {
        *band = hwnd;
    }
}

fn band() -> Option<isize> {
    BAND.lock().ok().and_then(|b| *b)
}

/// A rectangle in screen pixels: `left`/`top` in, `right`/`bottom` out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    fn contains(&self, x: i32, y: i32, margin: i32) -> bool {
        x >= self.left - margin
            && x < self.right + margin
            && y >= self.top - margin
            && y < self.bottom + margin
    }
}

/// Where the band goes so that `(x, y)` is clear of it: the same left, the
/// other edge of the work area (top when it sat in the lower half, bottom
/// otherwise). `None` when the point is not on it.
pub fn dodge(band: Rect, work: Rect, x: i32, y: i32) -> Option<i32> {
    if !band.contains(x, y, MARGIN) {
        return None;
    }
    let height = band.bottom - band.top;
    let middle = (work.top + work.bottom) / 2;
    let top = if (band.top + band.bottom) / 2 >= middle {
        work.top + EDGE_GAP
    } else {
        work.bottom - EDGE_GAP - height
    };
    Some(top)
}

/// Moves the band out of the way of a mouse action at `(x, y)` (screen
/// pixels). Does nothing when there is no band or it is not in the way.
pub fn clear(x: i32, y: i32) {
    if let Some(hwnd) = band() {
        imp::clear(hwnd, x, y);
    }
}

/// Keeps `hwnd` out of screen captures and stops it taking the focus.
pub fn shield(hwnd: isize) {
    imp::shield(hwnd);
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SWP_NOACTIVATE, SWP_NOSIZE,
        SWP_NOZORDER, SetWindowDisplayAffinity, SetWindowLongPtrW, SetWindowPos,
        WDA_EXCLUDEFROMCAPTURE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    use super::Rect;

    fn rect(r: RECT) -> Rect {
        Rect {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        }
    }

    pub(super) fn clear(hwnd: isize, x: i32, y: i32) {
        let hwnd = HWND(hwnd as *mut _);
        // SAFETY: plain Win32 calls on a window handle; a stale handle only
        // makes them fail.
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return;
            }
            let mut band = RECT::default();
            if GetWindowRect(hwnd, &mut band).is_err() {
                return;
            }
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return;
            }
            let Some(top) = super::dodge(rect(band), rect(info.rcWork), x, y) else {
                return;
            };
            let _ = SetWindowPos(
                hwnd,
                None,
                band.left,
                top,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        // Let the window underneath repaint before the click lands on it.
        std::thread::sleep(std::time::Duration::from_millis(60));
    }

    pub(super) fn shield(hwnd: isize) {
        let hwnd = HWND(hwnd as *mut _);
        // SAFETY: plain Win32 calls on a window handle.
        unsafe {
            // Windows 10 2004 and later; on older ones the band shows in
            // pictures, which is no worse than Writer being on the screen.
            if let Err(e) = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
                tracing::warn!(error = %e, "cannot keep the run band out of screen captures");
            }
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                style | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize,
            );
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub(super) fn clear(_hwnd: isize, _x: i32, _y: i32) {}
    pub(super) fn shield(_hwnd: isize) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1040,
    };

    fn at_bottom() -> Rect {
        Rect {
            left: 570,
            top: 1040 - EDGE_GAP - 44,
            right: 570 + 780,
            bottom: 1040 - EDGE_GAP,
        }
    }

    #[test]
    fn a_click_away_from_the_band_leaves_it() {
        assert_eq!(dodge(at_bottom(), WORK, 960, 500), None);
        assert_eq!(dodge(at_bottom(), WORK, 100, 1000), None);
    }

    #[test]
    fn a_click_on_the_band_sends_it_to_the_top() {
        assert_eq!(dodge(at_bottom(), WORK, 960, 1000), Some(EDGE_GAP));
    }

    #[test]
    fn a_click_just_off_its_edge_counts_as_on_it() {
        let band = at_bottom();
        assert!(dodge(band, WORK, 960, band.top - MARGIN + 1).is_some());
        assert!(dodge(band, WORK, 960, band.top - MARGIN - 1).is_none());
    }

    #[test]
    fn a_band_at_the_top_goes_back_down() {
        let band = Rect {
            top: EDGE_GAP,
            bottom: EDGE_GAP + 44,
            ..at_bottom()
        };
        assert_eq!(dodge(band, WORK, 960, 30), Some(1040 - EDGE_GAP - 44));
    }
}
