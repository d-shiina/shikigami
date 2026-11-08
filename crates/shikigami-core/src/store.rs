//! File-based workspace store.
//!
//! Layout of a workspace directory:
//!
//! ```text
//! <root>/                                 shared part (may live on a file server)
//!   workspace.json                         optional manifest (`"shared": true`)
//!   flows/<flow-id>/               one folder per flow (its project)
//!     flow.json                        the canonical flow document
//!     input/ config/ templates/ output/ work/   files the flow works with
//!   versions/<flow-id>/<number>.json   named versions (snapshots)
//!   trash/<flow-id>.<unix-ts>/         deleted flows with their files
//!   .lock                                  advisory lock for read-modify-write
//! <local root>/                            per-PC part
//!   history/<flow-id>/journal.jsonl    append-only change journal (audit)
//!   history/<flow-id>/undo.json        undo/redo stacks
//!   history/<flow-id>/evidence.jsonl   review evidence (test runs, observations, reviews)
//!   observations/<observation-id>/…        screens an AI looked at (tree, screenshot)
//!   runs/<run-id>/…                        run records (see shikigami-runtime)
//! ```
//!
//! For a private workspace the local root is the workspace root itself. For a
//! shared workspace (several people on OneDrive or a file server) it is a
//! per-PC directory under `%LOCALAPPDATA%\SpellSheet\local\`, so one
//! person's undo stacks and run logs never sync to (or conflict with) others.
//!
//! Studio, the MCP server and the CLI are separate processes that may share a
//! workspace. Every mutation takes an exclusive OS file lock, re-reads the
//! document, checks the revision, and replaces the file atomically
//! (write temp file + rename), so readers never observe partial writes.
//!
//! Workspaces written before flow folders kept each document as
//! `flows/<flow-id>.json`. Opening a workspace moves those into
//! folders; reading still accepts them, for files an older build writes.

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
use crate::ids::{FlowId, ObservationId, StepId};
use crate::migrate;
use crate::model::Flow;
use crate::ops::EditOp;
use crate::review::{Evidence, Observation};
use crate::version::{FlowVersion, PublishRecord};

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
    /// An AI in a chat window without MCP (Microsoft Copilot, ...): a
    /// person pasted its answer into Studio. Reviewed like an MCP edit.
    Chat,
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
    /// Revision of the flow after this change.
    pub revision: u64,
    pub actor: Actor,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub at: OffsetDateTime,
    pub label: String,
    /// The author's own explanation of the change (an AI's `summary`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// What the author asked a person to confirm before approving (an AI's `checks`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    /// Steps the change added, changed, moved or removed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub step_ids: Vec<StepId>,
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
    /// Flow revision these stacks belong to. A mismatch means the file
    /// was changed outside Shikigami and the stacks must be discarded.
    #[serde(default)]
    pub head_revision: u64,
    pub undo: Vec<HistoryEntry>,
    pub redo: Vec<HistoryEntry>,
}

/// Maximum undo depth kept per flow.
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
/// (`%APPDATA%\SpellSheet\config.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConfig {
    /// Default workspace folder when neither `--workspace` nor
    /// `SPELLSHEET_HOME` is given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<PathBuf>,
    /// Settings written by newer builds or other features are kept as-is.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl UserConfig {
    pub fn path() -> PathBuf {
        crate::paths::config_dir().join("config.json")
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
        // A path saved before the folders took the new name (a scheduled
        // task's or an AI client's `--workspace`) still finds its flows.
        let root = crate::paths::upgrade_legacy(&root.into());
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
        migrate_scenario_layout(&root);
        for dir in ["flows", "versions", "trash"] {
            fs::create_dir_all(root.join(dir))?;
        }
        fs::create_dir_all(local.join("history"))?;
        let store = Self {
            root,
            local,
            shared,
        };
        store.migrate_flat_files();
        Ok(store)
    }

    /// Moves `flows/<id>.json` (the layout before flow folders) to
    /// `flows/<id>/flow.json`. A file that cannot be moved stays
    /// where it is and is still read from there.
    fn migrate_flat_files(&self) {
        let Ok(entries) = fs::read_dir(self.flows_dir()) else {
            return;
        };
        let flat: Vec<FlowId> = entries
            .filter_map(|e| flat_flow_id(&e.ok()?.path()))
            .collect();
        if flat.is_empty() {
            return;
        }
        let Ok(_lock) = self.lock() else {
            return;
        };
        for id in flat {
            let from = self.flat_path(&id);
            let to = self.flow_path(&id);
            let moved = if to.is_file() {
                // Both exist: an older build wrote the flat file after the
                // move. Keep the newer one.
                let newer = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
                if newer(&from) > newer(&to) {
                    fs::rename(&from, &to)
                } else {
                    fs::remove_file(&from)
                }
            } else {
                fs::create_dir_all(self.project_dir(&id)).and_then(|()| fs::rename(&from, &to))
            };
            match moved {
                Ok(()) => self.ensure_project_folders(&id),
                Err(e) => {
                    tracing::warn!(path = %from.display(), error = %e, "could not move flow into its folder");
                }
            }
        }
    }

    /// Writes (or updates) `<root>/workspace.json`. Takes effect the next time
    /// the workspace is opened.
    pub fn init(root: &Path, manifest: &WorkspaceManifest) -> CoreResult<()> {
        fs::create_dir_all(root)?;
        let mut json = serde_json::to_vec_pretty(manifest)?;
        json.push(b'\n');
        write_atomic(&root.join(MANIFEST_FILE), &json)
    }

    /// Default workspace: `$SPELLSHEET_HOME` (or the old `$SHIKIGAMI_HOME`),
    /// else `workspace` in the user config, else the platform data dir
    /// (e.g. `%APPDATA%\SpellSheet\workspace`).
    pub fn default_root() -> PathBuf {
        if let Some(home) = crate::paths::env_var("HOME") {
            return crate::paths::upgrade_legacy(Path::new(&home));
        }
        if let Some(workspace) = UserConfig::load().workspace {
            return crate::paths::upgrade_legacy(&workspace);
        }
        crate::paths::data_dir().join("workspace")
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

    pub fn flows_dir(&self) -> PathBuf {
        self.root.join("flows")
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

    fn checked(&self, id: &FlowId) -> CoreResult<()> {
        if id.is_well_formed() {
            Ok(())
        } else {
            Err(CoreError::InvalidFlowId(id.to_string()))
        }
    }

    /// `flows/<id>/flow.json`.
    pub fn flow_path(&self, id: &FlowId) -> PathBuf {
        self.project_dir(id).join(crate::project::FLOW_FILE)
    }

    /// The flow's own folder: its document and the files it works with.
    /// Relative paths in its steps are resolved from here.
    pub fn project_dir(&self, id: &FlowId) -> PathBuf {
        self.flows_dir().join(id.as_str())
    }

    /// `flows/<id>.json`, the layout before flow folders.
    fn flat_path(&self, id: &FlowId) -> PathBuf {
        self.flows_dir().join(format!("{id}.json"))
    }

    /// Where the document is now: its folder, or the old flat file.
    fn existing_path(&self, id: &FlowId) -> Option<PathBuf> {
        [self.flow_path(id), self.flat_path(id)]
            .into_iter()
            .find(|p| p.is_file())
    }

    /// Creates the standard folders (`input/`, `config/`, …) that are missing.
    pub(crate) fn ensure_project_folders(&self, id: &FlowId) {
        let dir = self.project_dir(id);
        for folder in crate::project::FOLDERS {
            if let Err(e) = fs::create_dir_all(dir.join(folder.name)) {
                tracing::warn!(dir = %dir.display(), error = %e, "could not create project folder");
            }
        }
    }

    fn history_dir(&self, id: &FlowId) -> PathBuf {
        self.local.join("history").join(id.as_str())
    }

    pub fn exists(&self, id: &FlowId) -> bool {
        id.is_well_formed() && self.existing_path(id).is_some()
    }

    pub fn load(&self, id: &FlowId) -> CoreResult<Flow> {
        self.checked(id)?;
        let path = self.existing_path(id).unwrap_or_else(|| self.flow_path(id));
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(CoreError::FlowNotFound(id.clone()));
            }
            Err(e) => return Err(e.into()),
        };
        let flow = migrate::parse_flow(&text)?;
        if &flow.id != id {
            return Err(CoreError::InvalidEdit(format!(
                "file {} contains flow id {}",
                path.display(),
                flow.id
            )));
        }
        Ok(flow)
    }

    /// Loads every flow; unreadable files are skipped and logged.
    pub fn load_all(&self) -> CoreResult<Vec<Flow>> {
        let mut ids = std::collections::BTreeSet::new();
        for entry in fs::read_dir(self.flows_dir())? {
            let path = entry?.path();
            let id = if path.is_dir() {
                if !path.join(crate::project::FLOW_FILE).is_file() {
                    continue;
                }
                path.file_name().and_then(|s| s.to_str()).map(FlowId::new)
            } else {
                flat_flow_id(&path)
            };
            ids.extend(id);
        }
        let mut out = Vec::new();
        for id in ids {
            let path = self.project_dir(&id);
            match self.load(&id) {
                Ok(s) => out.push(s),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "skipping unreadable flow")
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    pub(crate) fn save(&self, flow: &Flow) -> CoreResult<()> {
        let id = &flow.id;
        self.checked(id)?;
        let mut json = serde_json::to_vec_pretty(flow)?;
        json.push(b'\n');
        fs::create_dir_all(self.project_dir(id))?;
        write_atomic(&self.flow_path(id), &json)?;
        self.ensure_project_folders(id);
        // Written by an older build after the folder existed: the folder
        // copy is now the current one.
        match fs::remove_file(self.flat_path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Moves the flow's folder (document and files) to the trash.
    pub(crate) fn trash(&self, id: &FlowId) -> CoreResult<PathBuf> {
        self.checked(id)?;
        if !self.exists(id) {
            return Err(CoreError::FlowNotFound(id.clone()));
        }
        let ts = OffsetDateTime::now_utc().unix_timestamp();
        let to = self.root.join("trash").join(format!("{id}.{ts}"));
        let dir = self.project_dir(id);
        if dir.is_dir() {
            fs::rename(&dir, &to)?;
        } else {
            fs::create_dir_all(&to)?;
        }
        let flat = self.flat_path(id);
        if flat.is_file() {
            fs::rename(&flat, to.join(crate::project::FLOW_FILE))?;
        }
        Ok(to)
    }

    pub(crate) fn append_journal(&self, id: &FlowId, entry: &HistoryEntry) -> CoreResult<()> {
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
    pub fn read_journal(&self, id: &FlowId, limit: usize) -> CoreResult<Vec<HistoryEntry>> {
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

    pub(crate) fn append_evidence(&self, id: &FlowId, evidence: &Evidence) -> CoreResult<()> {
        self.checked(id)?;
        let dir = self.history_dir(id);
        fs::create_dir_all(&dir)?;
        let mut line = serde_json::to_vec(evidence)?;
        line.push(b'\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("evidence.jsonl"))?
            .write_all(&line)?;
        Ok(())
    }

    /// Every evidence record of a flow, oldest first.
    pub fn read_evidence(&self, id: &FlowId) -> CoreResult<Vec<Evidence>> {
        self.checked(id)?;
        let file = match File::open(self.history_dir(id).join("evidence.jsonl")) {
            Ok(f) => f,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut out = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Evidence>(&line) {
                Ok(e) => out.push(e),
                Err(e) => tracing::warn!(error = %e, "skipping corrupt evidence line"),
            }
        }
        Ok(out)
    }

    fn observations_dir(&self) -> PathBuf {
        self.local.join("observations")
    }

    /// Folder of one observation's files.
    pub fn observation_dir(&self, id: &ObservationId) -> CoreResult<PathBuf> {
        if !id.is_well_formed() {
            return Err(CoreError::ObservationNotFound(id.clone()));
        }
        Ok(self.observations_dir().join(id.as_str()))
    }

    /// Writes an observation and its files (`(file name, bytes)`).
    pub(crate) fn save_observation(
        &self,
        observation: &Observation,
        files: &[(String, Vec<u8>)],
    ) -> CoreResult<()> {
        let dir = self.observation_dir(&observation.id)?;
        fs::create_dir_all(&dir)?;
        for (name, bytes) in files {
            write_atomic(&dir.join(name), bytes)?;
        }
        self.write_observation(observation)
    }

    pub(crate) fn write_observation(&self, observation: &Observation) -> CoreResult<()> {
        let dir = self.observation_dir(&observation.id)?;
        let mut json = serde_json::to_vec_pretty(observation)?;
        json.push(b'\n');
        write_atomic(&dir.join("observation.json"), &json)
    }

    pub fn load_observation(&self, id: &ObservationId) -> CoreResult<Observation> {
        let path = self.observation_dir(id)?.join("observation.json");
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == ErrorKind::NotFound => {
                Err(CoreError::ObservationNotFound(id.clone()))
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Deletes observations no edit referred to that are older than
    /// `max_age`. Returns how many were deleted.
    pub(crate) fn prune_observations(&self, max_age: time::Duration) -> CoreResult<usize> {
        let entries = match fs::read_dir(self.observations_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        let cutoff = OffsetDateTime::now_utc() - max_age;
        let mut removed = 0;
        for entry in entries {
            let path = entry?.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let id = ObservationId::new(name);
            let stale = match self.load_observation(&id) {
                Ok(o) => o.linked.is_empty() && o.at < cutoff,
                // A folder without a readable observation.json: an
                // interrupted write. Judge it by its age.
                Err(_) => fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .is_ok_and(|t| OffsetDateTime::from(t) < cutoff),
            };
            if stale && fs::remove_dir_all(&path).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    fn versions_dir(&self, id: &FlowId) -> PathBuf {
        self.root.join("versions").join(id.as_str())
    }

    /// Every stored version of a flow, oldest first. Unreadable files are
    /// skipped and logged.
    pub fn load_versions(&self, id: &FlowId) -> CoreResult<Vec<FlowVersion>> {
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
                .and_then(|bytes| Ok(serde_json::from_slice::<FlowVersion>(&bytes)?));
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

    pub fn load_version(&self, id: &FlowId, number: u32) -> CoreResult<FlowVersion> {
        self.checked(id)?;
        let path = self.versions_dir(id).join(format!("{number}.json"));
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == ErrorKind::NotFound => Err(CoreError::VersionNotFound {
                flow_id: id.clone(),
                number,
            }),
            Err(e) => Err(e.into()),
        }
    }

    /// Writes a new version file. Never overwrites: versions are immutable.
    /// The file is written under a temporary name and published complete, so
    /// a crash never leaves a truncated snapshot at a version's number.
    pub(crate) fn save_version(&self, version: &FlowVersion) -> CoreResult<()> {
        let id = &version.flow.id;
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

    /// Every publish record of a flow, oldest first (unreadable lines
    /// are skipped and logged).
    pub fn read_publish_log(&self, id: &FlowId) -> CoreResult<Vec<PublishRecord>> {
        self.checked(id)?;
        let file = match File::open(self.versions_dir(id).join(PUBLISH_LOG)) {
            Ok(f) => f,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut out = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str(&line) {
                Ok(record) => out.push(record),
                Err(e) => tracing::warn!(error = %e, "skipping unreadable publish record"),
            }
        }
        Ok(out)
    }

    pub(crate) fn append_publish(&self, id: &FlowId, record: &PublishRecord) -> CoreResult<()> {
        self.checked(id)?;
        let dir = self.versions_dir(id);
        fs::create_dir_all(&dir)?;
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(PUBLISH_LOG))?;
        file.write_all(&line)?;
        file.sync_all()?;
        Ok(())
    }

    pub(crate) fn load_undo(&self, id: &FlowId) -> CoreResult<UndoState> {
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

    pub(crate) fn save_undo(&self, id: &FlowId, state: &UndoState) -> CoreResult<()> {
        let dir = self.history_dir(id);
        fs::create_dir_all(&dir)?;
        write_atomic(&dir.join("undo.json"), &serde_json::to_vec(state)?)
    }

    pub(crate) fn remove_undo(&self, id: &FlowId) -> CoreResult<()> {
        match fs::remove_file(self.history_dir(id).join("undo.json")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

const MANIFEST_FILE: &str = "workspace.json";
/// Next to the version files (`.jsonl`, so version listing skips it).
const PUBLISH_LOG: &str = "publish.jsonl";

/// The ID of `flows/<id>.json` (the layout before flow folders).
fn flat_flow_id(path: &Path) -> Option<FlowId> {
    if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
        return None;
    }
    let id = FlowId::new(path.file_stem()?.to_str()?);
    id.is_well_formed().then_some(id)
}

fn read_manifest(root: &Path) -> CoreResult<WorkspaceManifest> {
    match fs::read(root.join(MANIFEST_FILE)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(WorkspaceManifest::default()),
        Err(e) => Err(e.into()),
    }
}

/// `%LOCALAPPDATA%\SpellSheet\local\<hash of the workspace path>`.
fn local_root_for(root: &Path) -> PathBuf {
    let local = local_root_named(root);
    // A workspace that moved with the folders' new name keeps its undo
    // history, run records and audit logs from before.
    if !local.exists()
        && let Some(old_root) = crate::paths::legacy_of(root)
    {
        let old = local_root_named(&old_root);
        if old.is_dir()
            && let Err(e) = fs::rename(&old, &local)
        {
            tracing::warn!(error = %e, folder = %old.display(), "cannot move the per-PC folder of the workspace");
            return old;
        }
    }
    local
}

fn local_root_named(root: &Path) -> PathBuf {
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
    crate::paths::local_dir()
        .join("local")
        .join(format!("{}-{hash:016x}", sanitize_file_name(&name)))
}

fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
        .take(32)
        .collect()
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> CoreResult<()> {
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
/// Flows were called scenarios up to 0.1.2: `scenarios/<id>/scenario.json`
/// becomes `flows/<id>/flow.json` (deleted ones in `trash/` too). Runs
/// before the folders are created, so an untouched old workspace is moved
/// as a whole. Whatever cannot be moved is left alone and logged.
fn migrate_scenario_layout(root: &Path) {
    let old = root.join("scenarios");
    let new = root.join("flows");
    if old.is_dir() {
        let new_is_empty = fs::read_dir(&new).map_or(true, |mut d| d.next().is_none());
        if new_is_empty {
            let moved = fs::remove_dir(&new)
                .or_else(|e| if new.exists() { Err(e) } else { Ok(()) })
                .and_then(|()| fs::rename(&old, &new));
            if let Err(e) = moved {
                tracing::warn!(path = %old.display(), error = %e, "could not rename scenarios/ to flows/");
            }
        } else {
            tracing::warn!(path = %old.display(), "both scenarios/ and flows/ exist; scenarios/ is not read");
        }
    }
    for parent in [new, root.join("trash")] {
        let Ok(entries) = fs::read_dir(&parent) else {
            continue;
        };
        for entry in entries.flatten() {
            let from = entry.path().join("scenario.json");
            let to = entry.path().join(crate::project::FLOW_FILE);
            if from.is_file()
                && !to.exists()
                && let Err(e) = fs::rename(&from, &to)
            {
                tracing::warn!(path = %from.display(), error = %e, "could not rename scenario.json to flow.json");
            }
        }
    }
}
