//! The 拡張機能 place: extensions (node plugins) installed on this PC, and
//! installing, updating, turning off and removing them. A thin layer over
//! `spellsheet_plugins::install` (the same as `spellsheet plugin …`).
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
use spellsheet_core::ErrorPayload;
use spellsheet_plugins::install::{self, InstallError, Source, Staged};
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
            spellsheet_adapters::builtin()
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
    let installed = install::list(&spellsheet_plugins::default_dirs(), Some(&root), &taken);
    Ok(json!({
        "root": root.display().to_string(),
        "installed": installed,
        "registries": install::registry_urls(),
        "officialRegistry": install::OFFICIAL_REGISTRY,
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
    Ok(keep(&ext, &root, staged))
}

/// The plugins the installer ships in `plugins\` next to Writer (from
/// `examples/plugins`, staged by `scripts/bundle-node.mjs`), so a feature
/// that needs one (reading a file from Google Drive) can offer it on a PC that
/// cannot reach a registry. A development build reads the repository's
/// `examples/plugins`.
fn shipped_extension(name: &str) -> Option<PathBuf> {
    if !spellsheet_plugins::manifest::is_plugin_name(name) {
        return None;
    }
    let shipped = spellsheet_runtime::node::exe_dir().map(|dir| dir.join("plugins").join(name));
    let dev = cfg!(debug_assertions).then(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/plugins")
            .join(name)
    });
    [shipped, dev]
        .into_iter()
        .flatten()
        .find(|dir| dir.join("spellsheet-plugin.json").is_file())
}

/// Stages the custom node `name` that came with Writer, as
/// [`stage_extension`] does; the person still confirms what it is.
#[tauri::command]
pub async fn stage_shipped_extension(ext: State<'_, Extensions>, name: String) -> CmdResult<Value> {
    let root = root()?;
    let dir = shipped_extension(&name).ok_or_else(|| {
        err(
            "EXTENSION_NOT_SHIPPED",
            format!("プラグイン「{name}」は Writer に入っていません"),
        )
    })?;
    let names = builtin_names();
    let taken: Vec<&str> = names.iter().map(String::as_str).collect();
    let source = Source::File {
        path: dir.display().to_string(),
    };
    let staged = install::stage(&root, source, &taken)
        .await
        .map_err(install_err)?;
    Ok(keep(&ext, &root, staged))
}

/// Stages the extension `name` from the registry `registry` (the one the
/// catalog row came from), as [`stage_extension`] does. Only that registry
/// is read, so the row shown is the one installed.
#[tauri::command]
pub async fn stage_extension_from_registry(
    ext: State<'_, Extensions>,
    name: String,
    registry: String,
) -> CmdResult<Value> {
    let root = root()?;
    let names = builtin_names();
    let taken: Vec<&str> = names.iter().map(String::as_str).collect();
    let staged = install::stage(&root, Source::Registry { name, registry }, &taken)
        .await
        .map_err(install_err)?;
    Ok(keep(&ext, &root, staged))
}

/// Keeps `staged` for [`install_extension`] and returns what it is. Only
/// the latest one waits: an earlier preview the person left is thrown away.
fn keep(ext: &Extensions, root: &std::path::Path, staged: Staged) -> Value {
    let preview = staged.preview(root);
    let mut waiting = ext.staged.lock().unwrap_or_else(|e| e.into_inner());
    for (id, _) in waiting.drain() {
        install::discard(root, &id);
    }
    waiting.insert(staged.id.clone(), staged);
    preview
}

/// Gets a new version of an installed extension from where it came from,
/// as [`stage_extension`] does.
#[tauri::command]
pub async fn stage_extension_update(ext: State<'_, Extensions>, name: String) -> CmdResult<Value> {
    let root = root()?;
    let names = builtin_names();
    let taken: Vec<&str> = names.iter().map(String::as_str).collect();
    let staged = install::stage_update(&root, &name, &taken)
        .await
        .map_err(install_err)?;
    Ok(keep(&ext, &root, staged))
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

/// Sets the registry index URLs, in order (earlier ones win a name).
#[tauri::command]
pub fn set_extension_registries(urls: Vec<String>) -> CmdResult<()> {
    install::set_registry_urls(&urls).map_err(|e| err("REGISTRY_INVALID", e))
}

/// The extensions the registries offer, and the registries that could not
/// be read.
#[tauri::command]
pub async fn fetch_extension_registry() -> CmdResult<Value> {
    let urls = install::registry_urls();
    Ok(json!(install::fetch_registries(&urls).await))
}

/// Restarts Studio so installed, updated or turned-off extensions take effect.
#[tauri::command]
pub fn restart_for_extensions(app: AppHandle) {
    app.restart()
}
