//! Tauri commands. Arguments arrive camelCased from the frontend; results
//! and errors use the shared types generated into `@shikigami/schema`.

use serde::Serialize;
use serde_json::{Map, Value};
use shikigami_core::{
    Actor, ActorKind, ChangeNote, EditOp, EditOutcome, ErrorPayload, Evidence, ExtractOutcome,
    FileStore, HistoryEntry, ImportConflict, ImportOutcome, NewReview, NewScenario, NewVersion,
    ObservationContent, ObservationId, ReviewTimeline, RunId, Scenario, ScenarioDiff, ScenarioId,
    ScenarioSummary, StepId, StepTypeDef, UserConfig, ValidationReport, VersionSummary,
    WorkspaceInfo, WorkspaceManifest,
};
use shikigami_runtime::record::RunRecorder;
use shikigami_runtime::{RunEventEnvelope, RunOptions, RunSnapshot};
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
pub fn list_versions(state: State<'_, AppState>, id: ScenarioId) -> CmdResult<Vec<VersionSummary>> {
    Ok(state.service.list_versions(&id)?)
}

#[tauri::command]
pub fn create_version(
    state: State<'_, AppState>,
    id: ScenarioId,
    expected_revision: Option<u64>,
    input: NewVersion,
) -> CmdResult<VersionSummary> {
    Ok(state
        .service
        .create_version(&id, input, expected_revision, studio())?)
}

/// `from` / `to` are version numbers; omitted means the current content.
#[tauri::command]
pub fn diff_versions(
    state: State<'_, AppState>,
    id: ScenarioId,
    from: Option<u32>,
    to: Option<u32>,
) -> CmdResult<ScenarioDiff> {
    Ok(state.service.diff_versions(&id, from, to)?)
}

#[tauri::command]
pub fn restore_version(
    state: State<'_, AppState>,
    id: ScenarioId,
    number: u32,
    expected_revision: Option<u64>,
) -> CmdResult<EditOutcome> {
    Ok(state
        .service
        .restore_version(&id, number, expected_revision, studio())?)
}

/// Writes a bundle into the Downloads folder and returns its path.
#[tauri::command]
pub fn export_scenario(state: State<'_, AppState>, id: ScenarioId) -> CmdResult<String> {
    let bundle = state.service.export(&id, true)?;
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| err("STORAGE_ERROR", "保存先フォルダが見つかりません"))?;
    let stem: String = bundle
        .scenario
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
        "scenario".to_owned()
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

/// Imports the text of a bundle or scenario file chosen in the UI.
#[tauri::command]
pub fn import_scenario(
    state: State<'_, AppState>,
    contents: String,
    on_conflict: Option<ImportConflict>,
) -> CmdResult<ImportOutcome> {
    let value: Value = serde_json::from_str(&contents)
        .map_err(|e| err("PARSE_ERROR", format!("JSON として読めません: {e}")))?;
    Ok(state.service.import_bundle(value, on_conflict, studio())?)
}

#[tauri::command]
pub fn list_scenarios(state: State<'_, AppState>) -> CmdResult<Vec<ScenarioSummary>> {
    Ok(state.service.list()?)
}

#[tauri::command]
pub fn get_scenario(state: State<'_, AppState>, id: ScenarioId) -> CmdResult<Scenario> {
    Ok(state.service.get(&id)?)
}

#[tauri::command]
pub fn create_scenario(state: State<'_, AppState>, input: NewScenario) -> CmdResult<EditOutcome> {
    Ok(state.service.create(input, studio())?)
}

#[tauri::command]
pub fn duplicate_scenario(
    state: State<'_, AppState>,
    id: ScenarioId,
    name: Option<String>,
) -> CmdResult<EditOutcome> {
    Ok(state.service.duplicate(&id, name, studio())?)
}

#[tauri::command]
pub fn delete_scenario(
    state: State<'_, AppState>,
    id: ScenarioId,
    expected_revision: Option<u64>,
) -> CmdResult<()> {
    Ok(state.service.delete(&id, expected_revision, studio())?)
}

/// Moves neighbouring steps into a new scenario called from where they were.
#[tauri::command]
pub fn extract_subscenario(
    state: State<'_, AppState>,
    id: ScenarioId,
    expected_revision: Option<u64>,
    step_ids: Vec<StepId>,
    name: String,
) -> CmdResult<ExtractOutcome> {
    Ok(state.service.extract_subscenario(
        &id,
        expected_revision,
        &step_ids,
        &name,
        studio(),
        ChangeNote::default(),
    )?)
}

#[tauri::command]
pub fn edit_scenario(
    state: State<'_, AppState>,
    id: ScenarioId,
    expected_revision: Option<u64>,
    ops: Vec<EditOp>,
) -> CmdResult<EditOutcome> {
    Ok(state.service.edit(&id, expected_revision, ops, studio())?)
}

#[tauri::command]
pub fn undo(
    state: State<'_, AppState>,
    id: ScenarioId,
    expected_revision: Option<u64>,
) -> CmdResult<EditOutcome> {
    Ok(state.service.undo(&id, expected_revision, studio())?)
}

#[tauri::command]
pub fn redo(
    state: State<'_, AppState>,
    id: ScenarioId,
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
pub fn undo_state(state: State<'_, AppState>, id: ScenarioId) -> CmdResult<UndoState> {
    let (can_undo, can_redo) = state.service.undo_state(&id)?;
    Ok(UndoState { can_undo, can_redo })
}

#[tauri::command]
pub fn validate_scenario(
    state: State<'_, AppState>,
    id: ScenarioId,
) -> CmdResult<ValidationReport> {
    Ok(state.service.validate_stored(&id)?)
}

#[tauri::command]
pub fn list_step_types(state: State<'_, AppState>) -> Vec<StepTypeDef> {
    state.service.registry().iter().cloned().collect()
}

#[tauri::command]
pub fn scenario_history(
    state: State<'_, AppState>,
    id: ScenarioId,
    limit: Option<usize>,
) -> CmdResult<Vec<HistoryEntry>> {
    Ok(state.service.history(&id, limit.unwrap_or(100))?)
}

/// Changes since the last approval (or `since`) with their summaries, the
/// AI's test runs, the screens it based changes on, and the reviews.
#[tauri::command]
pub fn review_timeline(
    state: State<'_, AppState>,
    id: ScenarioId,
    since: Option<u64>,
) -> CmdResult<ReviewTimeline> {
    Ok(state.service.review_timeline(&id, since)?)
}

/// Approves the current revision or sends it back with a reason the AI
/// reads over MCP (get_scenario `feedback`, get_review).
#[tauri::command]
pub fn submit_review(
    state: State<'_, AppState>,
    id: ScenarioId,
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

/// Starts a run of the stored scenario. Events are emitted as `run-event`
/// and recorded under `<workspace>/runs/<run-id>/`.
#[tauri::command]
pub async fn run_scenario(
    app: AppHandle,
    state: State<'_, AppState>,
    id: ScenarioId,
    inputs: Option<Map<String, Value>>,
) -> CmdResult<RunId> {
    let scenario = state.service.get_runnable(&id)?;
    let version = state.service.matching_version(&scenario).ok().flatten();
    let subscenarios = state.service.subscenarios(&scenario)?;
    let handle = state
        .runtime
        .start(
            scenario,
            RunOptions {
                inputs: inputs.unwrap_or_default(),
                run_id: None,
                version,
                subscenarios,
                ..RunOptions::default()
            },
        )
        .map_err(|e| ErrorPayload {
            code: e.code,
            message: e.message,
            details: e.details,
        })?;
    let run_id = handle.run_id.clone();
    let mut recorder = RunRecorder::create(state.service.store().local_root(), &run_id)
        .map_err(|e| err("STORAGE_ERROR", e.to_string()))?;

    if let Ok(mut runs) = state.runs.lock() {
        runs.insert(
            run_id.clone(),
            ActiveRun {
                cancel: handle.cancel_token(),
                snapshot: handle.snapshot_cell(),
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
                if let Err(e) = emit_app.emit(RUN_EVENT, event) {
                    tracing::warn!(error = %e, "failed to emit run event");
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
    run.cancel.cancel();
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
