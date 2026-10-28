//! Which technology can see inside a window.
//!
//! Scenarios never say how a window is reached: the Runtime looks at the
//! window and picks the backend. Today every window is driven through UI
//! Automation; SAP GUI (SAP GUI Scripting) and Java (Java Access Bridge)
//! windows are recognised so inspect_ui can say that UIA may show only part
//! of them, and get their own backends later behind the same `desktop.*`
//! steps.

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
                "SAP GUI window: shown through UI Automation, which may miss fields and tables. SAP GUI Scripting support is planned; it needs scripting enabled on the SAP server (sapgui/user_scripting) and in SAP GUI options.",
            ),
            Self::Java => Some(
                "Java window: shown through UI Automation, which usually sees only the frame. Java Access Bridge support is planned (enable it with `jabswitch -enable`).",
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
