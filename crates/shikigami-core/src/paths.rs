//! Where SpellSheet keeps its own files on this PC, and the move from the
//! folders of its old name.
//!
//! The product was called Shikigami. Its folders (`%APPDATA%\Shikigami`,
//! `%LOCALAPPDATA%\Shikigami`) are moved to `SpellSheet` the first time a new
//! build asks for them, so an update keeps the flows, run records, settings,
//! extensions and secrets where the new build looks. When the old folder
//! cannot be moved (a file in it is open, e.g. by an old build still
//! running), this process keeps using it and the next start tries again.
//!
//! Environment variables are read the same way: `SPELLSHEET_<NAME>` first,
//! then the old `SHIKIGAMI_<NAME>`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The folder name under the platform's data folders.
pub const APP_DIR: &str = "SpellSheet";
/// The folder name the product used before (moved on first use).
pub const LEGACY_APP_DIR: &str = "Shikigami";

/// `SPELLSHEET_<name>`, else the old `SHIKIGAMI_<name>`.
pub fn env_var(name: &str) -> Option<OsString> {
    env_var_in(name, |n| std::env::var_os(n)).map(|(_, value)| value)
}

/// Which of the two names is set, for messages (`SPELLSHEET_HOME`).
pub fn env_var_name(name: &str) -> Option<String> {
    env_var_in(name, |n| std::env::var_os(n)).map(|(set, _)| set)
}

fn env_var_in(name: &str, get: impl Fn(&str) -> Option<OsString>) -> Option<(String, OsString)> {
    [format!("SPELLSHEET_{name}"), format!("SHIKIGAMI_{name}")]
        .into_iter()
        .find_map(|n| get(&n).map(|value| (n, value)))
}

/// Moves every old folder that can be moved now (once per process). Called
/// before any path into them is resolved.
pub fn migrate() {
    config_dir();
    data_dir();
    local_dir();
}

/// Roaming settings: `%APPDATA%\SpellSheet` (config.json).
pub fn config_dir() -> PathBuf {
    app_dir(dirs::config_dir())
}

/// Roaming data: `%APPDATA%\SpellSheet` (the default workspace).
pub fn data_dir() -> PathBuf {
    app_dir(dirs::data_dir())
}

/// Per-PC data: `%LOCALAPPDATA%\SpellSheet` (extensions, logs, the
/// local part of shared workspaces).
pub fn local_dir() -> PathBuf {
    app_dir(dirs::data_local_dir())
}

fn app_dir(base: Option<PathBuf>) -> PathBuf {
    let base = base.unwrap_or_else(|| PathBuf::from("."));
    static CHOSEN: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    let mut chosen = CHOSEN
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    chosen
        .entry(base.clone())
        .or_insert_with(|| move_legacy(&base))
        .clone()
}

/// `base\SpellSheet`, after moving `base\Shikigami` there when only the old
/// one exists. Keeps the old folder when it cannot be moved.
pub fn move_legacy(base: &Path) -> PathBuf {
    let new = base.join(APP_DIR);
    let old = base.join(LEGACY_APP_DIR);
    if new.exists() || !old.is_dir() {
        return new;
    }
    match std::fs::rename(&old, &new) {
        Ok(()) => {
            tracing::info!(from = %old.display(), to = %new.display(), "moved the folder to the new name");
            new
        }
        // Another process starting at the same time moved it first.
        Err(_) if new.is_dir() => new,
        Err(e) => {
            tracing::warn!(error = %e, folder = %old.display(), "cannot move the folder to the new name yet; using it as it is");
            old
        }
    }
}

/// A path someone saved under an old folder (`--workspace` in a scheduled
/// task or an AI client's MCP setup, `workspace` in config.json,
/// `SHIKIGAMI_HOME`) that has since moved: the same place under the new
/// folder. Other paths, and paths that still exist, come back unchanged.
pub fn upgrade_legacy(path: &Path) -> PathBuf {
    // Move first: a path into the old folder must not be kept (and opened)
    // only for the folder to move from under it a moment later.
    migrate();
    if path.exists() {
        return path.to_path_buf();
    }
    let bases = [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir()];
    for base in bases.into_iter().flatten() {
        if let Some(moved) = moved_under(path, &base) {
            return moved;
        }
    }
    path.to_path_buf()
}

/// `path` with `base\Shikigami` swapped for `base\SpellSheet`, when it was
/// under the old folder and the new one exists.
fn moved_under(path: &Path, base: &Path) -> Option<PathBuf> {
    let rest = strip_prefix_ignore_case(path, &base.join(LEGACY_APP_DIR))?;
    let new = base.join(APP_DIR);
    new.is_dir().then(|| new.join(rest))
}

/// The same place under the old folder name, for a path under the new one
/// (to find what an older build kept for it).
pub fn legacy_of(path: &Path) -> Option<PathBuf> {
    let bases = [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir()];
    bases.into_iter().flatten().find_map(|base| {
        strip_prefix_ignore_case(path, &base.join(APP_DIR))
            .map(|rest| base.join(LEGACY_APP_DIR).join(rest))
    })
}

/// Windows paths are case-insensitive: `C:\Users\a\AppData` and
/// `c:\users\A\appdata` are the same folder.
fn strip_prefix_ignore_case(path: &Path, prefix: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    for want in prefix.components() {
        let got = parts.next()?;
        if !got
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&want.as_os_str().to_string_lossy())
        {
            return None;
        }
    }
    Some(parts.as_path().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_the_old_folder_once() {
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(base.path().join("Shikigami/workspace")).unwrap();
        std::fs::write(base.path().join("Shikigami/config.json"), "{}").unwrap();

        let dir = move_legacy(base.path());
        assert_eq!(dir, base.path().join("SpellSheet"));
        assert!(dir.join("config.json").is_file());
        assert!(dir.join("workspace").is_dir());
        assert!(!base.path().join("Shikigami").exists());
        // Again: nothing left to move.
        assert_eq!(move_legacy(base.path()), dir);
    }

    #[test]
    fn keeps_the_new_folder_when_both_exist() {
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(base.path().join("Shikigami")).unwrap();
        std::fs::create_dir_all(base.path().join("SpellSheet")).unwrap();
        assert_eq!(move_legacy(base.path()), base.path().join("SpellSheet"));
        assert!(base.path().join("Shikigami").exists());
    }

    #[test]
    fn new_folder_when_nothing_exists() {
        let base = tempfile::tempdir().unwrap();
        assert_eq!(move_legacy(base.path()), base.path().join("SpellSheet"));
        assert!(!base.path().join("SpellSheet").exists());
    }

    #[test]
    fn old_paths_point_into_the_moved_folder() {
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(base.path().join("SpellSheet/workspace")).unwrap();
        let old = base.path().join("Shikigami").join("workspace");
        assert_eq!(
            moved_under(&old, base.path()),
            Some(base.path().join("SpellSheet").join("workspace"))
        );
        assert_eq!(
            moved_under(&base.path().join("elsewhere"), base.path()),
            None
        );
    }

    #[test]
    fn prefix_ignores_case() {
        assert_eq!(
            strip_prefix_ignore_case(
                Path::new("/Data/shikigami/ws"),
                Path::new("/data/Shikigami")
            ),
            Some(PathBuf::from("ws"))
        );
        assert_eq!(
            strip_prefix_ignore_case(Path::new("/data/Shiki"), Path::new("/data/Shikigami")),
            None
        );
    }

    #[test]
    fn new_environment_variable_wins() {
        let env = |n: &str| match n {
            "SHIKIGAMI_A" | "SHIKIGAMI_B" => Some(OsString::from("old")),
            "SPELLSHEET_A" => Some(OsString::from("new")),
            _ => None,
        };
        assert_eq!(
            env_var_in("A", env),
            Some(("SPELLSHEET_A".into(), "new".into()))
        );
        assert_eq!(
            env_var_in("B", env),
            Some(("SHIKIGAMI_B".into(), "old".into()))
        );
        assert_eq!(env_var_in("C", env), None);
    }
}
