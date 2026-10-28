//! Shikigami Studio backend.
//!
//! Every command is a thin wrapper over `ScenarioService` (editing) or
//! `Runtime` (execution). Studio owns no scenario logic of its own, so what
//! the GUI does is exactly what MCP clients and the CLI can do.

mod agent;
mod commands;
mod debug;
mod updater;
mod watcher;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use shikigami_core::ScenarioId;
use shikigami_core::{FileStore, RunId, ScenarioService};
use shikigami_runtime::{Adapter, DebugControl, RunSnapshot, Runtime};
use shikigami_secrets::Vault;
use tokio_util::sync::CancellationToken;

pub(crate) struct ActiveRun {
    pub cancel: CancellationToken,
    pub snapshot: Arc<Mutex<RunSnapshot>>,
    pub scenario_id: ScenarioId,
    /// Studio runs are interactive: they pause on errors and breakpoints.
    pub debug: Option<DebugControl>,
}

pub(crate) struct AppState {
    pub service: Arc<ScenarioService>,
    pub runtime: Runtime,
    pub runs: Mutex<HashMap<RunId, ActiveRun>>,
    pub vault: Arc<Vault>,
    /// For looking at the screen where a run paused.
    pub adapters: Vec<Arc<dyn Adapter>>,
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,shikigami=debug".into()),
        )
        .init();

    let adapters = shikigami_adapters::all();
    let runtime = shikigami_adapters::runtime(&adapters);
    let root = FileStore::default_root();
    let store = match FileStore::open(&root) {
        Ok(store) => store,
        Err(e) => {
            tracing::error!(error = %e, root = %root.display(), "cannot open workspace");
            std::process::exit(1);
        }
    };
    let service = Arc::new(ScenarioService::new(store, runtime.registry().clone()));
    let vault = Arc::new(Vault::open(service.store().root()));
    let state = AppState {
        service: service.clone(),
        runtime: runtime.with_secrets(vault.clone()),
        runs: Mutex::new(HashMap::new()),
        vault,
        adapters,
    };

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .manage(updater::PendingUpdate::default())
        .manage(agent::AgentTurns::default())
        .setup(move |app| {
            fit_to_screen(app);
            updater::on_startup(app.handle());
            watcher::spawn(app.handle().clone(), service.store().scenarios_dir());
            watcher::spawn_secret_requests(
                app.handle().clone(),
                service.store().root().join("secrets"),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_info,
            commands::set_workspace,
            commands::list_versions,
            commands::create_version,
            commands::diff_versions,
            commands::restore_version,
            commands::export_scenario,
            commands::import_scenario,
            commands::list_scenarios,
            commands::get_scenario,
            commands::create_scenario,
            commands::duplicate_scenario,
            commands::delete_scenario,
            commands::edit_scenario,
            commands::extract_subscenario,
            commands::undo,
            commands::redo,
            commands::undo_state,
            commands::validate_scenario,
            commands::list_step_types,
            commands::scenario_history,
            commands::review_timeline,
            commands::submit_review,
            commands::get_observation,
            commands::run_scenario,
            commands::stop_run,
            commands::run_status,
            debug::debug_run,
            updater::app_info,
            updater::check_update,
            updater::install_update,
            commands::list_secrets,
            commands::set_secret,
            commands::remove_secret,
            commands::reset_secrets,
            commands::forget_login,
            commands::list_secret_requests,
            commands::dismiss_secret_request,
            agent::agent_info,
            agent::agent_send,
            agent::agent_stop,
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        tracing::error!(error = %e, "Studio exited with an error");
        std::process::exit(1);
    }
}

/// The default window (1400x900) is taller than many laptop screens, which
/// puts the bottom of the panels under the taskbar until the window is
/// maximized. On a screen whose work area cannot hold it, start maximized.
fn fit_to_screen(app: &tauri::App) {
    use tauri::Manager;
    for window in app.webview_windows().values() {
        let (Ok(Some(monitor)), Ok(size)) = (window.current_monitor(), window.outer_size()) else {
            continue;
        };
        let area = monitor.work_area().size;
        if (size.width > area.width || size.height > area.height)
            && let Err(e) = window.maximize()
        {
            tracing::warn!(error = %e, "cannot maximize the window");
        }
    }
}
