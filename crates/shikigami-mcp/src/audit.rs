//! Append-only audit log of MCP tool calls: `<workspace>/audit/mcp.jsonl`.
//!
//! Scenario changes are additionally journaled by Core; this log also covers
//! reads, runs and denied calls so a user can see what an AI client did.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuditRecord<'a> {
    pub at: String,
    pub tool: &'a str,
    pub class: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<&'a str>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<&'a str>,
}

pub(crate) fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

pub(crate) struct AuditLog {
    path: PathBuf,
    // Serializes writers inside this process; each record is a single
    // append so lines from other processes do not interleave.
    guard: Mutex<()>,
}

impl AuditLog {
    pub fn new(workspace: &Path) -> Self {
        Self {
            path: workspace.join("audit").join("mcp.jsonl"),
            guard: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write(&self, record: &AuditRecord<'_>) {
        if let Err(e) = self.try_write(record) {
            tracing::warn!(error = %e, "failed to write audit log");
        }
    }

    fn try_write(&self, record: &AuditRecord<'_>) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        let _guard = self.guard.lock();
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(&line)
    }
}
