//! Which window and element a step means, and how to find it among what
//! the application shows. Pure logic, shared by every backend and tested
//! without Windows.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spellsheet_runtime::StepError;

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
    /// PaddleOCR's larger models (handwriting; slower).
    #[serde(default)]
    pub accurate: bool,
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
    /// Every kind of place (highlighting a target on screen).
    Any,
}

pub const DEFAULT_IMAGE_THRESHOLD: f32 = 0.9;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowQuery {
    #[serde(default)]
    pub title: Option<String>,
    /// How `title` is compared (default: contains). `exact: true` is the
    /// older way to write `"exact"`.
    #[serde(default, rename = "match")]
    pub title_match: Option<TitleMatch>,
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

/// How a window's title is compared with `title`. All but `exact` ignore
/// upper and lower case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TitleMatch {
    /// The title contains it (the default).
    Contains,
    /// The title is exactly it.
    Exact,
    /// The title starts with it.
    Prefix,
    /// The title ends with it.
    Suffix,
    /// The title matches it as a regular expression (anywhere in the title;
    /// anchor with `^` and `$`).
    Pattern,
}

/// The longest pattern accepted (a title is one line).
const MAX_PATTERN: usize = 500;

/// The regular expression of a `pattern` title, or why it is not one.
fn title_pattern(pattern: &str) -> Result<regex::Regex, String> {
    if pattern.len() > MAX_PATTERN {
        return Err(format!(
            "the pattern is longer than {MAX_PATTERN} characters"
        ));
    }
    regex::RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| e.to_string())
}

/// Whether `actual` (a window title) is what `wanted` asks for.
pub fn title_matches(actual: &str, wanted: &str, how: TitleMatch) -> bool {
    let lower = || (actual.to_lowercase(), wanted.to_lowercase());
    match how {
        TitleMatch::Exact => actual == wanted,
        TitleMatch::Contains => {
            let (a, w) = lower();
            a.contains(&w)
        }
        TitleMatch::Prefix => {
            let (a, w) = lower();
            a.starts_with(&w)
        }
        TitleMatch::Suffix => {
            let (a, w) = lower();
            a.ends_with(&w)
        }
        TitleMatch::Pattern => title_pattern(wanted).is_ok_and(|re| re.is_match(actual)),
    }
}

/// What the picker puts in `title` for a window: the title without the
/// marks some apps add for unsaved changes (`*無題 - メモ帳`, `● file.txt`),
/// which come and go while the window stays the same.
pub fn stable_title(title: &str) -> String {
    let trimmed = title.trim();
    let without = trimmed
        .strip_prefix('*')
        .or_else(|| trimmed.strip_prefix('●'))
        .or_else(|| trimmed.strip_prefix('•'))
        .unwrap_or(trimmed);
    without.trim().to_owned()
}

/// The part of a window title that stays when the document in the window
/// changes its date or number, e.g. `請求書_2026年11月.xlsx - Excel` →
/// `請求書`: a picked title with a date in it found the window only that
/// month. `None` when the title has no digits (it is steady as it is) or
/// nothing steady is left.
///
/// The app's name after the last ` - ` and the file's extension are left
/// out (the window is found by its exe anyway), the rest is cut at every
/// run of digits, and the longest piece (two characters or more, without
/// the separators and date units around the digits) is the steady part.
pub fn steady_title(title: &str) -> Option<String> {
    let title = stable_title(title);
    let is_digit = |c: char| c.is_ascii_digit() || ('０'..='９').contains(&c);
    if !title.chars().any(is_digit) {
        return None;
    }
    let mut doc = title.as_str();
    for dash in [" - ", " \u{2014} ", " \u{2013} "] {
        if let Some((head, _app)) = doc.rsplit_once(dash)
            && !head.trim().is_empty()
        {
            doc = head;
            break;
        }
    }
    if let Some((stem, ext)) = doc.rsplit_once('.')
        && (1..=5).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
        && ext.chars().any(|c| c.is_ascii_alphabetic())
        && !stem.trim().is_empty()
    {
        doc = stem;
    }
    const AROUND: &[char] = &[
        ' ', '\u{3000}', '_', '-', '.', '/', ':', ',', '(', ')', '（', '）', '[', ']', '【', '】',
        '#', '＃', '・', '年', '月', '日', '時', '分', '秒', '第', '号', '回', '版', '~', '～',
        'v', 'V',
    ];
    let best = doc
        .split(is_digit)
        .map(|piece| piece.trim_matches(AROUND))
        .filter(|piece| piece.chars().count() >= 2)
        .max_by_key(|piece| piece.chars().count())?;
    (best != title).then(|| best.to_owned())
}

/// The name of the app a window belongs to, for people: the name the
/// window gives after its last ` - ` (`… - Excel`), else the exe name
/// without `.exe`.
pub fn app_label(title: &str, process: &str) -> String {
    let title = stable_title(title);
    if let Some((head, app)) = title.rsplit_once(" - ")
        && !head.trim().is_empty()
        && !app.trim().is_empty()
        && app.chars().count() <= 30
    {
        return app.trim().to_owned();
    }
    let exe = process.rsplit(['\\', '/']).next().unwrap_or(process);
    let stem = exe
        .strip_suffix(".exe")
        .or_else(|| exe.strip_suffix(".EXE"))
        .unwrap_or(exe);
    stem.to_owned()
}

/// How a picked window target finds its window, in words for the picker's
/// tag: `templates` are `any` (`{app}`), `contains` / `exact` / `prefix` /
/// `suffix` / `pattern` (`{app}`, `{title}`) and `nth` (`{n}`, counted
/// from 1, added at the end); missing ones are English.
pub fn describe_window(window: &Value, app: &str, templates: &Value) -> String {
    let text = |key: &str, default: &str| {
        templates
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_owned()
    };
    let title = window.get("title").and_then(Value::as_str);
    let how = if window.get("exact").and_then(Value::as_bool) == Some(true) {
        "exact"
    } else {
        window
            .get("match")
            .and_then(Value::as_str)
            .unwrap_or("contains")
    };
    let mut line = match title {
        None => text("any", "{app} (any of its windows)"),
        Some(_) => match how {
            "exact" => text("exact", "{app} \u{b7} titled \u{201c}{title}\u{201d}"),
            "prefix" => text(
                "prefix",
                "{app} \u{b7} title starts with \u{201c}{title}\u{201d}",
            ),
            "suffix" => text(
                "suffix",
                "{app} \u{b7} title ends with \u{201c}{title}\u{201d}",
            ),
            "pattern" => text("pattern", "{app} \u{b7} title matches {title}"),
            _ => text(
                "contains",
                "{app} \u{b7} title contains \u{201c}{title}\u{201d}",
            ),
        },
    };
    const MAX: usize = 40;
    let title = title.unwrap_or_default();
    let title: String = if title.chars().count() > MAX {
        title.chars().take(MAX - 1).chain(['\u{2026}']).collect()
    } else {
        title.to_owned()
    };
    line = line.replace("{app}", app).replace("{title}", &title);
    if let Some(n) = window.get("nth").and_then(Value::as_u64) {
        line.push_str(&text("nth", " (#{n})").replace("{n}", &(n + 1).to_string()));
    }
    line
}

/// The ways the picker offers to find `windows[window]` again, steadiest
/// first, for the node's settings to choose from: `any` (its exe only),
/// `steady` (the title without its date or number, see [`steady_title`]),
/// `contains` (the title without unsaved marks) and `exact`. Each comes
/// with the `window` it writes and how many open windows it finds now.
pub fn window_choices(windows: &[WindowInfo], window: usize) -> Vec<Value> {
    let w = &windows[window];
    let count = |q: &WindowQuery| windows.iter().filter(|x| q.matches(x)).count();
    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let any = WindowQuery {
        process: Some(w.process.clone()),
        ..WindowQuery::default()
    };
    out.push(json!({ "kind": "any", "window": { "process": w.process }, "finds": count(&any) }));
    let stable = stable_title(&w.title);
    for (kind, title, how) in [
        ("steady", steady_title(&w.title), TitleMatch::Contains),
        (
            "contains",
            (!stable.is_empty()).then(|| stable.clone()),
            TitleMatch::Contains,
        ),
        (
            "exact",
            (!w.title.trim().is_empty()).then(|| w.title.clone()),
            TitleMatch::Exact,
        ),
    ] {
        let Some(title) = title else { continue };
        let key = format!("{how:?}:{title}");
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let q = WindowQuery {
            title: Some(title.clone()),
            title_match: Some(how),
            ..any.clone()
        };
        let name = if how == TitleMatch::Exact {
            "exact"
        } else {
            "contains"
        };
        out.push(json!({
            "kind": kind,
            "title": title,
            "window": { "process": w.process, "title": title, "match": name },
            "finds": count(&q),
        }));
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementQuery {
    /// AutomationId (UIA); what a plugin's bridge uses as the id (the
    /// component ID in SAP GUI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exact: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nth: Option<usize>,
    /// Look only inside this element (a group, pane or row that tells
    /// same-named elements apart), itself found like `element`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub within: Option<Box<ElementQuery>>,
    /// The first match after this element in the window's order, e.g. the
    /// text box that follows the label 「氏名」 (`nth` counts from there).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<Box<ElementQuery>>,
}

/// How deep `within` / `after` may nest (the step schemas allow as much).
pub const MAX_NESTING: usize = 2;

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

    /// The window alone, keeping nothing else.
    pub fn window_part_only(&self) -> Target {
        Target::window_only(self.window.clone())
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
        if allow == Allow::Any {
            return Ok(());
        }
        let refuse = |what: &str, steps: &str| {
            Err(StepError::invalid_params(format!(
                "target.{what} works only with {steps}"
            )))
        };
        if self.point.is_some() && allow != Allow::Mouse {
            return refuse(
                "point",
                "the mouse steps (desktop.mouseClick, desktop.mouseScroll, desktop.drag, desktop.hover)",
            );
        }
        let visual_steps = "the mouse steps, desktop.type, desktop.waitFor and desktop.isVisible";
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
        if let (Some(title), TitleMatch::Pattern) = (&w.title, w.how())
            && let Err(e) = title_pattern(title)
        {
            return Err(StepError::invalid_params(format!(
                "target.window.title is not a valid pattern: {e}"
            ))
            .with_details(json!({ "hint": "With match \"pattern\", title is a regular expression (e.g. ^請求書_\\d+\\.xlsx - Excel$). Use match \"contains\" for plain text." })));
        }
        if w.title_match.is_some() && w.title.is_none() {
            return Err(StepError::invalid_params("target.window.match needs title"));
        }
        if let Some(element) = &self.element {
            element.check("target.element", 0)?;
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
    /// How `title` is compared: `match`, else `exact`, else contains.
    pub fn how(&self) -> TitleMatch {
        self.title_match.unwrap_or(if self.exact {
            TitleMatch::Exact
        } else {
            TitleMatch::Contains
        })
    }

    pub fn matches(&self, w: &WindowInfo) -> bool {
        let how = self.how();
        self.title
            .as_deref()
            .is_none_or(|t| title_matches(&w.title, t, how))
            && self
                .process
                .as_deref()
                .is_none_or(|p| process_key(p) == process_key(&w.process))
            && self.class_name.as_deref().is_none_or(|c| c == w.class_name)
    }
}

impl ElementQuery {
    fn check(&self, at: &str, depth: usize) -> Result<(), StepError> {
        if depth > MAX_NESTING {
            return Err(StepError::invalid_params(format!(
                "{at}: within / after nest more than {MAX_NESTING} levels"
            )));
        }
        if self.id.is_none()
            && self.name.is_none()
            && self.role.is_none()
            && self.class_name.is_none()
        {
            return Err(StepError::invalid_params(format!(
                "{at} needs id, name or role"
            )));
        }
        if let Some(role) = &self.role
            && roles::control_type(role).is_none()
        {
            return Err(
                StepError::invalid_params(format!("unknown role '{role}'")).with_details(
                    json!({ "hint": format!("Use one of: {}", roles::names().join(", ")) }),
                ),
            );
        }
        if let Some(within) = &self.within {
            within.check(&format!("{at}.within"), depth + 1)?;
        }
        if let Some(after) = &self.after {
            after.check(&format!("{at}.after"), depth + 1)?;
        }
        Ok(())
    }

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
    pick_in(query, nodes, 1..nodes.len(), "target.element")
}

/// The indices of the subtree under `nodes[parent]` (not itself).
fn subtree(nodes: &[NodeInfo], parent: usize) -> std::ops::Range<usize> {
    let depth = nodes[parent].depth;
    let end = (parent + 1..nodes.len())
        .find(|&i| nodes[i].depth <= depth)
        .unwrap_or(nodes.len());
    parent + 1..end
}

fn pick_in(
    query: &ElementQuery,
    nodes: &[NodeInfo],
    scope: std::ops::Range<usize>,
    at: &str,
) -> Result<usize, StepError> {
    let scope = match &query.within {
        Some(parent) => {
            let parent = pick_in(parent, nodes, scope, &format!("{at}.within"))?;
            subtree(nodes, parent)
        }
        None => scope,
    };
    let from = match &query.after {
        Some(anchor) => pick_in(anchor, nodes, scope.clone(), &format!("{at}.after"))? + 1,
        None => scope.start,
    };
    let hits: Vec<usize> = (from.max(scope.start)..scope.end)
        .filter(|&i| query.matches(&nodes[i]))
        .collect();
    // After an anchor the first match is the one meant (the box next to
    // its label), unless nth says otherwise.
    let nth = query.nth.or(query.after.as_ref().map(|_| 0));
    pick(nth, &hits).map_err(|kind| match kind {
        Miss::None => StepError::new(
            "ELEMENT_NOT_FOUND",
            format!("no element in the window matches {at}"),
        )
        .with_details(json!({
            "hint": "Call inspect_ui with this window and copy id / name / role exactly as listed. Names match partially unless exact is true."
        })),
        Miss::Many => StepError::permanent(
            "ELEMENT_AMBIGUOUS",
            format!("{} elements match {at}", hits.len()),
        )
        .with_details(json!({
            "hint": "Add id or role, use exact: true, look inside the group that holds it (within), start after its label (after), or pick one with nth (0-based, in the order listed).",
            "matches": hits.iter().take(MAX_CANDIDATES).map(|&i| describe(&nodes[i])).collect::<Vec<_>>(),
        })),
        Miss::Nth(n) => StepError::new(
            "ELEMENT_NOT_FOUND",
            format!("{at}.nth is {n} but only {} elements match", hits.len()),
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

/// How far back the picker looks for the label of a nameless element.
const MAX_LABEL_DISTANCE: usize = 8;

/// A target for what the user pointed at on screen (the picker), built to
/// be as sturdy as the app allows, and how it tells the element apart.
#[derive(Debug, Clone, PartialEq)]
pub struct Picked {
    pub target: Value,
    /// `window`, `id`, `name`, `within`, `after`, `nth` or `point`.
    pub how: &'static str,
}

/// The target for `nodes[element]` (`None`: the window itself) in
/// `windows[window]`. `point` is where the user clicked, from the window's
/// top-left corner: the last resort for an element with no id and no name.
///
/// In order: the window by its exe name (with its title only when the app
/// has several windows open); the element by an id unique in the window,
/// else role + name (exact), else role + name inside the nearest group the
/// window has one of, else (no name) its role after the label before it,
/// else with `nth`; else the point.
pub fn picked_target(
    windows: &[WindowInfo],
    window: usize,
    nodes: &[NodeInfo],
    element: Option<usize>,
    point: Point,
) -> Picked {
    let w = &windows[window];
    let mut window_query = WindowQuery {
        process: Some(w.process.clone()),
        ..WindowQuery::default()
    };
    let mut window_json = json!({ "process": w.process });
    let same_app = |q: &WindowQuery| {
        (0..windows.len())
            .filter(|&i| q.matches(&windows[i]))
            .collect::<Vec<_>>()
    };
    // The title only when the app has several windows open. Contains (the
    // default) the title without unsaved marks, so the target still finds
    // the window when the app adds or drops them; exact only when that
    // would also find another of its windows.
    // The steadiest first: the title without a date or number in it (the
    // same flow works on next month's file), then the whole title.
    let title = stable_title(&w.title);
    if same_app(&window_query).len() > 1 && !title.is_empty() {
        let steady = steady_title(&w.title).filter(|steady| {
            same_app(&WindowQuery {
                title: Some(steady.clone()),
                ..window_query.clone()
            })
            .len()
                == 1
        });
        let contains = steady.unwrap_or(title);
        window_query.title = Some(contains.clone());
        window_json["title"] = json!(contains);
        if same_app(&window_query).len() > 1 && !w.title.trim().is_empty() {
            window_query.title = Some(w.title.clone());
            window_query.title_match = Some(TitleMatch::Exact);
            window_json["title"] = json!(w.title);
            window_json["match"] = json!("exact");
        } else {
            window_json["match"] = json!("contains");
        }
    }
    let hits = same_app(&window_query);
    if hits.len() > 1
        && let Some(n) = hits.iter().position(|&i| i == window)
    {
        window_json["nth"] = json!(n);
    }
    let Some(index) = element.filter(|&i| i > 0 && i < nodes.len()) else {
        return Picked {
            target: json!({ "window": window_json }),
            how: "window",
        };
    };
    let node = &nodes[index];
    let count = |q: &ElementQuery| -> Vec<usize> {
        (1..nodes.len()).filter(|&i| q.matches(&nodes[i])).collect()
    };
    let element_json = |q: &ElementQuery, nth: Option<usize>| -> Value {
        let mut e = serde_json::Map::new();
        if let Some(id) = &q.id {
            e.insert("id".into(), json!(id));
        }
        if let Some(role) = &q.role {
            e.insert("role".into(), json!(role));
        }
        if let Some(name) = &q.name {
            e.insert("name".into(), json!(name));
        }
        if q.exact {
            e.insert("exact".into(), json!(true));
        }
        if let Some(n) = nth {
            e.insert("nth".into(), json!(n));
        }
        Value::Object(e)
    };
    let done = |e: Value, how| Picked {
        target: json!({ "window": window_json, "element": e }),
        how,
    };
    // A query that finds only `nodes[i]` in the whole window, by id or by
    // role + name: what `within` and `after` can stand on.
    let unique = |i: usize| -> Option<ElementQuery> {
        let n = &nodes[i];
        let by_id = (!n.id.is_empty()).then(|| ElementQuery {
            id: Some(n.id.clone()),
            ..ElementQuery::default()
        });
        let by_name = (!n.name.trim().is_empty()).then(|| ElementQuery {
            role: Some(n.role.to_owned()),
            name: Some(n.name.clone()),
            exact: true,
            ..ElementQuery::default()
        });
        [by_id, by_name]
            .into_iter()
            .flatten()
            .find(|q| count(q) == [i])
    };
    let nested = |q: &ElementQuery| -> Value {
        let mut e = element_json(q, None);
        if let Some(within) = &q.within {
            e["within"] = element_json(within, None);
        }
        if let Some(after) = &q.after {
            e["after"] = element_json(after, None);
        }
        e
    };
    // Same-named elements told apart by the nearest group, pane or row
    // around them that the window has only one of.
    let inside = |q: &ElementQuery| -> Option<ElementQuery> {
        let mut depth = node.depth;
        for j in (1..index).rev() {
            if nodes[j].depth >= depth {
                continue;
            }
            depth = nodes[j].depth;
            if let Some(parent) = unique(j) {
                let scoped = ElementQuery {
                    within: Some(Box::new(parent)),
                    ..q.clone()
                };
                if pick_element(&scoped, nodes).ok() == Some(index) {
                    return Some(scoped);
                }
            }
        }
        None
    };
    // An element without a name (an input box) by the label just before it:
    // the nearest named element in front that the window has only one of.
    let after_label = || -> Option<ElementQuery> {
        let q = ElementQuery {
            role: Some(node.role.to_owned()),
            ..ElementQuery::default()
        };
        (1..index).rev().take(MAX_LABEL_DISTANCE).find_map(|j| {
            if nodes[j].name.trim().is_empty() {
                return None;
            }
            let anchored = ElementQuery {
                after: Some(Box::new(unique(j)?)),
                ..q.clone()
            };
            (pick_element(&anchored, nodes).ok() == Some(index)).then_some(anchored)
        })
    };
    if !node.id.is_empty() {
        let q = ElementQuery {
            id: Some(node.id.clone()),
            ..ElementQuery::default()
        };
        if count(&q).len() == 1 {
            return done(element_json(&q, None), "id");
        }
    }
    if !node.name.trim().is_empty() {
        let q = ElementQuery {
            role: Some(node.role.to_owned()),
            name: Some(node.name.clone()),
            exact: true,
            ..ElementQuery::default()
        };
        let hits = count(&q);
        if hits.len() == 1 {
            return done(element_json(&q, None), "name");
        }
        if let Some(scoped) = inside(&q) {
            return done(nested(&scoped), "within");
        }
        let nth = hits.iter().position(|&i| i == index);
        return done(element_json(&q, nth), "nth");
    }
    if let Some(anchored) = after_label() {
        return done(nested(&anchored), "after");
    }
    if !node.id.is_empty() {
        let q = ElementQuery {
            id: Some(node.id.clone()),
            ..ElementQuery::default()
        };
        if let Some(scoped) = inside(&q) {
            return done(nested(&scoped), "within");
        }
        let nth = count(&q).iter().position(|&i| i == index);
        return done(element_json(&q, nth), "nth");
    }
    Picked {
        target: json!({ "window": window_json, "point": { "x": point.x, "y": point.y } }),
        how: "point",
    }
}
