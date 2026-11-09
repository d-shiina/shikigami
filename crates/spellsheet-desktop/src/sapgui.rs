//! What SAP GUI Scripting's words mean in `desktop.*` terms: component
//! types as shared roles, component ids, and keys as SAP's virtual keys.
//!
//! The scripting calls themselves are in `sap` (Windows only); this part
//! is plain data so it is tested everywhere.

use crate::keys::{Chord, Key};

/// The shared role of a SAP GUI component (`Type`, and `SubType` for
/// shells).
pub fn role(kind: &str, sub_type: &str) -> &'static str {
    match kind {
        "GuiTextField" | "GuiCTextField" | "GuiPasswordField" | "GuiOkCodeField" => "textbox",
        "GuiButton" => "button",
        "GuiCheckBox" => "checkbox",
        "GuiRadioButton" => "radio",
        "GuiComboBox" => "combobox",
        "GuiLabel" | "GuiStatusPane" => "text",
        "GuiTab" => "tab",
        "GuiTabStrip" => "tablist",
        "GuiTableControl" => "table",
        "GuiMenubar" => "menubar",
        "GuiMenu" => "menuitem",
        "GuiToolbar" => "toolbar",
        "GuiTitlebar" => "titlebar",
        "GuiStatusbar" => "status",
        "GuiMainWindow" | "GuiModalWindow" => "window",
        "GuiBox" => "group",
        "GuiUserArea"
        | "GuiSimpleContainer"
        | "GuiScrollContainer"
        | "GuiContainerShell"
        | "GuiCustomControl"
        | "GuiSplitterContainer"
        | "GuiDockShell" => "pane",
        "GuiShell" => match sub_type {
            "GridView" => "grid",
            "Tree" => "tree",
            "TextEdit" => "textbox",
            "Toolbar" => "toolbar",
            "HTMLViewer" => "document",
            _ => "pane",
        },
        _ => "custom",
    }
}

/// Whether a component's text is what a person types into it.
pub fn is_input(kind: &str) -> bool {
    matches!(
        kind,
        "GuiTextField" | "GuiCTextField" | "GuiPasswordField" | "GuiOkCodeField" | "GuiComboBox"
    )
}

/// A component id as `findById` takes it, from what a target says: the id
/// inspect_ui lists (`wnd[0]/usr/txtRSYST-BNAME`), the full path a
/// recorded SAP script has (`/app/con[0]/ses[0]/wnd[0]/usr/...`), or a
/// path inside the target window (`usr/txtRSYST-BNAME`).
pub fn component_id(window_id: &str, given: &str) -> String {
    let given = given.trim().trim_start_matches('/');
    // Drop `app/con[n]/ses[n]/` from a recorded script's path.
    let mut rest = given;
    for prefix in ["app/", "con[", "ses["] {
        if let Some(after) = rest.strip_prefix(prefix) {
            rest = match prefix {
                "app/" => after,
                _ => after.split_once("]/").map_or(after, |(_, tail)| tail),
            };
        }
    }
    if rest.starts_with("wnd[") {
        rest.to_owned()
    } else {
        format!("{window_id}/{rest}")
    }
}

/// Whether an element id can only be a SAP component id.
pub fn looks_like_component_id(id: &str) -> bool {
    let id = id.trim_start_matches('/');
    id.starts_with("wnd[") || id.starts_with("app/con[") || id.starts_with("usr/")
}

/// SAP's virtual key number for a key chord (`sendVKey`), for the keys
/// whose number is fixed in every SAP GUI. Other keys go through the real
/// keyboard.
pub fn vkey(chord: &Chord) -> Option<i32> {
    const SHIFT: u16 = 0x10;
    const CONTROL: u16 = 0x11;
    let has = |vk: u16| chord.modifiers.iter().any(|m| m.vk == vk);
    if chord
        .modifiers
        .iter()
        .any(|m| m.vk != SHIFT && m.vk != CONTROL)
    {
        return None;
    }
    let (shift, control) = (has(SHIFT), has(CONTROL));
    let Key { vk, .. } = chord.key;
    match vk {
        // F1..F12
        0x70..=0x7B => {
            let n = i32::from(vk - 0x70) + 1;
            Some(match (shift, control) {
                (false, false) => n,
                (true, false) => 12 + n,
                (false, true) => 24 + n,
                (true, true) => 36 + n,
            })
        }
        _ if shift => None,
        0x0D if !control => Some(0),
        0x1B if !control => Some(12),
        0x53 if control => Some(11),
        0x21 => Some(if control { 80 } else { 81 }),
        0x22 => Some(if control { 83 } else { 82 }),
        _ => None,
    }
}
