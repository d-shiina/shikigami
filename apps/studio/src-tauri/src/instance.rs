//! One Studio per Windows sign-in. Starting Studio again (the Start menu,
//! a `--runner` shortcut) brings the running one to the front instead of
//! opening a second copy: two copies on the same workspace would each
//! answer the AI's requests (a sign-in, an approval, 「画面から選ぶ」), show
//! two tray icons, and overwrite each other's edits of the same flow.
//!
//! Only installed (release) builds: `pnpm studio:dev` runs beside an
//! installed Studio, and several dev builds may run at once.

use tauri::AppHandle;

use crate::runner::show_runner_later;
use crate::tray::{self, show_studio_later};

/// What the running Studio does when it is started again with `args`.
#[derive(Debug, PartialEq, Eq)]
enum Again {
    /// `--runner`: the run window.
    Runner,
    /// `--tray`: nothing to show (it is already in the tray).
    Nothing,
    /// Otherwise: Studio's main window.
    Studio,
}

fn again(args: &[String]) -> Again {
    if args.iter().any(|a| a == "--runner") {
        Again::Runner
    } else if args.iter().any(|a| a == "--tray") {
        Again::Nothing
    } else {
        Again::Studio
    }
}

/// Called in the running Studio with the second start's arguments, on the
/// main thread: windows are made from another thread (tauri-apps/wry#583).
fn started_again(app: &AppHandle, args: Vec<String>, _cwd: String) {
    // A `--runner` or `--tray` shortcut keeps SpellSheet in the tray; that
    // still holds when it only brought the running Studio forward.
    if tray::wants_tray(args.iter().cloned()) {
        tray::stay_in_tray();
    }
    match again(&args) {
        Again::Runner => show_runner_later(app),
        Again::Studio => show_studio_later(app),
        Again::Nothing => {}
    }
}

/// The plugin that keeps Studio to one copy, for installed builds on Windows.
/// Registered first: a second start hands over its arguments and exits
/// before any window, tray icon or watcher of its own is made. What it did
/// before that (opening the workspace, the updater's startup tidy-up) only
/// reads or is harmless: a waiting update moves files aside only when the
/// running Studio exits.
pub(crate) fn plugin() -> Option<tauri::plugin::TauriPlugin<tauri::Wry>> {
    #[cfg(windows)]
    {
        // Checked at run time, not with cfg, so the debug builds of CI
        // compile this too.
        (!cfg!(debug_assertions)).then(|| tauri_plugin_single_instance::init(started_again))
    }
    #[cfg(not(windows))]
    {
        let _ = started_again;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("SpellSheet Studio.exe")
            .chain(list.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn a_second_start_shows_what_it_was_started_for() {
        assert_eq!(again(&args(&[])), Again::Studio);
        assert_eq!(again(&args(&["--runner"])), Again::Runner);
        assert_eq!(again(&args(&["--tray"])), Again::Nothing);
        assert_eq!(again(&args(&["--tray", "--runner"])), Again::Runner);
    }
}
