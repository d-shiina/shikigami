//! Tauri commands. Arguments arrive camelCased from the frontend; results
//! and errors use the shared types generated into `@shikigami/schema`.

use serde::Serialize;
use serde_json::{Map, Value};
use shikigami_core::{
    Actor, ActorKind, EditOp, EditOutcome, ErrorPayload, HistoryEntry, NewScenario, RunId,
    Scenario, ScenarioId, ScenarioSummary, StepTypeDef, ValidationReport,
};
use shikigami_runtime::record::RunRecorder;
use shikigami_runtime::{RunEventEnvelope, RunOptions, RunSnapshot};
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    root: String,
}

#[tauri::command]
pub fn workspace_info(state: State<'_, AppState>) -> WorkspaceInfo {
    WorkspaceInfo {
        root: state.service.store().root().display().to_string(),
    }
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
    let handle = state
        .runtime
        .start(
            scenario,
            RunOptions {
                inputs: inputs.unwrap_or_default(),
                run_id: None,
                ..RunOptions::default()
            },
        )
        .map_err(|e| ErrorPayload {
            code: e.code,
            message: e.message,
            details: e.details,
        })?;
    let run_id = handle.run_id.clone();
    let mut recorder = RunRecorder::create(state.service.store().root(), &run_id)
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
