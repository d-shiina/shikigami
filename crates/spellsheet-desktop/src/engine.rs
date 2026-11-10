//! Which technology can see inside a window.
//!
//! Flows never say how a window is reached: the Runtime looks at the
//! window and picks the backend. Every window is driven through UI
//! Automation, except Java windows the Java Access Bridge reaches (see
//! `jab`) and windows a plugin declares it reaches better (see
//! `plugin_bridge`, e.g. SAP GUI through the SAP plugin). When that way in
//! does not work, inspect_ui says that UIA may show only part of them.

use crate::plugin_bridge::{self, BridgeSpec};
use crate::target::{WindowInfo, process_key};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Uia,
    Java,
    /// Reached through an installed plugin.
    Plugin(&'static BridgeSpec),
    /// A SAP GUI window with no plugin to reach it: UI Automation only.
    SapGuiWithoutPlugin,
}

impl Engine {
    pub fn of(window: &WindowInfo) -> Self {
        let class = window.class_name.as_str();
        if let Some(spec) = plugin_bridge::for_window(class, &window.process) {
            Self::Plugin(spec)
        } else if class.starts_with("SunAwt") {
            Self::Java
        } else if class == "SAP_FRONTEND_SESSION" || process_key(&window.process) == "saplogon" {
            Self::SapGuiWithoutPlugin
        } else {
            Self::Uia
        }
    }

    /// What the window looks like to the backend in use (UIA for now).
    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::Uia => None,
            Self::Plugin(_) => Some(
                "Shown through UI Automation because the plugin for this app could not reach the window: fields and tables may be missing. The error from the plugin says how to open the way in.",
            ),
            Self::SapGuiWithoutPlugin => Some(
                "SAP GUI window, shown through UI Automation: fields and tables may be missing. The SAP plugin (sold separately, https://spellsheet.github.io/) reads SAP GUI through SAP GUI Scripting; without it use what UI Automation shows, OCR (target.ocr) or images.",
            ),
            Self::Java => Some(
                "Java window, shown through UI Automation because the Java Access Bridge could not reach it: usually only the frame is visible. Ask the user to run `jabswitch -enable` (in the bin folder of the Java the app uses) and restart the app, then inspect again.",
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uia => "uia",
            Self::Java => "java",
            Self::Plugin(spec) => &spec.app,
            Self::SapGuiWithoutPlugin => "sapgui",
        }
    }
}
