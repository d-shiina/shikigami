//! The run band: while Writer runs a flow that works on the screen
//! (`desktop.*` or `browser.*` nodes, its called flows included), Writer is
//! minimised and a thin band at the bottom of the screen shows the run
//! instead: the node before, the node now (with its progress), the node
//! after, the round of the loop it is in, and 一時停止・中止・Writer に戻す.
//! As UiPath Studio and Power Automate Desktop do, and WinActor's small
//! window during a run.
//!
//! The band never gets in the flow's way (`shikigami_desktop::keep_out`):
//! it is not in screen captures (image search, OCR, the 手順書), clicking it
//! does not take the focus, and it moves to the top edge before a mouse
//! action lands on it.
//!
//! Writer comes back when the run needs it: paused (error, breakpoint,
//! 一時停止; it steps aside again when the run goes on to the end) or stopped, and when it ends unless the setting says to stay
//! out of the way. A step that waits for a person shows its message in the
//! band and Writer stays down, since the person acts on the app, not on
//! Writer.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use shikigami_core::{ErrorPayload, Flow, FlowId, RunId, Subflow};
use shikigami_runtime::{ResumeAction, RunEvent, RunEventEnvelope, RunStatus};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// The band's label (capabilities/runband.json names it too).
pub(crate) const BAND_WINDOW: &str = "runband";
/// Sent to the band when it starts showing a run.
const BAND_RUN_EVENT: &str = "run-band";
/// The band's size in logical pixels: as wide as 70% of the screen, at
/// least [`MIN_WIDTH`] (or the whole screen less a margin when smaller).
const WIDTH_SHARE: f64 = 0.7;
const MIN_WIDTH: f64 = 760.0;
const HEIGHT: f64 = 68.0;

/// What the person chose in 設定 › 実行 (sent with each run).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BandSettings {
    /// Minimise Writer and show the band for runs that work on the screen.
    #[serde(default)]
    pub shrink: bool,
    /// Bring Writer back when the run ends (otherwise the band stays with
    /// the result until it is closed).
    #[serde(default)]
    pub restore_at_end: bool,
}

/// The run the band shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BandRun {
    run_id: RunId,
    flow_id: FlowId,
    #[serde(skip)]
    restore_at_end: bool,
    /// [`begin`] has run: Writer may step aside from now on.
    #[serde(skip)]
    begun: bool,
    /// Writer is out of the way now (minimised, the band up).
    #[serde(skip)]
    out: bool,
    /// The run is paused: Writer stays up until it goes on.
    #[serde(skip)]
    paused: bool,
    /// The person brought Writer back themselves: leave it up until the run ends.
    #[serde(skip)]
    kept: bool,
}

static CURRENT: Mutex<Option<BandRun>> = Mutex::new(None);
/// The run the band shows: the current one, or after it ended the last
/// one (a band that stays with the result may load only after the end).
static SHOWN: Mutex<Option<BandRun>> = Mutex::new(None);

/// Held while Writer and the band change places, so that the run's events
/// (another thread) and [`begin`] take turns: a pause or the end that comes
/// while Writer is stepping aside is never lost or undone. Never taken on
/// the main thread, which the window calls wait for.
static TURN: Mutex<()> = Mutex::new(());

fn turn() -> std::sync::MutexGuard<'static, ()> {
    TURN.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn current() -> Option<BandRun> {
    CURRENT.lock().ok().and_then(|c| c.clone())
}

fn update(f: impl FnOnce(&mut Option<BandRun>)) {
    if let Ok(mut c) = CURRENT.lock() {
        f(&mut c);
    }
}

fn update_run(run_id: &RunId, f: impl FnOnce(&mut BandRun)) {
    update(|c| {
        if let Some(run) = c.as_mut().filter(|r| &r.run_id == run_id) {
            f(run);
        }
    });
}

/// Whether the run works on the screen: a `desktop.*` or `browser.*` node
/// in the flow or in a flow it calls. Excel, files, mail and the like work
/// without the screen, so Writer stays as it is for them.
pub(crate) fn works_on_screen(flow: &Flow, subflows: &[Subflow]) -> bool {
    flow.walk()
        .chain(subflows.iter().flat_map(|s| s.flow.walk()))
        .any(|s| s.step_type.starts_with("desktop.") || s.step_type.starts_with("browser."))
}

/// Names the run before it starts, so that none of its events (a pause at
/// its first node, a quick end) pass by before the band knows it.
pub(crate) fn prepare(run_id: RunId, flow_id: FlowId, settings: BandSettings) {
    let run = BandRun {
        run_id,
        flow_id,
        restore_at_end: settings.restore_at_end,
        begun: false,
        out: false,
        paused: false,
        kept: false,
    };
    if let Ok(mut shown) = SHOWN.lock() {
        *shown = Some(run.clone());
    }
    update(|c| *c = Some(run));
}

/// The run did not start after [`prepare`].
pub(crate) fn forget(run_id: &RunId) {
    update(|c| {
        if c.as_ref().is_some_and(|r| &r.run_id == run_id) {
            *c = None;
        }
    });
}

/// Gets Writer out of the way for the run [`prepare`]d, unless it has
/// already paused or ended.
pub(crate) fn begin(app: &AppHandle, run_id: &RunId) {
    let _turn = turn();
    let Some(run) = current().filter(|r| &r.run_id == run_id) else {
        return;
    };
    update_run(run_id, |r| r.begun = true);
    if run.paused || run.kept {
        return;
    }
    update_run(run_id, |r| r.out = true);
    step_aside(app, &run);
}

/// Minimises Writer and shows the band, telling it the run to show (it
/// may still show an earlier one, or not have loaded yet: then it asks
/// [`run_band_current`]).
fn step_aside(app: &AppHandle, run: &BandRun) {
    if let Err(e) = show_band(app) {
        tracing::warn!(error = %e, "cannot show the run band");
        return;
    }
    if let Err(e) = app.emit_to(BAND_WINDOW, BAND_RUN_EVENT, run) {
        tracing::warn!(error = %e, "cannot tell the run band about the run");
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.minimize();
    }
}

/// Brings Writer back and puts the band away.
fn come_back(app: &AppHandle) {
    hide_band(app);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn hide_band(app: &AppHandle) {
    if let Some(band) = app.get_webview_window(BAND_WINDOW) {
        let _ = band.hide();
    }
}

/// What the band does about a run event.
#[derive(Debug, PartialEq, Eq)]
enum Move {
    Nothing,
    StepAside,
    ComeBack,
}

/// Updates `run` for `event` and says what Writer and the band do, and
/// whether the band still follows the run (not after its end).
fn react(run: &mut BandRun, event: &RunEvent) -> (Move, bool) {
    match event {
        RunEvent::Paused { .. } => {
            run.paused = true;
            if run.out {
                run.out = false;
                return (Move::ComeBack, true);
            }
            (Move::Nothing, true)
        }
        // Going on to the end (not one step at a time, which pauses again
        // right away): out of the way again.
        RunEvent::Resumed { action, .. } => {
            run.paused = false;
            let to_the_end = matches!(
                action,
                ResumeAction::Continue | ResumeAction::Retry | ResumeAction::Skip
            );
            if run.begun && !run.out && !run.kept && to_the_end {
                run.out = true;
                return (Move::StepAside, true);
            }
            (Move::Nothing, true)
        }
        // The band shows the result when it stays; a run that did not
        // complete always brings Writer back, where its log is.
        RunEvent::RunFinished { status, .. } => {
            let back = run.out && (run.restore_at_end || *status != RunStatus::Succeeded);
            run.out = false;
            (if back { Move::ComeBack } else { Move::Nothing }, false)
        }
        _ => (Move::Nothing, true),
    }
}

/// Follows a Studio run's events (called for every one, from `track_run`,
/// on the run's own thread).
pub(crate) fn on_event(app: &AppHandle, event: &RunEventEnvelope) {
    if !matches!(
        event.event,
        RunEvent::Paused { .. } | RunEvent::Resumed { .. } | RunEvent::RunFinished { .. }
    ) || current().is_none_or(|r| r.run_id != event.run_id)
    {
        return;
    }
    let _turn = turn();
    let mut todo = Move::Nothing;
    let mut shown = None;
    update(|c| {
        let Some(run) = c.as_mut().filter(|r| r.run_id == event.run_id) else {
            return;
        };
        let (move_, keep) = react(run, &event.event);
        todo = move_;
        shown = Some(run.clone());
        if !keep {
            *c = None;
        }
    });
    match todo {
        Move::StepAside => {
            if let Some(run) = &shown {
                step_aside(app, run);
            }
        }
        Move::ComeBack => come_back(app),
        Move::Nothing => {}
    }
}

/// Writer got the focus while the band was up (the person clicked it in the
/// taskbar): Writer stays up for the rest of the run. On the main thread:
/// only the band is put away.
pub(crate) fn writer_focused(app: &AppHandle) {
    let mut hide = false;
    update(|c| {
        if let Some(r) = c.as_mut().filter(|r| r.out) {
            r.out = false;
            r.kept = true;
            hide = true;
        }
    });
    if hide {
        hide_band(app);
    }
}

/// The run the band shows, if any (read by the band when it opens).
#[tauri::command]
pub fn run_band_current() -> Option<BandRun> {
    SHOWN.lock().ok().and_then(|s| s.clone())
}

/// 「Writer に戻す」 on the band (or the band clicked): Writer comes back
/// and stays up for the rest of the run, which goes on.
#[tauri::command]
pub async fn run_band_writer(app: AppHandle) -> Result<(), ErrorPayload> {
    let _turn = turn();
    update(|c| {
        if let Some(r) = c.as_mut() {
            r.out = false;
            r.kept = true;
        }
    });
    come_back(&app);
    Ok(())
}

/// The band's ✕ once a run it shows has ended.
#[tauri::command]
pub async fn run_band_close(app: AppHandle) -> Result<(), ErrorPayload> {
    hide_band(&app);
    Ok(())
}

/// Makes the band (once) and puts it at the bottom of the screen Writer is
/// on, in the middle, just over the taskbar.
fn show_band(app: &AppHandle) -> tauri::Result<()> {
    let band = match app.get_webview_window(BAND_WINDOW) {
        Some(band) => band,
        None => {
            let band = WebviewWindowBuilder::new(
                app,
                BAND_WINDOW,
                WebviewUrl::App("index.html?view=band".into()),
            )
            .title("SpellSheet")
            .inner_size(MIN_WIDTH, HEIGHT)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .visible(false)
            .additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ElasticOverscroll",
            )
            .build()?;
            #[cfg(windows)]
            if let Ok(hwnd) = band.hwnd() {
                shikigami_desktop::keep_out::shield(hwnd.0 as isize);
                shikigami_desktop::keep_out::set(Some(hwnd.0 as isize));
            }
            band
        }
    };
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| band.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let work = monitor.work_area();
        let scale = monitor.scale_factor();
        let gap = (f64::from(shikigami_desktop::keep_out::EDGE_GAP) * scale) as i32;
        let w = band_width(work.size.width as f64 / scale) * scale;
        let (w, h) = (w as i32, (HEIGHT * scale) as i32);
        band.set_size(tauri::PhysicalSize::new(w as u32, h as u32))?;
        let x = work.position.x + (work.size.width as i32 - w) / 2;
        let y = work.position.y + work.size.height as i32 - h - gap;
        band.set_position(tauri::PhysicalPosition::new(x, y))?;
    }
    band.show()?;
    Ok(())
}

/// The band's width (logical pixels) on a work area `screen` wide.
fn band_width(screen: f64) -> f64 {
    (screen * WIDTH_SHARE)
        .max(MIN_WIDTH)
        .min(screen - 2.0 * f64::from(shikigami_desktop::keep_out::EDGE_GAP))
}

#[cfg(test)]
mod tests {
    use super::*;
    use shikigami_core::Step;

    fn flow(types: &[&str]) -> Flow {
        let mut flow = Flow::new("f");
        flow.steps = types.iter().map(|t| Step::new(*t)).collect();
        flow
    }

    #[test]
    fn only_runs_that_work_on_the_screen_shrink_writer() {
        assert!(works_on_screen(
            &flow(&["excel.open", "desktop.click"]),
            &[]
        ));
        assert!(works_on_screen(&flow(&["browser.open"]), &[]));
        assert!(!works_on_screen(&flow(&["excel.open", "file.copy"]), &[]));
    }

    fn band_run(restore_at_end: bool) -> BandRun {
        BandRun {
            run_id: RunId::generate(),
            flow_id: FlowId::new("scn_a"),
            restore_at_end,
            begun: true,
            out: true,
            paused: false,
            kept: false,
        }
    }

    fn paused() -> RunEvent {
        RunEvent::Paused {
            step_id: shikigami_core::StepId::new("s1"),
            step_type: "desktop.click".into(),
            reason: shikigami_runtime::PauseReason::Error,
            error: None,
            variables: Default::default(),
            revision: 1,
        }
    }

    fn resumed(action: ResumeAction) -> RunEvent {
        RunEvent::Resumed {
            action,
            revision: None,
        }
    }

    fn finished(status: RunStatus) -> RunEvent {
        RunEvent::RunFinished {
            status,
            error: None,
            duration_ms: 1,
        }
    }

    #[test]
    fn a_pause_brings_writer_back_and_going_on_steps_aside_again() {
        let mut run = band_run(true);
        assert_eq!(react(&mut run, &paused()), (Move::ComeBack, true));
        assert!(run.paused && !run.out);
        // One step at a time: Writer stays up.
        assert_eq!(
            react(&mut run, &resumed(ResumeAction::StepOver)),
            (Move::Nothing, true)
        );
        assert_eq!(react(&mut run, &paused()), (Move::Nothing, true));
        assert_eq!(
            react(&mut run, &resumed(ResumeAction::Continue)),
            (Move::StepAside, true)
        );
        assert!(run.out && !run.paused);
    }

    #[test]
    fn a_pause_before_writer_stepped_aside_keeps_it_up() {
        let mut run = BandRun {
            begun: false,
            out: false,
            ..band_run(true)
        };
        assert_eq!(react(&mut run, &paused()), (Move::Nothing, true));
        // `begin` then finds it paused and leaves Writer as it is.
        assert!(run.paused);
    }

    #[test]
    fn writer_kept_up_by_the_person_stays_up() {
        let mut run = BandRun {
            out: false,
            kept: true,
            ..band_run(true)
        };
        assert_eq!(react(&mut run, &paused()), (Move::Nothing, true));
        assert_eq!(
            react(&mut run, &resumed(ResumeAction::Continue)),
            (Move::Nothing, true)
        );
    }

    #[test]
    fn the_end_brings_writer_back_as_set_and_always_after_a_failure() {
        assert_eq!(
            react(&mut band_run(true), &finished(RunStatus::Succeeded)),
            (Move::ComeBack, false)
        );
        assert_eq!(
            react(&mut band_run(false), &finished(RunStatus::Succeeded)),
            (Move::Nothing, false)
        );
        assert_eq!(
            react(&mut band_run(false), &finished(RunStatus::Cancelled)),
            (Move::ComeBack, false)
        );
    }

    #[test]
    fn the_band_takes_most_of_the_width_but_fits() {
        assert_eq!(band_width(1920.0), 1344.0);
        assert_eq!(band_width(1000.0), 760.0);
        assert_eq!(band_width(700.0), 676.0);
    }

    #[test]
    fn a_screen_node_inside_a_loop_counts() {
        let mut f = flow(&[]);
        f.steps =
            vec![Step::new("control.forEach").with_block("body", vec![Step::new("desktop.type")])];
        assert!(works_on_screen(&f, &[]));
    }
}
