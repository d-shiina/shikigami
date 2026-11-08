//! Pictures of the screens a run works on, for the flow's 手順書.
//!
//! A run given `RunOptions::screens_dir` (Studio's runs) keeps one picture
//! per browser or desktop step, the first time the step runs: the page or
//! window just before the step acts on it (a click, typing), or just after
//! it for steps that open a page or read and wait for something. The
//! adapter's own screenshot step takes it with `report: true`, which also
//! returns where the step's element is (`mark`) and where input fields and
//! table cells are (`regions`, for the 手順書 to blur). Fields the run typed
//! into are covered in the picture itself and password fields blacked out,
//! as in failure screenshots.
//!
//! A picture that cannot be taken (the element is not there yet, the
//! window is gone) is skipped without failing the step, and the step may
//! get one the next time it runs.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value};
use shikigami_core::{Step, StepId};

use crate::event::{RunEvent, ScreenRect};
use crate::exec::Executor;
use crate::handler::ActionInput;

/// How long a picture may take before the step goes on without it.
const SHOT_LIMIT: Duration = Duration::from_secs(5);
/// At most this many fields and cells are reported per picture.
const MAX_REGIONS: usize = 400;

/// When a step's picture is taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Moment {
    /// Before it acts: the screen as the person would see it before doing
    /// the same thing, the element still as it was.
    Before,
    /// After it: the page it opened, the thing it waited for or read.
    After,
}

/// When steps of `step_type` get their picture; `None` for steps that do
/// not work on a screen.
pub(crate) fn moment(step_type: &str) -> Option<Moment> {
    let (adapter, action) = step_type.split_once('.')?;
    match (adapter, action) {
        (
            "browser",
            "click" | "fill" | "check" | "select" | "press" | "hover" | "upload" | "download"
            | "scroll",
        ) => Some(Moment::Before),
        (
            "browser",
            "open" | "navigate" | "switchTab" | "attach" | "waitFor" | "getText" | "getTable"
            | "getAttribute" | "isVisible",
        ) => Some(Moment::After),
        (
            "desktop",
            "click" | "type" | "setValue" | "select" | "selectMenu" | "check" | "hover" | "drag"
            | "mouseClick" | "press" | "scroll" | "mouseScroll",
        ) => Some(Moment::Before),
        ("desktop", "waitFor" | "getValue" | "getTable" | "readText" | "isVisible") => {
            Some(Moment::After)
        }
        _ => None,
    }
}

/// The folder the pictures go to and the steps that have one.
pub(crate) struct Screens {
    dir: PathBuf,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// (call path, step) of the steps that have a picture or are taking one.
    taken: HashSet<(Vec<StepId>, StepId)>,
    /// Number of the last picture.
    count: u32,
}

impl Screens {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            state: Mutex::new(State::default()),
        }
    }

    /// A new picture's path and file name for `step`, or `None` when it
    /// has one already. Give it back with [`Screens::release`] when the
    /// picture is not taken after all.
    pub(crate) fn claim(
        &self,
        call_path: &[StepId],
        step: &StepId,
        extension: &str,
    ) -> Option<(PathBuf, String)> {
        let mut state = self.state.lock().ok()?;
        if !state.taken.insert((call_path.to_vec(), step.clone())) {
            return None;
        }
        if state.count == 0 && std::fs::create_dir_all(&self.dir).is_err() {
            state.taken.remove(&(call_path.to_vec(), step.clone()));
            return None;
        }
        state.count += 1;
        let file = format!("{:03}.{extension}", state.count);
        Some((self.dir.join(&file), file))
    }

    pub(crate) fn release(&self, call_path: &[StepId], step: &StepId) {
        if let Ok(mut state) = self.state.lock() {
            state.taken.remove(&(call_path.to_vec(), step.clone()));
        }
    }
}

impl Executor {
    /// Takes `step`'s picture for the 手順書 at `moment`, if the run keeps
    /// pictures and the step has none yet. `params` are the step's params
    /// as rendered for this run.
    pub(crate) async fn capture_screen(&self, step: &Step, params: &Value, at: Moment) {
        if moment(&step.step_type) != Some(at) || self.cancel.is_cancelled() {
            return;
        }
        let (shot_type, extension) = match step.step_type.split('.').next() {
            Some("browser") => ("browser.screenshot", "jpg"),
            Some("desktop") => ("desktop.screenshot", "png"),
            _ => return,
        };
        let Some(handler) = self.handlers.get(shot_type).cloned() else {
            return;
        };
        let Some(shot) = shot_params(&step.step_type, params) else {
            return;
        };
        let Some((path, file)) = self.emitter.screen_path(&step.id, extension) else {
            return;
        };
        let mut shot = shot;
        shot.insert("path".into(), Value::String(path.display().to_string()));
        shot.insert("report".into(), Value::Bool(true));
        let cancel = self.cancel.child_token();
        let input = ActionInput {
            run_id: self.run_id.clone(),
            step_id: step.id.clone(),
            step_type: shot_type.to_owned(),
            attempt: 1,
            params: Value::Object(shot),
            cancel: cancel.clone(),
            timeout_ms: SHOT_LIMIT.as_millis() as u64,
            emitter: self.emitter.clone(),
            secrets: self.secrets.clone(),
            sites_restricted: false,
        };
        let taken = tokio::time::timeout(SHOT_LIMIT, handler.execute(input)).await;
        cancel.cancel();
        let report = match taken {
            Ok(Ok(report)) if path.is_file() => report,
            _ => {
                let _ = std::fs::remove_file(&path);
                self.emitter.release_screen(&step.id);
                return;
            }
        };
        let (width, height) = match (
            report.get("width").and_then(Value::as_u64),
            report.get("height").and_then(Value::as_u64),
        ) {
            (Some(w), Some(h)) if w > 0 && h > 0 => (to_u32(w), to_u32(h)),
            _ => {
                let _ = std::fs::remove_file(&path);
                self.emitter.release_screen(&step.id);
                return;
            }
        };
        let regions = report
            .get("regions")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(rect)
                    .take(MAX_REGIONS)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let title = report
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| self.emitter.mask(t));
        self.emitter.emit(RunEvent::ScreenCaptured {
            step_id: step.id.clone(),
            file,
            width,
            height,
            mark: report.get("mark").and_then(rect),
            regions,
            title,
        });
    }
}

/// What the screenshot step needs to find the screen of a step with these
/// params, and the element to mark on it.
fn shot_params(step_type: &str, params: &Value) -> Option<Map<String, Value>> {
    let mut shot = Map::new();
    if step_type.starts_with("browser.") {
        if let Some(context) = params.get("context") {
            shot.insert("context".into(), context.clone());
        }
        // Waiting for something to go away: there is nothing to mark.
        let gone = step_type == "browser.waitFor"
            && matches!(
                params.get("state").and_then(Value::as_str),
                Some("hidden" | "detached")
            );
        if let Some(target) = params.get("target").filter(|_| !gone) {
            shot.insert("mark".into(), target.clone());
        }
        return Some(shot);
    }
    // A desktop step names its window in its target; the element (if
    // any) is what gets marked.
    let target = params.get("target")?.as_object()?;
    let window = target.get("window")?;
    let mut wanted = Map::new();
    wanted.insert("window".into(), window.clone());
    let gone = step_type == "desktop.waitFor"
        && matches!(params.get("state").and_then(Value::as_str), Some("hidden"));
    if let Some(element) = target.get("element").filter(|_| !gone) {
        wanted.insert("element".into(), element.clone());
    }
    shot.insert("target".into(), Value::Object(wanted));
    Some(shot)
}

fn rect(value: &Value) -> Option<ScreenRect> {
    let num = |key: &str| value.get(key).and_then(Value::as_f64);
    let (x, y, width, height) = (num("x")?, num("y")?, num("width")?, num("height")?);
    if width < 1.0 || height < 1.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(ScreenRect {
        x: x.round() as i32,
        y: y.round() as i32,
        width: width.round() as u32,
        height: height.round() as u32,
    })
}

fn to_u32(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn steps_on_a_screen_get_a_moment() {
        assert_eq!(moment("browser.click"), Some(Moment::Before));
        assert_eq!(moment("browser.fill"), Some(Moment::Before));
        assert_eq!(moment("browser.open"), Some(Moment::After));
        assert_eq!(moment("browser.getTable"), Some(Moment::After));
        assert_eq!(moment("desktop.type"), Some(Moment::Before));
        assert_eq!(moment("desktop.readText"), Some(Moment::After));
        assert_eq!(moment("browser.screenshot"), None);
        assert_eq!(moment("browser.close"), None);
        assert_eq!(moment("excel.readRange"), None);
        assert_eq!(moment("log.message"), None);
    }

    #[test]
    fn browser_shots_mark_the_target_in_its_context() {
        let shot = shot_params(
            "browser.click",
            &json!({ "context": "orders", "target": { "role": "button", "name": "出荷" } }),
        )
        .unwrap();
        assert_eq!(shot["context"], json!("orders"));
        assert_eq!(shot["mark"], json!({ "role": "button", "name": "出荷" }));
        let gone = shot_params(
            "browser.waitFor",
            &json!({ "target": { "text": "読み込み中" }, "state": "hidden" }),
        )
        .unwrap();
        assert!(gone.get("mark").is_none());
    }

    #[test]
    fn desktop_shots_need_a_window() {
        let shot = shot_params(
            "desktop.click",
            &json!({ "target": { "window": { "title": "会計" }, "element": { "name": "登録" } } }),
        )
        .unwrap();
        assert_eq!(
            shot["target"],
            json!({ "window": { "title": "会計" }, "element": { "name": "登録" } })
        );
        assert!(shot_params("desktop.press", &json!({ "keys": "Enter" })).is_none());
    }

    #[test]
    fn each_step_is_claimed_once() {
        let dir = tempfile::tempdir().unwrap();
        let screens = Screens::new(dir.path().join("screens"));
        let step = StepId::new("stp_a");
        let (path, file) = screens.claim(&[], &step, "jpg").unwrap();
        assert_eq!(file, "001.jpg");
        assert!(path.parent().unwrap().is_dir());
        assert!(screens.claim(&[], &step, "jpg").is_none());
        // The same step inside a called flow is another place.
        let call = StepId::new("stp_call");
        assert_eq!(
            screens
                .claim(std::slice::from_ref(&call), &step, "jpg")
                .unwrap()
                .1,
            "002.jpg"
        );
        screens.release(&[], &step);
        assert_eq!(screens.claim(&[], &step, "jpg").unwrap().1, "003.jpg");
    }

    #[test]
    fn rects_need_an_area() {
        assert_eq!(
            rect(&json!({ "x": 1.4, "y": 2.6, "width": 10, "height": 5 })),
            Some(ScreenRect {
                x: 1,
                y: 3,
                width: 10,
                height: 5
            })
        );
        assert_eq!(
            rect(&json!({ "x": 0, "y": 0, "width": 0, "height": 5 })),
            None
        );
        assert_eq!(rect(&json!({ "x": 0 })), None);
    }
}
