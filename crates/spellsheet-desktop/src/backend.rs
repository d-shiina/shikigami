//! What the steps ask of the technology that reaches the application.

use serde_json::{Value, json};
use spellsheet_runtime::{BoxFuture, StepError};

use crate::bitmap::{Bitmap, Rect};
use crate::keys::Chord;
use crate::target::{ElementQuery, Target, WindowQuery};
use crate::vision::OcrLine;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
}

/// Which way to scroll (`Top` / `Bottom` go all the way).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
    Top,
    Bottom,
}

impl Direction {
    pub fn parse(name: &str) -> Result<Self, StepError> {
        Ok(match name {
            "up" => Self::Up,
            "down" => Self::Down,
            "left" => Self::Left,
            "right" => Self::Right,
            "top" => Self::Top,
            "bottom" => Self::Bottom,
            other => {
                return Err(StepError::invalid_params(format!(
                    "unknown direction '{other}' (use up, down, left, right, top or bottom)"
                )));
            }
        })
    }

    pub fn is_vertical(self) -> bool {
        matches!(self, Self::Up | Self::Down | Self::Top | Self::Bottom)
    }
}

/// How a window is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowState {
    Maximized,
    Minimized,
    Normal,
}

impl WindowState {
    pub fn parse(name: &str) -> Result<Self, StepError> {
        Ok(match name {
            "maximized" => Self::Maximized,
            "minimized" => Self::Minimized,
            "normal" => Self::Normal,
            other => {
                return Err(StepError::invalid_params(format!(
                    "unknown window state '{other}' (use maximized, minimized or normal)"
                )));
            }
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Maximized => "maximized",
            Self::Minimized => "minimized",
            Self::Normal => "normal",
        }
    }
}

/// Where a window goes and how big it is, in screen pixels; what is left
/// out stays as it is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Bounds {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

impl Bounds {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// How far one scroll goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollUnit {
    Line,
    Page,
}

/// Text to enter, with the apps a secret may be typed into (`None` for
/// plain text).
#[derive(Clone, PartialEq)]
pub struct Text {
    pub value: String,
    pub allowed_apps: Option<Vec<String>>,
}

impl std::fmt::Debug for Text {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.allowed_apps {
            Some(apps) => write!(f, "Text(secret, apps={apps:?})"),
            None => write!(f, "Text({:?})", self.value),
        }
    }
}

/// One request to a backend. Element references never leave the backend:
/// each request names its target and is resolved anew.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// The open top-level windows.
    ListWindows,
    /// A window's element tree (or the part under `element`).
    Inspect {
        window: WindowQuery,
        element: Option<ElementQuery>,
        max_nodes: usize,
    },
    /// Whether the target exists now: `{ found, visible, enabled }`. Never
    /// fails because it is missing.
    Probe {
        target: Target,
    },
    /// Activates the element without the mouse (invoke, toggle, select,
    /// expand), so no focus is needed.
    Click {
        target: Target,
    },
    SetValue {
        target: Target,
        text: Text,
    },
    GetValue {
        target: Target,
    },
    Select {
        target: Target,
        option: String,
    },
    MouseClick {
        target: Target,
        button: MouseButton,
        double: bool,
    },
    Type {
        target: Target,
        text: Text,
    },
    Press {
        target: Target,
        chord: Chord,
    },
    CloseWindow {
        target: Target,
    },
    /// Maximizes, minimizes or restores `target.window`, moves or sizes it,
    /// and/or brings it to the front. Output: `{ state, x, y, width, height }`.
    SetWindow {
        target: Target,
        state: Option<WindowState>,
        front: bool,
        bounds: Bounds,
    },
    /// Scrolls without the mouse. `None` brings the target element into
    /// view; otherwise its scrollable area (or the nearest one around it)
    /// moves `amount` units. Output `{ verticalPercent, horizontalPercent,
    /// atEnd }`.
    Scroll {
        target: Target,
        direction: Option<Direction>,
        amount: u32,
        unit: ScrollUnit,
    },
    /// Turns the real mouse wheel `notches` times over the target.
    Wheel {
        target: Target,
        direction: Direction,
        notches: u32,
    },
    /// Holds the left button down on `from` and lets go on `to`.
    Drag {
        from: Target,
        to: Box<Target>,
    },
    /// Moves the real mouse onto the target.
    Hover {
        target: Target,
    },
    /// Reads a grid, list or table (`target.element`, or the first one in
    /// the window): a [`crate::table::Grid`] as JSON, at most `max_rows`
    /// rows (`truncated` when there were more).
    GetTable {
        target: Target,
        max_rows: usize,
    },
    /// Starts a SAP transaction in the SAP GUI window of `target`.
    /// Output: the status bar `{ type, text }`.
    SapTransaction {
        target: Target,
        code: String,
    },
    /// Opens the context menu of `target.element` (or uses the open menu /
    /// the menu bar of `target.window`) and picks `path` item by item.
    Menu {
        target: Target,
        path: Vec<String>,
    },
    /// Lets the user point at an element on screen: follows the mouse with
    /// a frame, takes the next click (the app never gets it) and answers
    /// `{ target, how, rect, window }` (see `target::picked_target`), or
    /// `{ cancelled: true }` on Esc or after `timeout_ms`. While the user
    /// points, a tag at the window's frame says how the window will be found
    /// (in the words of `labels`, see `target::describe_window`) and one at
    /// the part's frame names it. With `window_only` the window is picked,
    /// not a part of it (nodes that act on the window itself).
    Pick {
        message: Option<String>,
        timeout_ms: u64,
        labels: serde_json::Value,
        window_only: bool,
    },
    /// 「画面から切り取る」: freezes the screen, dims it and lets the user
    /// drag a rectangle on it. Answers `{ target: { window }, png (base64),
    /// width, height, rect, window }` with the window under the middle of
    /// the rectangle, or `{ cancelled: true }` on Esc, a right click or
    /// after `timeout_ms`.
    Snip {
        message: Option<String>,
        timeout_ms: u64,
    },
    /// Records what the user does until the banner is clicked or
    /// `timeout_ms` passes: each click (with the target of what was
    /// clicked, as `Pick` builds it), each text field's final text, and
    /// each command key. Answers `{ status: "stopped" | "timedOut",
    /// actions: [...] }`. `title` is the banner's first line, with `{n}`
    /// replaced by the number of actions so far.
    Record {
        title: String,
        hint: String,
        timeout_ms: u64,
    },
    /// Frames the target on screen for `ms`: `{ found, rect? }`.
    Highlight {
        target: Target,
        ms: u64,
    },
}

/// A picture of a window as it is shown now.
#[derive(Debug, Clone, PartialEq)]
pub struct Capture {
    /// The whole window, from its top-left corner (the origin of
    /// `target.point` and `target.region`).
    pub image: Bitmap,
    /// The target element's place in the picture, when it names one.
    pub element: Option<Rect>,
}

pub trait Backend: Send + Sync + 'static {
    fn call(&self, op: Op) -> BoxFuture<'static, Result<Value, StepError>>;

    /// A picture of `target.window` (`target.element` is located in it).
    fn capture(&self, _target: Target) -> BoxFuture<'static, Result<Capture, StepError>> {
        Box::pin(async { Err(unsupported()) })
    }

    /// The lines of text OCR reads in `image`, in its pixels: PaddleOCR
    /// where its models are installed (Windows OCR is the backend's own).
    fn recognize(
        &self,
        image: Bitmap,
        options: OcrOptions,
    ) -> BoxFuture<'static, Result<Vec<OcrLine>, StepError>> {
        match &options.engine {
            Some(OcrEngine::Windows) => Box::pin(async { Err(unsupported()) }),
            Some(OcrEngine::Other(name)) => other_recognize(name, image, options.clone()),
            _ => paddle_recognize(image, options.accurate, options.kind),
        }
    }

    /// An image file (PNG everywhere; other formats where the platform
    /// decodes them).
    fn load_image(&self, path: String) -> BoxFuture<'static, Result<Bitmap, StepError>> {
        Box::pin(async move { load_png(&path) })
    }
}

/// Which OCR to use and how.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OcrOptions {
    /// BCP-47 tag (`ja`, `en-US`) for Windows OCR; `None` uses the user's
    /// languages. PaddleOCR reads Japanese, Chinese and English at once.
    pub language: Option<String>,
    /// `None`: PaddleOCR when installed, otherwise Windows OCR.
    pub engine: Option<OcrEngine>,
    /// PaddleOCR's larger models: much better on handwriting, several
    /// times slower. Always PaddleOCR.
    pub accurate: bool,
    /// What the field holds: PaddleOCR reads only its characters.
    pub kind: Option<crate::ocr_fit::TextKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OcrEngine {
    Paddle,
    Windows,
    /// An engine added with [`register_ocr_engine`] (e.g. a cloud AI-OCR
    /// from an extension), by its name.
    Other(String),
}

impl OcrOptions {
    /// `accurate` is PaddleOCR's; it does not go with Windows OCR.
    pub fn check(self) -> Result<Self, StepError> {
        match &self.engine {
            Some(OcrEngine::Windows) if self.accurate => {
                return Err(StepError::invalid_params(
                    "accurate uses PaddleOCR's larger models; leave out engine: \"windows\"",
                ));
            }
            Some(OcrEngine::Other(name)) if self.accurate => {
                return Err(StepError::invalid_params(format!(
                    "accurate uses PaddleOCR's larger models; leave out engine: \"{name}\""
                )));
            }
            _ => {}
        }
        Ok(self)
    }
}

impl OcrEngine {
    pub fn parse(name: &str) -> Result<Self, StepError> {
        match name {
            "paddle" => Ok(Self::Paddle),
            "windows" => Ok(Self::Windows),
            other if ocr_engine(other).is_some() => Ok(Self::Other(other.to_owned())),
            other => {
                let mut names = vec!["paddle".to_owned(), "windows".to_owned()];
                names.extend(ocr_engine_names());
                Err(StepError::invalid_params(format!(
                    "unknown OCR engine '{other}' (use {})",
                    names.join(", ")
                )))
            }
        }
    }

    /// The name flows write (`engine` of desktop.readText and target.ocr).
    pub fn name(&self) -> &str {
        match self {
            Self::Paddle => "paddle",
            Self::Windows => "windows",
            Self::Other(name) => name,
        }
    }
}

/// An OCR engine besides the built-in ones (PaddleOCR, Windows OCR): the
/// slot for engines an extension adds, such as a cloud AI-OCR. Register it
/// once at start-up with [`register_ocr_engine`]; flows then choose it with
/// `engine: "<name>"`, and desktop.readText, target.ocr and inspect_ui read
/// through it.
pub trait OcrProvider: Send + Sync + 'static {
    /// The name flows choose it by: lower case letters, digits and `-`, not
    /// `paddle` or `windows`.
    fn name(&self) -> &str;

    /// The lines of text in `image`, in its pixels (`OcrWord::confidence`
    /// where the engine says how sure it is).
    fn recognize(
        &self,
        image: Bitmap,
        options: OcrOptions,
    ) -> BoxFuture<'static, Result<Vec<OcrLine>, StepError>>;
}

type Providers = std::sync::RwLock<Vec<std::sync::Arc<dyn OcrProvider>>>;

fn providers() -> &'static Providers {
    static PROVIDERS: std::sync::OnceLock<Providers> = std::sync::OnceLock::new();
    PROVIDERS.get_or_init(Default::default)
}

/// Adds an OCR engine (see [`OcrProvider`]); one of the same name is
/// replaced.
pub fn register_ocr_engine(provider: std::sync::Arc<dyn OcrProvider>) -> Result<(), String> {
    let name = provider.name();
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid || name == "paddle" || name == "windows" {
        return Err(format!("'{name}' cannot name an OCR engine"));
    }
    let mut list = providers()
        .write()
        .map_err(|_| "the OCR engines are broken")?;
    list.retain(|p| p.name() != name);
    list.push(provider);
    Ok(())
}

/// The added engine called `name`.
pub fn ocr_engine(name: &str) -> Option<std::sync::Arc<dyn OcrProvider>> {
    providers()
        .read()
        .ok()?
        .iter()
        .find(|p| p.name() == name)
        .cloned()
}

/// The names of the added engines.
pub fn ocr_engine_names() -> Vec<String> {
    providers()
        .read()
        .map(|list| list.iter().map(|p| p.name().to_owned()).collect())
        .unwrap_or_default()
}

/// An added engine's reading (see [`OcrProvider`]).
pub fn other_recognize(
    name: &str,
    image: Bitmap,
    options: OcrOptions,
) -> BoxFuture<'static, Result<Vec<OcrLine>, StepError>> {
    match ocr_engine(name) {
        Some(provider) => provider.recognize(image, options),
        None => {
            let error = StepError::permanent(
                "OCR_ENGINE_MISSING",
                format!("the OCR engine '{name}' is not installed"),
            );
            Box::pin(async move { Err(error) })
        }
    }
}

/// PaddleOCR on a worker thread (it keeps a CPU busy for a moment).
pub fn paddle_recognize(
    image: Bitmap,
    accurate: bool,
    kind: Option<crate::ocr_fit::TextKind>,
) -> BoxFuture<'static, Result<Vec<OcrLine>, StepError>> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            crate::paddle::engine_for(accurate)
                .map_err(|reason| crate::paddle::unavailable(&reason))?
                .recognize_kind(&image, kind)
        })
        .await
        .map_err(|e| StepError::new("OCR_FAILED", format!("PaddleOCR stopped: {e}")))?
    })
}

pub fn unsupported() -> StepError {
    StepError::permanent("PLATFORM_UNSUPPORTED", "desktop steps run only on Windows")
}

/// Reads a PNG file.
pub fn load_png(path: &str) -> Result<Bitmap, StepError> {
    let bytes = std::fs::read(path).map_err(|e| image_file_error(path, &e.to_string()))?;
    Bitmap::from_png(&bytes).map_err(|e| {
        StepError::permanent(
            "IMAGE_UNREADABLE",
            format!("{path} could not be read as an image: {e}"),
        )
        .with_details(json!({ "hint": "Save the picture as PNG (desktop.screenshot writes one)." }))
    })
}

pub fn image_file_error(path: &str, reason: &str) -> StepError {
    StepError::permanent(
        "IMAGE_FILE_NOT_FOUND",
        format!("cannot open the image {path}: {reason}"),
    )
    .with_details(json!({
        "hint": "Write the full path of a PNG file. Make one with desktop.screenshot (target.region cuts out the part to look for)."
    }))
}

/// The backend of a build that cannot drive desktop apps (non-Windows).
pub struct Unsupported;

impl Backend for Unsupported {
    fn call(&self, _op: Op) -> BoxFuture<'static, Result<Value, StepError>> {
        Box::pin(async { Err(unsupported()) })
    }
}
