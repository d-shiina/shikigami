//! `.spx` packages (SpellSheet packages): one file that carries a flow to another person
//! or PC.
//!
//! A package is a plain zip so people and AI can look inside:
//!
//! ```text
//! manifest.json            what it is, who needs what (read first)
//! flow.json                the flow (secret defaults removed)
//! versions/<n>.json        versions that came along
//! subflows/<id>.json       flows it calls
//! files/<flow-id>/<path>   files of those flows' folders
//! ```
//!
//! The manifest lists every other entry with its SHA-256, so a damaged or
//! altered package is refused instead of half imported. The manifest also
//! says what the receiving PC needs (extensions, logins by name, sites,
//! apps, inputs) so it can be checked before importing.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Write};

use base64::Engine as _;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::error::{CoreError, CoreResult};
use crate::ids::FlowId;
use crate::model::Flow;
use crate::policy::{TargetKind, site_origin};
use crate::project::BundledFile;
use crate::registry::StepRegistry;
use crate::version::{BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, FlowBundle, FlowDiff, FlowVersion};

/// `format` of a package manifest.
pub const PACKAGE_FORMAT: &str = "spellsheet.package";
pub const PACKAGE_FORMAT_VERSION: u32 = 1;
/// File name extension, without the dot.
pub const PACKAGE_EXTENSION: &str = "spx";

const MANIFEST: &str = "manifest.json";
const FLOW: &str = "flow.json";
/// Refuse packages beyond these instead of filling the disk or memory.
const MAX_ENTRIES: usize = 5_000;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

/// What a package holds and what the receiving PC needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    /// Always `spellsheet.package`.
    pub format: String,
    pub format_version: u32,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub exported_at: OffsetDateTime,
    /// Version of SpellSheet that wrote it.
    pub app_version: String,
    /// Who wrote it (the Windows user name), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_by: Option<String>,
    pub flow: PackagedFlow,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subflows: Vec<PackagedSubflow>,
    #[serde(default)]
    pub requires: PackageRequires,
    /// Every entry other than the manifest.
    pub contents: Vec<PackageEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackagedFlow {
    pub id: FlowId,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// The version the content is, if it is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<PackagedVersion>,
    /// Whether the content is the version published on the PC it came from.
    #[serde(default)]
    pub published: bool,
    /// Steps, nested ones included.
    #[serde(default)]
    pub step_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackagedVersion {
    pub number: u32,
    pub uid: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackagedSubflow {
    pub id: FlowId,
    pub name: String,
}

/// What the flow (and the flows it calls) needs on the PC that runs it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageRequires {
    /// `plugin:<name>` → version range, as in `requires`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub plugins: BTreeMap<String, String>,
    /// Names of the logins (secrets) the steps use. Never their values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets: Vec<String>,
    /// Sites the steps open (`https://host`), when written out literally.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sites: Vec<String>,
    /// Programs the steps start, when written out literally.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<String>,
    /// Inputs asked for when the flow runs (no default value).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<PackageInput>,
    /// Places outside the flow's folder it reads or writes, written out in
    /// full in its steps or as a folder in its settings files
    /// (`\\fs01\経理`, `%USERPROFILE%\Box\経理`): the PC that runs it
    /// has to reach them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub places: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageInput {
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

/// One entry of the zip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// Which content of the flow goes into a package.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PackageContent {
    /// The published version when there is one, otherwise the current content.
    #[default]
    Auto,
    /// The published version (fails when nothing is published).
    Published,
    /// The current content, also when it is not saved as a version.
    Current,
}

/// Which versions come along.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PackageVersions {
    /// Only the version the content is (if any).
    #[default]
    Content,
    /// Every version of the flow.
    All,
    None,
}

/// A file of a flow's folder, by flow and path.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub flow_id: FlowId,
    pub path: String,
}

/// Options of [`crate::FlowService::export_package`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageOptions {
    #[serde(default)]
    pub content: PackageContent,
    #[serde(default)]
    pub versions: PackageVersions,
    /// Include files under `input/`. Off by default: they are usually real
    /// business data (and may hold personal data).
    #[serde(default)]
    pub include_input: bool,
    /// Files to leave out (after `include_input`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<FileRef>,
    /// Exactly these files, when set (`include_input` and `exclude` are then
    /// ignored). A file not listed, such as one of a sub-flow the person did
    /// not see, stays out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only: Option<Vec<FileRef>>,
    /// Shown to the receiver as who wrote the package.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_by: Option<String>,
}

/// A file that may go into a package, for choosing before exporting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageFileChoice {
    pub flow_id: FlowId,
    /// Name of that flow (the main flow or a sub-flow).
    pub flow_name: String,
    pub path: String,
    pub size: u64,
    /// Whether it goes in with the default options (`input/` does not).
    pub included_by_default: bool,
}

/// What exporting would put in, for the export dialog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlan {
    pub flow_id: FlowId,
    pub name: String,
    /// The published version, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<PackagedVersion>,
    /// Whether the current content differs from the published version.
    pub has_unpublished_changes: bool,
    /// The plan is for the current content (not the published version).
    pub current: bool,
    pub subflows: Vec<PackagedSubflow>,
    pub files: Vec<PackageFileChoice>,
    pub requires: PackageRequires,
    /// File name to save as (without folder).
    pub file_name: String,
}

/// State of one requirement on this PC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Ok,
    /// Not installed / not registered here.
    Missing,
    /// Installed at a version outside the range.
    Mismatch,
    /// The workspace's policy does not allow it.
    NotAllowed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CheckKind {
    Plugin,
    Secret,
    Site,
    App,
    /// A place outside the flow's folder (`Missing`: this PC cannot reach it now).
    Place,
}

/// One thing the package needs, checked against this PC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequirementCheck {
    pub kind: CheckKind,
    /// Plugin name, login name, site origin or program.
    pub name: String,
    /// Version range for plugins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    /// Installed version when it does not match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed: Option<String>,
    pub status: CheckStatus,
}

/// The flow with the same ID that is already in the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExistingFlow {
    pub name: String,
    /// Newest version here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<u32>,
    /// Published version here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_version: Option<u32>,
    /// The package's version is already here (same `uid`).
    pub has_package_version: bool,
    /// From the current content here to the package's content.
    pub diff: FlowDiff,
    /// The package's files under `input/` that an update leaves out,
    /// because this PC already has a file of that name there.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kept_inputs: Vec<String>,
}

/// What importing a package would do, shown before importing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackagePreview {
    pub manifest: PackageManifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing: Option<ExistingFlow>,
    pub checks: Vec<RequirementCheck>,
}

// -- requirements ---------------------------------------------------------

/// What `flows` (a flow and the flows it calls) need on the PC that runs them.
pub fn requirements(flows: &[&Flow], registry: &StepRegistry) -> PackageRequires {
    let mut plugins = BTreeMap::new();
    let mut secrets = BTreeSet::new();
    let mut sites = BTreeSet::new();
    let mut apps = BTreeSet::new();
    for flow in flows {
        for (key, range) in &flow.requires {
            plugins.entry(key.clone()).or_insert_with(|| range.clone());
        }
        secrets.extend(flow.secret_names());
        for step in flow.walk() {
            let Some(def) = registry.get(&step.step_type) else {
                continue;
            };
            for target in &def.targets {
                let Some(text) = step.params.get(&target.param).and_then(|v| v.as_str()) else {
                    continue;
                };
                if text.contains("{{") || text.trim().is_empty() {
                    continue;
                }
                match target.kind {
                    TargetKind::Site => {
                        if let Some(origin) = site_origin(text) {
                            sites.insert(origin);
                        }
                    }
                    TargetKind::App => {
                        apps.insert(text.trim().to_owned());
                    }
                }
            }
        }
    }
    let inputs = flows
        .first()
        .map(|flow| {
            flow.variables
                .iter()
                .filter(|v| v.direction.is_input() && v.default.is_none())
                .map(|v| PackageInput {
                    name: v.name.clone(),
                    description: v.description.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    PackageRequires {
        plugins,
        secrets: secrets.into_iter().collect(),
        sites: sites.into_iter().collect(),
        apps: apps.into_iter().collect(),
        inputs,
        places: Vec::new(),
    }
}

/// A file name for the package: the flow's name and version, with
/// characters Windows does not allow replaced.
pub fn file_name(name: &str, version: Option<u32>) -> String {
    let clean: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let clean = clean.trim().trim_end_matches('.');
    let stem = if clean.is_empty() { "flow" } else { clean };
    match version {
        Some(n) => format!("{stem} v{n}.{PACKAGE_EXTENSION}"),
        None => format!("{stem}.{PACKAGE_EXTENSION}"),
    }
}

// -- writing --------------------------------------------------------------

/// Writes `bundle` as a package. `manifest.contents` is filled in here.
pub fn write(bundle: &FlowBundle, mut manifest: PackageManifest) -> CoreResult<Vec<u8>> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    entries.push((FLOW.into(), pretty(&bundle.flow)?));
    for v in &bundle.versions {
        entries.push((format!("versions/{}.json", v.number), pretty(v)?));
    }
    for sub in &bundle.subflows {
        entries.push((format!("subflows/{}.json", sub.id.as_str()), pretty(sub)?));
    }
    for file in &bundle.files {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&file.data)
            .map_err(|e| CoreError::InvalidEdit(format!("file {}: {e}", file.path)))?;
        entries.push((
            format!("files/{}/{}", file.flow_id.as_str(), file.path),
            bytes,
        ));
    }
    manifest.contents = entries
        .iter()
        .map(|(path, bytes)| PackageEntry {
            path: path.clone(),
            size: bytes.len() as u64,
            sha256: sha256(bytes),
        })
        .collect();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(MANIFEST, options).map_err(zip_error)?;
    zip.write_all(&pretty(&manifest)?)?;
    for (path, bytes) in &entries {
        zip.start_file(path.as_str(), options).map_err(zip_error)?;
        zip.write_all(bytes)?;
    }
    Ok(zip.finish().map_err(zip_error)?.into_inner())
}

fn pretty<T: Serialize>(value: &T) -> CoreResult<Vec<u8>> {
    let mut out = serde_json::to_vec_pretty(value)?;
    out.push(b'\n');
    Ok(out)
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn zip_error(e: zip::result::ZipError) -> CoreError {
    CoreError::InvalidEdit(format!("not a readable .spx file: {e}"))
}

// -- reading --------------------------------------------------------------

/// Whether `bytes` look like a package (a zip) rather than JSON.
pub fn is_package(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

/// Reads only the manifest (cheap: for listing packages in a folder).
pub fn read_manifest(bytes: &[u8]) -> CoreResult<PackageManifest> {
    read_manifest_from(Cursor::new(bytes))
}

/// Reads only the manifest, without loading the rest of the file (for
/// looking through a folder of packages on a file server).
pub fn read_manifest_from<R: Read + std::io::Seek>(reader: R) -> CoreResult<PackageManifest> {
    let mut zip = zip::ZipArchive::new(reader).map_err(zip_error)?;
    let manifest: PackageManifest = serde_json::from_slice(&entry(&mut zip, MANIFEST)?)
        .map_err(|e| CoreError::InvalidEdit(format!("manifest.json: {e}")))?;
    check_format(&manifest)?;
    Ok(manifest)
}

fn check_format(manifest: &PackageManifest) -> CoreResult<()> {
    if manifest.format != PACKAGE_FORMAT {
        return Err(CoreError::InvalidEdit(format!(
            "not a SpellSheet package (format {:?})",
            manifest.format
        )));
    }
    if manifest.format_version > PACKAGE_FORMAT_VERSION {
        return Err(CoreError::InvalidEdit(format!(
            "package format version {} is newer than this SpellSheet understands ({PACKAGE_FORMAT_VERSION}); update SpellSheet",
            manifest.format_version
        )));
    }
    Ok(())
}

fn entry<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> CoreResult<Vec<u8>> {
    let mut file = zip
        .by_name(name)
        .map_err(|_| CoreError::InvalidEdit(format!("the package has no {name}")))?;
    let mut out = Vec::new();
    file.by_ref().take(MAX_TOTAL_BYTES).read_to_end(&mut out)?;
    Ok(out)
}

/// Reads a package into a bundle, checking every entry against the
/// manifest's hashes.
pub fn read(bytes: &[u8]) -> CoreResult<(PackageManifest, FlowBundle)> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(zip_error)?;
    if zip.len() > MAX_ENTRIES {
        return Err(CoreError::InvalidEdit(format!(
            "the package has more than {MAX_ENTRIES} entries"
        )));
    }
    let manifest: PackageManifest = serde_json::from_slice(&entry(&mut zip, MANIFEST)?)
        .map_err(|e| CoreError::InvalidEdit(format!("manifest.json: {e}")))?;
    check_format(&manifest)?;
    let mut total = 0u64;
    let mut read_checked = |zip: &mut zip::ZipArchive<Cursor<&[u8]>>, item: &PackageEntry| {
        let bytes = entry(zip, &item.path)?;
        total += bytes.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(CoreError::InvalidEdit("the package is too large".into()));
        }
        if bytes.len() as u64 != item.size || sha256(&bytes) != item.sha256 {
            return Err(CoreError::InvalidEdit(format!(
                "{} in the package is damaged or was changed after it was written",
                item.path
            )));
        }
        Ok(bytes)
    };
    let mut flow: Option<Flow> = None;
    let mut versions: Vec<FlowVersion> = Vec::new();
    let mut subflows: Vec<Flow> = Vec::new();
    let mut files: Vec<BundledFile> = Vec::new();
    for item in &manifest.contents {
        let bytes = read_checked(&mut zip, item)?;
        let json = || -> CoreResult<serde_json::Value> {
            serde_json::from_slice(&bytes)
                .map_err(|e| CoreError::InvalidEdit(format!("{}: {e}", item.path)))
        };
        if item.path == FLOW {
            flow = Some(crate::migrate::from_value(json()?)?);
        } else if item.path.starts_with("versions/") {
            versions.push(
                serde_json::from_value(json()?)
                    .map_err(|e| CoreError::InvalidEdit(format!("{}: {e}", item.path)))?,
            );
        } else if item.path.starts_with("subflows/") {
            subflows.push(crate::migrate::from_value(json()?)?);
        } else if let Some(rest) = item.path.strip_prefix("files/") {
            let Some((flow_id, path)) = rest.split_once('/') else {
                continue;
            };
            files.push(BundledFile {
                flow_id: FlowId::new(flow_id),
                path: path.to_owned(),
                data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            });
        }
    }
    let flow = flow.ok_or_else(|| CoreError::InvalidEdit("the package has no flow.json".into()))?;
    versions.sort_by_key(|v| v.number);
    Ok((
        manifest.clone(),
        FlowBundle {
            format: BUNDLE_FORMAT.into(),
            format_version: BUNDLE_FORMAT_VERSION,
            exported_at: manifest.exported_at,
            flow,
            versions,
            subflows,
            files,
        },
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_safe_on_windows() {
        assert_eq!(file_name("請求書の集計", Some(3)), "請求書の集計 v3.spx");
        assert_eq!(file_name("a/b:c?", None), "a_b_c_.spx");
        assert_eq!(file_name("  ", None), "flow.spx");
    }

    #[test]
    fn zip_magic_tells_packages_from_json() {
        assert!(is_package(b"PK\x03\x04rest"));
        assert!(!is_package(b"{\"format\":1}"));
    }
}
