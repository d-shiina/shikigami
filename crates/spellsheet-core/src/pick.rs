//! An AI asking the person to point at something on screen, or to finish
//! something by hand in the browser (log in, approve MFA) while its
//! `test_step` waits.
//!
//! When an AI cannot tell which element a step should touch (two 「編集」
//! buttons, an icon without a name), it asks the person to click it in the
//! browser window or in the Windows app (MCP `ask_user_to_pick`). The
//! browser, or the frame drawn over the app, shows the question and catches
//! the click; this store only lets Studio know that a request is waiting,
//! so Studio can say so, offer to cancel it, and step aside (minimise) while
//! the person points at an app.
//!
//! A request is one file in the per-PC part of the workspace (`picks/`),
//! written when the AI starts waiting and removed when it stops. Studio
//! cancels a request by removing the file; the waiting server notices and
//! closes the banner. For a wait by hand, Studio's 「終わりました」 marks the
//! file `done`, so the step ends even when the page the AI waits for never
//! shows. The waiting server touches the file while it waits: one it left
//! behind (killed with the AI) is gone from Studio within seconds.

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
/// A request its server stopped touching (see [`PickWait::touch`]).
const UNTOUCHED_SECS: u64 = 20;
const TOUCH_EVERY_SECS: u64 = 5;
const MAX_MESSAGE_CHARS: usize = 300;

/// Where the person points.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PickApp {
    /// In the browser window the page is open in.
    #[default]
    Browser,
    /// In a Windows app, anywhere on the screen.
    Desktop,
}

impl PickApp {
    fn is_browser(&self) -> bool {
        *self == Self::Browser
    }
}

/// What the AI waits for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PickKind {
    /// The person points at an element (ask_user_to_pick).
    #[default]
    Pick,
    /// The person finishes something by hand in the browser
    /// (`test_step` browser.waitForHuman / oauth).
    Human,
}

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
    #[serde(default)]
    pub kind: PickKind,
    /// Where to point: in the browser, or in a Windows app.
    #[serde(default, skip_serializing_if = "PickApp::is_browser")]
    pub app: PickApp,
    /// The person said in Studio they finished (a wait by hand).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub requested_at: OffsetDateTime,
}

/// Where a request stands, as the waiting server sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickAnswer {
    Waiting,
    /// 「終わりました」 in Studio.
    Done,
    /// Cancelled in Studio (the file is gone).
    Cancelled,
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
    touched: std::sync::Mutex<std::time::Instant>,
}

impl PickWait {
    /// False once Studio cancelled the request (removed its file).
    pub fn is_open(&self) -> bool {
        self.path.exists()
    }

    /// What the person did about it in Studio so far.
    pub fn answer(&self) -> PickAnswer {
        match fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<PickRequest>(&bytes) {
                Ok(r) if r.done => PickAnswer::Done,
                _ => PickAnswer::Waiting,
            },
            Err(e) if e.kind() == ErrorKind::NotFound => PickAnswer::Cancelled,
            Err(_) => PickAnswer::Waiting,
        }
    }

    /// Says the server still waits; call it as often as it likes (the file
    /// is touched every few seconds, so Studio is not woken every poll).
    pub fn touch(&self) {
        let mut at = self.touched.lock().unwrap_or_else(|e| e.into_inner());
        if at.elapsed() < std::time::Duration::from_secs(TOUCH_EVERY_SECS) {
            return;
        }
        *at = std::time::Instant::now();
        drop(at);
        if let Ok(file) = fs::File::options().write(true).open(&self.path) {
            let _ = file.set_modified(std::time::SystemTime::now());
        }
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
        self.file(message, url, candidates, PickKind::Pick, PickApp::Browser)
    }

    /// Files a request to point at something in a Windows app.
    pub fn open_desktop(&self, message: &str) -> CoreResult<PickWait> {
        self.file(message, None, 0, PickKind::Pick, PickApp::Desktop)
    }

    /// Files a wait for the person to finish something by hand in the
    /// browser; Studio offers 「終わりました」 and 「待つのをやめる」.
    pub fn open_human(&self, message: &str) -> CoreResult<PickWait> {
        self.file(message, None, 0, PickKind::Human, PickApp::Browser)
    }

    fn file(
        &self,
        message: &str,
        url: Option<String>,
        candidates: usize,
        kind: PickKind,
        app: PickApp,
    ) -> CoreResult<PickWait> {
        let request = PickRequest {
            id: PickId::generate(),
            message: message.trim().chars().take(MAX_MESSAGE_CHARS).collect(),
            url,
            candidates,
            kind,
            app,
            done: false,
            requested_at: OffsetDateTime::now_utc(),
        };
        fs::create_dir_all(&self.dir)?;
        let path = self.path(&request.id)?;
        write_atomic(&path, &serde_json::to_vec_pretty(&request)?)?;
        Ok(PickWait {
            path,
            request,
            touched: std::sync::Mutex::new(std::time::Instant::now()),
        })
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
            if untouched(&path) {
                let _ = fs::remove_file(&path);
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

    /// The person says they finished a wait by hand (Studio's 「終わりました」).
    pub fn finish(&self, id: &PickId) -> CoreResult<()> {
        let path = self.path(id)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            // The wait already ended by itself.
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let mut request: PickRequest = serde_json::from_slice(&bytes)?;
        request.done = true;
        write_atomic(&path, &serde_json::to_vec_pretty(&request)?)?;
        Ok(())
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

/// A file whose server stopped touching it: killed together with its AI.
fn untouched(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|age| age.as_secs() > UNTOUCHED_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_says_when_it_is_for_an_app() {
        let dir = tempfile::tempdir().unwrap();
        let store = PickRequestStore::new(dir.path());
        let in_browser = store
            .open("編集ボタンをクリックしてください", None, 0)
            .unwrap();
        let file = fs::read_to_string(
            dir.path()
                .join("picks")
                .join(format!("{}.json", in_browser.request.id)),
        )
        .unwrap();
        assert!(
            !file.contains("\"app\""),
            "a browser request stays as before: {file}"
        );
        drop(in_browser);
        let in_app = store
            .open_desktop("検索ボタンをクリックしてください")
            .unwrap();
        let pending = store.pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].app, PickApp::Desktop);
        assert_eq!(pending[0].kind, PickKind::Pick);
        drop(in_app);
        assert!(store.pending().unwrap().is_empty());
    }

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

    #[test]
    fn a_wait_by_hand_can_be_finished_or_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let store = PickRequestStore::new(dir.path());
        let wait = store.open_human("GitHub にログインしてください").unwrap();
        let pending = store.pending().unwrap();
        assert_eq!(pending[0].kind, PickKind::Human);
        assert_eq!(wait.answer(), PickAnswer::Waiting);
        store.finish(&wait.request.id).unwrap();
        assert_eq!(wait.answer(), PickAnswer::Done);
        store.cancel(&wait.request.id).unwrap();
        assert_eq!(wait.answer(), PickAnswer::Cancelled);
        // Finishing one that already ended is fine.
        store.finish(&wait.request.id).unwrap();
    }

    #[test]
    fn a_request_its_server_left_behind_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let store = PickRequestStore::new(dir.path());
        let wait = store.open_human("ログインしてください").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(UNTOUCHED_SECS + 5);
        fs::File::options()
            .write(true)
            .open(&wait.path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(store.pending().unwrap().is_empty());
        let wait = store.open_human("ログインしてください").unwrap();
        *wait.touched.lock().unwrap() -= std::time::Duration::from_secs(TOUCH_EVERY_SECS + 1);
        fs::File::options()
            .write(true)
            .open(&wait.path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        wait.touch();
        assert_eq!(store.pending().unwrap().len(), 1);
    }

    #[test]
    fn requests_from_before_kinds_read_as_picks() {
        let r: PickRequest = serde_json::from_value(serde_json::json!({
            "id": "pck_01a1814aaad57038862e86f745a5310a",
            "message": "どれ？",
            "requestedAt": "2026-11-09T10:00:00Z"
        }))
        .unwrap();
        assert_eq!(r.kind, PickKind::Pick);
        assert!(!r.done);
    }
}
