//! The start-up screen: a picture with the mark, the product's name and its
//! version, shown the moment Writer is started. Writer's own window starts
//! hidden (tauri.conf.json `visible: false`) and comes up once its screen
//! has drawn the flows (`startup_ready`), so nobody sees a white window or
//! an empty list first. The picture stays at least [`MIN_SHOWN`]: it is
//! meant to be seen, not to blink.
//!
//! Not shown when SpellSheet starts for running flows (`--runner`) or into
//! the tray (`--tray`), nor when Writer is opened again later.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The start-up screen's label (capabilities/splash.json names it too).
pub(crate) const SPLASH_WINDOW: &str = "splash";
/// How long the picture stays at the least.
const MIN_SHOWN: Duration = Duration::from_millis(1800);
/// Writer comes up after this even when its screen never said it was ready
/// (a script error): a start-up screen that never goes is worse than a
/// half-drawn Writer.
const GIVE_UP: Duration = Duration::from_secs(20);
/// The picture's size in logical pixels (16:9).
const WIDTH: f64 = 720.0;
const HEIGHT: f64 = 405.0;
/// The picture's ground (splash.html), so the window is never white while
/// its page loads.
const GROUND: Color = Color(11, 19, 27, 255);

/// When the start-up screen came up, while it is up.
#[derive(Default)]
pub(crate) struct Splash(Mutex<Option<Instant>>);

/// Shows the start-up screen, centred on the screen Writer will open on.
pub(crate) fn show(app: &tauri::App) -> tauri::Result<()> {
    let version = app.package_info().version.to_string();
    WebviewWindowBuilder::new(
        app,
        SPLASH_WINDOW,
        WebviewUrl::App(format!("splash.html?v={version}").into()),
    )
    .title("SpellSheet Writer")
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .skip_taskbar(true)
    .center()
    .background_color(GROUND)
    .additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ElasticOverscroll",
    )
    .build()?;
    *lock(app.handle()) = Some(Instant::now());
    let app = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(GIVE_UP);
        if lock(&app).is_some() {
            tracing::warn!("Writer did not say it was ready: showing it anyway");
            reveal(&app);
        }
    });
    Ok(())
}

/// Writer's screen has drawn: show Writer (after the picture has been up
/// for [`MIN_SHOWN`]) and close the start-up screen. Also called by a
/// Writer window made again later (tray, run window), which only shows it.
#[tauri::command]
pub async fn startup_ready(app: AppHandle) {
    let shown_at = *lock(&app);
    if let Some(left) = shown_at.and_then(|at| MIN_SHOWN.checked_sub(at.elapsed())) {
        tokio::time::sleep(left).await;
    }
    reveal(&app);
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, Option<Instant>> {
    app.state::<Splash>()
        .inner()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn reveal(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main")
        && !main.is_visible().unwrap_or(true)
    {
        crate::fit_to_screen(&main);
        if let Err(e) = main.show().and_then(|()| main.set_focus()) {
            tracing::warn!(error = %e, "cannot show Writer");
        }
    }
    lock(app).take();
    if let Some(splash) = app.get_webview_window(SPLASH_WINDOW)
        && let Err(e) = splash.close()
    {
        tracing::warn!(error = %e, "cannot close the start-up screen");
    }
}
