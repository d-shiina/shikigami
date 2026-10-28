//! What the steps ask of the technology that reaches the application.

use serde_json::Value;
use shikigami_runtime::{BoxFuture, StepError};

use crate::keys::Chord;
use crate::target::{ElementQuery, Target, WindowQuery};

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

pub trait Backend: Send + Sync + 'static {
    fn call(&self, op: Op) -> BoxFuture<'static, Result<Value, StepError>>;
}

/// The backend of a build that cannot drive desktop apps (non-Windows).
pub struct Unsupported;

impl Backend for Unsupported {
    fn call(&self, _op: Op) -> BoxFuture<'static, Result<Value, StepError>> {
        Box::pin(async {
            Err(StepError::permanent(
                "PLATFORM_UNSUPPORTED",
                "desktop steps run only on Windows",
            ))
        })
    }
}
