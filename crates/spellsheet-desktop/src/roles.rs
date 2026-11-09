//! The shared role vocabulary of desktop targets.
//!
//! Roles follow the ARIA names AI clients already use for web pages
//! (`button`, `textbox`, `checkbox`, ...), so `{ "role": "button" }` means
//! the same in a browser and a desktop app. Each backend maps them to its
//! own types; for UI Automation that is the ControlType ID.

/// (role, UIA ControlType ID)
const ROLES: &[(&str, i32)] = &[
    ("button", 50000),
    ("calendar", 50001),
    ("checkbox", 50002),
    ("combobox", 50003),
    ("textbox", 50004),
    ("link", 50005),
    ("image", 50006),
    ("listitem", 50007),
    ("list", 50008),
    ("menu", 50009),
    ("menubar", 50010),
    ("menuitem", 50011),
    ("progressbar", 50012),
    ("radio", 50013),
    ("scrollbar", 50014),
    ("slider", 50015),
    ("spinbutton", 50016),
    ("status", 50017),
    ("tablist", 50018),
    ("tab", 50019),
    ("text", 50020),
    ("toolbar", 50021),
    ("tooltip", 50022),
    ("tree", 50023),
    ("treeitem", 50024),
    ("custom", 50025),
    ("group", 50026),
    ("thumb", 50027),
    ("grid", 50028),
    ("row", 50029),
    ("document", 50030),
    ("splitbutton", 50031),
    ("window", 50032),
    ("pane", 50033),
    ("header", 50034),
    ("columnheader", 50035),
    ("table", 50036),
    ("titlebar", 50037),
    ("separator", 50038),
    ("semanticzoom", 50039),
    ("appbar", 50040),
];

pub fn names() -> Vec<&'static str> {
    ROLES.iter().map(|(name, _)| *name).collect()
}

/// The UIA ControlType ID of `role`.
pub fn control_type(role: &str) -> Option<i32> {
    ROLES
        .iter()
        .find(|(name, _)| *name == role)
        .map(|(_, id)| *id)
}

/// The role of a UIA ControlType ID (`custom` for unknown ones).
pub fn of_control_type(id: i32) -> &'static str {
    ROLES
        .iter()
        .find(|(_, t)| *t == id)
        .map_or("custom", |(name, _)| *name)
}
