//! Installing, listing, turning off and removing plugins: what Studio's
//! 拡張機能 screen and `spellsheet plugin install` do (docs/extensions.md).
//!
//! Installed plugins live in one folder each under [`install_root`]
//! (`%LOCALAPPDATA%\SpellSheet\plugins\<name>\`). A plugin comes from a zip
//! file or folder on this PC, a zip URL, a GitHub repository's latest
//! release, or a registry (a JSON index listing extensions, each pinned to a
//! version and the SHA-256 of its zip). It is first *staged*: downloaded, unpacked and checked in a
//! folder of its own, so a person can see what it is (its nodes, what it
//! sends outside, the secrets it takes) before it is put in place. Nothing
//! is started while staging: the manifest is only read.
//!
//! Next to the manifest SpellSheet keeps two files of its own:
//! [`SOURCE_FILE`] (where it came from, for updates) and [`DISABLED_FILE`]
//! (turned off: kept, but not loaded).

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::manifest::{MANIFEST_FILE, Manifest};

/// Where SpellSheet wrote where an installed plugin came from.
pub const SOURCE_FILE: &str = ".spellsheet-source.json";

/// Present in a plugin folder that is turned off.
pub const DISABLED_FILE: &str = ".disabled";

/// Downloads and archives larger than this are refused.
const MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Archives with more entries than this are refused.
const MAX_ENTRIES: usize = 50_000;

/// The folder plugins are installed into:
/// `%LOCALAPPDATA%\SpellSheet\plugins`.
pub fn install_root() -> Option<PathBuf> {
    dirs::data_local_dir()?;
    Some(spellsheet_core::paths::local_dir().join("plugins"))
}

/// Why an install, update or removal did not happen.
#[derive(Debug, Clone, PartialEq)]
pub struct InstallError {
    pub code: &'static str,
    pub message: String,
    /// Manifest problems, one per line, when the plugin itself is wrong.
    pub problems: Vec<String>,
}

impl InstallError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            problems: Vec::new(),
        }
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)?;
        for line in &self.problems {
            write!(f, "\n  {line}")?;
        }
        Ok(())
    }
}

impl std::error::Error for InstallError {}

type Result<T> = std::result::Result<T, InstallError>;

/// Where a plugin comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// A zip file or a plugin folder on this PC.
    File { path: String },
    /// A zip file on the web (https), checked against `sha256` when given.
    Url {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
    },
    /// The latest release of a GitHub repository (`owner/name`): its first
    /// `.zip` asset, else the release's source zip.
    Github { repo: String },
    /// The extension `name` as a registry lists it: the version and zip
    /// the index pins. `registry` is the index URL; empty, the configured
    /// registries are looked through in order ([`registry_urls`]). Updates
    /// read the index again, so they too only take what it lists.
    Registry {
        name: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        registry: String,
    },
}

impl Source {
    /// Reads what a person typed or picked: a GitHub repository URL (or
    /// `github:owner/name`), an https URL of a zip, a path, or the name of
    /// an extension in the registries (`registry:name`, or the bare name
    /// when no such file or folder exists here).
    pub fn parse(text: &str) -> Result<Self> {
        let text = text.trim().trim_matches('"');
        if text.is_empty() {
            return Err(InstallError::new(
                "SOURCE_EMPTY",
                "no file, URL or GitHub repository was given",
            ));
        }
        if let Some(name) = text.strip_prefix("registry:") {
            return registry_name(name);
        }
        if crate::manifest::is_plugin_name(text) && !Path::new(text).exists() {
            return registry_name(text);
        }
        if let Some(repo) = text.strip_prefix("github:") {
            return github_repo(repo).map(|repo| Self::Github { repo });
        }
        let lower = text.to_ascii_lowercase();
        if let Some(rest) = lower
            .strip_prefix("https://github.com/")
            .map(|_| &text["https://github.com/".len()..])
        {
            // A release asset's own URL is a plain download.
            if rest.contains("/releases/download/") {
                return Ok(Self::Url {
                    url: text.into(),
                    sha256: None,
                });
            }
            return github_repo(rest).map(|repo| Self::Github { repo });
        }
        if lower.starts_with("https://") {
            return Ok(Self::Url {
                url: text.into(),
                sha256: None,
            });
        }
        if lower.starts_with("http://") {
            return Err(InstallError::new(
                "SOURCE_NOT_HTTPS",
                format!("'{text}' is not https; only https downloads are installed"),
            ));
        }
        // Kept for updates: a relative path would be read from wherever the
        // update runs.
        let path = std::path::absolute(text).unwrap_or_else(|_| PathBuf::from(text));
        Ok(Self::File {
            path: path.display().to_string(),
        })
    }

    /// The text [`Source::parse`] reads back.
    pub fn display(&self) -> String {
        match self {
            Self::File { path } => path.clone(),
            Self::Url { url, .. } => url.clone(),
            Self::Github { repo } => format!("https://github.com/{repo}"),
            Self::Registry { name, .. } => format!("registry:{name}"),
        }
    }
}

fn registry_name(name: &str) -> Result<Source> {
    let name = name.trim();
    if !crate::manifest::is_plugin_name(name) {
        return Err(InstallError::new(
            "SOURCE_INVALID",
            format!("'{name}' is not the name of an extension"),
        ));
    }
    Ok(Source::Registry {
        name: name.into(),
        registry: String::new(),
    })
}

/// `owner/name` from the start of a repository path.
fn github_repo(path: &str) -> Result<String> {
    let mut parts = path.trim_matches('/').split('/');
    let (Some(owner), Some(name)) = (parts.next(), parts.next()) else {
        return Err(InstallError::new(
            "SOURCE_INVALID",
            format!(
                "'{path}' does not name a GitHub repository (write https://github.com/owner/name)"
            ),
        ));
    };
    let name = name.strip_suffix(".git").unwrap_or(name);
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !ok(owner) || !ok(name) {
        return Err(InstallError::new(
            "SOURCE_INVALID",
            format!(
                "'{path}' does not name a GitHub repository (write https://github.com/owner/name)"
            ),
        ));
    }
    Ok(format!("{owner}/{name}"))
}

/// What [`SOURCE_FILE`] holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub source: Source,
    /// When it was installed or last updated (RFC 3339, UTC).
    pub installed_at: String,
}

/// A plugin downloaded and checked, waiting to be put in place.
#[derive(Debug)]
pub struct Staged {
    /// Identifies it to [`commit`] and [`discard`].
    pub id: String,
    pub source: Source,
    pub manifest: Manifest,
    /// The SHA-256 the download was checked against, when one was given
    /// (a registry pins it).
    pub sha256: Option<String>,
    /// The plugin folder inside the staging folder.
    dir: PathBuf,
}

impl Staged {
    /// What a person sees before installing: the plugin, its nodes, what
    /// they send outside, the secrets they take, the program it starts,
    /// and the version installed now (an update) if any.
    pub fn preview(&self, root: &Path) -> Value {
        let current = read_manifest(&root.join(&self.manifest.name))
            .ok()
            .map(|m| m.version);
        let mut summary = manifest_summary(&self.manifest);
        summary["id"] = json!(self.id);
        summary["source"] = json!(self.source);
        summary["installedVersion"] = json!(current);
        summary["sha256"] = json!(self.sha256);
        if let Source::Registry { registry, .. } = &self.source {
            summary["official"] = json!(registry == OFFICIAL_REGISTRY);
        }
        summary
    }
}

/// The parts of a manifest Studio lists.
pub fn manifest_summary(m: &Manifest) -> Value {
    let program = std::iter::once(m.command.program.as_str())
        .chain(m.command.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    json!({
        "name": m.name,
        "version": m.version,
        "label": m.label,
        "description": m.description,
        "publisher": m.publisher,
        "homepage": m.homepage,
        "tag": m.tag,
        "icon": m.icon,
        "program": program,
        "credentials": m.credentials.iter().map(|c| json!({
            "kind": c.kind, "label": c.label, "description": c.description,
        })).collect::<Vec<_>>(),
        "steps": m.steps.iter().map(|s| json!({
            "type": format!("{}.{}", m.name, s.action),
            "label": s.label,
            "risk": s.risk,
            "external": s.external.as_ref().map(|e| json!({ "service": e.service, "data": e.data })),
        })).collect::<Vec<_>>(),
    })
}

fn read_manifest(dir: &Path) -> std::result::Result<Manifest, Vec<String>> {
    let path = crate::manifest::file_in(dir, MANIFEST_FILE);
    let text =
        std::fs::read_to_string(&path).map_err(|e| vec![format!("{}: {e}", path.display())])?;
    Manifest::parse(&text)
}

fn staging_root(root: &Path) -> PathBuf {
    root.join(".staging")
}

fn trash_root(root: &Path) -> PathBuf {
    root.join(".trash")
}

fn io_error(what: &str, path: &Path, e: std::io::Error) -> InstallError {
    InstallError::new("IO_ERROR", format!("{what} {}: {e}", path.display()))
}

/// Downloads (or copies) the plugin, unpacks it and checks its manifest.
/// `taken` are the built-in adapter names. Starts nothing.
pub async fn stage(root: &Path, source: Source, taken: &[&str]) -> Result<Staged> {
    // A registry name is first looked up: the index says what to download.
    let (source, fetch, entry) = match source {
        Source::Registry { name, registry } => {
            let urls = if registry.is_empty() {
                registry_urls()
            } else {
                vec![registry]
            };
            let (registry, entry) = find_in_registries(&urls, &name).await?;
            let fetch = entry_source(&entry)?;
            (
                Source::Registry {
                    name,
                    registry: registry.clone(),
                },
                fetch,
                Some(entry),
            )
        }
        other => (other.clone(), other, None),
    };
    let id = uuid::Uuid::now_v7().simple().to_string();
    let work = staging_root(root).join(&id);
    std::fs::create_dir_all(&work).map_err(|e| io_error("cannot create", &work, e))?;
    let result = match stage_into(&work, &fetch, taken).await {
        Ok((dir, manifest)) => match &entry {
            Some(entry) => check_entry(&manifest, entry).map(|()| (dir, manifest)),
            None => Ok((dir, manifest)),
        },
        Err(e) => Err(e),
    };
    let sha256 = match &fetch {
        Source::Url { sha256, .. } => sha256.clone(),
        _ => None,
    };
    match result {
        Ok((dir, manifest)) => Ok(Staged {
            id,
            source,
            manifest,
            sha256,
            dir,
        }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&work);
            Err(e)
        }
    }
}

async fn stage_into(work: &Path, source: &Source, taken: &[&str]) -> Result<(PathBuf, Manifest)> {
    let content = work.join("content");
    match source {
        Source::File { path } => {
            let path = PathBuf::from(path);
            if path.is_dir() {
                copy_dir(&path, &content)?;
            } else if path.is_file() {
                let file =
                    std::fs::File::open(&path).map_err(|e| io_error("cannot open", &path, e))?;
                unzip(file, &content)?;
            } else {
                return Err(InstallError::new(
                    "SOURCE_NOT_FOUND",
                    format!("{} does not exist", path.display()),
                ));
            }
        }
        Source::Url { url, sha256 } => {
            let zip = work.join("download.zip");
            download(url, &zip).await?;
            if let Some(expected) = sha256 {
                check_sha256(&zip, expected)?;
            }
            let file = std::fs::File::open(&zip).map_err(|e| io_error("cannot open", &zip, e))?;
            unzip(file, &content)?;
        }
        Source::Github { repo } => {
            let url = latest_release_zip(repo).await?;
            let zip = work.join("download.zip");
            download(&url, &zip).await?;
            let file = std::fs::File::open(&zip).map_err(|e| io_error("cannot open", &zip, e))?;
            unzip(file, &content)?;
        }
        Source::Registry { .. } => {
            return Err(InstallError::new(
                "SOURCE_INVALID",
                "a registry entry cannot point at another registry entry",
            ));
        }
    }
    let dir = find_plugin_dir(&content)?;
    let manifest = read_manifest(&dir).map_err(|problems| InstallError {
        code: "PLUGIN_INVALID",
        message: "the extension's manifest cannot be read".into(),
        problems,
    })?;
    check(&manifest, taken)?;
    Ok((dir, manifest))
}

/// Stages a new version of the installed plugin `name` from where it was
/// installed from. Refused when the source now holds another plugin, which
/// would otherwise replace that one instead.
pub async fn stage_update(root: &Path, name: &str, taken: &[&str]) -> Result<Staged> {
    let record = source_of(root, name).ok_or_else(|| {
        InstallError::new(
            "PLUGIN_SOURCE_UNKNOWN",
            format!(
                "'{name}' was not installed by SpellSheet, so there is nowhere to update it from"
            ),
        )
    })?;
    let staged = stage(root, record.source, taken).await?;
    if staged.manifest.name != name {
        discard(root, &staged.id);
        return Err(InstallError::new(
            "PLUGIN_SOURCE_CHANGED",
            format!(
                "the source of '{name}' now holds the extension '{}'; install that one separately if you want it",
                staged.manifest.name
            ),
        ));
    }
    Ok(staged)
}

/// The checks loading does, without starting anything.
fn check(manifest: &Manifest, taken: &[&str]) -> Result<()> {
    if taken.contains(&manifest.name.as_str()) {
        return Err(InstallError::new(
            "PLUGIN_NAME_TAKEN",
            format!("'{}' is the name of a built-in adapter", manifest.name),
        ));
    }
    manifest
        .step_defs()
        .map(|_| ())
        .map_err(|problems| InstallError {
            code: "PLUGIN_INVALID",
            message: format!(
                "the extension '{}' has errors in its manifest",
                manifest.name
            ),
            problems,
        })
}

/// The folder holding the manifest: the archive's top, or its only
/// folder (GitHub source zips and most hand-made zips have one).
fn find_plugin_dir(content: &Path) -> Result<PathBuf> {
    crate::manifest::upgrade_legacy_files(content);
    if crate::manifest::file_in(content, MANIFEST_FILE).is_file() {
        return Ok(content.to_path_buf());
    }
    let entries: Vec<PathBuf> = std::fs::read_dir(content)
        .map_err(|e| io_error("cannot read", content, e))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    if let [only] = entries.as_slice()
        && only.is_dir()
        && {
            crate::manifest::upgrade_legacy_files(only);
            crate::manifest::file_in(only, MANIFEST_FILE).is_file()
        }
    {
        return Ok(only.clone());
    }
    Err(InstallError::new(
        "PLUGIN_MANIFEST_MISSING",
        format!("no {MANIFEST_FILE} at the top of the archive or in its only folder"),
    ))
}

fn unzip(file: std::fs::File, into: &Path) -> Result<()> {
    let bad = |e: zip::result::ZipError| {
        InstallError::new("ARCHIVE_INVALID", format!("not a readable zip file: {e}"))
    };
    let mut archive = zip::ZipArchive::new(file).map_err(bad)?;
    if archive.len() > MAX_ENTRIES {
        return Err(InstallError::new(
            "ARCHIVE_TOO_LARGE",
            format!("more than {MAX_ENTRIES} files"),
        ));
    }
    std::fs::create_dir_all(into).map_err(|e| io_error("cannot create", into, e))?;
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(bad)?;
        // Entries that would land outside the folder ("../", absolute) are refused.
        let Some(name) = entry.enclosed_name() else {
            return Err(InstallError::new(
                "ARCHIVE_INVALID",
                format!(
                    "'{}' points outside the archive's folder",
                    String::from_utf8_lossy(entry.name_raw())
                ),
            ));
        };
        let path = into.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&path).map_err(|e| io_error("cannot create", &path, e))?;
            continue;
        }
        if entry.is_symlink() {
            return Err(InstallError::new(
                "ARCHIVE_INVALID",
                format!(
                    "'{}' is a symbolic link; extensions cannot contain links",
                    String::from_utf8_lossy(entry.name_raw())
                ),
            ));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_error("cannot create", parent, e))?;
        }
        let mut out =
            std::fs::File::create(&path).map_err(|e| io_error("cannot write", &path, e))?;
        let left = MAX_BYTES.saturating_sub(total);
        let written = std::io::copy(&mut (&mut entry).take(left + 1), &mut out)
            .map_err(|e| io_error("cannot write", &path, e))?;
        total += written;
        if total > MAX_BYTES {
            return Err(InstallError::new(
                "ARCHIVE_TOO_LARGE",
                "the archive unpacks to more than 512 MB",
            ));
        }
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o755));
        }
    }
    Ok(())
}

/// Copies a plugin folder, leaving out SpellSheet's own files and `.git`.
fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to).map_err(|e| io_error("cannot create", to, e))?;
    for entry in std::fs::read_dir(from).map_err(|e| io_error("cannot read", from, e))? {
        let entry = entry.map_err(|e| io_error("cannot read", from, e))?;
        let name = entry.file_name();
        if name == ".git" || name == SOURCE_FILE || name == DISABLED_FILE {
            continue;
        }
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|e| io_error("cannot read", &path, e))?;
        if kind.is_dir() {
            copy_dir(&path, &to.join(&name))?;
        } else if kind.is_file() {
            std::fs::copy(&path, to.join(&name)).map_err(|e| io_error("cannot copy", &path, e))?;
        }
    }
    Ok(())
}

fn client() -> Result<reqwest::Client> {
    // reqwest is built without its own crypto provider (as in http.request).
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .user_agent(concat!("SpellSheet/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| InstallError::new("DOWNLOAD_FAILED", e.to_string()))
}

async fn get(url: &str, accept: &str) -> Result<reqwest::Response> {
    let response = client()?
        .get(url)
        .header("Accept", accept)
        .send()
        .await
        .map_err(|e| InstallError::new("DOWNLOAD_FAILED", format!("{url}: {e}")))?;
    if !response.status().is_success() {
        return Err(InstallError::new(
            "DOWNLOAD_FAILED",
            format!("{url}: the server answered {}", response.status()),
        ));
    }
    if response.url().scheme() != "https" {
        return Err(InstallError::new(
            "SOURCE_NOT_HTTPS",
            format!("{url} was redirected away from https"),
        ));
    }
    Ok(response)
}

async fn download(url: &str, to: &Path) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut response = get(url, "application/octet-stream, application/zip, */*").await?;
    if response.content_length().is_some_and(|n| n > MAX_BYTES) {
        return Err(InstallError::new(
            "ARCHIVE_TOO_LARGE",
            "the download is larger than 512 MB",
        ));
    }
    let mut file = tokio::fs::File::create(to)
        .await
        .map_err(|e| io_error("cannot write", to, e))?;
    let mut total = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| InstallError::new("DOWNLOAD_FAILED", format!("{url}: {e}")))?
    {
        total += chunk.len() as u64;
        if total > MAX_BYTES {
            return Err(InstallError::new(
                "ARCHIVE_TOO_LARGE",
                "the download is larger than 512 MB",
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| io_error("cannot write", to, e))?;
    }
    file.flush()
        .await
        .map_err(|e| io_error("cannot write", to, e))
}

async fn get_json(url: &str) -> Result<Value> {
    let response = get(url, "application/json").await?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| InstallError::new("DOWNLOAD_FAILED", format!("{url}: {e}")))?;
    serde_json::from_slice(&bytes).map_err(|e| {
        InstallError::new("DOWNLOAD_FAILED", format!("{url} did not answer JSON: {e}"))
    })
}

/// The zip of a repository's latest release.
async fn latest_release_zip(repo: &str) -> Result<String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let release = get_json(&url).await.map_err(|e| InstallError {
        message: format!(
            "{} (does https://github.com/{repo} have a published release?)",
            e.message
        ),
        ..e
    })?;
    release_zip(&release).ok_or_else(|| {
        InstallError::new(
            "RELEASE_HAS_NO_ZIP",
            format!("the latest release of {repo} has no zip file to install"),
        )
    })
}

/// The first `.zip` asset of a GitHub release, else its source zip.
fn release_zip(release: &Value) -> Option<String> {
    release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| {
            a["name"]
                .as_str()
                .is_some_and(|n| n.to_ascii_lowercase().ends_with(".zip"))
        })
        .and_then(|a| a["browser_download_url"].as_str())
        .or_else(|| release["zipball_url"].as_str())
        .map(str::to_owned)
}

/// Puts a staged plugin in place (replacing the installed version of the
/// same name, which keeps being on or off) and records where it came from.
pub fn commit(root: &Path, staged: Staged) -> Result<PathBuf> {
    let target = root.join(&staged.manifest.name);
    let was_disabled = target.join(DISABLED_FILE).exists();
    if target.exists() {
        move_to_trash(root, &target)?;
    }
    std::fs::rename(&staged.dir, &target).map_err(|e| io_error("cannot move into", &target, e))?;
    let record = SourceRecord {
        source: staged.source,
        installed_at: now(),
    };
    let text = serde_json::to_string_pretty(&record).unwrap_or_default();
    std::fs::write(target.join(SOURCE_FILE), text + "\n")
        .map_err(|e| io_error("cannot write", &target, e))?;
    if was_disabled {
        let _ = std::fs::write(target.join(DISABLED_FILE), "");
    }
    let _ = std::fs::remove_dir_all(staging_root(root).join(&staged.id));
    empty_trash(root);
    Ok(target)
}

/// Throws a staged plugin away.
pub fn discard(root: &Path, id: &str) {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        let _ = std::fs::remove_dir_all(staging_root(root).join(id));
    }
}

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Moves a plugin folder aside first: a program still running from it
/// (Studio started it) keeps its files, and a folder that cannot be moved
/// is left whole rather than half deleted.
fn move_to_trash(root: &Path, dir: &Path) -> Result<()> {
    let trash = trash_root(root);
    std::fs::create_dir_all(&trash).map_err(|e| io_error("cannot create", &trash, e))?;
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("plugin");
    let aside = trash.join(format!("{name}-{}", uuid::Uuid::now_v7().simple()));
    std::fs::rename(dir, &aside).map_err(|e| InstallError {
        code: "PLUGIN_IN_USE",
        message: format!(
            "{} is in use and cannot be replaced or removed now ({e}); close Writer and the AI clients, then try again",
            dir.display()
        ),
        problems: Vec::new(),
    })?;
    empty_trash(root);
    Ok(())
}

/// Removes what earlier updates and removals moved aside (what is still in
/// use stays until next time).
pub fn empty_trash(root: &Path) {
    if let Ok(entries) = std::fs::read_dir(trash_root(root)) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn installed_dir(root: &Path, name: &str) -> Result<PathBuf> {
    let dir = root.join(name);
    crate::manifest::upgrade_legacy_files(&dir);
    if crate::manifest::is_plugin_name(name)
        && crate::manifest::file_in(&dir, MANIFEST_FILE).is_file()
    {
        Ok(dir)
    } else {
        Err(InstallError::new(
            "PLUGIN_NOT_INSTALLED",
            format!(
                "no extension named '{name}' is installed in {}",
                root.display()
            ),
        ))
    }
}

/// Removes an installed plugin.
pub fn remove(root: &Path, name: &str) -> Result<()> {
    let dir = installed_dir(root, name)?;
    move_to_trash(root, &dir)
}

/// Turns an installed plugin on or off. Off, it stays in its folder but is
/// not loaded (its nodes are missing, as when it is not installed).
pub fn set_enabled(root: &Path, name: &str, enabled: bool) -> Result<()> {
    let dir = installed_dir(root, name)?;
    let marker = dir.join(DISABLED_FILE);
    let result = if enabled {
        match std::fs::remove_file(&marker) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    } else {
        std::fs::write(&marker, "")
    };
    result.map_err(|e| io_error("cannot change", &marker, e))
}

/// Where an installed plugin came from, when SpellSheet installed it.
pub fn source_of(root: &Path, name: &str) -> Option<SourceRecord> {
    crate::manifest::upgrade_legacy_files(&root.join(name));
    let text =
        std::fs::read_to_string(crate::manifest::file_in(&root.join(name), SOURCE_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// One plugin found on this PC, loaded or not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    /// The manifest's parts Studio lists ([`manifest_summary`]); for a
    /// folder whose manifest cannot be read, only `name` (the folder's).
    #[serde(flatten)]
    pub summary: Value,
    pub dir: String,
    pub enabled: bool,
    /// Installed by SpellSheet into [`install_root`]: it can be turned off,
    /// updated and removed there. Others come from `SPELLSHEET_PLUGINS`
    /// (a developer's folder) and are only listed.
    pub managed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceRecord>,
    /// Why it cannot be loaded (empty when it can).
    pub problems: Vec<String>,
}

/// Every plugin folder in `roots` (as [`crate::discover`] looks), with
/// those turned off and those that cannot be loaded. `managed_root` is
/// [`install_root`]; `taken` the built-in adapter names.
pub fn list(roots: &[PathBuf], managed_root: Option<&Path>, taken: &[&str]) -> Vec<Installed> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for root in roots {
        for dir in crate::plugin_dirs(root, true) {
            let managed = managed_root.is_some_and(|m| dir.parent() == Some(m));
            let enabled = !dir.join(DISABLED_FILE).exists();
            let folder = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_owned();
            let (summary, mut problems, name) = match read_manifest(&dir) {
                Ok(m) => {
                    let problems = check(&m, taken).err().map(|e| {
                        if e.problems.is_empty() {
                            vec![e.message]
                        } else {
                            e.problems
                        }
                    });
                    (manifest_summary(&m), problems.unwrap_or_default(), m.name)
                }
                Err(problems) => (
                    json!({ "name": folder, "label": folder }),
                    problems,
                    folder.clone(),
                ),
            };
            if enabled && problems.is_empty() {
                if seen.contains(&name) {
                    problems.push(format!(
                        "name: '{name}' is already used by another extension (only the first one is loaded)"
                    ));
                } else {
                    seen.push(name.clone());
                }
            }
            out.push(Installed {
                summary,
                dir: dir.display().to_string(),
                enabled,
                managed,
                source: if managed {
                    source_of(managed_root.unwrap_or(root), &folder)
                } else {
                    None
                },
                problems,
            });
        }
    }
    out
}

/// The official registry: the index of the `spellsheet/plugins` repository,
/// served by GitHub Pages. Listed first unless a person removes it.
pub const OFFICIAL_REGISTRY: &str = "https://spellsheet.github.io/plugins/index.json";

/// One extension in a registry index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    /// The version the index lists. With `url`, the zip must hold exactly
    /// this version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub publisher: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub homepage: String,
    /// Where it is developed: a GitHub repository (or a zip URL). Installed
    /// from when the entry has no `url`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// The zip of `version` (https).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The SHA-256 of that zip (64 hex digits). A download that differs is
    /// not installed, so a release replaced after the entry was reviewed
    /// does not reach anyone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Why it was taken off the list (a problem was found). It is no longer
    /// installed or updated, and Writer says so next to installed copies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn: Option<String>,
    /// The index it came from (filled in when read, not by the index).
    #[serde(default, skip_deserializing)]
    pub registry: String,
    /// It came from [`OFFICIAL_REGISTRY`] (filled in when read).
    #[serde(default, skip_deserializing)]
    pub official: bool,
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Reads a registry index: `{ "extensions": [ RegistryEntry, … ] }`, as
/// served from any https URL (a file in a Git repository is enough; no
/// server is needed). Entries that cannot be installed safely are refused
/// with the index, so its maintainers notice.
pub fn parse_registry(index: &Value) -> Result<Vec<RegistryEntry>> {
    let list = index.get("extensions").cloned().ok_or_else(|| {
        InstallError::new("REGISTRY_INVALID", "the index has no \"extensions\" list")
    })?;
    let entries: Vec<RegistryEntry> = serde_json::from_value(list).map_err(|e| {
        InstallError::new("REGISTRY_INVALID", format!("the index cannot be read: {e}"))
    })?;
    let mut problems = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        let at = format!("extensions[{i}] ({})", e.name);
        if !crate::manifest::is_plugin_name(&e.name) {
            problems.push(format!("{at}: name is not an extension name"));
        }
        if e.url.is_none() && e.source.trim().is_empty() {
            problems.push(format!("{at}: needs url (and sha256) or source"));
        }
        if let Some(url) = &e.url
            && !url.to_ascii_lowercase().starts_with("https://")
        {
            problems.push(format!("{at}: url is not https"));
        }
        if let Some(sha) = &e.sha256
            && !is_sha256(sha)
        {
            problems.push(format!("{at}: sha256 is not 64 hex digits"));
        }
        if e.sha256.is_some() && e.url.is_none() {
            problems.push(format!("{at}: sha256 needs the url of the zip it is for"));
        }
        if e.url.is_some() && e.version.is_none() {
            problems.push(format!("{at}: url needs the version it holds"));
        }
        // A zip URL is always pinned: without its hash a replaced release
        // would be taken. Unpinned entries name a `source` instead.
        if e.url.is_some() && e.sha256.is_none() {
            problems.push(format!("{at}: url needs the sha256 of the zip"));
        }
        if entries[..i].iter().any(|o| o.name == e.name) {
            problems.push(format!("{at}: listed twice"));
        }
    }
    if problems.is_empty() {
        Ok(entries)
    } else {
        Err(InstallError {
            code: "REGISTRY_INVALID",
            message: "the index has entries that cannot be installed".into(),
            problems,
        })
    }
}

/// Downloads and reads a registry index.
pub async fn fetch_registry(url: &str) -> Result<Vec<RegistryEntry>> {
    let url = url.trim();
    if !url.to_ascii_lowercase().starts_with("https://") {
        return Err(InstallError::new(
            "SOURCE_NOT_HTTPS",
            format!("'{url}' is not an https URL"),
        ));
    }
    let mut entries = parse_registry(&get_json(url).await?)?;
    for e in &mut entries {
        e.registry = url.to_owned();
        e.official = url == OFFICIAL_REGISTRY;
    }
    Ok(entries)
}

/// A registry that could not be read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFailure {
    pub registry: String,
    pub code: &'static str,
    pub message: String,
    pub problems: Vec<String>,
}

/// What the registries offer together.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offered {
    /// One entry per name: an earlier registry wins over a later one.
    pub extensions: Vec<RegistryEntry>,
    /// Every withdrawn entry of every registry, not merged by name: an
    /// installed extension is checked against the registry it came from.
    pub withdrawn: Vec<RegistryEntry>,
    pub failed: Vec<RegistryFailure>,
}

/// How long one registry may take to answer before it counts as failed,
/// so a stalled one does not hold up the others.
const REGISTRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Reads every registry in `urls` (in parallel) and merges them in order.
pub async fn fetch_registries(urls: &[String]) -> Offered {
    let results = futures_join_all(urls.iter().cloned().map(|url| async move {
        let result = match tokio::time::timeout(REGISTRY_TIMEOUT, fetch_registry(&url)).await {
            Ok(result) => result,
            Err(_) => Err(InstallError::new(
                "DOWNLOAD_FAILED",
                format!(
                    "{url} did not answer within {} seconds",
                    REGISTRY_TIMEOUT.as_secs()
                ),
            )),
        };
        (url, result)
    }))
    .await;
    let mut offered = Offered::default();
    for (registry, result) in results {
        match result {
            Ok(entries) => {
                for e in entries {
                    if e.withdrawn.is_some() {
                        offered.withdrawn.push(e.clone());
                    }
                    if !offered.extensions.iter().any(|o| o.name == e.name) {
                        offered.extensions.push(e);
                    }
                }
            }
            Err(e) => offered.failed.push(RegistryFailure {
                registry,
                code: e.code,
                message: e.message,
                problems: e.problems,
            }),
        }
    }
    offered
}

/// Runs the futures together and keeps their order.
async fn futures_join_all<F>(futures: impl Iterator<Item = F>) -> Vec<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let handles: Vec<_> = futures.map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(value) = handle.await {
            out.push(value);
        }
    }
    out
}

/// The entry for `name` in the first of `urls` that lists it.
async fn find_in_registries(urls: &[String], name: &str) -> Result<(String, RegistryEntry)> {
    if urls.is_empty() {
        return Err(InstallError::new(
            "REGISTRY_NOT_SET",
            "no registry is set, so there is no list to find the extension in",
        ));
    }
    let offered = fetch_registries(urls).await;
    if let Some(entry) = offered.extensions.into_iter().find(|e| e.name == name) {
        return Ok((entry.registry.clone(), entry));
    }
    if let Some(f) = offered.failed.into_iter().next() {
        return Err(InstallError {
            code: f.code,
            message: format!("{}: {}", f.registry, f.message),
            problems: f.problems,
        });
    }
    Err(InstallError::new(
        "REGISTRY_ENTRY_NOT_FOUND",
        format!("no registry lists an extension named '{name}'"),
    ))
}

/// What to download for a registry entry: its pinned zip, else its source.
fn entry_source(entry: &RegistryEntry) -> Result<Source> {
    if let Some(reason) = &entry.withdrawn {
        return Err(InstallError::new(
            "PLUGIN_WITHDRAWN",
            format!(
                "'{}' was taken off the list {}: {reason}",
                entry.name, entry.registry
            ),
        ));
    }
    if let Some(url) = &entry.url {
        return Ok(Source::Url {
            url: url.clone(),
            sha256: entry.sha256.as_ref().map(|s| s.to_ascii_lowercase()),
        });
    }
    match Source::parse(&entry.source)? {
        source @ (Source::Github { .. } | Source::Url { .. }) => Ok(source),
        _ => Err(InstallError::new(
            "REGISTRY_INVALID",
            format!(
                "the entry for '{}' does not say where to download it",
                entry.name
            ),
        )),
    }
}

/// The downloaded extension is the one the entry lists.
fn check_entry(manifest: &Manifest, entry: &RegistryEntry) -> Result<()> {
    if manifest.name != entry.name {
        return Err(InstallError::new(
            "REGISTRY_ENTRY_MISMATCH",
            format!(
                "the registry lists '{}', but the download holds the extension '{}'",
                entry.name, manifest.name
            ),
        ));
    }
    if entry.url.is_some()
        && let Some(version) = &entry.version
        && *version != manifest.version
    {
        return Err(InstallError::new(
            "REGISTRY_ENTRY_MISMATCH",
            format!(
                "the registry lists '{}' {version}, but the download holds {}",
                entry.name, manifest.version
            ),
        ));
    }
    Ok(())
}

/// The file's SHA-256 is `expected`.
fn check_sha256(path: &Path, expected: &str) -> Result<()> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| io_error("cannot open", path, e))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| io_error("cannot read", path, e))?;
    let actual = format!("{:x}", hasher.finalize());
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(InstallError::new(
            "ARCHIVE_HASH_MISMATCH",
            format!(
                "the download is not the one the registry lists (SHA-256 {actual}, listed {expected}); it may have been replaced after it was listed"
            ),
        ))
    }
}

/// The registry index URLs, in order (earlier ones win a name): config.json
/// `extensions.registries`, else the official one followed by the single
/// `extensions.registry` of earlier versions.
pub fn registry_urls() -> Vec<String> {
    let config = spellsheet_core::UserConfig::load();
    let extensions = config.extra.get("extensions");
    urls_from(extensions)
}

fn urls_from(extensions: Option<&Value>) -> Vec<String> {
    let clean = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    if let Some(list) = extensions
        .and_then(|e| e.get("registries"))
        .and_then(Value::as_array)
    {
        let mut out: Vec<String> = Vec::new();
        for url in list.iter().filter_map(clean) {
            if !out.contains(&url) {
                out.push(url);
            }
        }
        return out;
    }
    let mut out = vec![OFFICIAL_REGISTRY.to_owned()];
    if let Some(url) = extensions.and_then(|e| e.get("registry")).and_then(clean)
        && url != OFFICIAL_REGISTRY
    {
        out.push(url);
    }
    out
}

/// Sets the registry index URLs, in order (an empty list: none at all).
pub fn set_registry_urls(urls: &[String]) -> std::result::Result<(), String> {
    let mut list: Vec<String> = Vec::new();
    for url in urls.iter().map(|u| u.trim()).filter(|u| !u.is_empty()) {
        if !url.to_ascii_lowercase().starts_with("https://") {
            return Err(format!("'{url}' is not an https URL"));
        }
        if !list.iter().any(|u| u == url) {
            list.push(url.to_owned());
        }
    }
    let mut config = spellsheet_core::UserConfig::load();
    let mut extensions = config
        .extra
        .get("extensions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    extensions.remove("registry");
    extensions.insert("registries".into(), json!(list));
    config
        .extra
        .insert("extensions".into(), Value::Object(extensions));
    config.save().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sources() {
        assert_eq!(
            Source::parse("https://github.com/acme/spellsheet-ocr").unwrap(),
            Source::Github {
                repo: "acme/spellsheet-ocr".into()
            }
        );
        assert_eq!(
            Source::parse("https://github.com/acme/ocr.git/").unwrap(),
            Source::Github {
                repo: "acme/ocr".into()
            }
        );
        assert_eq!(
            Source::parse("https://github.com/acme/ocr/releases/tag/v1.0.0").unwrap(),
            Source::Github {
                repo: "acme/ocr".into()
            }
        );
        assert_eq!(
            Source::parse("github:acme/ocr").unwrap(),
            Source::Github {
                repo: "acme/ocr".into()
            }
        );
        assert!(matches!(
            Source::parse("https://github.com/acme/ocr/releases/download/v1/ocr.zip").unwrap(),
            Source::Url { .. }
        ));
        assert!(matches!(
            Source::parse("https://example.com/ocr.zip").unwrap(),
            Source::Url { .. }
        ));
        assert_eq!(
            Source::parse("http://example.com/a.zip").unwrap_err().code,
            "SOURCE_NOT_HTTPS"
        );
        assert_eq!(
            Source::parse("https://github.com/acme").unwrap_err().code,
            "SOURCE_INVALID"
        );
        // A relative path is kept absolute, so an update finds it from anywhere.
        let Source::File { path } = Source::parse(r#""plugins/ocr.zip""#).unwrap() else {
            panic!("not a file source")
        };
        assert!(Path::new(&path).is_absolute(), "{path}");
        assert!(path.ends_with("ocr.zip"));
        for s in [
            "github:acme/ocr",
            "https://example.com/a.zip",
            "plugins/a.zip",
        ] {
            let source = Source::parse(s).unwrap();
            assert_eq!(Source::parse(&source.display()).unwrap(), source);
        }
    }

    #[test]
    fn picks_the_release_zip() {
        let release = json!({
            "zipball_url": "https://api.github.com/repos/acme/ocr/zipball/v1",
            "assets": [
                { "name": "checksums.txt", "browser_download_url": "https://x/checksums.txt" },
                { "name": "ocr-1.0.0.ZIP", "browser_download_url": "https://x/ocr.zip" },
            ],
        });
        assert_eq!(release_zip(&release).as_deref(), Some("https://x/ocr.zip"));
        let bare = json!({ "zipball_url": "https://api.github.com/repos/acme/ocr/zipball/v1", "assets": [] });
        assert_eq!(
            release_zip(&bare).as_deref(),
            Some("https://api.github.com/repos/acme/ocr/zipball/v1")
        );
        assert_eq!(release_zip(&json!({})), None);
    }

    #[test]
    fn reads_a_registry_index() {
        let index = json!({
            "extensions": [
                { "name": "azureocr", "label": "Azure AI-OCR", "source": "https://github.com/acme/azureocr", "version": "0.2.0" },
            ],
        });
        let list = parse_registry(&index).unwrap();
        assert_eq!(list[0].name, "azureocr");
        assert_eq!(list[0].version.as_deref(), Some("0.2.0"));
        assert_eq!(
            parse_registry(&json!({})).unwrap_err().code,
            "REGISTRY_INVALID"
        );
        assert_eq!(
            parse_registry(&json!({ "extensions": [{ "name": "x" }] }))
                .unwrap_err()
                .code,
            "REGISTRY_INVALID"
        );
    }

    #[test]
    fn reads_registry_sources() {
        let named = Source::Registry {
            name: "azureocr".into(),
            registry: String::new(),
        };
        assert_eq!(Source::parse("registry:azureocr").unwrap(), named);
        // A bare name is a registry name unless such a file or folder is here.
        assert_eq!(Source::parse("azureocr").unwrap(), named);
        assert_eq!(Source::parse(&named.display()).unwrap(), named);
        assert_eq!(
            Source::parse("registry:Azure OCR").unwrap_err().code,
            "SOURCE_INVALID"
        );
        // What is recorded for updates keeps the index and the hash.
        let pinned = Source::Url {
            url: "https://x/a.zip".into(),
            sha256: Some("ab".repeat(32)),
        };
        let text = serde_json::to_string(&pinned).unwrap();
        assert_eq!(serde_json::from_str::<Source>(&text).unwrap(), pinned);
        let old: Source =
            serde_json::from_str(r#"{"kind":"url","url":"https://x/a.zip"}"#).unwrap();
        assert_eq!(
            old,
            Source::Url {
                url: "https://x/a.zip".into(),
                sha256: None
            }
        );
    }

    fn entry(value: Value) -> RegistryEntry {
        parse_registry(&json!({ "extensions": [value] }))
            .unwrap()
            .remove(0)
    }

    #[test]
    fn refuses_registry_entries_that_cannot_be_installed_safely() {
        let sha = "0f".repeat(32);
        let bad = |value: Value| {
            parse_registry(&json!({ "extensions": [value] }))
                .unwrap_err()
                .problems
                .join("\n")
        };
        assert!(bad(json!({ "name": "a", "label": "A" })).contains("needs url"));
        assert!(
            bad(json!({ "name": "a", "label": "A", "url": "http://x/a.zip", "version": "1.0.0", "sha256": sha }))
                .contains("not https")
        );
        assert!(
            bad(json!({ "name": "a", "label": "A", "url": "https://x/a.zip", "version": "1.0.0", "sha256": "abc" }))
                .contains("64 hex")
        );
        assert!(
            bad(json!({ "name": "a", "label": "A", "source": "https://github.com/x/a", "sha256": sha }))
                .contains("needs the url")
        );
        assert!(
            bad(json!({ "name": "a", "label": "A", "url": "https://x/a.zip", "sha256": sha }))
                .contains("needs the version")
        );
        assert!(
            bad(json!({ "name": "a", "label": "A", "url": "https://x/a.zip", "version": "1.0.0" }))
                .contains("needs the sha256")
        );
        assert!(
            bad(json!({ "name": "A b", "label": "A", "source": "https://github.com/x/a" }))
                .contains("not an extension name")
        );
        let twice = parse_registry(&json!({ "extensions": [
            { "name": "a", "label": "A", "source": "https://github.com/x/a" },
            { "name": "a", "label": "A", "source": "https://github.com/y/a" },
        ] }))
        .unwrap_err();
        assert!(twice.problems[0].contains("listed twice"), "{twice}");
        // Whether it is official is not the index's to say.
        let e = entry(
            json!({ "name": "a", "label": "A", "source": "https://github.com/x/a", "official": true, "registry": "x" }),
        );
        assert!(!e.official && e.registry.is_empty());
    }

    #[test]
    fn a_registry_entry_pins_what_is_installed() {
        let sha = "AB".repeat(32);
        let pinned = entry(json!({
            "name": "azureocr", "label": "Azure AI-OCR", "version": "0.2.0",
            "url": "https://github.com/acme/azureocr/releases/download/v0.2.0/azureocr-0.2.0.zip",
            "sha256": sha, "source": "https://github.com/acme/azureocr",
        }));
        assert_eq!(
            entry_source(&pinned).unwrap(),
            Source::Url {
                url: pinned.url.clone().unwrap(),
                sha256: Some("ab".repeat(32)),
            }
        );
        // Without a pinned zip, the source (a repository's latest release).
        let loose = entry(
            json!({ "name": "azureocr", "label": "A", "source": "https://github.com/acme/azureocr" }),
        );
        assert_eq!(
            entry_source(&loose).unwrap(),
            Source::Github {
                repo: "acme/azureocr".into()
            }
        );
        let local =
            entry(json!({ "name": "azureocr", "label": "A", "source": "C:/plugins/azureocr.zip" }));
        assert_eq!(entry_source(&local).unwrap_err().code, "REGISTRY_INVALID");
        let mut withdrawn = pinned.clone();
        withdrawn.withdrawn = Some("sends files to an undeclared address".into());
        let err = entry_source(&withdrawn).unwrap_err();
        assert_eq!(err.code, "PLUGIN_WITHDRAWN");
        assert!(err.message.contains("undeclared"), "{err}");

        // The download must be the extension and version listed.
        let manifest = read_manifest(&hello()).unwrap();
        let mut listed = pinned.clone();
        listed.name = "hello".into();
        listed.version = Some(manifest.version.clone());
        assert!(check_entry(&manifest, &listed).is_ok());
        listed.version = Some("9.9.9".into());
        assert_eq!(
            check_entry(&manifest, &listed).unwrap_err().code,
            "REGISTRY_ENTRY_MISMATCH"
        );
        assert_eq!(
            check_entry(&manifest, &pinned).unwrap_err().code,
            "REGISTRY_ENTRY_MISMATCH"
        );
    }

    #[test]
    fn checks_the_sha256_of_a_download() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.zip");
        std::fs::write(&file, b"abc").unwrap();
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(check_sha256(&file, abc).is_ok());
        assert!(check_sha256(&file, &abc.to_ascii_uppercase()).is_ok());
        assert_eq!(
            check_sha256(&file, &"0".repeat(64)).unwrap_err().code,
            "ARCHIVE_HASH_MISMATCH"
        );
    }

    #[test]
    fn lists_the_registries_in_order() {
        assert_eq!(urls_from(None), vec![OFFICIAL_REGISTRY.to_owned()]);
        // The one URL earlier versions kept comes after the official one.
        assert_eq!(
            urls_from(Some(
                &json!({ "registry": "https://acme.example/index.json" })
            )),
            vec![
                OFFICIAL_REGISTRY.to_owned(),
                "https://acme.example/index.json".to_owned()
            ]
        );
        // A list set by the person is taken as it is, even without the official one.
        assert_eq!(
            urls_from(Some(
                &json!({ "registries": ["https://acme.example/index.json", " ", "https://acme.example/index.json"], "registry": "https://old" })
            )),
            vec!["https://acme.example/index.json".to_owned()]
        );
        assert!(urls_from(Some(&json!({ "registries": [] }))).is_empty());
    }

    fn hello() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/hello")
    }

    fn zip_of(dir: &Path, top: Option<&str>, to: &Path) {
        let file = std::fs::File::create(to).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let name = match top {
                Some(top) => format!("{top}/{name}"),
                None => name,
            };
            zip.start_file(name, options).unwrap();
            std::io::Write::write_all(&mut zip, &std::fs::read(entry.path()).unwrap()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[tokio::test]
    async fn installs_turns_off_updates_and_removes() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("plugins");
        let zip = home.path().join("hello.zip");
        zip_of(&hello(), Some("hello-0.1.0"), &zip);

        let source = Source::parse(&zip.display().to_string()).unwrap();
        let staged = stage(&root, source.clone(), &["browser"]).await.unwrap();
        assert_eq!(staged.manifest.name, "hello");
        let preview = staged.preview(&root);
        assert_eq!(preview["installedVersion"], Value::Null);
        assert_eq!(preview["steps"][0]["type"], "hello.greet");
        let dir = commit(&root, staged).unwrap();
        assert!(dir.join(MANIFEST_FILE).is_file());
        assert_eq!(source_of(&root, "hello").unwrap().source, source);
        assert!(!staging_root(&root).join("x").exists());

        let found = crate::discover(std::slice::from_ref(&root), &[]);
        assert_eq!(found.plugins.len(), 1, "{:?}", found.problems);

        set_enabled(&root, "hello", false).unwrap();
        assert!(
            crate::discover(std::slice::from_ref(&root), &[])
                .plugins
                .is_empty()
        );
        let listed = list(std::slice::from_ref(&root), Some(&root), &[]);
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled && listed[0].managed && listed[0].problems.is_empty());
        assert_eq!(listed[0].summary["label"], "サンプル");

        // An update (here from the folder itself) replaces it and stays off.
        let staged = stage(
            &root,
            Source::File {
                path: hello().display().to_string(),
            },
            &[],
        )
        .await
        .unwrap();
        assert_eq!(staged.preview(&root)["installedVersion"], "0.1.0");
        commit(&root, staged).unwrap();
        assert!(root.join("hello").join(DISABLED_FILE).exists());
        assert!(matches!(
            source_of(&root, "hello").unwrap().source,
            Source::File { .. }
        ));
        set_enabled(&root, "hello", true).unwrap();
        assert_eq!(
            crate::discover(std::slice::from_ref(&root), &[])
                .plugins
                .len(),
            1
        );

        // The source now holding another extension is not taken as an update.
        let other = home.path().join("other");
        copy_dir(&hello(), &other).unwrap();
        let text = std::fs::read_to_string(other.join(MANIFEST_FILE)).unwrap();
        std::fs::write(
            other.join(MANIFEST_FILE),
            text.replacen("\"hello\"", "\"hello2\"", 1)
                .replace("hello.", "hello2."),
        )
        .unwrap();
        let record = SourceRecord {
            source: Source::File {
                path: other.display().to_string(),
            },
            installed_at: now(),
        };
        std::fs::write(
            root.join("hello").join(SOURCE_FILE),
            serde_json::to_string(&record).unwrap(),
        )
        .unwrap();
        assert_eq!(
            stage_update(&root, "hello", &[]).await.unwrap_err().code,
            "PLUGIN_SOURCE_CHANGED"
        );
        assert_eq!(
            stage_update(&root, "nothing", &[]).await.unwrap_err().code,
            "PLUGIN_SOURCE_UNKNOWN"
        );

        remove(&root, "hello").unwrap();
        assert!(!root.join("hello").exists());
        assert_eq!(
            remove(&root, "hello").unwrap_err().code,
            "PLUGIN_NOT_INSTALLED"
        );
        assert_eq!(
            remove(&root, "../x").unwrap_err().code,
            "PLUGIN_NOT_INSTALLED"
        );
    }

    #[tokio::test]
    async fn refuses_what_is_not_a_good_plugin() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("plugins");
        // A built-in name.
        let err = stage(
            &root,
            Source::File {
                path: hello().display().to_string(),
            },
            &["hello"],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PLUGIN_NAME_TAKEN");
        // No manifest.
        let empty = home.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(empty.join("readme.txt"), "x").unwrap();
        let err = stage(
            &root,
            Source::File {
                path: empty.display().to_string(),
            },
            &[],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PLUGIN_MANIFEST_MISSING");
        // A broken manifest.
        std::fs::write(empty.join(MANIFEST_FILE), r#"{"manifestVersion":1}"#).unwrap();
        let err = stage(
            &root,
            Source::File {
                path: empty.display().to_string(),
            },
            &[],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PLUGIN_INVALID");
        assert!(!err.problems.is_empty());
        // Not a zip, and a missing file.
        let err = stage(
            &root,
            Source::File {
                path: empty.join("readme.txt").display().to_string(),
            },
            &[],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "ARCHIVE_INVALID");
        let err = stage(
            &root,
            Source::File {
                path: "nowhere.zip".into(),
            },
            &[],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "SOURCE_NOT_FOUND");
        // A zip entry that climbs out of the folder.
        let evil = home.path().join("evil.zip");
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&evil).unwrap());
            zip.start_file("../outside.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut zip, b"x").unwrap();
            zip.finish().unwrap();
        }
        let err = stage(
            &root,
            Source::File {
                path: evil.display().to_string(),
            },
            &[],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "ARCHIVE_INVALID");
        assert!(!home.path().join("outside.txt").exists());
        // Nothing is left half staged.
        let left = std::fs::read_dir(staging_root(&root))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(left, 0);
    }
}
