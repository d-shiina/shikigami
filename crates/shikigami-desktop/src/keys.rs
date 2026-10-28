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
