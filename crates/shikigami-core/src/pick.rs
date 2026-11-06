//! An AI asking the person to point at something on screen.
//!
//! When an AI cannot tell which element a step should touch (two 「編集」
//! buttons, an icon without a name), it asks the person to click it in the
//! browser window (MCP `ask_user_to_pick`). The browser itself shows the
//! banner and catches the click; this store only lets Studio know that a
//! request is waiting, so Studio can say so and offer to cancel it.
//!
//! A request is one file in the per-PC part of the workspace (`picks/`),
//! written when the AI starts waiting and removed when it stops. Studio
//! cancels a request by removing the file; the waiting server notices and
//! closes the banner.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::error::{CoreError, CoreResult};
use crate::ids::PickId;
use crate::store::write_atomic;

/// Requests older than this are left over from a server that stopped.
const STALE_MINUTES: i64 = 15;
const MAX_MESSAGE_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PickRequest {
    pub id: PickId,
    /// What the AI wants the person to point at, in its own words.
    pub message: String,
    /// The page the banner is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// How many candidates are outlined with numbers on the page.
    #[serde(default)]
    pub candidates: usize,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub requested_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct PickRequestStore {
    dir: PathBuf,
}

/// A request on file for as long as this lives (dropping it removes the file).
#[derive(Debug)]
pub struct PickWait {
    path: PathBuf,
    pub request: PickRequest,
}

impl PickWait {
    /// False once Studio cancelled the request (removed its file).
    pub fn is_open(&self) -> bool {
        self.path.exists()
    }
}

impl Drop for PickWait {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl PickRequestStore {
    /// `local_root` is [`crate::FileStore::local_root`].
    pub fn new(local_root: &Path) -> Self {
        Self {
            dir: local_root.join("picks"),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, id: &PickId) -> CoreResult<PathBuf> {
        if !id.is_well_formed() {
            return Err(CoreError::Rejected {
                code: "PICK_NOT_FOUND",
                message: format!("pick request {id} does not exist"),
                hint: None,
            });
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    /// Files a request; it stays until the returned guard is dropped.
    pub fn open(
        &self,
        message: &str,
        url: Option<String>,
        candidates: usize,
    ) -> CoreResult<PickWait> {
        let request = PickRequest {
            id: PickId::generate(),
            message: message.trim().chars().take(MAX_MESSAGE_CHARS).collect(),
            url,
            candidates,
            requested_at: OffsetDateTime::now_utc(),
        };
        fs::create_dir_all(&self.dir)?;
        let path = self.path(&request.id)?;
        write_atomic(&path, &serde_json::to_vec_pretty(&request)?)?;
        Ok(PickWait { path, request })
    }

    /// Requests waiting now, oldest first. Stale ones are removed.
    pub fn pending(&self) -> CoreResult<Vec<PickRequest>> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let stale = OffsetDateTime::now_utc() - Duration::minutes(STALE_MINUTES);
        let mut out = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let parsed = fs::read(&path)
                .map_err(CoreError::from)
                .and_then(|b| Ok(serde_json::from_slice::<PickRequest>(&b)?));
            match parsed {
                Ok(r) if r.requested_at < stale => {
                    let _ = fs::remove_file(&path);
                }
                Ok(r) => out.push(r),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "skipping unreadable pick request");
                }
            }
        }
        out.sort_by_key(|r| r.requested_at);
        Ok(out)
    }

    /// The person declines (Studio): the waiting AI is told it was cancelled.
    pub fn cancel(&self, id: &PickId) -> CoreResult<()> {
        match fs::remove_file(self.path(id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_lives_as_long_as_its_guard() {
        let dir = tempfile::tempdir().unwrap();
        let store = PickRequestStore::new(dir.path());
        assert!(store.pending().unwrap().is_empty());
        let wait = store
            .open(
                "  出荷ボタンを押してください ",
                Some("https://example.com".into()),
                2,
            )
            .unwrap();
        let pending = store.pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].message, "出荷ボタンを押してください");
        assert_eq!(pending[0].candidates, 2);
        assert!(wait.is_open());
        drop(wait);
        assert!(store.pending().unwrap().is_empty());
    }

    #[test]
    fn studio_cancels_by_removing_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = PickRequestStore::new(dir.path());
        let wait = store.open("どれ？", None, 0).unwrap();
        store.cancel(&wait.request.id).unwrap();
        assert!(!wait.is_open());
        assert!(store.pending().unwrap().is_empty());
        store.cancel(&wait.request.id).unwrap();
    }
}
