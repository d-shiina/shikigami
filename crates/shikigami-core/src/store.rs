//! File-based workspace store.
//!
//! Layout of a workspace directory:
//!
//! ```text
//! <root>/                                 shared part (may live on a file server)
//!   workspace.json                         optional manifest (`"shared": true`)
//!   scenarios/<scenario-id>.json           canonical scenario documents
//!   versions/<scenario-id>/<number>.json   named versions (snapshots)
//!   trash/<scenario-id>.<unix-ts>.json     deleted scenarios (recoverable)
//!   .lock                                  advisory lock for read-modify-write
//! <local root>/                            per-PC part
//!   history/<scenario-id>/journal.jsonl    append-only change journal (audit)
//!   history/<scenario-id>/undo.json        undo/redo stacks
//!   runs/<run-id>/…                        run records (see shikigami-runtime)
//! ```
//!
//! For a private workspace the local root is the workspace root itself. For a
//! shared workspace (several people on OneDrive or a file server) it is a
//! per-PC directory under `%LOCALAPPDATA%\Shikigami\local\`, so one
//! person's undo stacks and run logs never sync to (or conflict with) others.
//!
//! Studio, the MCP server and the CLI are separate processes that may share a
//! workspace. Every mutation takes an exclusive OS file lock, re-reads the
//! document, checks the revision, and replaces the file atomically
//! (write temp file + rename), so readers never observe partial writes.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::error::{CoreError, CoreResult};
use crate::ids::ScenarioId;
use crate::migrate;
use crate::model::Scenario;
use crate::ops::EditOp;
use crate::version::ScenarioVersion;

/// Who made a change. Recorded in history and the audit journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub kind: ActorKind,
    /// Client name, e.g. the MCP client's reported name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Actor {
    pub fn new(kind: ActorKind) -> Self {
        Self { kind, name: None }
    }

    pub fn named(kind: ActorKind, name: impl Into<String>) -> Self {
        Self {
            kind,
            name: Some(name.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ActorKind {
    Studio,
    Mcp,
    Cli,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Create,
    Edit,
    Undo,
    Redo,
    Delete,
}

/// One committed change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub kind: ChangeKind,
    /// Revision of the scenario after this change.
    pub revision: u64,
    pub actor: Actor,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub at: OffsetDateTime,
    pub label: String,
    /// Ops that were applied.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ops: Vec<EditOp>,
    /// Ops that revert this change.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inverse: Vec<EditOp>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndoState {
    /// Scenario revision these stacks belong to. A mismatch means the file
    /// was changed outside Shikigami and the stacks must be discarded.
    #[serde(default)]
    pub head_revision: u64,
    pub undo: Vec<HistoryEntry>,
    pub redo: Vec<HistoryEntry>,
}

/// Maximum undo depth kept per scenario.
pub(crate) const UNDO_LIMIT: usize = 200;

#[derive(Debug, Clone)]
pub struct FileStore {
    root: PathBuf,
    local: PathBuf,
    shared: bool,
}

/// Optional `<root>/workspace.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceManifest {
    /// Several people use this folder (OneDrive, a file server). Per-PC data
    /// (undo history, run records) is then kept outside the folder.
    #[serde(default)]
    pub shared: bool,
}

/// Where a workspace keeps its data, for display and diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    /// Undo history, run records and audit logs of this PC.
    pub local_root: String,
    pub shared: bool,
}

/// User-level settings shared by Studio, the CLI and the MCP server
/// (`%APPDATA%\Shikigami\config.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConfig {
    /// Default workspace folder when neither `--workspace` nor
    /// `SHIKIGAMI_HOME` is given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<PathBuf>,
    /// Settings written by newer builds or other features are kept as-is.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl UserConfig {
    pub fn path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Shikigami")
            .join("config.json")
    }

    pub fn load() -> Self {
        match fs::read(Self::path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "ignoring unreadable config.json");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> CoreResult<()> {
        let path = Self::path();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut json = serde_json::to_vec_pretty(self)?;
        json.push(b'\n');
        write_atomic(&path, &json)
    }
}

/// Exclusive workspace lock; released on drop.
pub(crate) struct WorkspaceLock {
    file: File,
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        // Errors on unlock are not actionable; the OS releases the lock when
        // the handle closes anyway.
        let _ = self.file.unlock();
    }
}

impl FileStore {
    /// Opens (and creates if needed) a workspace directory.
    pub fn open(root: impl Into<PathBuf>) -> CoreResult<Self> {
        let root = root.into();
        let manifest = read_manifest(&root)?;
        let local = if manifest.shared {
            local_root_for(&root)
        } else {
            root.clone()
        };
        Self::open_with_local(root, local, manifest.shared)
    }

    /// Opens a workspace with an explicit per-PC directory (tests).
    pub fn open_with_local(
        root: impl Into<PathBuf>,
        local: impl Into<PathBuf>,
        shared: bool,
    ) -> CoreResult<Self> {
        let root = root.into();
        let local = local.into();
        for dir in ["scenarios", "versions", "trash"] {
            fs::create_dir_all(root.join(dir))?;
        }
        fs::create_dir_all(local.join("history"))?;
        Ok(Self {
            root,
            local,
            shared,
        })
    }

    /// Writes (or updates) `<root>/workspace.json`. Takes effect the next time
    /// the workspace is opened.
    pub fn init(root: &Path, manifest: &WorkspaceManifest) -> CoreResult<()> {
        fs::create_dir_all(root)?;
        let mut json = serde_json::to_vec_pretty(manifest)?;
        json.push(b'\n');
        write_atomic(&root.join(MANIFEST_FILE), &json)
    }

    /// Default workspace: `$SHIKIGAMI_HOME`, else `workspace` in the user
    /// config, else the platform data dir (e.g. `%APPDATA%\Shikigami\workspace`).
    pub fn default_root() -> PathBuf {
        if let Some(home) = std::env::var_os("SHIKIGAMI_HOME") {
            return PathBuf::from(home);
        }
        if let Some(workspace) = UserConfig::load().workspace {
            return workspace;
        }
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Shikigami")
            .join("workspace")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Per-PC directory: undo history, run records, audit logs.
    pub fn local_root(&self) -> &Path {
        &self.local
    }

    pub fn is_shared(&self) -> bool {
        self.shared
    }

    pub fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            root: self.root.display().to_string(),
            local_root: self.local.display().to_string(),
            shared: self.shared,
        }
    }

    pub fn scenarios_dir(&self) -> PathBuf {
        self.root.join("scenarios")
    }

    pub(crate) fn lock(&self) -> CoreResult<WorkspaceLock> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.root.join(".lock"))?;
        file.lock()?;
        Ok(WorkspaceLock { file })
    }

    fn checked(&self, id: &ScenarioId) -> CoreResult<()> {
        if id.is_well_formed() {
            Ok(())
        } else {
            Err(CoreError::InvalidScenarioId(id.to_string()))
        }
    }

    pub fn scenario_path(&self, id: &ScenarioId) -> PathBuf {
        self.scenarios_dir().join(format!("{id}.json"))
    }

    fn history_dir(&self, id: &ScenarioId) -> PathBuf {
        self.local.join("history").join(id.as_str())
    }

    pub fn exists(&self, id: &ScenarioId) -> bool {
        id.is_well_formed() && self.scenario_path(id).is_file()
    }

    pub fn load(&self, id: &ScenarioId) -> CoreResult<Scenario> {
        self.checked(id)?;
        let path = self.scenario_path(id);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(CoreError::ScenarioNotFound(id.clone()));
            }
            Err(e) => return Err(e.into()),
        };
        let scenario = migrate::parse_scenario(&text)?;
        if &scenario.id != id {
            return Err(CoreError::InvalidEdit(format!(
                "file {} contains scenario id {}",
                path.display(),
                scenario.id
            )));
        }
        Ok(scenario)
    }

    /// Loads every scenario; unreadable files are skipped and logged.
    pub fn load_all(&self) -> CoreResult<Vec<Scenario>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(self.scenarios_dir())? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            match self.load(&ScenarioId::new(stem)) {
                Ok(s) => out.push(s),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "skipping unreadable scenario")
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    pub(crate) fn save(&self, scenario: &Scenario) -> CoreResult<()> {
        self.checked(&scenario.id)?;
        let mut json = serde_json::to_vec_pretty(scenario)?;
        json.push(b'\n');
        write_atomic(&self.scenario_path(&scenario.id), &json)
    }

    pub(crate) fn trash(&self, id: &ScenarioId) -> CoreResult<PathBuf> {
        self.checked(id)?;
        let from = self.scenario_path(id);
        if !from.is_file() {
            return Err(CoreError::ScenarioNotFound(id.clone()));
        }
        let ts = OffsetDateTime::now_utc().unix_timestamp();
        let to = self.root.join("trash").join(format!("{id}.{ts}.json"));
        fs::rename(&from, &to)?;
        Ok(to)
    }

    pub(crate) fn append_journal(&self, id: &ScenarioId, entry: &HistoryEntry) -> CoreResult<()> {
        let dir = self.history_dir(id);
        fs::create_dir_all(&dir)?;
        let mut line = serde_json::to_vec(entry)?;
        line.push(b'\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("journal.jsonl"))?;
        file.write_all(&line)?;
        Ok(())
    }

    /// Reads the most recent `limit` journal entries (oldest first).
    pub fn read_journal(&self, id: &ScenarioId, limit: usize) -> CoreResult<Vec<HistoryEntry>> {
        self.checked(id)?;
        let path = self.history_dir(id).join("journal.jsonl");
        let file = match File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut entries = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<HistoryEntry>(&line) {
                Ok(entry) => entries.push(entry),
                Err(e) => tracing::warn!(error = %e, "skipping corrupt journal line"),
            }
        }
        let skip = entries.len().saturating_sub(limit);
        Ok(entries.split_off(skip))
    }

    fn versions_dir(&self, id: &ScenarioId) -> PathBuf {
        self.root.join("versions").join(id.as_str())
    }

    /// Every stored version of a scenario, oldest first. Unreadable files are
    /// skipped and logged.
    pub fn load_versions(&self, id: &ScenarioId) -> CoreResult<Vec<ScenarioVersion>> {
        self.checked(id)?;
        let dir = self.versions_dir(id);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut out = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let parsed = fs::read(&path)
                .map_err(CoreError::from)
                .and_then(|bytes| Ok(serde_json::from_slice::<ScenarioVersion>(&bytes)?));
            match parsed {
                Ok(v) => out.push(v),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "skipping unreadable version")
                }
            }
        }
        out.sort_by_key(|v| v.number);
        Ok(out)
    }

    pub fn load_version(&self, id: &ScenarioId, number: u32) -> CoreResult<ScenarioVersion> {
        self.checked(id)?;
        let path = self.versions_dir(id).join(format!("{number}.json"));
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == ErrorKind::NotFound => Err(CoreError::VersionNotFound {
                scenario_id: id.clone(),
                number,
            }),
            Err(e) => Err(e.into()),
        }
    }

    /// Writes a new version file. Never overwrites: versions are immutable.
    /// The file is written under a temporary name and published complete, so
    /// a crash never leaves a truncated snapshot at a version's number.
    pub(crate) fn save_version(&self, version: &ScenarioVersion) -> CoreResult<()> {
        let id = &version.scenario.id;
        self.checked(id)?;
        let dir = self.versions_dir(id);
        fs::create_dir_all(&dir)?;
        let mut json = serde_json::to_vec_pretty(version)?;
        json.push(b'\n');
        let mut tmp = tempfile::NamedTempFile::new_in(&dir)?;
        tmp.write_all(&json)?;
        tmp.as_file().sync_all()?;
        tmp.persist_noclobber(dir.join(format!("{}.json", version.number)))
            .map_err(|e| CoreError::Io(e.error))?;
        Ok(())
    }

    pub(crate) fn load_undo(&self, id: &ScenarioId) -> CoreResult<UndoState> {
        let path = self.history_dir(id).join("undo.json");
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "resetting corrupt undo state");
                UndoState::default()
            })),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(UndoState::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub(crate) fn save_undo(&self, id: &ScenarioId, state: &UndoState) -> CoreResult<()> {
        let dir = self.history_dir(id);
        fs::create_dir_all(&dir)?;
        write_atomic(&dir.join("undo.json"), &serde_json::to_vec(state)?)
    }

    pub(crate) fn remove_undo(&self, id: &ScenarioId) -> CoreResult<()> {
        match fs::remove_file(self.history_dir(id).join("undo.json")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

const MANIFEST_FILE: &str = "workspace.json";

fn read_manifest(root: &Path) -> CoreResult<WorkspaceManifest> {
    match fs::read(root.join(MANIFEST_FILE)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(WorkspaceManifest::default()),
        Err(e) => Err(e.into()),
    }
}

/// `%LOCALAPPDATA%\Shikigami\local\<hash of the workspace path>`.
fn local_root_for(root: &Path) -> PathBuf {
    let absolute = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    // Windows paths are case-insensitive; one folder must map to one directory.
    let key = absolute.to_string_lossy().to_lowercase();
    let key = key.trim_end_matches(['\\', '/']);
    // FNV-1a: stable across builds (unlike `DefaultHasher`).
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    let name = absolute
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Shikigami")
        .join("local")
        .join(format!("{}-{hash:016x}", sanitize_file_name(&name)))
}

fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
        .take(32)
        .collect()
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> CoreResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| CoreError::InvalidEdit(format!("invalid path {}", path.display())))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    // On Windows, replacing the target fails with "access denied" while another
    // process (antivirus, indexer, a reader) briefly holds it open, so retry.
    let mut attempt = 0;
    loop {
        match tmp.persist(path) {
            Ok(_) => return Ok(()),
            Err(e) if e.error.kind() == ErrorKind::PermissionDenied && attempt < 5 => {
                attempt += 1;
                tmp = e.file;
                thread::sleep(Duration::from_millis(10 << attempt));
            }
            Err(e) => return Err(CoreError::Io(e.error)),
        }
    }
}

/// Reads a JSON value from disk (used by import paths).
pub fn read_json(path: &Path) -> CoreResult<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
