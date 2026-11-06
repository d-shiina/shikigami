//! Picking menu items by the words a person sees.
//!
//! Menu items carry decorations a flow should not have to copy: the
//! access key (`ファイル(&F)`, `&File`), a trailing ellipsis (`名前を付けて
//! 保存...`) and the shortcut after a tab (`保存\tCtrl+S`). Names are
//! compared without them.

use serde_json::json;
use shikigami_runtime::StepError;

/// A menu item's name as a person reads it.
pub fn normalize(name: &str) -> String {
    let text = name.split('\t').next().unwrap_or_default().replace('&', "");
    let text = strip_ellipsis(&text);
    let text = strip_access_key(text);
    strip_ellipsis(text).to_lowercase()
}

fn strip_ellipsis(text: &str) -> &str {
    text.trim()
        .trim_end_matches("...")
        .trim_end_matches('…')
        .trim_end()
}

/// Drops an access key in brackets at the end: `ファイル(F)`, `保存（S）`.
fn strip_access_key(text: &str) -> &str {
    for (open, close) in [('(', ')'), ('（', '）')] {
        if let Some(inner) = text.strip_suffix(close)
            && let Some(start) = inner.rfind(open)
        {
            let key = &inner[start + open.len_utf8()..];
            if key.chars().count() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric()) {
                return &text[..start];
            }
        }
    }
    text
}

/// One visible menu item.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub name: String,
    /// In a menu that popped up (not the window's menu bar).
    pub popup: bool,
    pub enabled: bool,
}

/// The item named `wanted` among `items`: the same name first, then the
/// only one containing it. Items in an open popup menu come before the
/// menu bar, so a name in both picks the one just opened.
pub fn pick(wanted: &str, items: &[Item]) -> Result<usize, StepError> {
    let key = normalize(wanted);
    let choose = |matches: &dyn Fn(&str) -> bool| -> Vec<usize> {
        let all: Vec<usize> = (0..items.len())
            .filter(|&i| matches(&normalize(&items[i].name)))
            .collect();
        let popup: Vec<usize> = all.iter().copied().filter(|&i| items[i].popup).collect();
        if popup.is_empty() { all } else { popup }
    };
    let exact = choose(&|name| name == key);
    let found = if exact.is_empty() {
        choose(&|name| !key.is_empty() && name.contains(&key))
    } else {
        exact
    };
    match found.as_slice() {
        [i] => Ok(*i),
        [] => Err(StepError::new(
            "MENU_ITEM_NOT_FOUND",
            format!("no menu item named '{wanted}' is shown"),
        )
        .with_details(json!({
            "items": names(items),
            "hint": "Write the names as the menu shows them, from the first menu down (e.g. [\"ファイル\", \"名前を付けて保存\"]). Access keys like (F), ... and shortcuts can be left out."
        }))),
        many => Err(StepError::permanent(
            "MENU_ITEM_AMBIGUOUS",
            format!("{} menu items match '{wanted}'", many.len()),
        )
        .with_details(json!({
            "items": many.iter().map(|&i| items[i].name.clone()).collect::<Vec<_>>(),
            "hint": "Write the item's full name."
        }))),
    }
}

fn names(items: &[Item]) -> Vec<String> {
    let mut names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
    names.dedup();
    names.truncate(60);
    names
}
