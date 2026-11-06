//! Online updates for installed Studio builds.
//!
//! Uses the official Tauri updater: the release workflow publishes a signed
//! NSIS installer and `latest.json`, Studio checks that file, verifies the
//! signature against the public key in `tauri.conf.json`, and runs the
//! installer. Development builds never check.
//!
//! It works like VS Code: a new version found at launch (or by "check for
//! updates") is downloaded in the background, and the installer runs
//! silently (`installMode: quiet`, no window) either when the user presses
//! "restart to update" (Studio comes back as the new version) or when Studio
//! is closed (it stays closed; the next launch is the new version).
//!
//! The installer also carries the `shikigami` CLI (the MCP server), which an
//! MCP client such as Claude Code may be running from the install folder,
//! and Node.js (`node\node.exe`), which runs the browser adapter for Studio
//! and for that server. Windows refuses to overwrite a running executable
//! but allows renaming it, so both are moved aside just before the
//! installer starts. A running process keeps the old file; the next launch
//! picks up the new one.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use shikigami_core::ErrorPayload;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub(crate) const UPDATE_EVENT: &str = "update-progress";

const CLI_EXE: &str = "shikigami.exe";

/// Executables that may be running while the installer replaces them,
/// relative to the install folder.
const PARKED_EXES: [&str; 2] = [CLI_EXE, "node/node.exe"];

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// The update found by the last check, and the installer once it has been
/// downloaded, kept until it is installed.
#[derive(Default)]
pub(crate) struct PendingUpdate {
    found: Mutex<Option<Update>>,
    ready: Mutex<Option<Ready>>,
}

/// A downloaded, signature-checked installer waiting for a restart or exit.
struct Ready {
    update: Update,
    file: PathBuf,
}

/// Downloaded installers wait here; a later launch clears it.
fn download_dir() -> PathBuf {
    std::env::temp_dir().join("shikigami-update")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    /// False in development builds and when no signing key is configured.
    updates_enabled: bool,
    /// The bundled CLI, for registering the MCP server. `None` when Studio
    /// runs without it (development builds).
    cli_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn install_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}

fn updates_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|c| c.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

/// Startup housekeeping for installed builds: undo parked executables whose
/// installer never ran, and delete copies left by finished updates. Runs
/// before the adapters are built, since they look for `node\node.exe`.
pub(crate) fn on_startup() {
    if cfg!(debug_assertions) {
        return;
    }
    if let Some(dir) = install_dir() {
        // Studio's version is the workspace version, as in `package_info`.
        restore_parked_exes(&dir, env!("CARGO_PKG_VERSION"));
    }
    clean_downloads(&download_dir(), env!("CARGO_PKG_VERSION"));
}

/// Deletes downloaded installers this version no longer needs: those not
/// newer than it (already installed, or older). A newer one may belong to
/// another Studio window that is waiting to restart, so it stays.
fn clean_downloads(dir: &Path, current_version: &str) {
    let Ok(current) = semver::Version::parse(current_version) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|e| e.path()) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let newer = name
            .strip_prefix("shikigami-")
            .and_then(|n| n.strip_suffix(".update"))
            .and_then(|v| semver::Version::parse(v).ok())
            .is_some_and(|v| v > current);
        if !newer {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let cli_path = install_dir()
        .map(|dir| dir.join(CLI_EXE))
        .filter(|p| !cfg!(debug_assertions) && p.is_file())
        .map(|p| p.display().to_string());
    AppInfo {
        version: app.package_info().version.to_string(),
        updates_enabled: updates_enabled(&app),
        cli_path,
    }
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> CmdResult<Option<UpdateInfo>> {
    if !updates_enabled(&app) {
        return Ok(None);
    }
    let update = app
        .updater()
        .map_err(|e| err("UPDATE_CHECK_FAILED", e.to_string()))?
        .check()
        .await
        .map_err(|e| err("UPDATE_CHECK_FAILED", e.to_string()))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *lock(&pending.found) = update;
    Ok(info)
}

/// Downloads the update found by the last check in the background and keeps
/// the installer until a restart or exit. Returns the version now ready.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> CmdResult<String> {
    let Some(update) = lock(&pending.found).clone() else {
        return Err(err("NO_PENDING_UPDATE", "check for updates first"));
    };
    if let Some(ready) = lock(&pending.ready).as_ref()
        && ready.update.version == update.version
    {
        return Ok(update.version);
    }
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(UPDATE_EVENT, Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| err("UPDATE_DOWNLOAD_FAILED", e.to_string()))?;
    let dir = download_dir();
    let file = dir.join(format!("shikigami-{}.update", update.version));
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&file, &bytes))
        .map_err(|e| err("UPDATE_DOWNLOAD_FAILED", e.to_string()))?;
    let version = update.version.clone();
    *lock(&pending.ready) = Some(Ready { update, file });
    Ok(version)
}

/// Installs the downloaded update now and starts Studio again as the new
/// version. Never returns on success.
#[tauri::command]
pub fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> CmdResult<()> {
    let Some(ready) = lock(&pending.ready).take() else {
        return Err(err(
            "NO_PENDING_UPDATE",
            "the update has not been downloaded yet",
        ));
    };
    install(ready, true)?;
    app.restart()
}

/// Called as Studio exits: a downloaded update is installed silently, and
/// Studio stays closed until the user starts it again.
pub(crate) fn install_on_exit<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;
    let Some(ready) = app
        .try_state::<PendingUpdate>()
        .and_then(|p| lock(&p.ready).take())
    else {
        return;
    };
    if let Err(e) = install(ready, false) {
        tracing::warn!(error = %e.message, "cannot install the update on exit");
    }
}

/// Moves the running executables aside and starts the installer, which
/// exits Studio on success.
fn install(ready: Ready, restart: bool) -> CmdResult<()> {
    let bytes =
        std::fs::read(&ready.file).map_err(|e| err("UPDATE_INSTALL_FAILED", e.to_string()))?;
    let update = ready.update.restart_after_install(restart);
    if let Some(dir) = install_dir() {
        for exe in PARKED_EXES {
            let exe = dir.join(exe);
            if let Err(e) = park(&exe, &update.current_version) {
                tracing::warn!(exe = %exe.display(), error = %e, "cannot move aside; the installer may ask to retry");
            }
        }
    }
    if let Err(e) = update.install(bytes) {
        // The installer never started, so MCP clients and runs still need
        // these files.
        if let Some(dir) = install_dir() {
            restore_parked_exes(&dir, &update.current_version);
        }
        return Err(err("UPDATE_INSTALL_FAILED", e.to_string()));
    }
    Ok(())
}

fn lock<T>(slot: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    slot.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `shikigami.exe` -> `shikigami-<version>.exe.old` in the same folder.
fn parked_path(exe: &Path, version: &str) -> PathBuf {
    exe.with_file_name(format!("{}-{version}.exe.old", exe_stem(exe)))
}

fn exe_stem(exe: &Path) -> &str {
    exe.file_stem().and_then(|s| s.to_str()).unwrap_or_default()
}

/// Renames `exe` so the installer can write a fresh copy even while it is
/// running. The name carries the version being replaced, so a copy still
/// held open by an earlier update never blocks this one.
fn park(exe: &Path, current_version: &str) -> io::Result<()> {
    if !exe.is_file() {
        return Ok(());
    }
    let parked = parked_path(exe, current_version);
    if parked.exists() {
        std::fs::remove_file(&parked)?;
    }
    std::fs::rename(exe, parked)
}

fn restore_parked_exes(dir: &Path, current_version: &str) {
    for exe in PARKED_EXES {
        let exe = dir.join(exe);
        if let Err(e) = restore(&exe, current_version) {
            tracing::warn!(exe = %exe.display(), error = %e, "cannot restore the parked copy");
        }
    }
}

fn restore(exe: &Path, current_version: &str) -> io::Result<()> {
    let own = parked_path(exe, current_version);
    if !exe.exists() && own.is_file() {
        // The installer was cancelled or failed: this version is still the
        // installed one, so its file goes back.
        std::fs::rename(&own, exe)?;
    }
    let Some(dir) = exe.parent().filter(|d| d.is_dir()) else {
        return Ok(());
    };
    let prefix = format!("{}-", exe_stem(exe));
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with(&prefix) && name.ends_with(".exe.old") {
            // Still running under an MCP client: leave it for next time.
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn startup_keeps_only_newer_downloads() {
        let dir = tempdir();
        for name in [
            "shikigami-0.1.1.update",
            "shikigami-0.1.2.update",
            "shikigami-0.1.3.update",
            "junk",
        ] {
            write(&dir.path().join(name), "x");
        }
        clean_downloads(dir.path(), "0.1.2");
        let mut left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["shikigami-0.1.3.update"]);
    }

    #[test]
    fn park_moves_the_cli_aside() -> io::Result<()> {
        let dir = tempdir();
        write(&dir.path().join(CLI_EXE), "v1");
        park(&dir.path().join(CLI_EXE), "0.1.0")?;
        assert!(!dir.path().join(CLI_EXE).exists());
        assert_eq!(read(&dir.path().join("shikigami-0.1.0.exe.old")), "v1");
        Ok(())
    }

    #[test]
    fn park_without_cli_is_a_no_op() -> io::Result<()> {
        let dir = tempdir();
        park(&dir.path().join(CLI_EXE), "0.1.0")?;
        assert_eq!(std::fs::read_dir(dir.path())?.count(), 0);
        Ok(())
    }

    #[test]
    fn startup_after_a_finished_update_deletes_old_copies() -> io::Result<()> {
        let dir = tempdir();
        write(&dir.path().join(CLI_EXE), "v2");
        write(&dir.path().join("shikigami-0.1.0.exe.old"), "v1");
        restore_parked_exes(dir.path(), "0.2.0");
        assert_eq!(read(&dir.path().join(CLI_EXE)), "v2");
        assert!(!dir.path().join("shikigami-0.1.0.exe.old").exists());
        Ok(())
    }

    #[test]
    fn startup_after_a_cancelled_update_restores_the_cli() -> io::Result<()> {
        let dir = tempdir();
        write(&dir.path().join("shikigami-0.1.0.exe.old"), "v1");
        restore_parked_exes(dir.path(), "0.1.0");
        assert_eq!(read(&dir.path().join(CLI_EXE)), "v1");
        assert!(!dir.path().join("shikigami-0.1.0.exe.old").exists());
        Ok(())
    }

    #[test]
    fn parks_and_restores_the_shipped_node() -> io::Result<()> {
        let dir = tempdir();
        let node = dir.path().join("node/node.exe");
        std::fs::create_dir_all(node.parent().unwrap())?;
        write(&node, "v1");
        park(&node, "0.1.0")?;
        assert_eq!(read(&dir.path().join("node/node-0.1.0.exe.old")), "v1");
        restore_parked_exes(dir.path(), "0.1.0");
        assert_eq!(read(&node), "v1");
        assert!(!dir.path().join("node/node-0.1.0.exe.old").exists());
        Ok(())
    }
}
