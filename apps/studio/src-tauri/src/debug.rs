//! Interactive runs: step commands, resuming with the latest revision, and
//! the screen a run paused on.

use serde::Serialize;
use serde_json::{Map, Value, json};
use shikigami_core::{
    Actor, ActorKind, ErrorPayload, NewObservation, ObservationContent, ObservationSource, RunId,
    ScenarioId, StepId,
};
use shikigami_runtime::{DebugCommand, RunError};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

pub(crate) const RUN_EVIDENCE_EVENT: &str = "run-evidence";

/// Longest UI tree sent to the frontend with the evidence (the stored
/// observation keeps more).
const TREE_PREVIEW_CHARS: usize = 12_000;

fn run_err(e: RunError) -> ErrorPayload {
    ErrorPayload {
        code: e.code,
        message: e.message,
        details: e.details,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugOutcome {
    /// The revision the run executes from now on.
    revision: u64,
    /// A newer revision (e.g. the AI's fix) was swapped in.
    updated: bool,
}

/// Sends a step command to a paused (or, for `pause` / `setBreakpoints`,
/// running) Studio run. Resuming commands first swap in the stored
/// revision when it is newer than the one the run executes, so a fix made
/// while paused applies; `RESUME_INCOMPATIBLE` when it no longer fits where
/// the run is.
#[tauri::command]
pub fn debug_run(
    state: State<'_, AppState>,
    run_id: RunId,
    command: DebugCommand,
) -> CmdResult<DebugOutcome> {
    let (control, scenario_id) = {
        let runs = state.runs.lock().map_err(|_| ErrorPayload {
            code: "INTERNAL".into(),
            message: "run registry poisoned".into(),
            details: None,
        })?;
        let run = runs.get(&run_id).ok_or_else(|| ErrorPayload {
            code: "RUN_NOT_FOUND".into(),
            message: format!("no active run {run_id}"),
            details: None,
        })?;
        let control = run.debug.clone().ok_or_else(|| ErrorPayload {
            code: "NOT_INTERACTIVE".into(),
            message: "this run cannot pause".into(),
            details: None,
        })?;
        (control, run.scenario_id.clone())
    };
    let resumes = !matches!(
        command,
        DebugCommand::Pause | DebugCommand::SetBreakpoints { .. } | DebugCommand::Abort
    );
    let mut updated = false;
    if resumes && control.is_paused() {
        let scenario = state.service.get(&scenario_id)?;
        if scenario.revision != control.revision() {
            updated = control.update_scenario(scenario).map_err(run_err)?;
        }
    }
    control.send(command).map_err(run_err)?;
    Ok(DebugOutcome {
        revision: control.revision(),
        updated,
    })
}

type CmdResult<T> = Result<T, ErrorPayload>;

/// What Studio shows (and hands the AI) about the screen a run paused on.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunEvidence {
    run_id: RunId,
    /// The `paused` event this belongs to.
    seq: u64,
    step_id: StepId,
    #[serde(skip_serializing_if = "Option::is_none")]
    observation: Option<ObservationContent>,
    /// Why there is no observation.
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
}

/// Looks at the application a failed step worked on (page tree and
/// screenshot for `browser.*`, the window's UI tree for `desktop.*`) and
/// keeps it as an observation the AI's fix can cite. Emitted as
/// `run-evidence`; steps of other types have nothing to look at.
pub(crate) fn capture_pause(
    app: AppHandle,
    run_id: RunId,
    scenario_id: ScenarioId,
    step_id: StepId,
    step_type: String,
    seq: u64,
) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let prefix = step_type.split('.').next().unwrap_or_default();
        let Some(adapter) = state.adapters.iter().find(|a| a.name() == prefix).cloned() else {
            return;
        };
        let mut params = Map::new();
        if let Ok(scenario) = state.service.get(&scenario_id)
            && let Some(step) = scenario.find_step(&step_id)
        {
            for key in ["context", "window"] {
                if let Some(value) = step.params.get(key) {
                    params.insert(key.into(), value.clone());
                }
            }
        }
        let request = Value::Object(params.clone());
        let shot = std::env::temp_dir().join(format!("shikigami-pause-{run_id}-{seq}.jpg"));
        if prefix == "browser" {
            params.insert(
                "screenshotPath".into(),
                Value::String(shot.display().to_string()),
            );
        }
        let looked = adapter
            .inspect(run_id.as_str(), Value::Object(params))
            .await;
        let screenshot = std::fs::read(&shot).ok();
        let _ = std::fs::remove_file(&shot);
        let evidence = match looked {
            Ok(screen) => {
                let tree = screen
                    .get("snapshot")
                    .and_then(Value::as_str)
                    .map(|t| state.vault.mask(t));
                let title = ["/title", "/url", "/window/title"]
                    .iter()
                    .find_map(|k| screen.pointer(k).and_then(Value::as_str))
                    .filter(|t| !t.is_empty())
                    .unwrap_or(&step_type)
                    .to_owned();
                let input = NewObservation {
                    source: ObservationSource::RunPause,
                    title: state.vault.mask(&title),
                    request: json!({ "runId": run_id, "stepId": step_id, "params": request }),
                    status: Some("failed".into()),
                    output: None,
                    tree,
                    screenshot,
                };
                match state
                    .service
                    .record_observation(input, Actor::new(ActorKind::Studio))
                    .and_then(|o| state.service.get_observation(&o.id))
                {
                    Ok(mut content) => {
                        if let Some(tree) = content.tree.as_mut()
                            && let Some((cut, _)) = tree.char_indices().nth(TREE_PREVIEW_CHARS)
                        {
                            tree.truncate(cut);
                            tree.push('…');
                        }
                        RunEvidence {
                            run_id,
                            seq,
                            step_id,
                            observation: Some(content),
                            problem: None,
                        }
                    }
                    Err(e) => RunEvidence {
                        run_id,
                        seq,
                        step_id,
                        observation: None,
                        problem: Some(e.to_string()),
                    },
                }
            }
            Err(e) => RunEvidence {
                run_id,
                seq,
                step_id,
                observation: None,
                problem: Some(e.message),
            },
        };
        if let Err(e) = app.emit(RUN_EVIDENCE_EVENT, evidence) {
            tracing::warn!(error = %e, "failed to emit run evidence");
        }
    });
}
