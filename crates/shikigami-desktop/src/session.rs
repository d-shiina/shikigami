//! Whether this Windows session's desktop can take mouse and keyboard input
//! now. While the screen is locked (or the sign-in screen, a UAC prompt or a
//! disconnected remote session holds the input), the input desktop is not
//! the user's "Default" desktop and cannot be opened by the user's
//! processes. Steps that need the mouse and keyboard then stop with
//! `DESKTOP_UNAVAILABLE` instead of failing halfway with
//! `FOREGROUND_DENIED` or `INPUT_BLOCKED`.
//!
//! Besides `uia` and `capture`, the only module that may use `unsafe`.

#![allow(unsafe_code)]

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP, GetUserObjectInformationW,
    OpenInputDesktop, UOI_NAME,
};

/// `None` when the desktop takes input, else why not.
pub fn desktop_unavailable() -> Option<String> {
    // SAFETY: plain Win32 calls; the handle is closed before returning and
    // the buffer outlives the call that fills it.
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP)
        else {
            return Some(
                "the screen is locked, or the remote session is disconnected or minimized".into(),
            );
        };
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        let read = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            u32::try_from(std::mem::size_of_val(&name)).unwrap_or(0),
            Some(&mut needed),
        );
        let _ = CloseDesktop(desktop);
        if read.is_err() {
            return None; // could not tell: let the step try
        }
        let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        let name = String::from_utf16_lossy(&name[..len]);
        if name.eq_ignore_ascii_case("Default") {
            None
        } else {
            Some(format!(
                "another desktop has the input ({name}: the lock screen, sign-in or an elevation prompt)"
            ))
        }
    }
}

/// Asks Windows to keep the display on and the PC awake (so the screen
/// does not turn off and the PC does not sleep for being idle) until the
/// returned value is dropped. Held for the whole of a run that has nodes
/// using the mouse and keyboard. It does not stop locking: a
/// password-protected screen saver, an inactivity limit set by policy and
/// Win+L still lock the screen (they are security settings, left alone).
pub fn keep_awake() -> Box<dyn Send + Sync> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
        PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
    use windows::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };
    use windows::core::PWSTR;

    /// The power request, as a plain number so the guard can move between
    /// threads (the handle is not tied to the thread that made it).
    struct Awake(isize);
    impl Drop for Awake {
        fn drop(&mut self) {
            let handle = HANDLE(self.0 as *mut _);
            // SAFETY: the handle came from PowerCreateRequest and is closed
            // only here.
            unsafe {
                let _ = PowerClearRequest(handle, PowerRequestDisplayRequired);
                let _ = PowerClearRequest(handle, PowerRequestSystemRequired);
                let _ = CloseHandle(handle);
            }
        }
    }

    // Shown by `powercfg /requests`.
    let mut reason: Vec<u16> = "Shikigami: running a flow that uses the screen"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let context = REASON_CONTEXT {
        Version: POWER_REQUEST_CONTEXT_VERSION,
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        Reason: REASON_CONTEXT_0 {
            SimpleReasonString: PWSTR(reason.as_mut_ptr()),
        },
    };
    // SAFETY: `context` and the string it points to outlive the call, which
    // copies the string.
    unsafe {
        let Ok(handle) = PowerCreateRequest(&raw const context) else {
            return Box::new(());
        };
        let _ = PowerSetRequest(handle, PowerRequestDisplayRequired);
        let _ = PowerSetRequest(handle, PowerRequestSystemRequired);
        Box::new(Awake(handle.0 as isize))
    }
}
