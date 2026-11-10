//! The console window of a program started by Windows itself.
//!
//! `spellsheet.exe` is a console program, so when Task Scheduler or the Run
//! key starts `worker run` at sign-in, Windows opens a console window just
//! for it: it would stay on the desktop, and closing it would stop the
//! worker. A console the program shares (a terminal it was typed in) is left
//! alone.
#![allow(unsafe_code)]

/// Leaves the console when this process is the only one attached to it
/// (Windows made it for this process), which closes its window. Output
/// written afterwards is dropped. Whether it left.
#[cfg(windows)]
pub fn leave_own_console() -> bool {
    use windows::Win32::System::Console::{FreeConsole, GetConsoleProcessList};
    let mut ids = [0u32; 2];
    // SAFETY: the buffer is valid for the call.
    let attached = unsafe { GetConsoleProcessList(&mut ids) };
    // SAFETY: no handle of the console is kept across the call.
    attached == 1 && unsafe { FreeConsole() }.is_ok()
}

/// Elsewhere a program has no console of its own to leave.
#[cfg(not(windows))]
pub fn leave_own_console() -> bool {
    false
}
