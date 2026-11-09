//! Tauri commands. Arguments arrive camelCased from the frontend; results
//! and errors use the shared types generated into `@shikigami/schema`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shikigami_core::distribution::{DistributionFolder, DistributionView};
use shikigami_core::package::{PackageManifest, PackageOptions, PackagePlan, PackagePreview};
use shikigami_core::{
    Actor, ActorKind, ApprovalId, ApprovalRequest, ChangeNote, EditOp, EditOutcome, ErrorPayload,
    Evidence, ExtractOutcome, FileStore, Flow, FlowDiff, FlowId, FlowSummary, HistoryEntry,
    ImportConflict, ImportOutcome, NewFlow, NewReview, NewVersion, ObservationContent,
    ObservationId, PickId, PickRequest, PickRequestStore, Policy, ProjectFile, ProjectFiles,
    PublishInput, PublishedState, ReviewTimeline, RunId, StepId, StepTypeDef, UserConfig,
    ValidationReport, VersionSummary, WorkspaceInfo, WorkspaceManifest,
};
use shikigami_runtime::record::RunRecorder;
use shikigami_runtime::{
    DebugOptions, RunEvent, RunEventEnvelope, RunOptions, RunOrigin, RunSnapshot, RunTrigger,
};
use shikigami_secrets::{PendingSecretRequest, SecretInfo, SecretInput};
use tauri::{AppHandle, Emitter, State};

use crate::{ActiveRun, AppState};

pub(crate) const RUN_EVENT: &str = "run-event";

type CmdResult<T> = Result<T, ErrorPayload>;

fn studio() -> Actor {
    Actor::new(ActorKind::Studio)
}

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// The clipboard's text for Studio's paste. `navigator.clipboard.readText`
/// in WebView2 asks the person for clipboard access first, which looks
/// alarming in a desktop app, so Studio reads it from Windows itself.
#[tauri::command]
pub async fn read_clipboard_text() -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(shikigami_system::clipboard_text)
        .await
        .map_err(|e| err("INTERNAL", e.to_string()))?
        .map_err(|e| err("CLIPBOARD_BUSY", e.message))
}

#[tauri::command]
pub fn workspace_info(state: State<'_, AppState>) -> WorkspaceInfo {
    state.service.store().info()
}

/// Makes `path` the default workspace (shared by the CLI and the MCP server)
/// and restarts Studio on it. `shared` marks a new folder for several people.
#[tauri::command]
pub fn set_workspace(app: AppHandle, path: String, shared: bool) -> CmdResult<()> {
    if let Some(name) = shikigami_core::paths::env_var_name("HOME") {
        return Err(err(
            "WORKSPACE_OVERRIDDEN",
            format!("{name} が設定されているため、保存先はその値に固定されています"),
        ));
    }
    let dir = std::path::absolute(path.trim())
        .map_err(|e| err("INVALID_PATH", format!("フォルダを指定できません: {e}")))?;
    if shared {
        FileStore::init(&dir, &WorkspaceManifest { shared: true })?;
    }
    FileStore::open(&dir)?;
    let mut config = UserConfig::load();
    config.workspace = Some(dir);
    config.save()?;
    app.restart()
}

#[tauri::command]
pub fn list_versions(state: State<'_, AppState>, id: FlowId) -> CmdResult<Vec<VersionSummary>> {
    Ok(state.service.list_versions(&id)?)
}

#[tauri::command]
pub fn create_version(
    state: State<'_, AppState>,
    id: FlowId,
    expected_revision: Option<u64>,
    input: NewVersion,
) -> CmdResult<VersionSummary> {
    Ok(state
        .service
        .create_version(&id, input, expected_revision, studio())?)
}

/// The version unattended runs execute (`spellsheet run <id>`), if any.
#[tauri::command]
pub fn published_state(
    state: State<'_, AppState>,
    id: FlowId,
) -> CmdResult<Option<PublishedState>> {
    Ok(state.service.published(&id)?)
}

#[tauri::command]
pub fn publish_flow(
    state: State<'_, AppState>,
    id: FlowId,
    input: PublishInput,
) -> CmdResult<PublishedState> {
    Ok(state.service.publish(&id, input, studio())?)
}

/// The review desk's 「確認して公開」: approves `revision` and publishes it.
#[tauri::command]
pub fn approve_and_publish(
    state: State<'_, AppState>,
    id: FlowId,
    revision: u64,
    reason: Option<String>,
    input: Option<PublishInput>,
) -> CmdResult<PublishedState> {
    Ok(state.service.approve_and_publish(
        &id,
        revision,
        reason.unwrap_or_default(),
        input.unwrap_or_default(),
        studio(),
    )?)
}

#[tauri::command]
pub fn unpublish_flow(state: State<'_, AppState>, id: FlowId) -> CmdResult<()> {
    Ok(state.service.unpublish(&id, String::new(), studio())?)
}

/// The workspace policy (`policy.json`), or the defaults.
#[tauri::command]
pub fn get_policy(state: State<'_, AppState>) -> CmdResult<Policy> {
    Ok(Policy::load(&Policy::path(state.service.store().root()))?)
}

/// Saves `policy.json`. Only Studio and the CLI write it, never an AI client.
#[tauri::command]
pub fn save_policy(state: State<'_, AppState>, policy: Policy) -> CmdResult<Policy> {
    let path = Policy::path(state.service.store().root());
    policy.save(&path)?;
    Ok(Policy::load(&path)?)
}

/// Requests from AI clients waiting for the person (oldest first).
#[tauri::command]
pub fn list_approvals(state: State<'_, AppState>) -> CmdResult<Vec<ApprovalRequest>> {
    Ok(state.approvals.pending()?)
}

/// AI clients waiting for the person to point at something in the browser.
#[tauri::command]
pub fn list_pick_requests(state: State<'_, AppState>) -> CmdResult<Vec<PickRequest>> {
    Ok(PickRequestStore::new(state.service.store().local_root()).pending()?)
}

/// The person declines: the AI's banner in the browser closes and it is told so.
#[tauri::command]
pub fn cancel_pick_request(state: State<'_, AppState>, id: PickId) -> CmdResult<()> {
    Ok(PickRequestStore::new(state.service.store().local_root()).cancel(&id)?)
}

#[tauri::command]
pub fn decide_approval(
    state: State<'_, AppState>,
    id: ApprovalId,
    approve: bool,
) -> CmdResult<ApprovalRequest> {
    Ok(state.approvals.decide(&id, approve, studio())?)
}

/// `from` / `to` are version numbers; omitted means the current content.
#[tauri::command]
pub fn diff_versions(
    state: State<'_, AppState>,
    id: FlowId,
    from: Option<u32>,
    to: Option<u32>,
) -> CmdResult<FlowDiff> {
    Ok(state.service.diff_versions(&id, from, to)?)
}

#[tauri::command]
pub fn restore_version(
    state: State<'_, AppState>,
    id: FlowId,
    number: u32,
    expected_revision: Option<u64>,
) -> CmdResult<EditOutcome> {
    Ok(state
        .service
        .restore_version(&id, number, expected_revision, studio())?)
}

/// A free path for `name` in the Downloads folder (`name (2).spx`, …).
fn download_path(name: &str) -> CmdResult<std::path::PathBuf> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| err("STORAGE_ERROR", "保存先フォルダーが見つかりません"))?;
    let path = dir.join(name);
    if !path.exists() {
        return Ok(path);
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let mut n = 2;
    loop {
        let path = dir.join(format!("{stem} ({n}).{ext}"));
        if !path.exists() {
            return Ok(path);
        }
        n += 1;
    }
}

fn windows_user() -> Option<String> {
    std::env::var("USERNAME").ok().filter(|s| !s.is_empty())
}

/// Writes the flow as a `.spx` file (default choices) into the Downloads
/// folder and returns its path. Several flows at once use this.
#[tauri::command]
pub fn export_flow(state: State<'_, AppState>, id: FlowId) -> CmdResult<String> {
    let options = PackageOptions {
        exported_by: windows_user(),
        ..PackageOptions::default()
    };
    Ok(write_package_file(&state, &id, options)?.path)
}

/// What handing over a flow would put in the file, for the 「渡す」 dialog.
#[tauri::command]
pub fn package_plan(
    state: State<'_, AppState>,
    id: FlowId,
    content: Option<shikigami_core::package::PackageContent>,
) -> CmdResult<PackagePlan> {
    Ok(state
        .service
        .package_plan(&id, content.unwrap_or_default())?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedPackage {
    pub path: String,
    pub manifest: PackageManifest,
}

/// Writes the flow as a `.spx` file into the Downloads folder.
#[tauri::command]
pub fn export_package(
    state: State<'_, AppState>,
    id: FlowId,
    options: PackageOptions,
) -> CmdResult<ExportedPackage> {
    write_package_file(&state, &id, options)
}

fn write_package_file(
    state: &AppState,
    id: &FlowId,
    mut options: PackageOptions,
) -> CmdResult<ExportedPackage> {
    if options.exported_by.is_none() {
        options.exported_by = windows_user();
    }
    let (manifest, bytes) = state.service.export_package(id, &options)?;
    let path = download_path(&shikigami_core::package::file_name(
        &manifest.flow.name,
        manifest.flow.version.as_ref().map(|v| v.number),
    ))?;
    std::fs::write(&path, bytes).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    Ok(ExportedPackage {
        path: path.display().to_string(),
        manifest,
    })
}

/// Shows a file selected in Explorer.
/// The 配布フォルダー this PC looks at.
#[tauri::command]
pub fn distribution_folders(state: State<'_, AppState>) -> CmdResult<Vec<DistributionFolder>> {
    Ok(state.service.distribution_folders()?)
}

#[tauri::command]
pub fn set_distribution_folders(
    state: State<'_, AppState>,
    folders: Vec<DistributionFolder>,
) -> CmdResult<Vec<DistributionFolder>> {
    Ok(state.service.set_distribution_folders(folders)?)
}

/// What each 配布フォルダー holds now. Reading a file server can be slow,
/// so it runs off the main thread.
#[tauri::command]
pub async fn scan_distribution(state: State<'_, AppState>) -> CmdResult<Vec<DistributionView>> {
    let service = state.service.clone();
    Ok(
        tauri::async_runtime::spawn_blocking(move || service.scan_distribution())
            .await
            .map_err(|e| err("INTERNAL", e.to_string()))??,
    )
}

/// Puts the published version of a flow into a 配布フォルダー.
#[tauri::command]
pub async fn place_in_distribution(
    state: State<'_, AppState>,
    id: FlowId,
    folder: String,
    only: Option<Vec<shikigami_core::package::FileRef>>,
) -> CmdResult<String> {
    let service = state.service.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        service.place_in_distribution(&id, &folder, only, windows_user())
    })
    .await
    .map_err(|e| err("INTERNAL", e.to_string()))??;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reveal_file(path: String) -> CmdResult<()> {
    let result = if cfg!(windows) {
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
    } else {
        let dir = std::path::Path::new(&path)
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_default();
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };
    result
        .map(|_| ())
        .map_err(|e| err("OPEN_FAILED", e.to_string()))
}

/// A flow file to look at or import: a path on disk (opened from Explorer,
/// dropped on the window) or the contents of a file chosen in the page
/// (base64).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowFile {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
}

fn file_bytes(file: &FlowFile) -> CmdResult<Vec<u8>> {
    use base64::Engine as _;
    match (&file.path, &file.data) {
        (Some(path), _) => std::fs::read(path)
            .map_err(|e| err("FILE_NOT_FOUND", format!("{path} を読めません: {e}"))),
        (None, Some(data)) => base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| err("PARSE_ERROR", e.to_string())),
        (None, None) => Err(err("PARSE_ERROR", "ファイルがありません")),
    }
}

/// What a flow file holds and what this PC still needs, before importing.
#[tauri::command]
pub fn preview_package(state: State<'_, AppState>, file: FlowFile) -> CmdResult<PackagePreview> {
    let secrets: Vec<String> = state
        .vault
        .summaries()
        .map(|list| list.into_iter().map(|s| s.name).collect())
        .unwrap_or_default();
    Ok(state.service.preview_file(&file_bytes(&file)?, &secrets)?)
}

/// Imports a flow file (`.spx`, an older bundle, or a flow JSON file).
#[tauri::command]
pub fn import_package(
    state: State<'_, AppState>,
    file: FlowFile,
    on_conflict: Option<ImportConflict>,
) -> CmdResult<ImportOutcome> {
    Ok(state
        .service
        .import_file(&file_bytes(&file)?, on_conflict, studio())?)
}

// -- an AI without MCP (Copilot, a chat window) --------------------------

/// Writes the guide for an AI without MCP (instructions and reference, see
/// `shikigami_core::chat`) into `Downloads\SpellSheet AI 仕様書`, opens the
/// folder and returns its path.
#[tauri::command]
pub fn save_ai_guide(state: State<'_, AppState>) -> CmdResult<String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| err("STORAGE_ERROR", "保存先フォルダが見つかりません"))?
        .join("SpellSheet AI 仕様書");
    std::fs::create_dir_all(&dir).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    for file in shikigami_core::chat::guide(state.service.registry()) {
        std::fs::write(dir.join(&file.name), file.text)
            .map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    }
    let opener = if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    // Only a convenience: the path is shown either way.
    let _ = std::process::Command::new(opener).arg(&dir).spawn();
    Ok(dir.display().to_string())
}

/// What pasting an AI's answer did: the flow it made or changed, or the
/// problems to send back to the AI (nothing was changed then).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<EditOutcome>,
    problems: Vec<shikigami_core::chat::AnswerProblem>,
}

/// Takes in an answer pasted from an AI chat: a new flow, or with `into`
/// the new content of that flow (one undoable edit). Recorded as the AI's
/// change, so it waits in 確認待ち like an MCP edit; only a person publishes.
#[tauri::command]
pub fn paste_ai_answer(
    state: State<'_, AppState>,
    text: String,
    into: Option<FlowId>,
    expected_revision: Option<u64>,
) -> CmdResult<PasteOutcome> {
    let answer = match shikigami_core::chat::read_answer(&text) {
        Ok(answer) => answer,
        Err(problems) => {
            return Ok(PasteOutcome {
                outcome: None,
                problems,
            });
        }
    };
    let actor = Actor::named(ActorKind::Chat, "AI（貼り付け）");
    let outcome = state
        .service
        .apply_answer(answer, into.as_ref(), expected_revision, actor)?;
    Ok(PasteOutcome {
        outcome: Some(outcome),
        problems: Vec::new(),
    })
}

/// Imports the text of a bundle or flow file chosen in the UI.
#[tauri::command]
pub fn import_flow(
    state: State<'_, AppState>,
    contents: String,
    on_conflict: Option<ImportConflict>,
) -> CmdResult<ImportOutcome> {
    let value: Value = serde_json::from_str(&contents)
        .map_err(|e| err("PARSE_ERROR", format!("JSON として読めません: {e}")))?;
    Ok(state.service.import_bundle(value, on_conflict, studio())?)
}

// -- the flow's folder ----------------------------------------------------

#[tauri::command]
pub fn project_files(state: State<'_, AppState>, id: FlowId) -> CmdResult<ProjectFiles> {
    Ok(state.service.project_files(&id)?)
}

/// A text file of the flow's folder (settings, CSV, notes) for the
/// editor. Files that are not UTF-8 text are opened with their app instead.
#[tauri::command]
pub fn read_project_text(
    state: State<'_, AppState>,
    id: FlowId,
    path: String,
) -> CmdResult<String> {
    let bytes = state.service.read_project_file(&id, &path)?;
    if bytes.len() as u64 > shikigami_core::project::MAX_TEXT_READ {
        return Err(err(
            "PROJECT_FILE_TOO_LARGE",
            "大きすぎるため Writer では開けません",
        ));
    }
    let text = String::from_utf8(bytes)
        .ok()
        .filter(|t| !t.contains('\0'))
        .ok_or_else(|| err("PROJECT_FILE_NOT_TEXT", "テキストファイルではありません"))?;
    Ok(text
        .strip_prefix('\u{feff}')
        .map(str::to_owned)
        .unwrap_or(text))
}

/// A picture of the flow's folder (an image part's PNG) as a data URL, for
/// Studio to show. Missing files come back as `None`.
#[tauri::command]
pub fn read_project_image(
    state: State<'_, AppState>,
    id: FlowId,
    path: String,
) -> CmdResult<Option<String>> {
    use base64::Engine as _;
    let Ok(bytes) = state.service.read_project_file(&id, &path) else {
        return Ok(None);
    };
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(err(
            "PROJECT_FILE_TOO_LARGE",
            "大きすぎるため Writer では表示できません",
        ));
    }
    let kind = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else {
        return Ok(None);
    };
    Ok(Some(format!(
        "data:{kind};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    )))
}

/// The columns of the table a node reads (an Excel sheet, a CSV file), read
/// from its file now, so a repeat over its rows can offer them before any
/// run. Empty when the node reads no table or the file is not there yet.
#[tauri::command]
pub async fn table_columns(
    state: State<'_, AppState>,
    id: FlowId,
    step_type: String,
    params: Value,
) -> CmdResult<Vec<String>> {
    let folder = state.service.project_dir(&id)?;
    let adapters = state.adapters.clone();
    Ok(tokio::task::spawn_blocking(move || {
        shikigami_adapters::table_columns(&adapters, &step_type, &params, &folder)
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default())
}

/// What a file looks like at a glance, for the hover preview of a value
/// (a picture, the first rows of a table, the start of a text). A relative
/// path is in the flow's folder; a full path is read where it is. Never an
/// error: a path that cannot be read says why in its `kind`.
#[tauri::command]
pub async fn preview_file(
    state: State<'_, AppState>,
    id: Option<FlowId>,
    path: String,
    sheet: Option<String>,
) -> CmdResult<Value> {
    let path = path.trim().trim_matches('"').to_owned();
    if path.is_empty() || path.contains("{{") {
        return Ok(serde_json::json!({ "kind": "missing" }));
    }
    let full = std::path::PathBuf::from(&path);
    let target = if full.is_absolute() {
        full
    } else {
        let Some(id) = id else {
            return Ok(serde_json::json!({ "kind": "missing" }));
        };
        let relative = path.replace('\\', "/");
        match state
            .service
            .project_path(&id, relative.trim_start_matches("./"))
        {
            Ok(target) => target,
            Err(_) => return Ok(serde_json::json!({ "kind": "missing" })),
        }
    };
    Ok(tokio::task::spawn_blocking(move || {
        shikigami_adapters::preview::preview(&target, sheet.as_deref())
    })
    .await
    .unwrap_or_else(|e| serde_json::json!({ "kind": "unreadable", "message": e.to_string() })))
}

#[tauri::command]
pub fn write_project_text(
    state: State<'_, AppState>,
    id: FlowId,
    path: String,
    text: String,
    overwrite: bool,
) -> CmdResult<ProjectFile> {
    Ok(state
        .service
        .write_project_file(&id, &path, text.as_bytes(), overwrite)?)
}

/// A file picked in the browser's file dialog (its bytes, base64).
#[tauri::command]
pub fn upload_project_file(
    state: State<'_, AppState>,
    id: FlowId,
    path: String,
    data: String,
    overwrite: bool,
) -> CmdResult<ProjectFile> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| err("INVALID_INPUT", e.to_string()))?;
    Ok(state
        .service
        .write_project_file(&id, &path, &bytes, overwrite)?)
}

/// Files dropped from Explorer onto a folder of the tree. Each keeps its
/// name; an existing file is replaced only with `overwrite`.
#[tauri::command]
pub fn copy_into_project(
    state: State<'_, AppState>,
    id: FlowId,
    folder: String,
    paths: Vec<String>,
    overwrite: bool,
) -> CmdResult<Vec<ProjectFile>> {
    let mut added = Vec::new();
    for from in paths {
        let from = std::path::PathBuf::from(from);
        let Some(name) = from.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let to = if folder.is_empty() {
            name
        } else {
            format!("{folder}/{name}")
        };
        added.push(
            state
                .service
                .copy_into_project(&id, &from, &to, overwrite)?,
        );
    }
    Ok(added)
}

#[tauri::command]
pub fn create_project_folder(
    state: State<'_, AppState>,
    id: FlowId,
    path: String,
) -> CmdResult<()> {
    Ok(state.service.create_project_folder(&id, &path)?)
}

#[tauri::command]
pub fn rename_project_file(
    state: State<'_, AppState>,
    id: FlowId,
    from: String,
    to: String,
) -> CmdResult<ProjectFile> {
    Ok(state.service.rename_project_file(&id, &from, &to)?)
}

/// To the workspace trash; a standard folder (work/…) is emptied.
#[tauri::command]
pub fn delete_project_file(state: State<'_, AppState>, id: FlowId, path: String) -> CmdResult<()> {
    Ok(state.service.delete_project_file(&id, &path)?)
}

/// Opens a file with its app (Excel, Word, Notepad) or a folder in Explorer.
/// `reveal` shows the file selected in Explorer instead.
#[tauri::command]
pub fn open_project_file(
    state: State<'_, AppState>,
    id: FlowId,
    path: String,
    reveal: bool,
) -> CmdResult<()> {
    let target = if path.is_empty() {
        state.service.project_dir(&id)?
    } else {
        state.service.project_path(&id, &path)?
    };
    if !target.exists() {
        return Err(err(
            "PROJECT_FILE_NOT_FOUND",
            format!("{path} がありません"),
        ));
    }
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("explorer");
        if reveal {
            c.arg(format!("/select,{}", target.display()));
        } else {
            c.arg(&target);
        }
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(if reveal {
            target
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or(target)
        } else {
            target
        });
        c
    };
    command
        .spawn()
        .map(drop)
        .map_err(|e| err("OPEN_FAILED", format!("開けません: {e}")))
}

#[tauri::command]
pub fn list_flows(state: State<'_, AppState>) -> CmdResult<Vec<FlowSummary>> {
    Ok(state.service.list()?)
}

#[tauri::command]
pub fn get_flow(state: State<'_, AppState>, id: FlowId) -> CmdResult<Flow> {
    Ok(state.service.get(&id)?)
}

#[tauri::command]
pub fn create_flow(state: State<'_, AppState>, input: NewFlow) -> CmdResult<EditOutcome> {
    Ok(state.service.create(input, studio())?)
}

#[tauri::command]
pub fn duplicate_flow(
    state: State<'_, AppState>,
    id: FlowId,
    name: Option<String>,
) -> CmdResult<EditOutcome> {
    Ok(state.service.duplicate(&id, name, studio())?)
}

#[tauri::command]
pub fn delete_flow(
    state: State<'_, AppState>,
    id: FlowId,
    expected_revision: Option<u64>,
) -> CmdResult<()> {
    Ok(state.service.delete(&id, expected_revision, studio())?)
}

/// Moves neighbouring steps into a new flow called from where they were.
#[tauri::command]
pub fn extract_subflow(
    state: State<'_, AppState>,
    id: FlowId,
    expected_revision: Option<u64>,
    step_ids: Vec<StepId>,
    name: String,
) -> CmdResult<ExtractOutcome> {
    Ok(state.service.extract_subflow(
        &id,
        expected_revision,
        &step_ids,
        &name,
        studio(),
        ChangeNote::default(),
    )?)
}

#[tauri::command]
pub fn edit_flow(
    state: State<'_, AppState>,
    id: FlowId,
    expected_revision: Option<u64>,
    ops: Vec<EditOp>,
) -> CmdResult<EditOutcome> {
    Ok(state.service.edit(&id, expected_revision, ops, studio())?)
}

#[tauri::command]
pub fn undo(
    state: State<'_, AppState>,
    id: FlowId,
    expected_revision: Option<u64>,
) -> CmdResult<EditOutcome> {
    Ok(state.service.undo(&id, expected_revision, studio())?)
}

#[tauri::command]
pub fn redo(
    state: State<'_, AppState>,
    id: FlowId,
    expected_revision: Option<u64>,
) -> CmdResult<EditOutcome> {
    Ok(state.service.redo(&id, expected_revision, studio())?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    can_undo: bool,
    can_redo: bool,
}

#[tauri::command]
pub fn undo_state(state: State<'_, AppState>, id: FlowId) -> CmdResult<UndoState> {
    let (can_undo, can_redo) = state.service.undo_state(&id)?;
    Ok(UndoState { can_undo, can_redo })
}

#[tauri::command]
pub fn validate_flow(state: State<'_, AppState>, id: FlowId) -> CmdResult<ValidationReport> {
    Ok(state.service.validate_stored(&id)?)
}

#[tauri::command]
pub fn list_step_types(state: State<'_, AppState>) -> Vec<StepTypeDef> {
    state.service.registry().iter().cloned().collect()
}

/// Evaluates an expression against the values a run recorded, for the
/// result shown under an expression field. Functions have no side effects,
/// so this never touches files, the screen or the network.
#[tauri::command]
pub fn eval_expression(expression: String, values: Map<String, Value>) -> CmdResult<Value> {
    use shikigami_core::expr::{self, ExprError};
    expr::evaluate(&expression, &values).map_err(|e| {
        let details = match &e {
            ExprError::UndefinedVariable(name) => Some(serde_json::json!({ "variable": name })),
            ExprError::UnknownFunction(name) => Some(serde_json::json!({ "function": name })),
            _ => None,
        };
        ErrorPayload {
            code: e.code().to_owned(),
            message: e.to_string(),
            details,
        }
    })
}

#[tauri::command]
pub fn flow_history(
    state: State<'_, AppState>,
    id: FlowId,
    limit: Option<usize>,
) -> CmdResult<Vec<HistoryEntry>> {
    Ok(state.service.history(&id, limit.unwrap_or(100))?)
}

/// Changes since the last approval (or `since`) with their summaries, the
/// AI's test runs, the screens it based changes on, and the reviews.
#[tauri::command]
pub fn review_timeline(
    state: State<'_, AppState>,
    id: FlowId,
    since: Option<u64>,
) -> CmdResult<ReviewTimeline> {
    Ok(state.service.review_timeline(&id, since)?)
}

/// Approves the current revision or sends it back with a reason the AI
/// reads over MCP (get_flow `feedback`, get_review).
#[tauri::command]
pub fn submit_review(
    state: State<'_, AppState>,
    id: FlowId,
    input: NewReview,
) -> CmdResult<Evidence> {
    Ok(state.service.submit_review(&id, input, studio())?)
}

/// One observation with its UI tree and screenshot (data URL).
#[tauri::command]
pub fn get_observation(
    state: State<'_, AppState>,
    id: ObservationId,
) -> CmdResult<ObservationContent> {
    Ok(state.service.get_observation(&id)?)
}

/// How many of a flow's latest runs `step_times` learns from.
const STEP_TIMES_RUNS: usize = 5;

/// How long each step of a flow usually takes (ms, by step id), from its
/// latest finished runs: the chart shows a running step's progress against it.
#[tauri::command]
pub async fn step_times(
    state: State<'_, AppState>,
    id: FlowId,
) -> CmdResult<std::collections::HashMap<StepId, u64>> {
    let root = state.service.store().local_root().to_path_buf();
    Ok(tokio::task::spawn_blocking(move || {
        shikigami_runtime::record::step_times(&root, &id, STEP_TIMES_RUNS)
    })
    .await
    .unwrap_or_default())
}

/// Most events `run_record` returns; a long loop's tail is dropped.
const MAX_RECORD_EVENTS: usize = 20_000;

/// A finished run as recorded under `runs/<id>/`: its report and events, for
/// the review desk to show what an AI test run actually did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    report: Option<shikigami_runtime::RunReport>,
    events: Vec<RunEventEnvelope>,
    /// Events were dropped after `MAX_RECORD_EVENTS`.
    truncated: bool,
}

#[tauri::command]
pub fn run_record(state: State<'_, AppState>, run_id: RunId) -> CmdResult<RunRecord> {
    let root = state.service.store().local_root();
    let io = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => err("RUN_NOT_FOUND", format!("no run {run_id}")),
        _ => err("STORAGE_ERROR", e.to_string()),
    };
    let report = shikigami_runtime::record::read_report(root, &run_id).map_err(io)?;
    let mut events = shikigami_runtime::record::read_events(root, &run_id).map_err(io)?;
    let truncated = events.len() > MAX_RECORD_EVENTS;
    events.truncate(MAX_RECORD_EVENTS);
    Ok(RunRecord {
        report,
        events,
        truncated,
    })
}

/// How a Studio run pauses (see `shikigami_runtime::debug`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugSettings {
    #[serde(default)]
    breakpoints: Vec<shikigami_core::StepId>,
    /// Pause before the first step.
    #[serde(default)]
    step: bool,
    /// 「ここから実行」: start at this step (the ones before do not run).
    #[serde(default)]
    start_at: Option<shikigami_core::StepId>,
    /// The variables' values there, from the last run.
    #[serde(default)]
    start_values: Map<String, Value>,
}

/// Starts a run of the stored flow. Events are emitted as `run-event`
/// and recorded under `<workspace>/runs/<run-id>/`. Studio runs are
/// interactive: they pause on unhandled errors and at `debug.breakpoints`
/// (see `debug_run`).
#[tauri::command]
pub async fn run_flow(
    app: AppHandle,
    state: State<'_, AppState>,
    id: FlowId,
    inputs: Option<Map<String, Value>>,
    debug: Option<DebugSettings>,
) -> CmdResult<RunId> {
    let debug = debug.unwrap_or_default();
    let flow = state.service.get_runnable(&id)?;
    let version = state.service.matching_version(&flow).ok().flatten();
    let subflows = state.service.subflows(&flow)?;
    let project_dir = Some(state.service.project_dir(&id)?);
    // A run of the whole flow keeps the pictures for its 手順書.
    let run_id = RunId::generate();
    let screens_dir = debug
        .start_at
        .is_none()
        .then(|| crate::manual::screens_dir(state.service.store().local_root(), &id, &run_id))
        .flatten();
    let manual = screens_dir.clone().map(crate::manual::Collector::new);
    let handle = state
        .runtime
        .start(
            flow,
            RunOptions {
                project_dir,
                full_run: true,
                inputs: inputs.unwrap_or_default(),
                run_id: Some(run_id),
                screens_dir,
                version,
                debug: Some(DebugOptions {
                    pause_on_error: true,
                    breakpoints: debug.breakpoints,
                    pause_at_start: debug.step,
                }),
                subflows,
                origin: RunOrigin::new(RunTrigger::Studio),
                start_at: debug.start_at,
                start_values: debug.start_values,
                ..RunOptions::default()
            },
        )
        .map_err(|e| ErrorPayload {
            code: e.code,
            message: e.message,
            details: e.details,
        })?;
    track_run(app, &state, id, handle, RUN_EVENT, manual)
}

/// A test case with its name (`tests/<name>.json`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedTestCase {
    name: String,
    case: shikigami_core::testcase::TestCase,
}

/// The flow's test cases, in name order.
#[tauri::command]
pub fn list_test_cases(state: State<'_, AppState>, id: FlowId) -> CmdResult<Vec<NamedTestCase>> {
    let dir = state.service.project_dir(&id)?;
    Ok(shikigami_core::testcase::load_all(&dir)?
        .into_iter()
        .map(|(name, case)| NamedTestCase { name, case })
        .collect())
}

#[tauri::command]
pub fn save_test_case(
    state: State<'_, AppState>,
    id: FlowId,
    name: String,
    case: shikigami_core::testcase::TestCase,
) -> CmdResult<()> {
    let dir = state.service.project_dir(&id)?;
    shikigami_core::testcase::save(&dir, &name, &case)?;
    Ok(())
}

#[tauri::command]
pub fn delete_test_case(state: State<'_, AppState>, id: FlowId, name: String) -> CmdResult<()> {
    let dir = state.service.project_dir(&id)?;
    shikigami_core::testcase::remove(&dir, &name)?;
    Ok(())
}

/// What 「この実行をテストケースにする」 saved, and the values it left out
/// (secret inputs and outputs, values the record cut short).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseFromRun {
    name: String,
    case: shikigami_core::testcase::TestCase,
    left_out: Vec<String>,
}

/// Save a finished run of the flow as a test case that expects what it did.
#[tauri::command]
pub fn test_case_from_run(
    state: State<'_, AppState>,
    id: FlowId,
    run_id: RunId,
    name: String,
) -> CmdResult<CaseFromRun> {
    let root = state.service.store().local_root();
    let io = |e: std::io::Error| err("STORAGE_ERROR", e.to_string());
    let report = shikigami_runtime::record::read_report(root, &run_id)
        .map_err(io)?
        .ok_or_else(|| err("RUN_NOT_FINISHED", format!("run {run_id} has not ended")))?;
    if report.flow_id != id {
        return Err(err(
            "RUN_OF_ANOTHER_FLOW",
            format!("run {run_id} is not a run of {id}"),
        ));
    }
    let events = shikigami_runtime::record::read_events(root, &run_id).map_err(io)?;
    let flow = state.service.get(&id)?;
    let (case, left_out) = shikigami_runtime::testing::case_from_run(&flow, &events, &report);
    let dir = state.service.project_dir(&id)?;
    shikigami_core::testcase::save(&dir, &name, &case)?;
    Ok(CaseFromRun {
        name,
        case,
        left_out,
    })
}

/// Run the flow's test cases (all, or `names`) one after another with the
/// working content, as Run in Studio does, and compare. The runs are
/// recorded like any other; they do not pause on errors.
#[tauri::command]
pub async fn run_tests(
    state: State<'_, AppState>,
    id: FlowId,
    names: Option<Vec<String>>,
) -> CmdResult<Vec<shikigami_runtime::testing::CaseResult>> {
    use shikigami_core::testcase;
    use shikigami_runtime::testing;
    let flow = state.service.get_runnable(&id)?;
    let version = state.service.matching_version(&flow).ok().flatten();
    let subflows = state.service.subflows(&flow)?;
    let dir = state.service.project_dir(&id)?;
    let cases = match names {
        None => testcase::load_all(&dir)?,
        Some(names) => names
            .into_iter()
            .map(|name| testcase::load(&dir, &name).map(|case| (name, case)))
            .collect::<Result<_, _>>()?,
    };
    let interrupt = testing::Interrupt::default();
    {
        let mut slot = state
            .tests
            .lock()
            .map_err(|_| err("INTERNAL", "tests lock"))?;
        if slot.is_some() {
            return Err(err("TESTS_RUNNING", "the test cases are already running"));
        }
        *slot = Some(interrupt.clone());
    }
    let policy = Policy::path(state.service.store().root());
    let mut results = Vec::new();
    let mut failure = None;
    for (name, case) in cases {
        if interrupt.is_stopped() {
            break;
        }
        let options = RunOptions {
            inputs: case.inputs.clone(),
            version,
            subflows: subflows.clone(),
            project_dir: Some(dir.clone()),
            full_run: true,
            origin: RunOrigin::new(RunTrigger::Studio).requested_by(format!("test:{name}")),
            ..RunOptions::default()
        };
        let records = testing::Records {
            workspace: state.service.store().local_root(),
            policy: &policy,
        };
        match testing::run_case(
            &state.runtime,
            records,
            &interrupt,
            &name,
            &case,
            flow.clone(),
            options,
        )
        .await
        {
            Ok(result) => results.push(result),
            Err(e) => {
                failure = Some(ErrorPayload {
                    code: e.code,
                    message: format!("{name}: {}", e.message),
                    details: e.details,
                });
                break;
            }
        }
    }
    if let Ok(mut slot) = state.tests.lock() {
        *slot = None;
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(results),
    }
}

/// 「中止」 while the test cases run: cancels the one running now and
/// starts no more.
#[tauri::command]
pub fn stop_tests(state: State<'_, AppState>) {
    if let Ok(slot) = state.tests.lock()
        && let Some(interrupt) = slot.as_ref()
    {
        interrupt.stop();
    }
}

/// What 「ノードの単体実行」 gave: the node ran alone, with the values the
/// last run left (see `shikigami_runtime::single`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepTest {
    status: shikigami_runtime::RunStatus,
    output: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<shikigami_runtime::RunError>,
    logs: Vec<StepTestLog>,
}

#[derive(Debug, Serialize)]
pub struct StepTestLog {
    level: shikigami_runtime::LogLevel,
    message: String,
}

/// The browser that 「画面から選ぶ」 opens outside a run: a node run alone
/// works on the same page, so pick-then-run needs no run of the flow.
const STUDIO_BROWSER: &str = "studio-pick";

/// Runs one node of the stored flow on its own. Nothing before it runs:
/// `values` are the variables it reads, from the last run. The run is not
/// recorded under `runs/` (it is not a run of the flow).
#[tauri::command]
pub async fn test_step(
    state: State<'_, AppState>,
    id: FlowId,
    step_id: StepId,
    values: Option<Map<String, Value>>,
) -> CmdResult<StepTest> {
    let flow = state.service.get(&id)?;
    let step = flow
        .find_step(&step_id)
        .cloned()
        .ok_or_else(|| err("STEP_NOT_FOUND", format!("no step {step_id}")))?;
    let inputs = values.unwrap_or_default();
    // The screen it met is the node's picture in the 手順書 until a run
    // of the whole flow takes one.
    let mut draft = shikigami_runtime::drafts::DraftCapture::new(
        state.service.store().local_root(),
        &id,
        &step,
        Some(&flow.parts),
        shikigami_runtime::drafts::DraftSource::Studio,
    );
    let single = shikigami_runtime::single::flow_for(
        step,
        state.runtime.registry(),
        &inputs,
        shikigami_runtime::single::Context {
            flow_id: Some(id.clone()),
            parts: Some(&flow.parts),
        },
    )
    .map_err(|m| err("UNKNOWN_STEP_TYPE", m))?;
    let subflows = state.service.subflows(&flow)?;
    let handle = state
        .runtime
        .start(
            single.flow.clone(),
            RunOptions {
                inputs,
                run_id: Some(RunId::new(STUDIO_BROWSER)),
                keep_adapter_state: true,
                subflows,
                screens_dir: draft.as_ref().map(|d| d.screens_dir()),
                project_dir: Some(state.service.project_dir(&id)?),
                origin: RunOrigin::new(RunTrigger::Studio),
                ..RunOptions::default()
            },
        )
        .map_err(|e| ErrorPayload {
            code: e.code,
            message: e.message,
            details: e.details,
        })?;
    // 「中止」 stops it like any run (`stop_run` with this id).
    let run_id = handle.run_id.clone();
    if let Ok(mut runs) = state.runs.lock() {
        runs.insert(
            run_id.clone(),
            ActiveRun {
                cancel: handle.stopper(),
                snapshot: handle.snapshot_cell(),
                flow_id: id.clone(),
                debug: None,
            },
        );
    }
    let mut logs = Vec::new();
    let report = handle
        .wait_with(|event: &RunEventEnvelope| {
            if let Some(draft) = draft.as_mut() {
                draft.on_event(&event.event);
            }
            if let RunEvent::Log { level, message, .. } = &event.event {
                logs.push(StepTestLog {
                    level: *level,
                    message: message.clone(),
                });
            }
        })
        .await;
    if let Some(draft) = draft {
        draft.finish();
    }
    if let Ok(mut runs) = state.runs.lock() {
        runs.remove(&run_id);
    }
    let report = report.map_err(|e| err("INTERNAL", e.message))?;
    Ok(StepTest {
        status: report.status,
        output: single.result(&report.outputs),
        error: report.error,
        logs,
    })
}

/// Records a started run, sends its events to the windows as `event`, and
/// keeps it in the registry (for `stop_run`) until it ends.
pub(crate) fn track_run(
    app: AppHandle,
    state: &AppState,
    id: FlowId,
    handle: shikigami_runtime::RunHandle,
    event_name: &'static str,
    mut manual: Option<crate::manual::Collector>,
) -> CmdResult<RunId> {
    let run_id = handle.run_id.clone();
    let mut recorder = RunRecorder::create(state.service.store().local_root(), &run_id)
        .map_err(|e| err("STORAGE_ERROR", e.to_string()))?
        .prune_on_finish(&shikigami_core::Policy::path(state.service.store().root()));

    if let Ok(mut runs) = state.runs.lock() {
        runs.insert(
            run_id.clone(),
            ActiveRun {
                cancel: handle.stopper(),
                snapshot: handle.snapshot_cell(),
                flow_id: id.clone(),
                debug: handle.debug_control(),
            },
        );
    }

    let task_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let emit_app = app.clone();
        let result = handle
            .wait_with(|event: &RunEventEnvelope| {
                if let Err(e) = recorder.write_event(event) {
                    tracing::warn!(error = %e, "failed to record run event");
                }
                if let Some(manual) = manual.as_mut() {
                    manual.on_event(event);
                }
                if let Err(e) = emit_app.emit(event_name, event) {
                    tracing::warn!(error = %e, "failed to emit run event");
                }
                if let RunEvent::Paused {
                    reason: shikigami_runtime::PauseReason::Error,
                    step_id,
                    step_type,
                    ..
                } = &event.event
                {
                    crate::debug::capture_pause(
                        emit_app.clone(),
                        event.run_id.clone(),
                        id.clone(),
                        event.call_path.clone(),
                        step_id.clone(),
                        step_type.clone(),
                        event.seq,
                    );
                }
            })
            .await;
        match result {
            Ok(report) => {
                if let Err(e) = recorder.finish(&report) {
                    tracing::warn!(error = %e, "failed to write run report");
                }
                if let Some(manual) = manual.take() {
                    manual.finish(&report);
                }
            }
            Err(e) => tracing::error!(error = %e, "run task failed"),
        }
        use tauri::Manager;
        if let Some(state) = app.try_state::<AppState>()
            && let Ok(mut runs) = state.runs.lock()
        {
            runs.remove(&task_run_id);
        }
    });

    Ok(run_id)
}

#[tauri::command]
pub fn stop_run(state: State<'_, AppState>, run_id: RunId) -> CmdResult<()> {
    let runs = state
        .runs
        .lock()
        .map_err(|_| err("INTERNAL", "run registry poisoned"))?;
    let run = runs
        .get(&run_id)
        .ok_or_else(|| err("RUN_NOT_FOUND", format!("no active run {run_id}")))?;
    run.cancel.stop();
    Ok(())
}

#[tauri::command]
pub fn run_status(state: State<'_, AppState>, run_id: RunId) -> CmdResult<Option<RunSnapshot>> {
    let runs = state
        .runs
        .lock()
        .map_err(|_| err("INTERNAL", "run registry poisoned"))?;
    Ok(runs
        .get(&run_id)
        .and_then(|r| r.snapshot.lock().ok().map(|s| s.clone())))
}

// -- secrets ------------------------------------------------------------------
// Values go in (set_secret) but never come back out: the list has names,
// user names and sites only.

fn secret_err(e: shikigami_core::secret::SecretError) -> ErrorPayload {
    ErrorPayload {
        details: e.details(),
        code: e.code,
        message: e.message,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretList {
    secrets: Vec<SecretInfo>,
    /// Where the encryption key is kept (shown in the dialog).
    key_location: String,
    /// Secrets are registered but their key is not on this PC / Windows
    /// user: only names are listed, and `reset_secrets` is the way out.
    key_missing: bool,
}

#[tauri::command]
pub fn list_secrets(state: State<'_, AppState>) -> CmdResult<SecretList> {
    let vault = &state.vault;
    let key_missing = vault.key_missing().map_err(secret_err)?;
    let secrets = if key_missing {
        vault
            .summaries()
            .map_err(secret_err)?
            .into_iter()
            .map(|s| SecretInfo {
                name: s.name,
                kind: s.kind,
                username: String::new(),
                sites: s.sites,
                fields: s.fields,
                description: s.description,
                signed_in: s.signed_in,
                oauth: None,
                windows_credential: s.windows_credential,
                updated_at: String::new(),
            })
            .collect()
    } else {
        vault.list().map_err(secret_err)?
    };
    Ok(SecretList {
        secrets,
        key_location: vault.key_location(),
        key_missing,
    })
}

#[tauri::command]
pub fn reset_secrets(state: State<'_, AppState>) -> CmdResult<usize> {
    state.vault.reset().map_err(secret_err)
}

#[tauri::command]
pub fn set_secret(state: State<'_, AppState>, input: SecretInput) -> CmdResult<SecretInfo> {
    state.vault.set(input).map_err(secret_err)
}

/// Generic credentials of Windows Credential Manager a secret can be
/// linked to (addresses and user names only).
#[tauri::command]
pub fn list_windows_credentials(
    state: State<'_, AppState>,
) -> CmdResult<Vec<shikigami_secrets::WindowsCredentialInfo>> {
    state.vault.windows_credentials().map_err(secret_err)
}

#[tauri::command]
pub fn remove_secret(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    state.vault.remove(&name).map_err(secret_err)?;
    // A saved login under the same name belongs to the secret.
    state.vault.remove_session(&name).map_err(secret_err)?;
    Ok(())
}

/// Logins AI clients asked the user to register (names, sites and fields
/// only), oldest first.
#[tauri::command]
pub fn list_secret_requests(state: State<'_, AppState>) -> CmdResult<Vec<PendingSecretRequest>> {
    state.vault.requests().map_err(secret_err)
}

#[tauri::command]
pub fn dismiss_secret_request(state: State<'_, AppState>, name: String) -> CmdResult<bool> {
    state.vault.dismiss_request(&name).map_err(secret_err)
}

#[tauri::command]
pub fn forget_login(state: State<'_, AppState>, session: String) -> CmdResult<bool> {
    state.vault.remove_session(&session).map_err(secret_err)
}
