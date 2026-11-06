//! Key names for `desktop.press`, spelled as for `browser.press`
//! (Playwright): `Enter`, `Tab`, `Control+S`, `Alt+F4`, `Shift+ArrowDown`.

use serde_json::json;
use shikigami_runtime::StepError;

/// A key with modifiers, as Windows virtual-key codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Vec<Key>,
    pub key: Key,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub vk: u16,
    /// Needs KEYEVENTF_EXTENDEDKEY (navigation keys).
    pub extended: bool,
}

const fn key(vk: u16) -> Key {
    Key {
        vk,
        extended: false,
    }
}

const fn ext(vk: u16) -> Key {
    Key { vk, extended: true }
}

const MODIFIERS: &[(&str, Key)] = &[
    ("control", key(0x11)),
    ("ctrl", key(0x11)),
    ("shift", key(0x10)),
    ("alt", key(0x12)),
    ("meta", ext(0x5B)),
    ("win", ext(0x5B)),
];

const NAMED: &[(&str, Key)] = &[
    ("enter", key(0x0D)),
    ("tab", key(0x09)),
    ("escape", key(0x1B)),
    ("esc", key(0x1B)),
    ("backspace", key(0x08)),
    ("space", key(0x20)),
    ("delete", ext(0x2E)),
    ("insert", ext(0x2D)),
    ("home", ext(0x24)),
    ("end", ext(0x23)),
    ("pageup", ext(0x21)),
    ("pagedown", ext(0x22)),
    ("arrowleft", ext(0x25)),
    ("arrowup", ext(0x26)),
    ("arrowright", ext(0x27)),
    ("arrowdown", ext(0x28)),
    ("contextmenu", ext(0x5D)),
    ("pause", key(0x13)),
    ("printscreen", ext(0x2C)),
];

fn lookup(table: &[(&str, Key)], name: &str) -> Option<Key> {
    table.iter().find(|(n, _)| *n == name).map(|(_, k)| *k)
}

fn main_key(name: &str) -> Option<Key> {
    let lower = name.to_lowercase();
    if let Some(k) = lookup(NAMED, &lower) {
        return Some(k);
    }
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u16>().ok())
        && (1..=24).contains(&n)
    {
        return Some(key(0x6F + n));
    }
    let mut chars = name.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphanumeric() => Some(key(c.to_ascii_uppercase() as u16)),
        _ => None,
    }
}

pub fn parse(text: &str) -> Result<Chord, StepError> {
    let invalid = |what: String| {
        StepError::invalid_params(what).with_details(json!({
            "hint": "Write keys like Enter, Tab, Escape, F5, Control+S, Alt+F4, Shift+ArrowDown. To enter text, use desktop.type or desktop.setValue."
        }))
    };
    let parts: Vec<&str> = text.split('+').map(str::trim).collect();
    let Some((last, mods)) = parts.split_last() else {
        return Err(invalid("key is empty".into()));
    };
    let modifiers = mods
        .iter()
        .map(|m| {
            lookup(MODIFIERS, &m.to_lowercase())
                .ok_or_else(|| invalid(format!("'{m}' is not a modifier key in '{text}'")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let key = main_key(last).ok_or_else(|| invalid(format!("unknown key '{last}' in '{text}'")))?;
    Ok(Chord { modifiers, key })
}

/// Modifier keys held with a key the recorder saw.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Held {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
}

/// Whether `vk` is a modifier key itself (Shift, Ctrl, Alt, Windows, left or right).
pub fn is_modifier(vk: u16) -> bool {
    matches!(vk, 0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5)
}

/// Keys the recorder writes down as `desktop.press`: Enter, Tab, Escape,
/// F1–F24, and any key held with Ctrl, Alt or Windows (`Control+S`).
/// Everything else (letters, IME input, Backspace, arrows) is typing: the
/// field's text is read when the typing ends.
pub fn is_command(vk: u16, held: Held) -> bool {
    if is_modifier(vk) {
        return false;
    }
    matches!(vk, 0x09 | 0x0D | 0x1B | 0x70..=0x87) || held.ctrl || held.alt || held.win
}

/// Editing chords inside a text field (select all, copy, paste, cut, undo,
/// redo): they change the text, which the recorder reads afterwards, so
/// they are not written down as keys of their own.
pub fn is_text_edit(vk: u16, held: Held) -> bool {
    held.ctrl && !held.alt && !held.win && matches!(vk, 0x41 | 0x43 | 0x56 | 0x58 | 0x59 | 0x5A)
}

/// Keys the IME uses while converting Japanese, typed in a field: F6–F10
/// (hiragana, katakana, half-width, full-width, romaji) and Escape with the
/// IME on (cancels the conversion). Part of the typing, not commands.
pub fn is_ime_key(vk: u16, held: Held, ime_open: bool) -> bool {
    !held.ctrl
        && !held.alt
        && !held.win
        && ((0x75..=0x79).contains(&vk) || (vk == 0x1B && ime_open))
}

/// The name `desktop.press` takes for a key the recorder saw
/// (`Control+Shift+S`, `Enter`, `F5`), or `None` for a key it has no name for.
pub fn name(vk: u16, held: Held) -> Option<String> {
    let main = if (0x70..=0x87).contains(&vk) {
        format!("F{}", vk - 0x6F)
    } else if (0x30..=0x39).contains(&vk) || (0x41..=0x5A).contains(&vk) {
        char::from(vk as u8).to_string()
    } else {
        let lower = NAMED
            .iter()
            .filter(|(n, _)| !matches!(*n, "esc"))
            .find(|(_, k)| k.vk == vk)
            .map(|(n, _)| *n)?;
        PRETTY
            .iter()
            .find(|(n, _)| *n == lower)
            .map_or_else(|| lower.to_owned(), |(_, p)| (*p).to_owned())
    };
    let mut parts = Vec::new();
    for (on, label) in [
        (held.ctrl, "Control"),
        (held.alt, "Alt"),
        (held.shift, "Shift"),
        (held.win, "Meta"),
    ] {
        if on {
            parts.push(label);
        }
    }
    parts.push(&main);
    Some(parts.join("+"))
}

/// The spelling `parse` reads back for the named keys.
const PRETTY: &[(&str, &str)] = &[
    ("enter", "Enter"),
    ("tab", "Tab"),
    ("escape", "Escape"),
    ("backspace", "Backspace"),
    ("space", "Space"),
    ("delete", "Delete"),
    ("insert", "Insert"),
    ("home", "Home"),
    ("end", "End"),
    ("pageup", "PageUp"),
    ("pagedown", "PageDown"),
    ("arrowleft", "ArrowLeft"),
    ("arrowup", "ArrowUp"),
    ("arrowright", "ArrowRight"),
    ("arrowdown", "ArrowDown"),
    ("contextmenu", "ContextMenu"),
    ("pause", "Pause"),
    ("printscreen", "PrintScreen"),
];
