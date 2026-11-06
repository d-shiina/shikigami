//! The run window ("Shikigami 実行", competitive-gaps.md #17): a small
//! window for the people who use scenarios rather than build them. It lists
//! published scenarios only, asks for their inputs with a form made from the
//! input variables, and runs the published version. A person starts the run
//! and watches it, so the unattended policy does not apply (as in Studio),
//! but it never runs working content nobody published.

use serde::Serialize;
use serde_json::{Map, Value};
use shikigami_core::{ErrorPayload, RunId, Scenario, ScenarioId};
use shikigami_runtime::record::{list_runs, read_report};
use shikigami_runtime::{RunOptions, RunOrigin, RunStatus, RunTrigger};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use time::OffsetDateTime;

use crate::AppState;
use crate::commands::track_run;

/// The run window's label (capabilities/runner.json names it too).
pub(crate) const RUNNER_WINDOW: &str = "runner";
/// Run events of the run window: apart from Studio's `run-event`, so the
/// editor does not take them for its own run.
const RUNNER_EVENT: &str = "runner-event";
/// How many recorded runs to look through for each scenario's last run.
const RECENT_RUNS: usize = 300;

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// A published scenario as the run window lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerItem {
    /// The published version: what a run executes.
    scenario: Scenario,
    version: u32,
    #[serde(with = "time::serde::rfc3339")]
    published_at: OffsetDateTime,
    last_run: Option<LastRun>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    run_id: RunId,
    status: RunStatus,
    #[serde(with = "time::serde::rfc3339")]
    finished_at: OffsetDateTime,
}

/// The published scenarios, by name, with the last time each ran.
#[tauri::command]
pub fn runner_list(state: State<'_, AppState>) -> CmdResult<Vec<RunnerItem>> {
    let svc = &state.service;
    let mut last: std::collections::HashMap<ScenarioId, LastRun> = Default::default();
    let root = svc.store().local_root();
    for run_id in list_runs(root)
        .unwrap_or_default()
        .into_iter()
        .take(RECENT_RUNS)
    {
        let Ok(Some(report)) = read_report(root, &run_id) else {
            continue;
        };
        // Newest first, so the first report of a scenario is its last run.
        last.entry(report.scenario_id.clone()).or_insert(LastRun {
            run_id,
            status: report.status,
            finished_at: report.finished_at,
        });
    }
    let mut items = Vec::new();
    for summary in svc.list()? {
        let Some(published) = svc.published(&summary.id)? else {
            continue;
        };
        let Some(version) = svc.published_version(&summary.id)? else {
            continue;
        };
        items.push(RunnerItem {
            last_run: last.get(&summary.id).cloned(),
            scenario: version.scenario,
            version: published.version,
            published_at: published.published_at,
        });
    }
    items.sort_by(|a, b| a.scenario.name.cmp(&b.scenario.name));
    Ok(items)
}

/// Runs the published version of `id` with `inputs`. Events arrive as
/// `runner-event`; an unhandled error ends the run (nobody here debugs it).
#[tauri::command]
pub fn runner_run(
    app: AppHandle,
    state: State<'_, AppState>,
    id: ScenarioId,
    inputs: Option<Map<String, Value>>,
) -> CmdResult<RunId> {
    let run = state.service.published_run(&id)?;
    let inputs = inputs.unwrap_or_default();
    // Only the scenario's inputs: the form never sets anything else.
    if let Some(name) = inputs.keys().find(|name| {
        !run.scenario
            .variables
            .iter()
            .any(|v| &v.name == *name && v.direction.is_input())
    }) {
        return Err(err("INVALID_INPUT", format!("{name} is not an input")));
    }
    let project_dir = Some(state.service.project_dir(&id)?);
    let handle = state
        .runtime
        .start(
            run.scenario,
            RunOptions {
                project_dir,
                full_run: true,
                inputs,
                version: Some(run.version),
                subscenarios: run.subscenarios,
                origin: RunOrigin::new(RunTrigger::Studio).requested_by("runner"),
                ..RunOptions::default()
            },
        )
        .map_err(|e| ErrorPayload {
            code: e.code,
            message: e.message,
            details: e.details,
        })?;
    track_run(app, &state, id, handle, RUNNER_EVENT)
}

/// Opens the run window, or brings it to the front.
#[tauri::command]
pub fn open_runner(app: AppHandle) -> CmdResult<()> {
    show_runner(&app).map_err(|e| err("WINDOW_FAILED", e.to_string()))
}

pub(crate) fn show_runner(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(RUNNER_WINDOW) {
        window.unminimize()?;
        window.show()?;
        return window.set_focus();
    }
    WebviewWindowBuilder::new(
        app,
        RUNNER_WINDOW,
        WebviewUrl::App("index.html?view=runner".into()),
    )
    .title("Shikigami")
    .inner_size(880.0, 600.0)
    .min_inner_size(640.0, 440.0)
    .decorations(false)
    .additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ElasticOverscroll",
    )
    .build()?;
    Ok(())
}

/// `--runner` on the command line: start with the run window only (a
/// shortcut for the people who only run scenarios).
pub(crate) fn wants_runner_only() -> bool {
    std::env::args().any(|a| a == "--runner")
}
