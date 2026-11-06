//! Which technology can see inside a window.
//!
//! Scenarios never say how a window is reached: the Runtime looks at the
//! window and picks the backend. Today every window is driven through UI
//! Automation, except SAP GUI windows that SAP GUI Scripting can reach
//! (see `sap`) and Java windows the Java Access Bridge reaches (see `jab`).
//! When neither works, inspect_ui says that UIA may show only part of them.

use crate::target::{WindowInfo, process_key};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Uia,
    SapGui,
    Java,
}

impl Engine {
    pub fn of(window: &WindowInfo) -> Self {
        let class = window.class_name.as_str();
        if class == "SAP_FRONTEND_SESSION" || process_key(&window.process) == "saplogon" {
            Self::SapGui
        } else if class.starts_with("SunAwt") {
            Self::Java
        } else {
            Self::Uia
        }
    }

    /// What the window looks like to the backend in use (UIA for now).
    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::Uia => None,
            Self::SapGui => Some(
                "SAP GUI window, shown through UI Automation because SAP GUI Scripting could not reach it: fields and tables may be missing. Ask the user to enable scripting on the SAP server (transaction RZ11, sapgui/user_scripting = TRUE) and in SAP GUI Options > Accessibility & Scripting > Scripting (enable, without notifications), then inspect again.",
            ),
            Self::Java => Some(
                "Java window, shown through UI Automation because the Java Access Bridge could not reach it: usually only the frame is visible. Ask the user to run `jabswitch -enable` (in the bin folder of the Java the app uses) and restart the app, then inspect again.",
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uia => "uia",
            Self::SapGui => "sapgui",
            Self::Java => "java",
        }
    }
}
