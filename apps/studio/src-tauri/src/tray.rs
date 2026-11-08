//! The task tray icon (competitive-gaps.md #17): opens the run window or
//! Studio without looking for them on the taskbar. Started with `--runner`
//! or `--tray`, Shikigami stays in the tray when the run window is closed,
//! so the people who only run flows keep it at hand all day.

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindowBuilder, Wry};

use crate::runner::show_runner_later;

const TRAY_ID: &str = "shikigami";
const OPEN_RUNNER: &str = "open-runner";
const OPEN_STUDIO: &str = "open-studio";
const QUIT: &str = "quit";

/// The words of the tray menu, in the language Studio shows (the screens
/// send them with `set_tray_labels`; the Japanese ones are the start).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    tooltip: String,
    open_runner: String,
    open_studio: String,
    quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            tooltip: "SpellSheet".into(),
            open_runner: "実行画面を開く".into(),
            open_studio: "Studio を開く".into(),
            quit: "終了".into(),
        }
    }
}

/// Whether closing the run window keeps Shikigami in the tray: when it
/// was started for running flows (`--runner`, or `--tray` with no window).
pub(crate) fn stays_in_tray() -> bool {
    std::env::args().any(|a| a == "--runner" || a == "--tray")
}

/// `--tray`: start with the tray icon only (for a sign-in shortcut).
pub(crate) fn starts_hidden() -> bool {
    std::env::args().any(|a| a == "--tray")
}

fn menu(app: &AppHandle, labels: &TrayLabels) -> tauri::Result<Menu<Wry>> {
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, OPEN_RUNNER, &labels.open_runner, true, None::<&str>)?,
            &MenuItem::with_id(app, OPEN_STUDIO, &labels.open_studio, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, &labels.quit, true, None::<&str>)?,
        ],
    )
}

pub(crate) fn create(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let labels = TrayLabels::default();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(&labels.tooltip)
        .menu(&menu(app, &labels)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            // Windows are made off the main thread: making one inside an
            // event handler deadlocks on Windows (tauri-apps/wry#583).
            match event.id().as_ref() {
                OPEN_RUNNER => show_runner_later(app),
                OPEN_STUDIO => show_studio_later(app),
                QUIT => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // A left click opens the run window; the right click shows the menu.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_runner_later(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)
}

/// [`show_studio`] from an event handler, off the main thread (see
/// [`show_runner_later`]).
pub(crate) fn show_studio_later(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = show_studio(&app) {
            tracing::warn!(error = %e, "cannot open Studio");
        }
    });
}

/// Opens Studio's main window, making it again when it was closed (as at
/// a `--runner` start).
pub(crate) fn show_studio(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        return window.set_focus();
    }
    let Some(config) = app.config().app.windows.first() else {
        return Ok(());
    };
    WebviewWindowBuilder::from_config(app, config)?.build()?;
    Ok(())
}

/// The tray menu in the language the screens show.
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, labels: TrayLabels) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_menu(Some(menu(&app, &labels).map_err(|e| e.to_string())?))
        .and_then(|()| tray.set_tooltip(Some(&labels.tooltip)))
        .map_err(|e| e.to_string())
}
