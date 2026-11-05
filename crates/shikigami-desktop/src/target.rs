//! Which window and element a step means, and how to find it among what
//! the application shows. Pure logic, shared by every backend and tested
//! without Windows.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use shikigami_runtime::StepError;

use crate::roles;

/// `target` of a desktop step: a top-level window, optionally an element
/// inside it, or (last resort, mouse steps only) a point in the window.
/// Where the app shows no elements (Citrix, remote desktops, drawn
/// screens), `image` or `ocr` find the place on the picture of the window,
/// within `element` or `region` when given.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub window: WindowQuery,
    #[serde(default)]
    pub element: Option<ElementQuery>,
    #[serde(default)]
    pub point: Option<Point>,
    /// Part of the window (pixels from its top-left) to look in or read.
    #[serde(default)]
    pub region: Option<Region>,
    #[serde(default)]
    pub image: Option<ImageQuery>,
    #[serde(default)]
    pub ocr: Option<TextQuery>,
    /// Moves the place found by `image` / `ocr` (from its centre).
    #[serde(default)]
    pub offset: Option<Point>,
}

/// A rectangle of the window, from its top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A picture to find on the screen.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageQuery {
    /// PNG file (absolute path), cut from a screenshot of the same app.
    pub path: String,
    /// How alike the place must be, 0.5 to 1 (default 0.9).
    #[serde(default)]
    pub threshold: Option<f32>,
    #[serde(default)]
    pub nth: Option<usize>,
}

/// Text to find on the screen with OCR.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextQuery {
    pub text: String,
    /// The whole line must be this text.
    #[serde(default)]
    pub exact: bool,
    #[serde(default)]
    pub nth: Option<usize>,
    /// OCR language for Windows OCR, e.g. `ja` or `en-US` (default: the
    /// user's languages).
    #[serde(default)]
    pub language: Option<String>,
    /// `paddle` or `windows` (default: PaddleOCR when installed).
    #[serde(default)]
    pub engine: Option<String>,
}

/// What a step allows in its target besides a window and an element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Allow {
    /// Window and element only.
    Plain,
    /// Also `point`, `image`, `ocr` (desktop.mouseClick).
    Mouse,
    /// Also `image` and `ocr` (steps that find a place to act on or wait for).
    Visual,
    /// Also `region` (steps that read or save the picture itself).
    Picture,
}

pub const DEFAULT_IMAGE_THRESHOLD: f32 = 0.9;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowQuery {
    #[serde(default)]
    pub title: Option<String>,
    /// Executable name, e.g. `billing.exe` (`.exe` optional).
    #[serde(default)]
    pub process: Option<String>,
    #[serde(default)]
    pub class_name: Option<String>,
    #[serde(default)]
    pub exact: bool,
    #[serde(default)]
    pub nth: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementQuery {
    /// AutomationId (UIA); the component ID in SAP GUI.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub class_name: Option<String>,
    #[serde(default)]
    pub exact: bool,
    #[serde(default)]
    pub nth: Option<usize>,
}

/// Pixels from the window's top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Target {
    pub fn from_params(params: &Value, key: &str, allow: Allow) -> Result<Self, StepError> {
        let value = params
            .get(key)
            .ok_or_else(|| StepError::invalid_params(format!("'{key}' is required")))?;
        let target: Target =
            serde_json::from_value(value.clone()).map_err(StepError::invalid_params)?;
        target.check()?;
        target.check_allowed(allow)?;
        Ok(target)
    }

    /// Whether the place is found on the picture of the window.
    pub fn is_visual(&self) -> bool {
        self.image.is_some() || self.ocr.is_some()
    }

    /// The window (and element) alone, for the backend.
    pub fn window_part(&self) -> Target {
        Target {
            element: self.element.clone(),
            ..Target::window_only(self.window.clone())
        }
    }

    pub fn window_only(window: WindowQuery) -> Target {
        Target {
            window,
            element: None,
            point: None,
            region: None,
            image: None,
            ocr: None,
            offset: None,
        }
    }

    fn check_allowed(&self, allow: Allow) -> Result<(), StepError> {
        let refuse = |what: &str, steps: &str| {
            Err(StepError::invalid_params(format!(
                "target.{what} works only with {steps}"
            )))
        };
        if self.point.is_some() && allow != Allow::Mouse {
            return refuse("point", "desktop.mouseClick");
        }
        let visual_steps =
            "desktop.mouseClick, desktop.type, desktop.waitFor and desktop.isVisible";
        if self.image.is_some() && !matches!(allow, Allow::Mouse | Allow::Visual) {
            return refuse("image", visual_steps);
        }
        if self.ocr.is_some() && !matches!(allow, Allow::Mouse | Allow::Visual) {
            return refuse("ocr", visual_steps);
        }
        if self.region.is_some() && allow == Allow::Plain {
            return refuse(
                "region",
                "target.image / target.ocr, desktop.readText and desktop.screenshot",
            );
        }
        if self.region.is_some() && !self.is_visual() && allow != Allow::Picture {
            return Err(StepError::invalid_params(
                "target.region narrows target.image or target.ocr; add one of them",
            ));
        }
        Ok(())
    }

    fn check(&self) -> Result<(), StepError> {
        let w = &self.window;
        if w.title.is_none() && w.process.is_none() && w.class_name.is_none() {
            return Err(StepError::invalid_params(
                "target.window needs title or process",
            )
            .with_details(json!({ "hint": "Call inspect_ui without arguments to list the open windows, then copy title and process from there." })));
        }
        if let Some(element) = &self.element {
            if element.id.is_none()
                && element.name.is_none()
                && element.role.is_none()
                && element.class_name.is_none()
            {
                return Err(StepError::invalid_params(
                    "target.element needs id, name or role",
                ));
            }
            if let Some(role) = &element.role
                && roles::control_type(role).is_none()
            {
                return Err(StepError::invalid_params(format!("unknown role '{role}'"))
                    .with_details(
                        json!({ "hint": format!("Use one of: {}", roles::names().join(", ")) }),
                    ));
            }
        }
        if self.element.is_some() && self.point.is_some() {
            return Err(StepError::invalid_params(
                "give target.element or target.point, not both",
            ));
        }
        if self.point.is_some() && (self.region.is_some() || self.is_visual()) {
            return Err(StepError::invalid_params(
                "target.point is a place of its own: leave out region, image and ocr",
            ));
        }
        if self.element.is_some() && self.region.is_some() {
            return Err(StepError::invalid_params(
                "give target.element or target.region, not both",
            ));
        }
        if self.image.is_some() && self.ocr.is_some() {
            return Err(StepError::invalid_params(
                "give target.image or target.ocr, not both",
            ));
        }
        if self.offset.is_some() && !self.is_visual() {
            return Err(StepError::invalid_params(
                "target.offset moves the place found by target.image or target.ocr",
            ));
        }
        if let Some(region) = &self.region
            && (region.width == 0 || region.height == 0)
        {
            return Err(StepError::invalid_params(
                "target.region needs a width and height",
            ));
        }
        if let Some(image) = &self.image {
            if image.path.trim().is_empty() {
                return Err(StepError::invalid_params("target.image.path is empty"));
            }
            if let Some(t) = image.threshold
                && !(0.5..=1.0).contains(&t)
            {
                return Err(StepError::invalid_params(
                    "target.image.threshold must be between 0.5 and 1",
                ));
            }
        }
        if let Some(ocr) = &self.ocr
            && ocr.text.trim().is_empty()
        {
            return Err(StepError::invalid_params("target.ocr.text is empty"));
        }
        Ok(())
    }
}

/// A top-level window as a backend sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub title: String,
    pub process: String,
    pub pid: u32,
    pub class_name: String,
    #[serde(skip)]
    pub handle: isize,
}

/// One element of a window's tree, in document order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NodeInfo {
    pub depth: usize,
    pub name: String,
    pub id: String,
    pub role: &'static str,
    pub class_name: String,
    pub enabled: bool,
    pub offscreen: bool,
    pub password: bool,
    pub value: Option<String>,
    pub checked: Option<bool>,
}

fn text_matches(actual: &str, wanted: &str, exact: bool) -> bool {
    if exact {
        actual == wanted
    } else {
        actual.to_lowercase().contains(&wanted.to_lowercase())
    }
}

/// `billing.exe`, `Billing` and `BILLING.EXE` are one process name.
pub fn process_key(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_owned()
}

impl WindowQuery {
    pub fn matches(&self, w: &WindowInfo) -> bool {
        self.title
            .as_deref()
            .is_none_or(|t| text_matches(&w.title, t, self.exact))
            && self
                .process
                .as_deref()
                .is_none_or(|p| process_key(p) == process_key(&w.process))
            && self.class_name.as_deref().is_none_or(|c| c == w.class_name)
    }
}

impl ElementQuery {
    pub fn matches(&self, n: &NodeInfo) -> bool {
        self.id.as_deref().is_none_or(|id| id == n.id)
            && self
                .name
                .as_deref()
                .is_none_or(|name| text_matches(&n.name, name, self.exact))
            && self.role.as_deref().is_none_or(|role| role == n.role)
            && self.class_name.as_deref().is_none_or(|c| c == n.class_name)
    }
}

const MAX_CANDIDATES: usize = 15;

/// Index of the one window `query` means. Not found is retryable (the
/// window may still be opening); several matches without `nth` is not.
pub fn pick_window(query: &WindowQuery, windows: &[WindowInfo]) -> Result<usize, StepError> {
    let hits: Vec<usize> = (0..windows.len())
        .filter(|&i| query.matches(&windows[i]))
        .collect();
    let listed = |indices: &mut dyn Iterator<Item = usize>| -> Vec<Value> {
        indices
            .take(MAX_CANDIDATES)
            .map(|i| json!({ "title": windows[i].title, "process": windows[i].process }))
            .collect()
    };
    pick(query.nth, &hits).map_err(|kind| match kind {
        Miss::None => StepError::new("WINDOW_NOT_FOUND", "no open window matches target.window")
            .with_details(json!({
                "hint": "Copy title / process from the open windows below (or from inspect_ui). Titles match partially unless exact is true.",
                "openWindows": listed(&mut (0..windows.len())),
            })),
        Miss::Many => StepError::permanent(
            "WINDOW_AMBIGUOUS",
            format!("{} windows match target.window", hits.len()),
        )
        .with_details(json!({
            "hint": "Narrow it down with a longer title, process or exact: true, or pick one with nth (0-based).",
            "matches": listed(&mut hits.iter().copied()),
        })),
        Miss::Nth(n) => StepError::new(
            "WINDOW_NOT_FOUND",
            format!("target.window.nth is {n} but only {} windows match", hits.len()),
        ),
    })
}

/// Index into `nodes` of the one element `query` means (the window itself,
/// `nodes[0]`, is not searched).
pub fn pick_element(query: &ElementQuery, nodes: &[NodeInfo]) -> Result<usize, StepError> {
    let hits: Vec<usize> = (1..nodes.len())
        .filter(|&i| query.matches(&nodes[i]))
        .collect();
    pick(query.nth, &hits).map_err(|kind| match kind {
        Miss::None => StepError::new(
            "ELEMENT_NOT_FOUND",
            "no element in the window matches target.element",
        )
        .with_details(json!({
            "hint": "Call inspect_ui with this window and copy id / name / role exactly as listed. Names match partially unless exact is true."
        })),
        Miss::Many => StepError::permanent(
            "ELEMENT_AMBIGUOUS",
            format!("{} elements match target.element", hits.len()),
        )
        .with_details(json!({
            "hint": "Add id or role, use exact: true, or pick one with nth (0-based, in the order listed).",
            "matches": hits.iter().take(MAX_CANDIDATES).map(|&i| describe(&nodes[i])).collect::<Vec<_>>(),
        })),
        Miss::Nth(n) => StepError::new(
            "ELEMENT_NOT_FOUND",
            format!("target.element.nth is {n} but only {} elements match", hits.len()),
        ),
    })
}

enum Miss {
    None,
    Many,
    Nth(usize),
}

fn pick(nth: Option<usize>, hits: &[usize]) -> Result<usize, Miss> {
    match (nth, hits) {
        (_, []) => Err(Miss::None),
        (None, [one]) => Ok(*one),
        (None, _) => Err(Miss::Many),
        (Some(n), hits) => hits.get(n).copied().ok_or(Miss::Nth(n)),
    }
}

/// One line of `inspect_ui`'s tree, e.g. `button "保存" id=btnSave`.
pub fn describe(n: &NodeInfo) -> String {
    let mut line = n.role.to_owned();
    if !n.name.is_empty() {
        line.push_str(&format!(" {}", quote(&n.name)));
    }
    if !n.id.is_empty() {
        line.push_str(&format!(" id={}", n.id));
    }
    if n.password {
        line.push_str(" [password]");
    } else if let Some(value) = n.value.as_deref().filter(|v| !v.is_empty() && *v != n.name) {
        line.push_str(&format!(" value={}", quote(value)));
    }
    match n.checked {
        Some(true) => line.push_str(" [checked]"),
        Some(false) => line.push_str(" [unchecked]"),
        None => {}
    }
    if !n.enabled {
        line.push_str(" [disabled]");
    }
    if n.offscreen {
        line.push_str(" [offscreen]");
    }
    line
}

fn quote(text: &str) -> String {
    const MAX: usize = 80;
    let mut short: String = text.chars().take(MAX).collect();
    if text.chars().count() > MAX {
        short.push('…');
    }
    serde_json::to_string(&short).unwrap_or_default()
}

/// The indented tree `inspect_ui` returns, cut after `max_nodes` lines.
pub fn render_tree(nodes: &[NodeInfo], max_nodes: usize) -> String {
    let mut out = String::new();
    for node in nodes.iter().take(max_nodes) {
        out.push_str(&"  ".repeat(node.depth));
        out.push_str("- ");
        out.push_str(&describe(node));
        out.push('\n');
    }
    if nodes.len() > max_nodes {
        out.push_str(&format!(
            "… ({} more elements: pass `element` to inspect one part of the window)\n",
            nodes.len() - max_nodes
        ));
    }
    out
}

/// Secret sites a desktop app is written as: `app:billing.exe`.
pub const APP_SITE_PREFIX: &str = "app:";

/// Whether a secret registered for `sites` may be typed into `process`.
pub fn app_allowed(sites: &[String], process: &str) -> bool {
    let want = process_key(process);
    sites.iter().any(|site| {
        site.strip_prefix(APP_SITE_PREFIX)
            .is_some_and(|app| process_key(app) == want)
    })
}
