//! 配布フォルダー: shared folders (a team's file server or OneDrive folder)
//! where people put the `.spx` files of published versions, so others see
//! when a newer version is there and take it in after looking at what
//! changed. No server: the folder is the only thing shared.
//!
//! Which folders a PC looks at is that PC's choice, kept in
//! `distribution.json` in the workspace's local part (not shared).
//! A folder holds `.spx` files side by side (`<name> v<n>.spx`); for each
//! flow the highest version found is the one offered. Only published
//! versions are put there, and taking one in does not publish it.

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::{CoreError, CoreResult};
use crate::ids::FlowId;
use crate::package::{self, PACKAGE_EXTENSION, PackageManifest, PackagedVersion};

/// File in the workspace's local part listing the folders this PC looks at.
pub const SETTINGS_FILE: &str = "distribution.json";

/// One registered folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DistributionFolder {
    /// What people call it, such as 経理課.
    pub name: String,
    /// The folder, such as `\\fs01\経理\SpellSheet`.
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DistributionSettings {
    #[serde(default)]
    pub folders: Vec<DistributionFolder>,
}

/// How a flow in the folder stands against this PC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DistributedState {
    /// Not on this PC.
    New,
    /// This PC has the flow, and the folder has a newer version.
    Update,
    /// This PC already has that version.
    Latest,
    /// This PC has a newer version than the folder.
    Older,
}

/// The newest version of one flow in a folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DistributedFlow {
    pub flow_id: FlowId,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub version: PackagedVersion,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_by: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub exported_at: OffsetDateTime,
    /// The file to take it in from.
    pub path: String,
    pub state: DistributedState,
    /// Newest version number on this PC, when it has the flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_version: Option<u32>,
}

/// What one folder holds now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DistributionView {
    pub folder: DistributionFolder,
    /// Why the folder could not be read (not reachable, no access…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub flows: Vec<DistributedFlow>,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub checked_at: OffsetDateTime,
}

/// What this PC knows about a flow, for comparing.
pub struct Local {
    pub latest: Option<u32>,
    pub uids: Vec<String>,
}

pub fn load(local_root: &Path) -> CoreResult<DistributionSettings> {
    match std::fs::read(local_root.join(SETTINGS_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| CoreError::InvalidEdit(format!("{SETTINGS_FILE}: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DistributionSettings::default()),
        Err(e) => Err(e.into()),
    }
}

/// Saves the list after checking it: a name and an absolute path each,
/// no name twice.
pub fn save(
    local_root: &Path,
    settings: &DistributionSettings,
) -> CoreResult<DistributionSettings> {
    let mut clean = DistributionSettings::default();
    for folder in &settings.folders {
        let name = folder.name.trim().to_owned();
        let path = folder.path.trim().trim_matches('"').to_owned();
        if name.is_empty() {
            return Err(rejected(
                "NAME_REQUIRED",
                "a distribution folder needs a name".into(),
            ));
        }
        if !is_absolute(&path) {
            return Err(rejected(
                "INVALID_PATH",
                format!("{path:?} is not a full folder path (such as \\\\fs01\\share\\SpellSheet)"),
            ));
        }
        if clean.folders.iter().any(|f| f.name == name) {
            return Err(rejected(
                "DUPLICATE_NAME",
                format!("{name} is listed twice"),
            ));
        }
        clean.folders.push(DistributionFolder { name, path });
    }
    std::fs::create_dir_all(local_root)?;
    let json =
        serde_json::to_vec_pretty(&clean).map_err(|e| CoreError::InvalidEdit(e.to_string()))?;
    crate::store::write_atomic(&local_root.join(SETTINGS_FILE), &json)?;
    Ok(clean)
}

fn is_absolute(path: &str) -> bool {
    // UNC (\\server\share) and drive paths are absolute on Windows even
    // when this runs elsewhere (tests, the Linux CI).
    path.starts_with("\\\\")
        || path.as_bytes().get(1..3) == Some(b":\\")
        || path.as_bytes().get(1..3) == Some(b":/")
        || Path::new(path).is_absolute()
}

fn rejected(code: &'static str, message: String) -> CoreError {
    CoreError::Rejected {
        code,
        message,
        hint: None,
    }
}

/// The `.spx` files directly in `dir`, by name.
fn packages_in(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case(PACKAGE_EXTENSION))
        })
        .collect();
    found.sort();
    Ok(found)
}

/// Manifests of the packages in `dir` that hold a version (only those are
/// offered), with their files. Files that are not packages are skipped.
pub fn manifests(dir: &Path) -> std::io::Result<Vec<(PathBuf, PackageManifest)>> {
    let mut out = Vec::new();
    for path in packages_in(dir)? {
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        if let Ok(manifest) = package::read_manifest_from(std::io::BufReader::new(file))
            && manifest.flow.version.is_some()
        {
            out.push((path, manifest));
        }
    }
    Ok(out)
}

/// What `folder` holds, compared with this PC (`local` for a flow ID).
pub fn view(
    folder: &DistributionFolder,
    local: impl Fn(&FlowId) -> Option<Local>,
) -> DistributionView {
    let checked_at = OffsetDateTime::now_utc();
    let found = match manifests(Path::new(&folder.path)) {
        Ok(found) => found,
        Err(e) => {
            return DistributionView {
                folder: folder.clone(),
                error: Some(e.to_string()),
                flows: Vec::new(),
                checked_at,
            };
        }
    };
    let mut flows: Vec<DistributedFlow> = Vec::new();
    for (path, manifest) in found {
        let Some(version) = manifest.flow.version.clone() else {
            continue;
        };
        if flows
            .iter()
            .any(|f| f.flow_id == manifest.flow.id && f.version.number >= version.number)
        {
            continue;
        }
        flows.retain(|f| f.flow_id != manifest.flow.id);
        let here = local(&manifest.flow.id);
        let state = match &here {
            None => DistributedState::New,
            Some(l) if l.uids.contains(&version.uid) => DistributedState::Latest,
            Some(l) if l.latest.is_none_or(|n| version.number > n) => DistributedState::Update,
            Some(_) => DistributedState::Older,
        };
        flows.push(DistributedFlow {
            flow_id: manifest.flow.id.clone(),
            name: manifest.flow.name.clone(),
            description: manifest.flow.description.clone(),
            version,
            exported_by: manifest.exported_by.clone(),
            exported_at: manifest.exported_at,
            path: path.to_string_lossy().into_owned(),
            state,
            local_version: here.and_then(|l| l.latest),
        });
    }
    flows.sort_by(|a, b| a.name.cmp(&b.name));
    DistributionView {
        folder: folder.clone(),
        error: None,
        flows,
        checked_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_count_as_full_paths_everywhere() {
        assert!(is_absolute("\\\\fs01\\経理\\SpellSheet"));
        assert!(is_absolute("C:\\Users\\a"));
        assert!(!is_absolute("経理"));
    }

    #[test]
    fn settings_need_names_and_full_paths() {
        let dir = tempfile::tempdir().unwrap();
        let folder = |name: &str, path: &str| DistributionFolder {
            name: name.into(),
            path: path.into(),
        };
        let bad = DistributionSettings {
            folders: vec![folder("経理課", "SpellSheet")],
        };
        assert!(save(dir.path(), &bad).is_err());
        let twice = DistributionSettings {
            folders: vec![folder("経理課", "\\\\a\\b"), folder("経理課", "\\\\a\\c")],
        };
        assert!(save(dir.path(), &twice).is_err());
        let good = DistributionSettings {
            folders: vec![folder(" 経理課 ", "\"\\\\fs01\\経理\\SpellSheet\"")],
        };
        let saved = save(dir.path(), &good).unwrap();
        assert_eq!(saved.folders[0].name, "経理課");
        assert_eq!(saved.folders[0].path, "\\\\fs01\\経理\\SpellSheet");
        assert_eq!(load(dir.path()).unwrap(), saved);
    }
}
