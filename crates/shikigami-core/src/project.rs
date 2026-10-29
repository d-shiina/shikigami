//! A scenario's project folder: its document and the files it works with.
//!
//! ```text
//! scenarios/<scenario-id>/
//!   scenario.json   the scenario document
//!   input/          data the scenario reads (Excel, CSV, …)
//!   config/         settings kept out of the scenario (JSON, CSV, …)
//!   templates/      forms the output is made from (Excel / Word templates)
//!   output/         what runs produce
//!   work/           temporary files of a run
//!   logs/           one readable log per run (newest kept)
//! ```
//!
//! Relative paths in a step's path params (`StepTypeDef::path_params`) are
//! resolved from this folder, so `input/orders.xlsx` works wherever the
//! workspace is. Bundles carry the files of `input/`, `config/` and
//! `templates/` (and anything else the author put there), not `output/`,
//! `work/` or `logs/`, which runs make.

use std::fs;
use std::path::{Component, Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::error::{CoreError, CoreResult};
use crate::ids::ScenarioId;
use crate::resource::is_absolute_windows_path;

/// The scenario document inside its folder.
pub const SCENARIO_FILE: &str = "scenario.json";

/// A standard folder of every project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectFolder {
    pub name: &'static str,
    /// Made by runs: left out of bundles.
    pub generated: bool,
}

pub const FOLDERS: [ProjectFolder; 6] = [
    ProjectFolder {
        name: "input",
        generated: false,
    },
    ProjectFolder {
        name: "config",
        generated: false,
    },
    ProjectFolder {
        name: "templates",
        generated: false,
    },
    ProjectFolder {
        name: "output",
        generated: true,
    },
    ProjectFolder {
        name: "work",
        generated: true,
    },
    ProjectFolder {
        name: "logs",
        generated: true,
    },
];

/// Folder of the per-run logs.
pub const LOGS_FOLDER: &str = "logs";

/// Run logs kept per scenario; older ones are deleted.
pub const LOGS_KEPT: usize = 100;

/// Largest file `read_project_file` returns as text.
pub const MAX_TEXT_READ: u64 = 1024 * 1024;

/// One file in a project folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    /// Relative to the project folder, `/`-separated (`input/orders.xlsx`).
    /// Write it as is in a step's path param.
    pub path: String,
    pub size: u64,
    #[serde(
        default,
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<String>")]
    pub modified: Option<OffsetDateTime>,
}

/// What a scenario's project folder holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    pub scenario_id: ScenarioId,
    /// Absolute path of the folder.
    pub dir: String,
    /// Every folder, relative and `/`-separated: the standard ones first,
    /// then the author's own (`input/2026`), sorted.
    pub folders: Vec<String>,
    /// Every file except `scenario.json`, sorted by path.
    pub files: Vec<ProjectFile>,
}

/// A file carried in a bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BundledFile {
    /// The scenario (the bundle's own or one of its sub-scenarios) whose
    /// folder it belongs to.
    pub scenario_id: ScenarioId,
    /// Relative to that folder, `/`-separated.
    pub path: String,
    /// The contents, base64 (standard alphabet, padded).
    pub data: String,
}

/// `format` of a settings file Studio edits as a form.
pub const CONFIG_FORMAT: &str = "shikigami.config";

/// A settings file (`config/*.json`) kept out of the scenario: values a
/// person changes without touching the flow (a cut-off day, a recipient, a
/// folder). Studio edits it as a form; `config.read` turns it into
/// `{ "締め日": 25, … }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    /// Always `shikigami.config`.
    pub format: String,
    #[serde(default)]
    pub items: Vec<ConfigItem>,
}

/// One setting of a [`ConfigFile`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfigItem {
    /// The key in the object `config.read` returns (`settings.締め日`).
    pub name: String,
    #[serde(rename = "type", default)]
    pub value_type: ConfigType,
    #[serde(default)]
    pub value: Value,
    /// What the setting is for, shown under it in the form.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConfigType {
    #[default]
    Text,
    Number,
    Boolean,
    /// `yyyy-MM-dd` text.
    Date,
    /// A list of texts.
    List,
}

impl ConfigFile {
    /// The settings as `config.read` returns them. A plain JSON object (not
    /// a `shikigami.config` file) is returned as it is.
    pub fn values(json: &Value) -> Result<serde_json::Map<String, Value>, String> {
        if json.get("format").and_then(Value::as_str) != Some(CONFIG_FORMAT) {
            return match json {
                Value::Object(map) => Ok(map.clone()),
                _ => Err("a settings file holds a JSON object".into()),
            };
        }
        let file: Self = serde_json::from_value(json.clone()).map_err(|e| e.to_string())?;
        let mut out = serde_json::Map::new();
        for item in file.items {
            if item.name.trim().is_empty() {
                continue;
            }
            if out.contains_key(&item.name) {
                return Err(format!("'{}' appears twice", item.name));
            }
            out.insert(item.name, item.value);
        }
        Ok(out)
    }
}

/// Checks a path written relative to a project folder and returns it as a
/// relative `PathBuf`. Rejects absolute paths, `..`, empty parts, the
/// scenario document itself and names Windows cannot store.
pub fn relative_path(path: &str) -> CoreResult<PathBuf> {
    let invalid = |why: &str| CoreError::InvalidProjectPath {
        path: path.to_owned(),
        reason: why.to_owned(),
    };
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(invalid("the path is empty"));
    }
    if is_absolute_windows_path(&normalized) || normalized.starts_with('/') {
        return Err(invalid(
            "write the path relative to the scenario's folder (e.g. input/orders.xlsx)",
        ));
    }
    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(invalid("'..' would leave the scenario's folder"));
        }
        if part
            .chars()
            .any(|c| "<>:\"|?*".contains(c) || c.is_control())
            || part.ends_with(['.', ' '])
        {
            return Err(invalid(&format!("'{part}' is not a valid file name")));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err(invalid("the path is empty"));
    }
    if out == Path::new(SCENARIO_FILE) {
        return Err(invalid(
            "scenario.json is the scenario itself; edit it with edit operations",
        ));
    }
    Ok(out)
}

/// `/`-separated form of a relative path.
pub fn display_path(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether `path` is relative in both Windows and POSIX terms (so it is to be
/// resolved from a project folder).
pub fn is_relative(path: &str) -> bool {
    let path = path.trim();
    !path.is_empty()
        && !is_absolute_windows_path(path)
        && !path.starts_with(['/', '\\'])
        // `C:foo` (drive-relative) is not ours to resolve.
        && !(path.len() >= 2 && path.as_bytes()[1] == b':')
        && !path.contains("://")
}

/// `dir` joined with a relative `path` (`/` or `\` separated); absolute
/// paths come back unchanged.
pub fn resolve(dir: &Path, path: &str) -> String {
    if !is_relative(path) {
        return path.to_owned();
    }
    let mut out = dir.to_path_buf();
    for part in path.trim().split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    out.to_string_lossy().into_owned()
}

/// Resolves the relative paths among `keys` of rendered `params` (strings,
/// or arrays of strings) from `dir`.
pub fn resolve_params(params: &mut Value, keys: &[String], dir: &Path) {
    let Some(map) = params.as_object_mut() else {
        return;
    };
    for key in keys {
        match map.get_mut(key) {
            Some(Value::String(s)) => *s = resolve(dir, s),
            Some(Value::Array(items)) => {
                for item in items {
                    if let Value::String(s) = item {
                        *s = resolve(dir, s);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Lists a project folder (empty when it does not exist).
pub fn list(id: &ScenarioId, dir: &Path) -> CoreResult<ProjectFiles> {
    let mut folders: Vec<String> = Vec::new();
    let mut files = Vec::new();
    walk(dir, Path::new(""), &mut folders, &mut files)?;
    let standard: Vec<String> = FOLDERS.iter().map(|f| f.name.to_owned()).collect();
    folders.retain(|f| !standard.contains(f));
    folders.sort();
    let mut all = standard;
    all.extend(folders);
    files.sort_by(|a: &ProjectFile, b| a.path.cmp(&b.path));
    Ok(ProjectFiles {
        scenario_id: id.clone(),
        dir: dir.to_string_lossy().into_owned(),
        folders: all,
        files,
    })
}

fn walk(
    root: &Path,
    rel: &Path,
    folders: &mut Vec<String>,
    files: &mut Vec<ProjectFile>,
) -> CoreResult<()> {
    let entries = match fs::read_dir(root.join(rel)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if is_hidden(&name_str) {
            continue;
        }
        let path = rel.join(&name);
        let meta = entry.metadata()?;
        if meta.is_dir() {
            folders.push(display_path(&path));
            walk(root, &path, folders, files)?;
        } else if !(rel.as_os_str().is_empty() && name_str == SCENARIO_FILE) {
            files.push(ProjectFile {
                path: display_path(&path),
                size: meta.len(),
                modified: meta.modified().ok().map(OffsetDateTime::from),
            });
        }
    }
    Ok(())
}

/// Temporary files of an atomic write (`.tmpXXXX`), Office's lock files
/// (`~$Book.xlsx`) and hidden files are not part of a project.
fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || name.starts_with("~$") || name.eq_ignore_ascii_case("desktop.ini")
}

/// Empties `work/` of a project folder (creating it when missing). Returns
/// what could not be removed (a file open in Excel…), for the run's log.
pub fn clear_work(project_dir: &Path) -> Vec<String> {
    let work = project_dir.join("work");
    let mut problems = Vec::new();
    let entries = match fs::read_dir(&work) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Err(e) = fs::create_dir_all(&work) {
                problems.push(format!("could not create {}: {e}", work.display()));
            }
            return problems;
        }
        Err(e) => return vec![format!("could not empty {}: {e}", work.display())],
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let removed = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(e) = removed {
            problems.push(format!(
                "could not remove {} from work/: {e}",
                path.display()
            ));
        }
    }
    problems
}

/// Writes the bundle's files of scenario `id` into `dir` (a project folder),
/// replacing files of the same name.
pub fn unpack(files: &[BundledFile], id: &ScenarioId, dir: &Path) -> CoreResult<()> {
    use base64::Engine as _;
    for file in files.iter().filter(|f| &f.scenario_id == id) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(file.data.as_bytes())
            .map_err(|e| {
                CoreError::InvalidEdit(format!("file {} in the bundle: {e}", file.path))
            })?;
        let target = dir.join(relative_path(&file.path)?);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::store::write_atomic(&target, &bytes)?;
    }
    Ok(())
}

/// Whether a file belongs in a bundle: not under `output/`, `work/` or
/// `logs/`.
pub fn is_bundled(path: &str) -> bool {
    let top = path.split('/').next().unwrap_or_default();
    !FOLDERS
        .iter()
        .any(|f| f.generated && f.name.eq_ignore_ascii_case(top))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_are_checked() {
        assert_eq!(
            relative_path("input\\受注.xlsx").ok(),
            Some(PathBuf::from("input").join("受注.xlsx"))
        );
        assert_eq!(
            relative_path("./config//a.json").ok(),
            Some(PathBuf::from("config").join("a.json"))
        );
        for bad in [
            "",
            "C:\\x.txt",
            "/etc/x",
            "../x",
            "input/../../x",
            "a:b",
            "scenario.json",
            "input/x?.txt",
            "input/trailing. ",
        ] {
            assert!(relative_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_relative_paths_are_resolved() {
        let dir = Path::new("/w/scenarios/scn_1");
        assert_eq!(
            resolve(dir, "input/a.xlsx"),
            Path::new("/w/scenarios/scn_1/input/a.xlsx").to_string_lossy()
        );
        assert_eq!(
            resolve(dir, "..\\shared\\b.csv"),
            Path::new("/w/scenarios/shared/b.csv").to_string_lossy()
        );
        for absolute in ["C:\\work\\a.xlsx", "\\\\server\\share\\a", "/tmp/a", "C:a"] {
            assert_eq!(resolve(dir, absolute), absolute);
        }
        let mut params = serde_json::json!({ "path": "out.txt", "from": ["a", "C:\\b"], "n": 1 });
        resolve_params(
            &mut params,
            &["path".into(), "from".into(), "n".into()],
            dir,
        );
        assert_eq!(
            params["path"],
            Path::new("/w/scenarios/scn_1/out.txt")
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(params["from"][1], "C:\\b");
        assert_eq!(params["n"], 1);
    }

    #[test]
    fn generated_folders_stay_out_of_bundles() {
        assert!(is_bundled("input/a.xlsx"));
        assert!(is_bundled("readme.txt"));
        assert!(!is_bundled("output/a.xlsx"));
        assert!(!is_bundled("Work/tmp.csv"));
        assert!(!is_bundled("logs/x.log"));
    }
}
