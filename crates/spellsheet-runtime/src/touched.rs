//! What a run worked on outside itself: the files and folders it read,
//! wrote or deleted, the sites and programs it opened, the addresses it
//! sent to. One entry per place, as the steps ran with it (templates
//! filled in, relative paths resolved, secrets masked), kept in the run's
//! report so the run can be checked afterwards (the 実行結果 in Writer,
//! the audit trail). A file the run changed is stamped with its size and
//! SHA-256 as it was when the run ended, so a later change to it shows.
//!
//! Which param names the place follows the step type's definition: its
//! path params, then the sites and programs it is checked against, then
//! the usual names (`url`, `command`, `program`, `path`, `to`). A step
//! whose type is `safe` only reads.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use spellsheet_core::policy::TargetDef;
use spellsheet_core::registry::RiskLevel;
use spellsheet_core::{StepId, expr};
use time::OffsetDateTime;

/// At most this many places are kept per run.
pub(crate) const MAX_TOUCHED: usize = 500;
/// Files larger than this are stamped with their size only.
const MAX_HASHED_BYTES: u64 = 512 * 1024 * 1024;

/// One place a run worked on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Touched {
    /// The file, folder, URL, program or address, as the step ran with it.
    pub target: String,
    /// The step types that worked on it, in the order they first did.
    pub step_types: Vec<String>,
    /// The first step that worked on it.
    pub step_id: StepId,
    /// The `flow.call` steps that step ran inside (outermost first).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub call_path: Vec<StepId>,
    /// Nothing was changed: every step on it only read.
    #[serde(default, skip_serializing_if = "is_false")]
    pub reads: bool,
    /// An element on a page or window that steps acted on (clicked,
    /// typed into, chose from): `target` is the step's target as JSON,
    /// e.g. `{"role":"button","name":"出荷"}`. What was typed is not kept.
    #[serde(default, skip_serializing_if = "is_false")]
    pub screen: bool,
    /// How many times steps worked on it.
    pub count: u32,
    /// When a step first worked on it.
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub at: OffsetDateTime,
    /// A file the run changed, as it was when the run ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<FileStamp>,
    /// The run changed it and it was not there when the run ended
    /// (deleted or moved).
    #[serde(default, skip_serializing_if = "is_false")]
    pub gone: bool,
}

/// A file as it was when the run ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub size: u64,
    /// Lower-case hex; absent for files too large to read through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Steps that act on an element of a page or window: what they act on is
/// kept, though not as a place outside (what they typed is not).
fn acts_on_screen(step_type: &str) -> bool {
    matches!(
        step_type.split_once('.'),
        Some((
            "browser",
            "click" | "fill" | "check" | "uncheck" | "select" | "press" | "upload" | "drag"
        )) | Some((
            "desktop",
            "click"
                | "type"
                | "setValue"
                | "select"
                | "selectMenu"
                | "check"
                | "mouseClick"
                | "drag"
                | "press"
        ))
    )
}

/// One place a step worked on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Place {
    pub target: String,
    pub reads: bool,
    pub screen: bool,
}

/// Steps that only move around inside a page or window, ask the person,
/// or never leave the run: not places outside.
fn inside(step_type: &str) -> bool {
    let Some((adapter, action)) = step_type.split_once('.') else {
        return true;
    };
    match adapter {
        "browser" => !matches!(action, "open" | "attach" | "download" | "upload"),
        "desktop" => action != "launch",
        "dialog" | "clipboard" | "control" | "variable" | "log" | "flow" | "wait" => true,
        "config" => action == "read",
        _ => false,
    }
}

/// Path params that name what a step reads (a source, a template, an
/// attachment) or only where it works, not what it changes.
const READ_PARAMS: &[&str] = &["from", "files", "template", "attachments", "source"];
/// Path params that are never a place the step works on.
const NOT_PLACES: &[&str] = &["cwd", "workingDir"];
/// Where to look when the type names none of its params.
const USUAL_PARAMS: &[&str] = &["url", "command", "program", "path", "to"];

/// The places one step worked on, each with whether it only read it.
pub(crate) fn places(
    step_type: &str,
    params: &Value,
    risk: RiskLevel,
    path_params: &[String],
    target_defs: &[TargetDef],
) -> Vec<Place> {
    if acts_on_screen(step_type) {
        return match params.get("target") {
            Some(target @ Value::Object(_)) => vec![Place {
                target: target.to_string(),
                reads: false,
                screen: true,
            }],
            _ => Vec::new(),
        };
    }
    places_outside(step_type, params, risk, path_params, target_defs)
        .into_iter()
        .map(|(target, reads)| Place {
            target,
            reads,
            screen: false,
        })
        .collect()
}

fn places_outside(
    step_type: &str,
    params: &Value,
    risk: RiskLevel,
    path_params: &[String],
    target_defs: &[TargetDef],
) -> Vec<(String, bool)> {
    if inside(step_type) {
        return Vec::new();
    }
    let safe = risk == RiskLevel::Safe;
    let mut out: Vec<(String, bool)> = Vec::new();
    let push = |out: &mut Vec<(String, bool)>, value: Option<&Value>, reads: bool| {
        for text in texts(value) {
            if !out.iter().any(|(t, _)| *t == text) {
                out.push((text, reads));
            }
        }
    };
    for key in path_params {
        // An image to find on the screen is part of the flow, not a place.
        if key.contains('.') || NOT_PLACES.contains(&key.as_str()) {
            continue;
        }
        push(
            &mut out,
            params.get(key),
            safe || READ_PARAMS.contains(&key.as_str()),
        );
    }
    for def in target_defs {
        push(&mut out, params.get(&def.param), safe);
    }
    // Where a mail goes, whatever it attaches.
    if step_type.starts_with("mail.") {
        for key in ["to", "cc", "bcc"] {
            if !path_params.iter().any(|p| p == key) {
                push(&mut out, params.get(key), safe);
            }
        }
    }
    if out.is_empty()
        && let Some(value) = USUAL_PARAMS.iter().find_map(|key| params.get(*key))
    {
        push(&mut out, Some(value), safe);
    }
    out
}

fn texts(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_owned()],
        Some(Value::Array(items)) => items.iter().flat_map(|v| texts(Some(v))).collect(),
        // A recipient list as an object, a number…: as it reads.
        Some(v @ (Value::Number(_) | Value::Object(_))) => vec![expr::to_display(v)],
        _ => Vec::new(),
    }
}

/// The places of a run, in the order it first worked on them.
#[derive(Default)]
pub(crate) struct TouchedList {
    items: Vec<Touched>,
    by_target: HashMap<String, usize>,
}

impl TouchedList {
    pub(crate) fn add(
        &mut self,
        place: Place,
        step_type: &str,
        step_id: &StepId,
        call_path: &[StepId],
    ) {
        let Place {
            target,
            reads,
            screen,
        } = place;
        if let Some(&i) = self.by_target.get(&target) {
            let item = &mut self.items[i];
            item.count = item.count.saturating_add(1);
            item.reads &= reads;
            if !item.step_types.iter().any(|t| t == step_type) {
                item.step_types.push(step_type.to_owned());
            }
            return;
        }
        if self.items.len() >= MAX_TOUCHED {
            return;
        }
        self.by_target.insert(target.clone(), self.items.len());
        self.items.push(Touched {
            target,
            step_types: vec![step_type.to_owned()],
            step_id: step_id.clone(),
            call_path: call_path.to_vec(),
            reads,
            screen,
            count: 1,
            at: OffsetDateTime::now_utc(),
            file: None,
            gone: false,
        });
    }

    /// The places, the files the run changed stamped as they are now.
    pub(crate) fn finish(self) -> Vec<Touched> {
        let mut items = self.items;
        for item in items.iter_mut().filter(|i| !i.reads && !i.screen) {
            let path = Path::new(&item.target);
            // Only places on this PC: a URL or a program name is no file.
            if !path.is_absolute() {
                continue;
            }
            match std::fs::metadata(path) {
                Ok(meta) if meta.is_file() => item.file = Some(stamp(path, meta.len())),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => item.gone = true,
                Err(_) => {}
            }
        }
        items
    }
}

/// A file as it is now, to compare with a run's [`Touched::file`]; `None`
/// when it is not a file (anymore).
pub fn stamp_file(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path)
        .ok()
        .filter(std::fs::Metadata::is_file)?;
    Some(stamp(path, meta.len()))
}

fn stamp(path: &Path, size: u64) -> FileStamp {
    let sha256 = (size <= MAX_HASHED_BYTES).then(|| sha256(path)).flatten();
    FileStamp { size, sha256 }
}

fn sha256(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn place(target: &str, reads: bool) -> Place {
        Place {
            target: target.into(),
            reads,
            screen: false,
        }
    }

    fn paths(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|k| (*k).to_owned()).collect()
    }

    #[test]
    fn a_copy_reads_its_source_and_writes_its_destination() {
        let found = places(
            "files.copy",
            &json!({ "from": "C:/in/a.csv", "to": "C:/out/a.csv" }),
            RiskLevel::Interactive,
            &paths(&["path", "from", "to", "folder"]),
            &[],
        );
        assert_eq!(
            found,
            vec![place("C:/in/a.csv", true), place("C:/out/a.csv", false)]
        );
    }

    #[test]
    fn steps_inside_a_page_or_the_run_name_no_place() {
        for ty in [
            "browser.waitFor",
            "desktop.getValue",
            "variable.set",
            "control.if",
            "log.message",
        ] {
            let found = places(
                ty,
                &json!({ "url": "https://x" }),
                RiskLevel::Interactive,
                &[],
                &[],
            );
            assert!(found.is_empty(), "{ty}");
        }
        let open = places(
            "browser.open",
            &json!({ "url": "https://example.com/" }),
            RiskLevel::Interactive,
            &[],
            &[TargetDef::site("url")],
        );
        assert_eq!(open, vec![place("https://example.com/", false)]);
    }

    #[test]
    fn a_click_keeps_what_it_clicked_and_typing_not_what_it_typed() {
        let click = places(
            "browser.click",
            &json!({ "target": { "role": "button", "name": "出荷" } }),
            RiskLevel::Interactive,
            &[],
            &[],
        );
        assert_eq!(
            click,
            vec![Place {
                target: r#"{"role":"button","name":"出荷"}"#.into(),
                reads: false,
                screen: true,
            }]
        );
        let fill = places(
            "browser.fill",
            &json!({ "target": { "label": "パスワード" }, "value": "secret-pass" }),
            RiskLevel::Interactive,
            &[],
            &[],
        );
        assert_eq!(fill.len(), 1);
        assert!(!fill[0].target.contains("secret-pass"));
    }

    #[test]
    fn a_mail_names_where_it_went_besides_what_it_attached() {
        let found = places(
            "mail.send",
            &json!({ "to": ["a@example.com", "b@example.com"], "attachments": ["C:/out/r.pdf"] }),
            RiskLevel::Dangerous,
            &paths(&["attachments"]),
            &[],
        );
        assert_eq!(
            found,
            vec![
                place("C:/out/r.pdf", true),
                place("a@example.com", false),
                place("b@example.com", false),
            ]
        );
    }

    #[test]
    fn a_safe_step_only_reads() {
        let found = places(
            "excel.read",
            &json!({ "path": "C:/in/a.xlsx" }),
            RiskLevel::Safe,
            &paths(&["path"]),
            &[],
        );
        assert_eq!(found, vec![place("C:/in/a.xlsx", true)]);
    }

    #[test]
    fn a_place_worked_on_twice_is_one_entry_and_a_write_counts() {
        let mut list = TouchedList::default();
        let step = StepId::new("s1");
        list.add(place("C:/a.xlsx", true), "excel.read", &step, &[]);
        list.add(
            place("C:/a.xlsx", false),
            "excel.write",
            &StepId::new("s2"),
            &[],
        );
        list.add(
            place("C:/a.xlsx", false),
            "excel.write",
            &StepId::new("s2"),
            &[],
        );
        let items = list.items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].count, 3);
        assert!(!items[0].reads);
        assert_eq!(items[0].step_types, vec!["excel.read", "excel.write"]);
        assert_eq!(items[0].step_id, step);
    }

    #[test]
    fn a_written_file_is_stamped_and_a_deleted_one_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out.txt");
        std::fs::write(&file, b"abc").unwrap();
        let deleted = dir.path().join("old.txt");
        let read = dir.path().join("in.txt");
        let mut list = TouchedList::default();
        let step = StepId::new("s");
        list.add(
            place(&file.display().to_string(), false),
            "files.writeText",
            &step,
            &[],
        );
        list.add(
            place(&deleted.display().to_string(), false),
            "files.delete",
            &step,
            &[],
        );
        list.add(
            place(&read.display().to_string(), true),
            "files.readText",
            &step,
            &[],
        );
        let items = list.finish();
        assert_eq!(
            items[0].file,
            Some(FileStamp {
                size: 3,
                sha256: Some(
                    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into()
                ),
            })
        );
        assert!(items[1].gone && items[1].file.is_none());
        // Read only: neither stamped nor said to be gone.
        assert!(!items[2].gone && items[2].file.is_none());
    }
}
