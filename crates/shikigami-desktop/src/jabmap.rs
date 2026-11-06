//! What Java Access Bridge's words mean in `desktop.*` terms. The bridge
//! calls themselves are in `jab` (Windows only); this part is plain data
//! so it is tested everywhere.

/// The shared role of a Java accessible role (`role_en_US`).
pub fn role(java: &str) -> &'static str {
    match java.trim() {
        "push button" | "toggle button" => "button",
        "text" | "password text" | "editbar" => "textbox",
        "check box" | "check menu item" => "checkbox",
        "radio button" => "radio",
        "combo box" => "combobox",
        "list" => "list",
        "list item" => "listitem",
        "menu bar" => "menubar",
        "menu" | "menu item" | "radio menu item" => "menuitem",
        "popup menu" => "menu",
        "page tab list" => "tablist",
        "page tab" => "tab",
        "table" => "table",
        "tree" => "tree",
        "label" => "text",
        "hyperlink" => "link",
        "tool bar" => "toolbar",
        "progress bar" => "progressbar",
        "slider" => "slider",
        "spinbox" | "spin box" => "spinbutton",
        "scroll bar" => "scrollbar",
        "separator" => "separator",
        "frame" | "dialog" | "window" | "alert" => "window",
        "panel" | "scroll pane" | "viewport" | "root pane" | "layered pane" | "glass pane"
        | "internal frame" | "split pane" | "desktop pane" | "option pane" | "filler" => "pane",
        "tool tip" => "tooltip",
        "header" | "column header" => "columnheader",
        "status bar" => "status",
        "canvas" | "icon" => "image",
        _ => "custom",
    }
}

/// Whether the bridge's state list (`states_en_US`, comma separated) has
/// `state`.
pub fn has_state(states: &str, state: &str) -> bool {
    states.split(',').any(|s| s.trim() == state)
}

/// Roles whose children are rows or cells: read with desktop.getTable,
/// not walked (a long table would make the tree huge).
pub fn holds_cells(java: &str) -> bool {
    matches!(java.trim(), "table" | "tree")
}

/// A Java string buffer (UTF-16, NUL-terminated) as text.
pub fn wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}
