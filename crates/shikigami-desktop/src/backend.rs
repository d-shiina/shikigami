//! What the steps ask of the technology that reaches the application.

use serde_json::{Value, json};
use shikigami_runtime::{BoxFuture, StepError};

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
    /// Opens the context menu of `target.element` (or uses the open menu /
    /// the menu bar of `target.window`) and picks `path` item by item.
    Menu {
        target: Target,
        path: Vec<String>,
    },
    /// Lets the user point at an element on screen: follows the mouse with
    /// a frame, takes the next click (the app never gets it) and answers
    /// `{ target, how, rect, window }` (see `target::picked_target`), or
    /// `{ cancelled: true }` on Esc or after `timeout_ms`.
    Pick {
        message: Option<String>,
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
        if options.engine == Some(OcrEngine::Windows) {
            return Box::pin(async { Err(unsupported()) });
        }
        paddle_recognize(image, options.accurate)
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrEngine {
    Paddle,
    Windows,
}

impl OcrOptions {
    /// `accurate` is PaddleOCR's; it does not go with Windows OCR.
    pub fn check(self) -> Result<Self, StepError> {
        if self.accurate && self.engine == Some(OcrEngine::Windows) {
            return Err(StepError::invalid_params(
                "accurate uses PaddleOCR's larger models; leave out engine: \"windows\"",
            ));
        }
        Ok(self)
    }
}

impl OcrEngine {
    pub fn parse(name: &str) -> Result<Self, StepError> {
        match name {
            "paddle" => Ok(Self::Paddle),
            "windows" => Ok(Self::Windows),
            other => Err(StepError::invalid_params(format!(
                "unknown OCR engine '{other}' (use paddle or windows)"
            ))),
        }
    }
}

/// PaddleOCR on a worker thread (it keeps a CPU busy for a moment).
pub fn paddle_recognize(
    image: Bitmap,
    accurate: bool,
) -> BoxFuture<'static, Result<Vec<OcrLine>, StepError>> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            crate::paddle::engine_for(accurate)
                .map_err(|reason| crate::paddle::unavailable(&reason))?
                .recognize(&image)
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
