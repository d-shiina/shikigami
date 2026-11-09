//! Where SpellSheet keeps its own files on this PC, and the move from the
//! folders of its old name.
//!
//! The product had another name before. Its folders (`%APPDATA%\<old name>`,
//! `%LOCALAPPDATA%\<old name>`, see [`LEGACY_APP_DIR`]) are moved to `SpellSheet` the first time a new
//! build asks for them, so an update keeps the flows, run records, settings,
//! extensions and secrets where the new build looks. When the old folder
//! cannot be moved (a file in it is open, e.g. by an old build still
//! running), this process keeps using it and the next start tries again.
//!
//! The default workspace moved too: builds before kept it in the roaming
//! profile (`%APPDATA%\SpellSheet\workspace`), which a company's roaming
//! profile copies at every sign-in and sign-out, output files, run records
//! and screenshots included. It now lives in `%LOCALAPPDATA%\SpellSheet\workspace`
//! and is moved there the same way (see [`default_workspace`]).
//!
//! Environment variables are read the same way: `SPELLSHEET_<NAME>` first,
//! then the old name's ([`LEGACY_ENV_PREFIX`]).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The folder name under the platform's data folders.
pub const APP_DIR: &str = "SpellSheet";
/// The folder name the product used before (moved on first use).
pub const LEGACY_APP_DIR: &str = "Shikigami";
/// The prefix of the environment variables under the old name.
pub const LEGACY_ENV_PREFIX: &str = "SHIKIGAMI_";

/// `SPELLSHEET_<name>`, else the old name's ([`LEGACY_ENV_PREFIX`]).
pub fn env_var(name: &str) -> Option<OsString> {
    env_var_in(name, |n| std::env::var_os(n)).map(|(_, value)| value)
}

/// Which of the two names is set, for messages (`SPELLSHEET_HOME`).
pub fn env_var_name(name: &str) -> Option<String> {
    env_var_in(name, |n| std::env::var_os(n)).map(|(set, _)| set)
}

fn env_var_in(name: &str, get: impl Fn(&str) -> Option<OsString>) -> Option<(String, OsString)> {
    [
        format!("SPELLSHEET_{name}"),
        format!("{LEGACY_ENV_PREFIX}{name}"),
    ]
    .into_iter()
    .find_map(|n| get(&n).map(|value| (n, value)))
}

/// How `current` (a format marker or file name with `spellsheet` in it) was
/// spelled under the old name: what files written before the rename carry.
pub fn legacy_spelling(current: &str) -> String {
    current.replace("spellsheet", &LEGACY_APP_DIR.to_ascii_lowercase())
}

/// `found` is `current`, or `current` as spelled before the rename.
pub fn same_or_legacy(found: &str, current: &str) -> bool {
    found == current || found == legacy_spelling(current)
}

/// Moves every old folder that can be moved now (once per process). Called
/// before any path into them is resolved.
pub fn migrate() {
    config_dir();
    data_dir();
    local_dir();
    default_workspace();
}

/// Roaming settings: `%APPDATA%\SpellSheet` (config.json).
pub fn config_dir() -> PathBuf {
    app_dir(dirs::config_dir())
}

/// Roaming data: `%APPDATA%\SpellSheet` (where the default workspace was
/// before it moved to [`local_dir`]).
pub fn data_dir() -> PathBuf {
    app_dir(dirs::data_dir())
}

/// Per-PC data: `%LOCALAPPDATA%\SpellSheet` (the default workspace,
/// extensions, logs, the local part of shared workspaces).
pub fn local_dir() -> PathBuf {
    app_dir(dirs::data_local_dir())
}

/// The default workspace: `%LOCALAPPDATA%\SpellSheet\workspace`, after moving
/// the one an older build kept in the roaming profile there (once per
/// process). Keeps using the roaming one when it cannot be moved (a file in
/// it is open, or the roaming profile is on another drive), and the next
/// start tries again.
pub fn default_workspace() -> PathBuf {
    static CHOSEN: OnceLock<PathBuf> = OnceLock::new();
    CHOSEN
        .get_or_init(|| move_workspace(&roaming_workspace(), &local_workspace()))
        .clone()
}

/// Where the default workspace was before it moved to [`local_dir`].
pub fn roaming_workspace() -> PathBuf {
    data_dir().join("workspace")
}

fn local_workspace() -> PathBuf {
    local_dir().join("workspace")
}

/// `new`, after moving `old` there when only `old` exists. Keeps `old` when
/// it cannot be moved.
pub fn move_workspace(old: &Path, new: &Path) -> PathBuf {
    if same_path(old, new) || new.exists() || !old.is_dir() {
        return new.to_path_buf();
    }
    if let Some(parent) = new.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        tracing::warn!(error = %e, folder = %parent.display(), "cannot create the folder for the workspace");
        return old.to_path_buf();
    }
    match std::fs::rename(old, new) {
        Ok(()) => {
            tracing::info!(from = %old.display(), to = %new.display(), "moved the workspace out of the roaming profile");
            new.to_path_buf()
        }
        // Another process starting at the same time moved it first.
        Err(_) if new.is_dir() => new.to_path_buf(),
        Err(e) => {
            tracing::warn!(error = %e, folder = %old.display(), "cannot move the workspace out of the roaming profile yet; using it as it is");
            old.to_path_buf()
        }
    }
}

/// The default workspace's place in the roaming profile, for a path saved
/// while it was there (`workspace` in config.json, `--workspace` in a
/// scheduled task or an AI client's MCP setup).
pub fn is_roaming_workspace(path: &Path) -> bool {
    same_path(path, &roaming_workspace())
}

fn same_path(a: &Path, b: &Path) -> bool {
    strip_prefix_ignore_case(a, b).is_some_and(|rest| rest.as_os_str().is_empty())
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

/// `base\SpellSheet`, after moving the old folder ([`LEGACY_APP_DIR`]) there when only the old
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
/// `SPELLSHEET_HOME`) that has since moved: the same place under the new
/// folder. Other paths, and paths that still exist, come back unchanged.
pub fn upgrade_legacy(path: &Path) -> PathBuf {
    // Move first: a path into the old folder must not be kept (and opened)
    // only for the folder to move from under it a moment later.
    migrate();
    if path.exists() {
        return path.to_path_buf();
    }
    let mut path = path.to_path_buf();
    let bases = [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir()];
    for base in bases.into_iter().flatten() {
        if let Some(moved) = moved_under(&path, &base) {
            path = moved;
            break;
        }
    }
    if !path.exists()
        && let Some(moved) = moved_into(&path, &roaming_workspace(), &default_workspace())
    {
        return moved;
    }
    path
}

/// `path` with `old` swapped for `new`, when it was under `old` and `new`
/// exists.
fn moved_into(path: &Path, old: &Path, new: &Path) -> Option<PathBuf> {
    if same_path(old, new) {
        return None;
    }
    let rest = strip_prefix_ignore_case(path, old)?;
    new.is_dir().then(|| new.join(rest))
}

/// Where the default workspace was kept before it moved out of the roaming
/// profile, for `path` (to find what an older build kept for it).
pub fn roaming_of(path: &Path) -> Option<PathBuf> {
    let local = local_workspace();
    let roaming = roaming_workspace();
    if same_path(&local, &roaming) {
        return None;
    }
    strip_prefix_ignore_case(path, &local).map(|rest| roaming.join(rest))
}

/// `path` with the old folder under `base` swapped for `base\SpellSheet`, when it was
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
        std::fs::create_dir_all(base.path().join(LEGACY_APP_DIR).join("workspace")).unwrap();
        std::fs::write(base.path().join(LEGACY_APP_DIR).join("config.json"), "{}").unwrap();

        let dir = move_legacy(base.path());
        assert_eq!(dir, base.path().join("SpellSheet"));
        assert!(dir.join("config.json").is_file());
        assert!(dir.join("workspace").is_dir());
        assert!(!base.path().join(LEGACY_APP_DIR).exists());
        // Again: nothing left to move.
        assert_eq!(move_legacy(base.path()), dir);
    }

    #[test]
    fn keeps_the_new_folder_when_both_exist() {
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(base.path().join(LEGACY_APP_DIR)).unwrap();
        std::fs::create_dir_all(base.path().join("SpellSheet")).unwrap();
        assert_eq!(move_legacy(base.path()), base.path().join("SpellSheet"));
        assert!(base.path().join(LEGACY_APP_DIR).exists());
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
        let old = base.path().join(LEGACY_APP_DIR).join("workspace");
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
    fn moves_the_roaming_workspace_to_local() {
        let base = tempfile::tempdir().unwrap();
        let old = base.path().join("Roaming/SpellSheet/workspace");
        let new = base.path().join("Local/SpellSheet/workspace");
        std::fs::create_dir_all(old.join("flows/scn_a")).unwrap();
        std::fs::write(old.join("flows/scn_a/flow.json"), "{}").unwrap();

        assert_eq!(move_workspace(&old, &new), new);
        assert!(new.join("flows/scn_a/flow.json").is_file());
        assert!(!old.exists());
        // Again: nothing left to move.
        assert_eq!(move_workspace(&old, &new), new);
    }

    #[test]
    fn keeps_the_local_workspace_when_both_exist() {
        let base = tempfile::tempdir().unwrap();
        let old = base.path().join("Roaming/workspace");
        let new = base.path().join("Local/workspace");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        assert_eq!(move_workspace(&old, &new), new);
        assert!(old.exists());
    }

    #[test]
    fn local_workspace_when_nothing_exists() {
        let base = tempfile::tempdir().unwrap();
        let new = base.path().join("Local/workspace");
        assert_eq!(
            move_workspace(&base.path().join("Roaming/workspace"), &new),
            new
        );
        assert!(!new.exists());
    }

    #[test]
    fn paths_into_the_roaming_workspace_follow_it() {
        let base = tempfile::tempdir().unwrap();
        let old = base.path().join("Roaming/workspace");
        let new = base.path().join("Local/workspace");
        std::fs::create_dir_all(&new).unwrap();
        assert_eq!(moved_into(&old, &old, &new), Some(new.clone()));
        assert_eq!(
            moved_into(&old.join("flows"), &old, &new),
            Some(new.join("flows"))
        );
        assert_eq!(moved_into(&base.path().join("elsewhere"), &old, &new), None);
        // Not moved yet: the path stays.
        let gone = base.path().join("Local/missing");
        assert_eq!(moved_into(&old, &old, &gone), None);
    }

    #[test]
    fn prefix_ignores_case() {
        assert_eq!(
            strip_prefix_ignore_case(Path::new("/Data/oldname/ws"), Path::new("/data/OldName")),
            Some(PathBuf::from("ws"))
        );
        assert_eq!(
            strip_prefix_ignore_case(Path::new("/data/Old"), Path::new("/data/OldName")),
            None
        );
    }

    #[test]
    fn formats_from_before_the_rename_are_recognised() {
        let old = legacy_spelling("spellsheet.config");
        assert_ne!(old, "spellsheet.config");
        assert!(same_or_legacy(&old, "spellsheet.config"));
        assert!(same_or_legacy("spellsheet.config", "spellsheet.config"));
        assert!(!same_or_legacy("other.config", "spellsheet.config"));
    }

    #[test]
    fn new_environment_variable_wins() {
        let env = |n: &str| match n {
            n if n == format!("{LEGACY_ENV_PREFIX}A") || n == format!("{LEGACY_ENV_PREFIX}B") => {
                Some(OsString::from("old"))
            }
            "SPELLSHEET_A" => Some(OsString::from("new")),
            _ => None,
        };
        assert_eq!(
            env_var_in("A", env),
            Some(("SPELLSHEET_A".into(), "new".into()))
        );
        assert_eq!(
            env_var_in("B", env),
            Some((format!("{LEGACY_ENV_PREFIX}B"), "old".into()))
        );
        assert_eq!(env_var_in("C", env), None);
    }
}
