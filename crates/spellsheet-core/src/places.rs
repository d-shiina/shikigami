//! Where a flow's files come from: the files it reads from its `input/`
//! folder that are not there yet, and the places outside its folder it
//! names (a file server, a folder synced with cloud storage).
//!
//! Writer asks "where should this be read from?" for each missing file,
//! the AI hears about them from `list_project_files`, and sharing lists the
//! outside places so the receiver checks their PC reaches them.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::StepId;
use crate::model::Flow;
use crate::project::{ProjectFiles, is_relative};
use crate::registry::StepRegistry;
use crate::resource::is_absolute_windows_path;

/// A file the flow reads from its `input/` folder that is not there yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NeededFile {
    /// Relative to the flow's folder, `/`-separated (`input/受注.xlsx`).
    pub path: String,
    /// The steps that read it, in flow order.
    pub step_ids: Vec<StepId>,
}

/// A place outside the flow's folder that a step names with its full path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutsidePlace {
    /// The path as written (`\\fs01\経理\受注.xlsx`, `C:\Users\…\Box\…`).
    pub path: String,
    /// `fileServer` (a `\\server\share` path), `cloud` (inside a Box,
    /// OneDrive, Dropbox or Google Drive folder) or `local` (a drive of
    /// this PC).
    pub kind: PlaceKind,
    /// The steps that name it, in flow order.
    pub step_ids: Vec<StepId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PlaceKind {
    FileServer,
    Cloud,
    Local,
}

/// Params that name what a step makes, not what it reads: a file the flow
/// downloads into `input/` is not missing before the run.
const MADE_PARAMS: [&str; 2] = ["to", "saveTo"];

/// Step types whose `path` (or `folder`) is where they write, or that only
/// look whether it is there.
const MAKES_PATH: [&str; 10] = [
    "browser.download",
    "browser.screenshot",
    "desktop.screenshot",
    "file.writeText",
    "file.writeCsv",
    "file.createFolder",
    "file.exists",
    "file.delete",
    "mail.saveAttachments",
    "pdf.split",
];

/// The files under `input/` the flow reads that `files` does not hold.
/// Paths built with `{{ }}` cannot be known before the run and are left
/// out, as are files a step of the flow makes (a download into `input/`).
pub fn needed_files(flow: &Flow, registry: &StepRegistry, files: &ProjectFiles) -> Vec<NeededFile> {
    let mut read: BTreeMap<String, (usize, Vec<StepId>)> = BTreeMap::new();
    let mut made: Vec<String> = Vec::new();
    for (order, step) in flow.walk().enumerate() {
        let Some(def) = registry.get(&step.step_type) else {
            continue;
        };
        for key in &def.path_params {
            for value in param_texts(&step.params, key) {
                if value.contains("{{") || !is_relative(&value) {
                    continue;
                }
                let path = clean(&value);
                if !is_in_input(&path) {
                    continue;
                }
                let makes = MADE_PARAMS.contains(&key.as_str())
                    || (MAKES_PATH.contains(&step.step_type.as_str())
                        && (key == "path" || key == "folder"));
                if makes {
                    made.push(path.to_lowercase());
                } else {
                    let entry = read.entry(path).or_insert((order, Vec::new()));
                    if !entry.1.contains(&step.id) {
                        entry.1.push(step.id.clone());
                    }
                }
            }
        }
    }
    let there = |path: &str| {
        let lower = path.to_lowercase();
        files.files.iter().any(|f| f.path.to_lowercase() == lower)
            || files.folders.iter().any(|f| f.to_lowercase() == lower)
    };
    let mut needed: Vec<(usize, NeededFile)> = read
        .into_iter()
        .filter(|(path, _)| !there(path) && !made.contains(&path.to_lowercase()))
        .map(|(path, (order, step_ids))| (order, NeededFile { path, step_ids }))
        .collect();
    needed.sort_by_key(|(order, _)| *order);
    needed.into_iter().map(|(_, n)| n).collect()
}

/// The full paths the flow's steps name (outside its own folder), in flow
/// order. Paths built with `{{ }}` are left out.
pub fn outside_places(flow: &Flow, registry: &StepRegistry) -> Vec<OutsidePlace> {
    let mut places: Vec<OutsidePlace> = Vec::new();
    for step in flow.walk() {
        let Some(def) = registry.get(&step.step_type) else {
            continue;
        };
        for key in &def.path_params {
            for value in param_texts(&step.params, key) {
                let value = value.trim().to_owned();
                if value.contains("{{") || !is_absolute_windows_path(&value) {
                    continue;
                }
                match places
                    .iter_mut()
                    .find(|p| p.path.eq_ignore_ascii_case(&value))
                {
                    Some(place) if !place.step_ids.contains(&step.id) => {
                        place.step_ids.push(step.id.clone())
                    }
                    Some(_) => {}
                    None => places.push(OutsidePlace {
                        kind: place_kind(&value),
                        path: value,
                        step_ids: vec![step.id.clone()],
                    }),
                }
            }
        }
    }
    places
}

/// The places outside their folders that `flows` (a flow and the flows it
/// calls) name, with the folders kept in their settings files
/// (`configs`: the contents of `config/*.json`), for a package's
/// requirements. Written as they are (`%USERPROFILE%` stays).
pub fn package_places<'a>(
    flows: &[&Flow],
    registry: &StepRegistry,
    configs: impl IntoIterator<Item = &'a [u8]>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |path: String| {
        if !out.iter().any(|p| p.eq_ignore_ascii_case(&path)) {
            out.push(path);
        }
    };
    for flow in flows {
        for place in outside_places(flow, registry) {
            add(place.path);
        }
    }
    for bytes in configs {
        for folder in config_folders(bytes) {
            add(folder);
        }
    }
    out
}

/// The folder settings (`type: "folder"`) of a settings file, unexpanded.
pub fn config_folders(bytes: &[u8]) -> Vec<String> {
    let Ok(file) = serde_json::from_slice::<crate::project::ConfigFile>(bytes) else {
        return Vec::new();
    };
    file.items
        .into_iter()
        .filter(|i| i.value_type == crate::project::ConfigType::Folder)
        .filter_map(|i| {
            i.value
                .as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

/// Whether this PC reaches `place` now: it is there, or (for a file the
/// flow will make) its folder is.
pub fn reachable(place: &str) -> bool {
    let path = std::path::PathBuf::from(crate::project::expand_env(place));
    path.exists()
        || path
            .parent()
            .is_some_and(|p| !p.as_os_str().is_empty() && p.is_dir())
}

/// What kind of place a full path is in.
pub fn place_kind(path: &str) -> PlaceKind {
    let p = path.replace('/', "\\");
    if p.starts_with("\\\\") {
        return PlaceKind::FileServer;
    }
    let lower = p.to_lowercase();
    // The folders the sync apps make: `Box`, `OneDrive`, `OneDrive - 会社名`,
    // `Dropbox`, `iCloudDrive`, and Google Drive's `G:\マイドライブ` (or the
    // older `Google Drive` in the profile).
    let synced = lower.split('\\').any(|part| {
        matches!(
            part,
            "box"
                | "dropbox"
                | "google drive"
                | "my drive"
                | "マイドライブ"
                | "共有ドライブ"
                | "shared drives"
                | "icloud drive"
                | "iclouddrive"
                | "onedrive"
        ) || part.starts_with("onedrive - ")
    });
    if synced {
        PlaceKind::Cloud
    } else {
        PlaceKind::Local
    }
}

/// The texts of a param: a string, or the strings of a list. `key` may
/// reach into an object (`target.image.path`).
fn param_texts(params: &serde_json::Map<String, Value>, key: &str) -> Vec<String> {
    let mut parts = key.split('.');
    let Some(first) = parts.next() else {
        return Vec::new();
    };
    let mut value = params.get(first);
    for part in parts {
        value = value.and_then(|v| v.get(part));
    }
    match value {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

/// `input\a.xlsx`, `./input/a.xlsx` → `input/a.xlsx`.
fn clean(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn is_in_input(path: &str) -> bool {
    let mut parts = path.split('/');
    parts
        .next()
        .is_some_and(|p| p.eq_ignore_ascii_case("input"))
        && parts.next().is_some()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::model::Step;
    use crate::project::ProjectFile;

    fn files(paths: &[&str]) -> ProjectFiles {
        ProjectFiles {
            flow_id: crate::ids::FlowId::new("scn_t"),
            dir: String::new(),
            folders: vec!["input".into(), "config".into(), "input/2026".into()],
            files: paths
                .iter()
                .map(|p| ProjectFile {
                    path: (*p).into(),
                    size: 1,
                    modified: None,
                    in_use: false,
                })
                .collect(),
            needed: Vec::new(),
            cloud: None,
        }
    }

    fn registry() -> StepRegistry {
        let mut registry = StepRegistry::with_builtins();
        for (name, keys) in [
            ("file.readCsv", vec!["path"]),
            ("browser.download", vec!["path", "folder"]),
            ("file.copy", vec!["from", "to"]),
            ("pdf.merge", vec!["files", "to"]),
        ] {
            let mut def = registry.get("log.message").unwrap().clone();
            def.step_type = name.into();
            def.path_params = keys.into_iter().map(str::to_owned).collect();
            registry.register(def);
        }
        registry
    }

    fn flow(steps: Vec<Step>) -> Flow {
        let mut flow = Flow::new("t");
        flow.steps = steps;
        flow
    }

    #[test]
    fn a_missing_input_file_is_needed_once_with_every_step_that_reads_it() {
        let flow = flow(vec![
            Step::new("file.readCsv")
                .with_id("a")
                .with_param("path", "input/受注.csv"),
            Step::new("file.copy")
                .with_id("b")
                .with_param("from", "input\\受注.csv")
                .with_param("to", "output/x.csv"),
            Step::new("file.readCsv")
                .with_id("c")
                .with_param("path", "input/ある.csv"),
        ]);
        let needed = needed_files(&flow, &registry(), &files(&["input/ある.csv"]));
        assert_eq!(
            needed,
            vec![NeededFile {
                path: "input/受注.csv".into(),
                step_ids: vec!["a".into(), "b".into()]
            }]
        );
    }

    #[test]
    fn files_the_flow_makes_built_paths_and_other_folders_are_not_needed() {
        let flow = flow(vec![
            Step::new("browser.download")
                .with_id("a")
                .with_param("path", "input/受注.csv"),
            Step::new("file.readCsv")
                .with_id("b")
                .with_param("path", "input/受注.csv"),
            Step::new("file.readCsv")
                .with_id("c")
                .with_param("path", "input/{{ name }}.csv"),
            Step::new("file.readCsv")
                .with_id("d")
                .with_param("path", "templates/様式.csv"),
            Step::new("file.readCsv")
                .with_id("e")
                .with_param("path", "C:\\work\\a.csv"),
            Step::new("file.readCsv")
                .with_id("f")
                .with_param("path", "input/2026"),
            Step::new("pdf.merge")
                .with_id("g")
                .with_param("files", json!(["input/表紙.pdf"]))
                .with_param("to", "input/まとめ.pdf"),
        ]);
        let needed = needed_files(&flow, &registry(), &files(&[]));
        assert_eq!(
            needed.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(),
            ["input/表紙.pdf"]
        );
    }

    #[test]
    fn outside_places_are_sorted_into_file_servers_synced_folders_and_drives() {
        let flow = flow(vec![
            Step::new("file.readCsv")
                .with_id("a")
                .with_param("path", "\\\\fs01\\経理\\受注.csv"),
            Step::new("file.readCsv")
                .with_id("b")
                .with_param("path", "C:\\Users\\taro\\Box\\経理\\a.csv"),
            Step::new("file.readCsv")
                .with_id("c")
                .with_param("path", "C:\\Users\\taro\\OneDrive - 例\\a.csv"),
            Step::new("file.readCsv")
                .with_id("d")
                .with_param("path", "D:\\work\\a.csv"),
            Step::new("file.readCsv")
                .with_id("e")
                .with_param("path", "input/a.csv"),
            Step::new("file.readCsv")
                .with_id("f")
                .with_param("path", "\\\\FS01\\経理\\受注.csv"),
        ]);
        let places = outside_places(&flow, &registry());
        let kinds: Vec<_> = places.iter().map(|p| (p.kind, p.step_ids.len())).collect();
        assert_eq!(
            kinds,
            [
                (PlaceKind::FileServer, 2),
                (PlaceKind::Cloud, 1),
                (PlaceKind::Cloud, 1),
                (PlaceKind::Local, 1)
            ]
        );
    }

    #[test]
    fn folder_settings_expand_environment_variables_and_travel_as_written() {
        let path = std::env::var("PATH").unwrap_or_default();
        assert_eq!(
            crate::project::expand_env("%PATH%\\Box"),
            format!("{path}\\Box")
        );
        assert_eq!(
            crate::project::expand_env("%NO_SUCH_VAR_SPX%\\a 50%"),
            "%NO_SUCH_VAR_SPX%\\a 50%"
        );
        let config = json!({
            "format": "spellsheet.config",
            "items": [
                { "name": "受注の場所", "type": "folder", "value": "%USERPROFILE%\\Box\\経理" },
                { "name": "締め日", "type": "number", "value": 25 }
            ]
        });
        let bytes = serde_json::to_vec(&config).unwrap();
        let values = crate::project::ConfigFile::values(&config).unwrap();
        assert!(
            !values["受注の場所"]
                .as_str()
                .unwrap()
                .contains("%USERPROFILE%")
                || std::env::var("USERPROFILE").is_err()
        );
        let flow = flow(vec![
            Step::new("file.readCsv")
                .with_id("a")
                .with_param("path", "\\\\fs01\\経理\\a.csv"),
        ]);
        assert_eq!(
            package_places(&[&flow], &registry(), [bytes.as_slice()]),
            ["\\\\fs01\\経理\\a.csv", "%USERPROFILE%\\Box\\経理"]
        );
    }
}
