//! A `.spx` file opened from Explorer (double-click, 「プログラムから開く」):
//! Writer shows what it holds before importing it.
//!
//! The path waits here until the page asks for it (`take_opened_file`), so
//! it is not lost while the page is still loading; when Writer is already
//! running, the event tells the open page to ask now.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

/// Event sent to the page when a file was opened while Writer runs.
pub(crate) const EVENT: &str = "opened-file";

static PENDING: Mutex<Option<String>> = Mutex::new(None);

/// The `.spx` file among the start arguments, if any.
pub(crate) fn spx_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| {
        std::path::Path::new(a)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case(spellsheet_core::package::PACKAGE_EXTENSION))
    })
}

/// Keeps `path` for the page and tells it, if it is already open.
pub(crate) fn remember(app: Option<&AppHandle>, path: String) {
    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some(path);
    }
    if let Some(app) = app {
        // The page may not be there yet; it asks on load either way.
        let _ = app.emit(EVENT, ());
    }
}

/// The opened file waiting to be shown, once.
#[tauri::command]
pub fn take_opened_file() -> Option<String> {
    PENDING.lock().ok().and_then(|mut p| p.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_package_among_the_arguments() {
        let args = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            spx_arg(args(&["Writer.exe", r"C:\Users\a\Downloads\請求書 v3.SPX"])),
            Some(r"C:\Users\a\Downloads\請求書 v3.SPX".to_owned())
        );
        assert_eq!(spx_arg(args(&["Writer.exe", "--runner"])), None);
        // The program itself is never taken for the file.
        assert_eq!(spx_arg(args(&["x.spx"])), None);
    }
}
