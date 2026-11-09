//! The run window ("SpellSheet 実行", competitive-gaps.md #17): a small
//! window for the people who use flows rather than build them. It lists
//! published flows only, asks for their inputs with a form made from the
//! input variables, and runs the published version. A person starts the run
//! and watches it, so the unattended policy does not apply (as in Studio),
//! but it never runs working content nobody published.

use serde::Serialize;
use serde_json::{Map, Value};
use spellsheet_core::{ErrorPayload, Flow, FlowId, FlowService, RunId};
use spellsheet_runtime::record::{list_runs, read_report};
use spellsheet_runtime::{RunOptions, RunOrigin, RunStatus, RunTrigger};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use time::OffsetDateTime;

use crate::AppState;
use crate::commands::track_run;

/// The run window's label (capabilities/runner.json names it too).
pub(crate) const RUNNER_WINDOW: &str = "runner";
/// Run events of the run window: apart from Studio's `run-event`, so the
/// editor does not take them for its own run.
const RUNNER_EVENT: &str = "runner-event";
/// How many recorded runs to look through for each flow's last run.
const RECENT_RUNS: usize = 300;
/// How the run window names itself in a run's origin.
const RUNNER_REQUESTER: &str = "runner";

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// A published flow as the run window lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerItem {
    /// The published version: what a run executes.
    flow: Flow,
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

/// The published flows, by name, with the last time each ran. Read off the
/// main thread: it reads up to [`RECENT_RUNS`] run reports, and a slow disk
/// must not stop every window while it does.
#[tauri::command]
pub async fn runner_list(state: State<'_, AppState>) -> CmdResult<Vec<RunnerItem>> {
    let svc = state.service.clone();
    tokio::task::spawn_blocking(move || list_published(&svc))
        .await
        .map_err(|e| err("INTERNAL", e.to_string()))?
}

fn list_published(svc: &FlowService) -> CmdResult<Vec<RunnerItem>> {
    let mut last: std::collections::HashMap<FlowId, LastRun> = Default::default();
    let root = svc.store().local_root();
    for run_id in list_runs(root)
        .unwrap_or_default()
        .into_iter()
        .take(RECENT_RUNS)
    {
        let Ok(Some(report)) = read_report(root, &run_id) else {
            continue;
        };
        // A try in the editor or by an AI runs the draft: not what is handed out.
        if !runs_published(&report.origin) {
            continue;
        }
        // Newest first, so the first report of a flow is its last run.
        last.entry(report.flow_id.clone()).or_insert(LastRun {
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
            flow: version.flow,
            version: published.version,
            published_at: published.published_at,
        });
    }
    items.sort_by(|a, b| a.flow.name.cmp(&b.flow.name));
    Ok(items)
}

/// Whether a run carried out the published version: from this window, a
/// schedule, a management server or the command line. Studio's own runs
/// and an AI's tries run the draft.
fn runs_published(origin: &RunOrigin) -> bool {
    match origin.trigger {
        Some(RunTrigger::Studio) => origin.requested_by.as_deref() == Some(RUNNER_REQUESTER),
        Some(RunTrigger::Mcp) => false,
        _ => true,
    }
}

/// Runs the published version of `id` with `inputs`. Events arrive as
/// `runner-event`; an unhandled error ends the run (nobody here debugs it).
/// Async like `run_flow`: a sync command runs on the main thread, outside
/// the Tokio runtime the run is spawned on, and Studio would abort.
#[tauri::command]
pub async fn runner_run(
    app: AppHandle,
    state: State<'_, AppState>,
    id: FlowId,
    inputs: Option<Map<String, Value>>,
) -> CmdResult<RunId> {
    let run = state.service.published_run(&id)?;
    let inputs = inputs.unwrap_or_default();
    // Only the flow's inputs: the form never sets anything else.
    if let Some(name) = inputs.keys().find(|name| {
        !run.flow
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
            run.flow,
            RunOptions {
                project_dir,
                full_run: true,
                inputs,
                version: Some(run.version),
                subflows: run.subflows,
                origin: RunOrigin::new(RunTrigger::Studio).requested_by(RUNNER_REQUESTER),
                ..RunOptions::default()
            },
        )
        .map_err(|e| ErrorPayload {
            code: e.code,
            message: e.message,
            details: e.details,
        })?;
    track_run(app, &state, id, handle, RUNNER_EVENT, None)
}

/// The file or folder picker of a `format: file` / `folder` input. `start`
/// is the path in the field, so the dialog opens next to it. `None` when
/// the person cancels.
#[tauri::command]
pub async fn runner_pick(kind: String, start: Option<String>) -> CmdResult<Option<String>> {
    if kind != "file" && kind != "folder" {
        return Err(err("INVALID_INPUT", format!("cannot pick a {kind}")));
    }
    let folder = start
        .map(std::path::PathBuf::from)
        .and_then(|p| {
            if p.is_dir() {
                Some(p)
            } else {
                p.parent().filter(|d| d.is_dir()).map(Into::into)
            }
        })
        .map(|p| p.to_string_lossy().into_owned());
    let params = serde_json::json!({ "kind": kind, "folder": folder.unwrap_or_default() });
    let picked = spellsheet_system::select_file(&params)
        .await
        .map_err(|e| ErrorPayload {
            code: e.code,
            message: e.message,
            details: e.details,
        })?;
    Ok(picked.as_str().map(str::to_owned))
}

/// Opens the run window, or brings it to the front.
///
/// Async on purpose: a synchronous command runs on the main thread, and
/// making a window there waits for the main thread itself, so Studio froze
/// on Windows (tauri-apps/wry#583).
#[tauri::command]
pub async fn open_runner(app: AppHandle) -> CmdResult<()> {
    show_runner(&app).map_err(|e| err("WINDOW_FAILED", e.to_string()))
}

/// [`show_runner`] from an event handler (tray icon, tray menu): handlers
/// run on the main thread, where making a window deadlocks on Windows, so
/// the window is made from another thread.
pub(crate) fn show_runner_later(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = show_runner(&app) {
            tracing::warn!(error = %e, "cannot open the run window");
        }
    });
}

pub(crate) fn show_runner(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(RUNNER_WINDOW) {
        window.unminimize()?;
        window.show()?;
        return window.set_focus();
    }
    let window = WebviewWindowBuilder::new(
        app,
        RUNNER_WINDOW,
        WebviewUrl::App("index.html?view=runner".into()),
    )
    .title("SpellSheet")
    .inner_size(880.0, 600.0)
    .min_inner_size(640.0, 440.0)
    .decorations(false)
    .visible(false)
    .additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ElasticOverscroll",
    )
    .build()?;
    // Before it is first shown, so the taskbar files it under Runner.
    own_taskbar_button(&window, &app.config().identifier);
    window.show()
}

/// Runner's AppUserModelID: Writer's with `.runner` after it. The installer
/// gives the "SpellSheet Runner" shortcut the same one
/// (windows/installer-hooks.nsh, `RUNNER_APPID`). With Writer's ID on both
/// shortcuts, the Start menu showed only one of them.
pub(crate) fn runner_app_id(identifier: &str) -> String {
    format!("{identifier}.runner")
}

/// Runner's window gets its own taskbar button, apart from Writer's, which
/// pins as "SpellSheet Runner" and starts Runner again from the pin.
fn own_taskbar_button(window: &tauri::WebviewWindow, identifier: &str) {
    #[cfg(windows)]
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(e) => {
            tracing::warn!(error = %e, "cannot give Runner its own taskbar button");
            return;
        }
    };
    #[cfg(not(windows))]
    let hwnd = 0;
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let relaunch = format!("\"{}\" --runner", exe.display());
    let app_id = runner_app_id(identifier);
    // The window's property store belongs to the thread of its window.
    let _ = window.run_on_main_thread(move || {
        if let Err(e) =
            spellsheet_desktop::taskbar::own_button(hwnd, &app_id, &relaunch, "SpellSheet Runner")
        {
            tracing::warn!(error = %e, "cannot give Runner its own taskbar button");
        }
    });
}

/// `--runner` on the command line: start with the run window only (a
/// shortcut for the people who only run flows).
pub(crate) fn wants_runner_only() -> bool {
    std::env::args().any(|a| a == "--runner")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_has_an_app_id_of_its_own() {
        // Must match RUNNER_APPID in windows/installer-hooks.nsh.
        assert_eq!(
            runner_app_id("dev.spellsheet.studio"),
            "dev.spellsheet.studio.runner"
        );
        let hooks = include_str!("../windows/installer-hooks.nsh");
        assert!(hooks.contains(r#"!define RUNNER_APPID "${BUNDLEID}.runner""#));
    }

    #[test]
    fn only_runs_of_the_published_version_count() {
        assert!(runs_published(
            &RunOrigin::new(RunTrigger::Studio).requested_by(RUNNER_REQUESTER)
        ));
        assert!(runs_published(&RunOrigin::new(RunTrigger::Schedule)));
        assert!(runs_published(&RunOrigin::new(RunTrigger::Cli)));
        assert!(!runs_published(&RunOrigin::new(RunTrigger::Studio)));
        assert!(!runs_published(
            &RunOrigin::new(RunTrigger::Mcp).requested_by("claude-code")
        ));
    }
}
