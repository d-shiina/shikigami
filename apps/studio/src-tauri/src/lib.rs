//! SpellSheet Writer backend.
//!
//! Every command is a thin wrapper over `FlowService` (editing) or
//! `Runtime` (execution). Studio owns no flow logic of its own, so what
//! the GUI does is exactly what MCP clients and the CLI can do.

mod agent;
mod attention;
mod commands;
mod debug;
mod extensions;
mod instance;
mod legacy;
mod manual;
mod opened;
mod picker;
mod run_band;
mod runner;
mod schedules;
mod splash;
mod tray;
mod updater;
mod watcher;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use spellsheet_core::FlowId;
use spellsheet_core::{ApprovalStore, FileStore, FlowService, RunId};
use spellsheet_runtime::{Adapter, DebugControl, RunSnapshot, Runtime, Stopper};
use spellsheet_secrets::Vault;

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
    /// The test cases running now (`run_tests`), for 「中止」.
    pub tests: Mutex<Option<spellsheet_runtime::testing::Interrupt>>,
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,spellsheet=debug".into()),
        )
        .init();
    crash_log();

    legacy::move_webview_data();
    updater::on_startup();
    legacy::spawn_after_start();
    let adapters = spellsheet_adapters::all();
    let runtime = spellsheet_adapters::runtime(&adapters);
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
        runtime: runtime.for_workspace(service.store().root(), vault.clone()),
        approvals: ApprovalStore::new(service.store().local_root()),
        runs: Mutex::new(HashMap::new()),
        vault,
        adapters,
        tests: Mutex::new(None),
    };

    let mut builder = tauri::Builder::default();
    if let Some(single) = instance::plugin() {
        builder = builder.plugin(single);
    }
    let result = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .manage(updater::PendingUpdate::default())
        .manage(agent::AgentTurns::default())
        .manage(agent::AgentLogin::default())
        .manage(agent::AgentInstall::default())
        .manage(extensions::Extensions::default())
        .manage(splash::Splash::default())
        .setup(move |app| {
            // Before any window shows: Writer's windows go under Writer's
            // taskbar button even when this copy was started from the
            // Runner shortcut (which has an ID of its own).
            if let Err(e) = spellsheet_desktop::taskbar::claim_process(&app.config().identifier) {
                tracing::warn!(error = %e, "cannot set the app's taskbar ID");
            }
            if let Some(path) = opened::spx_arg(std::env::args()) {
                opened::remember(None, path);
            }
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
            } else if let Err(e) = splash::show(app) {
                // Only a picture: Writer still comes up when its screen is ready.
                tracing::warn!(error = %e, "cannot show the start-up screen");
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
            // Writer brought back by the person during a run: the band goes.
            if let tauri::WindowEvent::Focused(true) = event
                && window.label() == "main"
            {
                run_band::writer_focused(tauri::Manager::app_handle(window));
            }
            // Started for running flows, closing the run window leaves
            // SpellSheet in the tray (its menu has Quit).
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
            splash::startup_ready,
            run_band::run_band_current,
            run_band::run_band_writer,
            run_band::run_band_close,
            commands::workspace_info,
            extensions::list_extensions,
            extensions::stage_extension,
            extensions::stage_extension_update,
            extensions::install_extension,
            extensions::discard_extension,
            extensions::set_extension_enabled,
            extensions::uninstall_extension,
            extensions::set_extension_registries,
            extensions::stage_extension_from_registry,
            extensions::fetch_extension_registry,
            extensions::restart_for_extensions,
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
            schedules::release_remote_session,
            schedules::save_schedule,
            schedules::delete_schedule,
            schedules::agent_status,
            schedules::start_agent,
            schedules::stop_agent,
            commands::decide_approval,
            commands::list_pick_requests,
            commands::read_clipboard_text,
            commands::cancel_pick_request,
            commands::finish_pick_request,
            commands::export_flow,
            commands::package_plan,
            commands::export_package,
            commands::distribution_folders,
            commands::set_distribution_folders,
            commands::scan_distribution,
            commands::place_in_distribution,
            commands::preview_package,
            commands::import_package,
            commands::reveal_file,
            opened::take_opened_file,
            manual::get_manual,
            manual::manual_image,
            manual::save_manual_masks,
            manual::save_manual_export,
            commands::import_flow,
            commands::list_flows,
            commands::project_files,
            commands::read_project_image,
            commands::read_project_text,
            commands::table_columns,
            commands::preview_file,
            commands::write_project_text,
            commands::upload_project_file,
            commands::copy_into_project,
            commands::copy_into_project_as,
            commands::sync_folders,
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
            commands::step_times,
            commands::run_flow,
            commands::test_step,
            commands::list_test_cases,
            commands::save_test_case,
            commands::delete_test_case,
            commands::test_case_from_run,
            commands::run_tests,
            commands::stop_tests,
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
            commands::list_windows_credentials,
            commands::reset_secrets,
            commands::forget_login,
            commands::list_secret_requests,
            commands::dismiss_secret_request,
            agent::agent_info,
            agent::agent_choices,
            agent::agent_select,
            agent::agent_send,
            agent::agent_stop,
            agent::agent_login,
            agent::agent_login_code,
            agent::agent_login_cancel,
            agent::agent_install,
            agent::agent_install_cancel,
            agent::agent_open_url,
            agent::agent_open_link,
            updater::open_cursor_mcp_install,
            runner::runner_list,
            runner::runner_run,
            runner::open_runner,
            runner::runner_pick,
            tray::set_tray_labels,
            attention::call_attention,
            attention::clear_attention,
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
        tracing::error!(error = %e, "Writer exited with an error");
        std::process::exit(1);
    }
}

/// The default window (1400x900) is taller than many laptop screens, which
/// puts the bottom of the panels under the taskbar until the window is
/// maximized. On a screen whose work area cannot hold it, start maximized.
pub(crate) fn fit_to_screen(window: &tauri::WebviewWindow) {
    let (Ok(Some(monitor)), Ok(size)) = (window.current_monitor(), window.outer_size()) else {
        return;
    };
    let area = monitor.work_area().size;
    if (size.width > area.width || size.height > area.height)
        && let Err(e) = window.maximize()
    {
        tracing::warn!(error = %e, "cannot maximize the window");
    }
}

/// Where Studio writes its panics: `%LOCALAPPDATA%\SpellSheet\logs\studio-crash.log`.
fn crash_log_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir()?;
    Some(
        spellsheet_core::paths::local_dir()
            .join("logs")
            .join("studio-crash.log"),
    )
}

/// Writes every panic (with where it happened and the stack) to
/// [`crash_log_path`] as well as the console, so a Studio that closed on its
/// own leaves a trace to find the cause by. Panics that are caught (a
/// request that failed alone) are written too.
fn crash_log() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(path) = crash_log_path() {
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                use std::io::Write as _;
                let thread = std::thread::current();
                let _ = writeln!(
                    file,
                    "---- {} (UTC) v{} thread '{}'\n{info}\n{}",
                    time::OffsetDateTime::now_utc()
                        .format(&time::format_description::well_known::Rfc3339)
                        .unwrap_or_default(),
                    env!("CARGO_PKG_VERSION"),
                    thread.name().unwrap_or("?"),
                    std::backtrace::Backtrace::force_capture(),
                );
            }
        }
        previous(info);
    }));
}
