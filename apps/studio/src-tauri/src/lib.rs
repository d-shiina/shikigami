//! Shikigami Studio backend.
//!
//! Every command is a thin wrapper over `FlowService` (editing) or
//! `Runtime` (execution). Studio owns no flow logic of its own, so what
//! the GUI does is exactly what MCP clients and the CLI can do.

mod agent;
mod commands;
mod debug;
mod picker;
mod runner;
mod schedules;
mod tray;
mod updater;
mod watcher;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use shikigami_core::FlowId;
use shikigami_core::{ApprovalStore, FileStore, FlowService, Policy, RunId};
use shikigami_runtime::{Adapter, DebugControl, RunSnapshot, Runtime, Stopper};
use shikigami_secrets::Vault;

pub(crate) struct ActiveRun {
    pub cancel: Stopper,
    pub snapshot: Arc<Mutex<RunSnapshot>>,
    pub flow_id: FlowId,
    /// Studio runs are interactive: they pause on errors and breakpoints.
    pub debug: Option<DebugControl>,
}

pub(crate) struct AppState {
    pub service: Arc<FlowService>,
    pub runtime: Runtime,
    pub runs: Mutex<HashMap<RunId, ActiveRun>>,
    pub vault: Arc<Vault>,
    /// Requests from AI clients waiting for the person's answer.
    pub approvals: ApprovalStore,
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

    updater::on_startup();
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
    let service = Arc::new(FlowService::new(store, runtime.registry().clone()));
    let vault = Arc::new(Vault::open(service.store().root()));
    let state = AppState {
        service: service.clone(),
        runtime: runtime
            .with_secrets(vault.clone())
            .with_policy(Policy::path(service.store().root())),
        approvals: ApprovalStore::new(service.store().local_root()),
        runs: Mutex::new(HashMap::new()),
        vault,
        adapters,
    };

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .manage(updater::PendingUpdate::default())
        .manage(agent::AgentTurns::default())
        .manage(agent::AgentLogin::default())
        .setup(move |app| {
            fit_to_screen(app);
            if let Err(e) = tray::create(app.handle()) {
                // Only a shortcut: Studio works without it.
                tracing::warn!(error = %e, "cannot show the tray icon");
            }
            if runner::wants_runner_only() || tray::starts_hidden() {
                use tauri::Manager;
                if !tray::starts_hidden() {
                    runner::show_runner(app.handle())?;
                }
                if let Some(main) = app.get_webview_window("main") {
                    main.close()?;
                }
            }
            watcher::spawn(app.handle().clone(), service.store().flows_dir());
            watcher::spawn_secret_requests(
                app.handle().clone(),
                service.store().root().join("secrets"),
            );
            watcher::spawn_approvals(
                app.handle().clone(),
                service.store().local_root().join("approvals"),
            );
            watcher::spawn_pick_requests(
                app.handle().clone(),
                service.store().local_root().join("picks"),
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            // Started for running flows, closing the run window leaves
            // Shikigami in the tray (its menu has Quit).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == runner::RUNNER_WINDOW
                && tray::stays_in_tray()
            {
                api.prevent_close();
                if let Err(e) = window.hide() {
                    tracing::warn!(error = %e, "cannot hide the run window");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_info,
            commands::save_ai_guide,
            commands::paste_ai_answer,
            commands::set_workspace,
            commands::list_versions,
            commands::create_version,
            commands::diff_versions,
            commands::restore_version,
            commands::published_state,
            commands::publish_flow,
            commands::approve_and_publish,
            commands::unpublish_flow,
            commands::get_policy,
            commands::save_policy,
            commands::list_approvals,
            schedules::list_schedules,
            schedules::save_schedule,
            schedules::delete_schedule,
            schedules::agent_status,
            schedules::start_agent,
            schedules::stop_agent,
            commands::decide_approval,
            commands::list_pick_requests,
            commands::cancel_pick_request,
            commands::export_flow,
            commands::import_flow,
            commands::list_flows,
            commands::project_files,
            commands::read_project_text,
            commands::write_project_text,
            commands::upload_project_file,
            commands::copy_into_project,
            commands::create_project_folder,
            commands::rename_project_file,
            commands::delete_project_file,
            commands::open_project_file,
            commands::get_flow,
            commands::create_flow,
            commands::duplicate_flow,
            commands::delete_flow,
            commands::edit_flow,
            commands::extract_subflow,
            commands::undo,
            commands::redo,
            commands::undo_state,
            commands::validate_flow,
            commands::list_step_types,
            commands::eval_expression,
            commands::flow_history,
            commands::review_timeline,
            commands::submit_review,
            commands::get_observation,
            commands::run_record,
            commands::run_flow,
            commands::stop_run,
            commands::run_status,
            debug::debug_run,
            picker::point_at,
            updater::app_info,
            updater::check_update,
            updater::download_update,
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
            agent::agent_login,
            agent::agent_login_code,
            agent::agent_login_cancel,
            agent::agent_open_url,
            runner::runner_list,
            runner::runner_run,
            runner::open_runner,
            runner::runner_pick,
            tray::set_tray_labels,
        ])
        .build(tauri::generate_context!())
        .map(|app| {
            app.run(|app, event| match event {
                // In the tray, closing the last window is not quitting
                // (Quit in the tray menu exits with a code).
                tauri::RunEvent::ExitRequested {
                    code: None, api, ..
                } if tray::stays_in_tray() => api.prevent_exit(),
                tauri::RunEvent::Exit => updater::install_on_exit(app),
                _ => {}
            });
        });
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
