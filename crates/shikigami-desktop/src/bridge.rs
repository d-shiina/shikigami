//! A way into an app that UI Automation sees only part of (SAP GUI
//! Scripting, Java Access Bridge). The `desktop.*` steps on such a window
//! go through it; what it cannot do falls back to UI Automation.

use serde_json::{Value, json};
use shikigami_runtime::StepError;

use crate::backend::Text;
use crate::keys::Chord;
use crate::target::ElementQuery;

pub trait AppBridge {
    /// `sapgui` or `java`, as inspect_ui says.
    fn app(&self) -> &'static str;
    fn inspect(&self, max_nodes: usize, root: Option<&ElementQuery>) -> Result<Value, StepError>;
    /// `{ found, visible, enabled }`.
    fn probe(&self, element: &ElementQuery) -> Value;
    fn click(&self, element: &ElementQuery) -> Result<Value, StepError>;
    fn set_value(&self, element: &ElementQuery, value: &Text) -> Result<Value, StepError>;
    fn get_value(&self, element: &ElementQuery) -> Result<Value, StepError>;
    fn select(&self, element: &ElementQuery, option: &str) -> Result<Value, StepError>;
    /// `None` when the key goes through the real keyboard instead.
    fn press(&self, chord: &Chord) -> Option<Result<Value, StepError>>;
    fn focus(&self, element: &ElementQuery) -> Result<(), StepError>;
    /// The element's place on the screen: (left, top, width, height).
    fn screen_rect(&self, element: &ElementQuery) -> Result<(i32, i32, i32, i32), StepError>;
    /// Picks a menu bar item by its names from the top.
    fn menu(&self, path: &[String]) -> Result<Value, StepError>;
    fn table(&self, element: Option<&ElementQuery>, max_rows: usize) -> Result<Value, StepError>;
    fn transaction(&self, _code: &str) -> Result<Value, StepError> {
        Err(StepError::permanent(
            "NOT_SAP_WINDOW",
            "sap.runTransaction works only on SAP GUI windows",
        )
        .with_details(
            json!({ "hint": "Target the SAP GUI window (inspect_ui lists it with app sapgui)." }),
        ))
    }
}
