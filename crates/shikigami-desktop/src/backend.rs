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
        paddle_recognize(image)
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrEngine {
    Paddle,
    Windows,
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
pub fn paddle_recognize(image: Bitmap) -> BoxFuture<'static, Result<Vec<OcrLine>, StepError>> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            crate::paddle::engine()
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
