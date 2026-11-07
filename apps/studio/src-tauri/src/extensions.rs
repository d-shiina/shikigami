//! The 拡張機能 place: extensions (node plugins) installed on this PC, and
//! installing, updating, turning off and removing them. A thin layer over
//! `shikigami_plugins::install` (the same as `shikigami plugin …`).
//!
//! Installing is two steps, as the screen shows them: `stage_extension`
//! downloads and checks it and returns what it is (its nodes, what they
//! send outside, the program it starts); `install_extension` puts it in
//! place once the person has read that. Studio loads extensions when it
//! starts, so changes take effect after a restart (the screen offers one).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use shikigami_core::ErrorPayload;
use shikigami_plugins::install::{self, InstallError, Source, Staged};
use tauri::{AppHandle, State};

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}

fn install_err(e: InstallError) -> ErrorPayload {
    ErrorPayload {
        code: e.code.into(),
        message: e.message,
        details: (!e.problems.is_empty()).then(|| json!({ "problems": e.problems })),
    }
}

/// Staged extensions waiting for the person's go-ahead, and whether
/// anything changed since Studio started.
#[derive(Default)]
pub struct Extensions {
    staged: Mutex<HashMap<String, Staged>>,
    changed: AtomicBool,
}

fn root() -> CmdResult<PathBuf> {
    install::install_root().ok_or_else(|| {
        err(
            "EXTENSIONS_UNAVAILABLE",
            "拡張機能のインストール先（%LOCALAPPDATA%）が見つかりません",
        )
    })
}

/// Names extensions cannot take: the built-in adapters.
fn builtin_names() -> Vec<String> {
    static NAMES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    NAMES
        .get_or_init(|| {
            shikigami_adapters::builtin()
                .iter()
                .map(|a| a.name().to_owned())
                .collect()
        })
        .clone()
}

/// The installed extensions (on, off, or not loadable), the registry URL,
/// and whether a restart is needed for changes to take effect.
#[tauri::command]
pub fn list_extensions(ext: State<'_, Extensions>) -> CmdResult<Value> {
    let root = root()?;
    install::empty_trash(&root);
    let names = builtin_names();
    let taken: Vec<&str> = names.iter().map(String::as_str).collect();
    let installed = install::list(&shikigami_plugins::default_dirs(), Some(&root), &taken);
    Ok(json!({
        "root": root.display().to_string(),
        "installed": installed,
        "registry": install::registry_url(),
        "restartNeeded": ext.changed.load(Ordering::Relaxed),
    }))
}

/// Downloads and checks an extension (a zip or folder path, an https zip
/// URL or a GitHub repository) and returns what it is, with an `id` for
/// [`install_extension`]. Nothing is installed or started yet.
#[tauri::command]
pub async fn stage_extension(ext: State<'_, Extensions>, source: String) -> CmdResult<Value> {
    let root = root()?;
    let source = Source::parse(&source).map_err(install_err)?;
    let names = builtin_names();
    let taken: Vec<&str> = names.iter().map(String::as_str).collect();
    let staged = install::stage(&root, source, &taken)
        .await
        .map_err(install_err)?;
    let preview = staged.preview(&root);
    let mut waiting = ext.staged.lock().unwrap_or_else(|e| e.into_inner());
    // Only the latest one waits: an earlier preview the person left is thrown away.
    for (id, _) in waiting.drain() {
        install::discard(&root, &id);
    }
    waiting.insert(staged.id.clone(), staged);
    Ok(preview)
}

/// Gets a new version of an installed extension from where it came from,
/// as [`stage_extension`] does.
#[tauri::command]
pub async fn stage_extension_update(ext: State<'_, Extensions>, name: String) -> CmdResult<Value> {
    let root = root()?;
    let Some(record) = install::source_of(&root, &name) else {
        return Err(err(
            "EXTENSION_SOURCE_UNKNOWN",
            format!("「{name}」の入手先が記録されていないため、更新を確認できません"),
        ));
    };
    stage_extension(ext, record.source.display()).await
}

/// Installs the staged extension `id` (replacing the installed version).
#[tauri::command]
pub fn install_extension(ext: State<'_, Extensions>, id: String) -> CmdResult<()> {
    let root = root()?;
    let staged = ext
        .staged
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id)
        .ok_or_else(|| {
            err(
                "EXTENSION_NOT_STAGED",
                "確認した拡張機能が見つかりません。もう一度読み込んでください",
            )
        })?;
    install::commit(&root, staged).map_err(install_err)?;
    ext.changed.store(true, Ordering::Relaxed);
    Ok(())
}

/// Throws away a staged extension the person did not install.
#[tauri::command]
pub fn discard_extension(ext: State<'_, Extensions>, id: String) -> CmdResult<()> {
    let root = root()?;
    ext.staged
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    install::discard(&root, &id);
    Ok(())
}

#[tauri::command]
pub fn set_extension_enabled(
    ext: State<'_, Extensions>,
    name: String,
    enabled: bool,
) -> CmdResult<()> {
    install::set_enabled(&root()?, &name, enabled).map_err(install_err)?;
    ext.changed.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn uninstall_extension(ext: State<'_, Extensions>, name: String) -> CmdResult<()> {
    install::remove(&root()?, &name).map_err(install_err)?;
    ext.changed.store(true, Ordering::Relaxed);
    Ok(())
}

/// Sets (or clears, with an empty text) the registry index URL.
#[tauri::command]
pub fn set_extension_registry(url: String) -> CmdResult<()> {
    install::set_registry_url(&url).map_err(|e| err("REGISTRY_INVALID", e))
}

/// The extensions the registry offers.
#[tauri::command]
pub async fn fetch_extension_registry() -> CmdResult<Value> {
    let Some(url) = install::registry_url() else {
        return Ok(json!([]));
    };
    let list = install::fetch_registry(&url).await.map_err(install_err)?;
    Ok(json!(list))
}

/// Restarts Studio so installed, updated or turned-off extensions take effect.
#[tauri::command]
pub fn restart_for_extensions(app: AppHandle) {
    app.restart()
}
