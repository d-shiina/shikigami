//! Online updates for installed Studio builds.
//!
//! Uses the official Tauri updater: the release workflow publishes a signed
//! NSIS installer and `latest.json`, Studio checks that file, verifies the
//! signature against the public key in `tauri.conf.json`, and runs the
//! installer. Development builds never check.
//!
//! The installer also carries the `shikigami` CLI (the MCP server), which an
//! MCP client such as Claude Code may be running from the install folder.
//! Windows refuses to overwrite a running executable but allows renaming it,
//! so the CLI is moved aside just before the installer starts. The running
//! server keeps the old file; the next launch picks up the new one.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use shikigami_core::ErrorPayload;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub(crate) const UPDATE_EVENT: &str = "update-progress";

const CLI_EXE: &str = "shikigami.exe";

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// The update found by the last check, kept until the user installs it.
#[derive(Default)]
pub(crate) struct PendingUpdate(Mutex<Option<Update>>);

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

/// Startup housekeeping for installed builds: undo a parked CLI whose
/// installer never ran, and delete copies left by finished updates.
pub(crate) fn on_startup<R: Runtime>(app: &AppHandle<R>) {
    if cfg!(debug_assertions) {
        return;
    }
    if let Some(dir) = install_dir() {
        let version = app.package_info().version.to_string();
        if let Err(e) = restore_parked_cli(&dir, &version) {
            tracing::warn!(error = %e, "cannot restore the parked CLI");
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
    *lock(&pending) = update;
    Ok(info)
}

/// Downloads and installs the pending update. On Windows the installer
/// replaces the running app and starts it again, so this never returns on
/// success.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> CmdResult<()> {
    let Some(update) = lock(&pending).take() else {
        return Err(err("NO_PENDING_UPDATE", "check for updates first"));
    };
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
    if let Some(dir) = install_dir()
        && let Err(e) = park_cli(&dir, &update.current_version)
    {
        tracing::warn!(error = %e, "cannot move the CLI aside; the installer may ask to retry");
    }
    if let Err(e) = update.install(bytes) {
        // The installer never started, so MCP clients still need the CLI.
        if let Some(dir) = install_dir()
            && let Err(e) = restore_parked_cli(&dir, &update.current_version)
        {
            tracing::warn!(error = %e, "cannot restore the parked CLI");
        }
        return Err(err("UPDATE_INSTALL_FAILED", e.to_string()));
    }
    app.restart()
}

fn lock(pending: &PendingUpdate) -> std::sync::MutexGuard<'_, Option<Update>> {
    pending
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn parked_name(version: &str) -> String {
    format!("shikigami-{version}.exe.old")
}

/// Renames the CLI so the installer can write a fresh copy even while it is
/// running. The name carries the version being replaced, so a copy still
/// held open by an earlier update never blocks this one.
fn park_cli(dir: &Path, current_version: &str) -> io::Result<()> {
    let exe = dir.join(CLI_EXE);
    if !exe.is_file() {
        return Ok(());
    }
    let parked = dir.join(parked_name(current_version));
    if parked.exists() {
        std::fs::remove_file(&parked)?;
    }
    std::fs::rename(exe, parked)
}

fn restore_parked_cli(dir: &Path, current_version: &str) -> io::Result<()> {
    let exe = dir.join(CLI_EXE);
    let own = dir.join(parked_name(current_version));
    if !exe.exists() && own.is_file() {
        // The installer was cancelled or failed: this version is still the
        // installed one, so its CLI goes back.
        std::fs::rename(&own, &exe)?;
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("shikigami-") && name.ends_with(".exe.old") {
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
    fn park_moves_the_cli_aside() -> io::Result<()> {
        let dir = tempdir();
        write(&dir.path().join(CLI_EXE), "v1");
        park_cli(dir.path(), "0.1.0")?;
        assert!(!dir.path().join(CLI_EXE).exists());
        assert_eq!(read(&dir.path().join("shikigami-0.1.0.exe.old")), "v1");
        Ok(())
    }

    #[test]
    fn park_without_cli_is_a_no_op() -> io::Result<()> {
        let dir = tempdir();
        park_cli(dir.path(), "0.1.0")?;
        assert_eq!(std::fs::read_dir(dir.path())?.count(), 0);
        Ok(())
    }

    #[test]
    fn startup_after_a_finished_update_deletes_old_copies() -> io::Result<()> {
        let dir = tempdir();
        write(&dir.path().join(CLI_EXE), "v2");
        write(&dir.path().join("shikigami-0.1.0.exe.old"), "v1");
        restore_parked_cli(dir.path(), "0.2.0")?;
        assert_eq!(read(&dir.path().join(CLI_EXE)), "v2");
        assert!(!dir.path().join("shikigami-0.1.0.exe.old").exists());
        Ok(())
    }

    #[test]
    fn startup_after_a_cancelled_update_restores_the_cli() -> io::Result<()> {
        let dir = tempdir();
        write(&dir.path().join("shikigami-0.1.0.exe.old"), "v1");
        restore_parked_cli(dir.path(), "0.1.0")?;
        assert_eq!(read(&dir.path().join(CLI_EXE)), "v1");
        assert!(!dir.path().join("shikigami-0.1.0.exe.old").exists());
        Ok(())
    }
}
