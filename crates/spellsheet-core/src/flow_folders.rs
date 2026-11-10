//! Each flow's folder under `flows/` is named after the flow
//! (`flows/請求書を登録する/`), so a person finds it in Explorer. The flow
//! ID stays inside `flow.json`: calls, schedules, run records and audit
//! logs keep pointing at the ID, and renaming a flow renames only its
//! folder.
//!
//! Two flows cannot have the same name: names that give the same folder
//! (Windows compares them without case) are the same name. A new flow
//! whose name is taken gets ` (2)`, ` (3)`, … ([`free_name`]); renaming a
//! flow to a taken name is refused.
//!
//! Folders of workspaces written before are named by the ID
//! (`flows/<id>/`). They are renamed when the workspace is opened, and a
//! folder that cannot be renamed now (a file in it is open) is renamed
//! the next time. Lookups by ID read `flow.json`, so a flow is found
//! whichever name its folder has.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::ids::FlowId;
use crate::project::FLOW_FILE;

/// The longest folder name, in characters: long names run into the path
/// length limit of Windows together with the folders and files below.
pub const MAX_FOLDER_CHARS: usize = 60;

/// Windows' reserved device names: a folder cannot be called that.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// The folder name for a flow name: characters Windows does not allow in
/// a name become their full-width forms, and the name is cut at
/// [`MAX_FOLDER_CHARS`].
pub fn folder_name(name: &str) -> String {
    let mut out: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '\\' => '＼',
            '/' => '／',
            ':' => '：',
            '*' => '＊',
            '?' => '？',
            '"' => '”',
            '<' => '＜',
            '>' => '＞',
            '|' => '｜',
            c if c.is_control() => ' ',
            c => c,
        })
        .take(MAX_FOLDER_CHARS)
        .collect();
    // Windows drops trailing dots and spaces from a name.
    while out.ends_with(['.', ' ']) {
        out.pop();
    }
    if out.is_empty() {
        return "flow".into();
    }
    let stem = out.split('.').next().unwrap_or_default();
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        out.push('_');
    }
    out
}

/// Two folder names that are one folder on Windows.
pub fn same_folder(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Two flow names that would give the same folder.
pub fn same_name(a: &str, b: &str) -> bool {
    same_folder(&folder_name(a), &folder_name(b))
}

/// `base`, or `base (2)`, `base (3)`, … : the first that `taken` does not
/// refuse.
pub fn free_name(base: &str, taken: impl Fn(&str) -> bool) -> String {
    let base = base.trim();
    if !taken(base) {
        return base.to_owned();
    }
    let mut n = 2u64;
    loop {
        let name = format!("{base} ({n})");
        if !taken(&name) {
            return name;
        }
        n += 1;
    }
}

/// A flow folder found under `flows/`.
#[derive(Debug, Clone)]
pub(crate) struct FlowFolder {
    pub id: FlowId,
    pub name: String,
    pub dir: PathBuf,
}

impl FlowFolder {
    pub fn folder(&self) -> String {
        file_name(&self.dir)
    }
}

pub(crate) fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The ID and name in `<dir>/flow.json`, without the rest of the document.
pub(crate) fn read(dir: &Path) -> Option<FlowFolder> {
    #[derive(Deserialize)]
    struct Head {
        id: FlowId,
        #[serde(default)]
        name: String,
    }
    let bytes = fs::read(dir.join(FLOW_FILE)).ok()?;
    let head: Head = serde_json::from_slice(&bytes).ok()?;
    head.id.is_well_formed().then(|| FlowFolder {
        id: head.id,
        name: head.name,
        dir: dir.to_path_buf(),
    })
}

/// The ID of the flow whose folder is `dir` (for watchers of `flows/`).
pub fn flow_id_of(dir: &Path) -> Option<FlowId> {
    read(dir).map(|f| f.id)
}

/// Every flow folder under `flows_dir`, in folder name order.
pub(crate) fn scan(flows_dir: &Path) -> Vec<FlowFolder> {
    let Ok(entries) = fs::read_dir(flows_dir) else {
        return Vec::new();
    };
    let mut out: Vec<FlowFolder> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| read(&p))
        .collect();
    out.sort_by(|a, b| a.dir.cmp(&b.dir));
    out
}

/// The entry of `flows_dir` (folder or file) that is one folder with
/// `name` on Windows, other than `except`.
pub(crate) fn occupant(flows_dir: &Path, name: &str, except: Option<&Path>) -> Option<PathBuf> {
    fs::read_dir(flows_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| except.is_none_or(|x| p != x))
        .find(|p| same_folder(&file_name(p), name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_folder_names() {
        assert_eq!(folder_name("請求書を登録する"), "請求書を登録する");
        assert_eq!(
            folder_name("  売上 / 月次: 集計?  "),
            "売上 ／ 月次： 集計？"
        );
        assert_eq!(folder_name("終わり..."), "終わり");
        assert_eq!(folder_name(""), "flow");
        assert_eq!(folder_name("con"), "con_");
        assert_eq!(folder_name("Nul.txt"), "Nul.txt_");
        assert_eq!(folder_name("Console"), "Console");
        let long = "あ".repeat(100);
        assert_eq!(folder_name(&long).chars().count(), MAX_FOLDER_CHARS);
    }

    #[test]
    fn names_compare_like_windows_folders() {
        assert!(same_name("Invoice", "invoice"));
        assert!(same_name("a/b", "a／b"));
        assert!(same_name("請求書 ", "請求書"));
        assert!(!same_name("請求書", "請求書 (2)"));
    }

    #[test]
    fn taken_names_get_a_number() {
        let taken = ["新しいフロー", "新しいフロー (2)"];
        let is_taken = |n: &str| taken.iter().any(|t| same_name(t, n));
        assert_eq!(free_name("新しいフロー", is_taken), "新しいフロー (3)");
        assert_eq!(free_name("別のフロー", is_taken), "別のフロー");
    }
}
