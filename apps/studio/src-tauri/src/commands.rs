//! Tauri commands. Arguments arrive camelCased from the frontend; results
//! and errors use the shared types generated into `@shikigami/schema`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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

#[tauri::command]
pub fn workspace_info(state: State<'_, AppState>) -> WorkspaceInfo {
    state.service.store().info()
}

/// Makes `path` the default workspace (shared by the CLI and the MCP server)
/// and restarts Studio on it. `shared` marks a new folder for several people.
#[tauri::command]
pub fn set_workspace(app: AppHandle, path: String, shared: bool) -> CmdResult<()> {
    if std::env::var_os("SHIKIGAMI_HOME").is_some() {
        return Err(err(
            "WORKSPACE_OVERRIDDEN",
            "SHIKIGAMI_HOME が設定されているため、保存先はその値に固定されています",
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

/// The version unattended runs execute (`shikigami run <id>`), if any.
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

/// Writes a bundle into the Downloads folder and returns its path.
#[tauri::command]
pub fn export_flow(state: State<'_, AppState>, id: FlowId) -> CmdResult<String> {
    let bundle = state.service.export(&id, true)?;
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| err("STORAGE_ERROR", "保存先フォルダが見つかりません"))?;
    let stem: String = bundle
        .flow
        .name
        .chars()
        .map(|c| {
            if r#"\/:*?"<>|"#.contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = if stem.trim().is_empty() {
        "flow".to_owned()
    } else {
        stem
    };
    let mut path = dir.join(format!("{stem}.shikigami.json"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).shikigami.json"));
        n += 1;
    }
    let json =
        serde_json::to_vec_pretty(&bundle).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    Ok(path.display().to_string())
}

// -- an AI without MCP (Copilot, a chat window) --------------------------

/// Writes the guide for an AI without MCP (instructions and reference, see
/// `shikigami_core::chat`) into `Downloads\Shikigami AI 仕様書`, opens the
/// folder and returns its path.
#[tauri::command]
pub fn save_ai_guide(state: State<'_, AppState>) -> CmdResult<String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| err("STORAGE_ERROR", "保存先フォルダが見つかりません"))?
        .join("Shikigami AI 仕様書");
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
            "大きすぎるため Studio では開けません",
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
    let handle = state
        .runtime
        .start(
            flow,
            RunOptions {
                project_dir,
                full_run: true,
                inputs: inputs.unwrap_or_default(),
                run_id: None,
                version,
                debug: Some(DebugOptions {
                    pause_on_error: true,
                    breakpoints: debug.breakpoints,
                    pause_at_start: debug.step,
                }),
                subflows,
                origin: RunOrigin::new(RunTrigger::Studio),
                ..RunOptions::default()
            },
        )
        .map_err(|e| ErrorPayload {
            code: e.code,
            message: e.message,
            details: e.details,
        })?;
    track_run(app, &state, id, handle, RUN_EVENT)
}

/// Records a started run, sends its events to the windows as `event`, and
/// keeps it in the registry (for `stop_run`) until it ends.
pub(crate) fn track_run(
    app: AppHandle,
    state: &AppState,
    id: FlowId,
    handle: shikigami_runtime::RunHandle,
    event_name: &'static str,
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
                username: String::new(),
                sites: s.sites,
                fields: s.fields,
                description: s.description,
                signed_in: s.signed_in,
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
