//! Pictures for the 手順書 before the flow is run: the screen a node met
//! when it was tried alone (Studio's 「ノードの単体実行」, the AI's
//! `test_step`).
//!
//! They are kept per flow in `<local root>/manuals/<flow id>/drafts/`,
//! named by the node's [`fingerprint`] (its type and params), not its ID:
//! the AI tries a node before it is in the flow. A node whose params
//! changed since no longer matches its old picture. Studio shows these as
//! 「作るときの画面」 until a run of the whole flow takes the real ones.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use shikigami_core::{FlowId, Part, RunId, Step};

use crate::{RunEvent, ScreenRect};

const INDEX: &str = "drafts.json";
/// Pictures kept per flow; the oldest go first.
const MAX_DRAFTS: usize = 300;

/// Who tried the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftSource {
    /// A person, with 「ノードの単体実行」 in Studio.
    Studio,
    /// The AI, with `test_step`.
    Ai,
}

/// One picture taken when a node was tried alone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftShot {
    pub file: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<ScreenRect>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<ScreenRect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    pub source: DraftSource,
    /// Milliseconds since 1970.
    pub taken_at: u64,
}

/// `<local root>/manuals/<flow id>`, when the ID is safe as a folder name.
pub fn manual_dir(local_root: &Path, flow: &FlowId) -> Option<PathBuf> {
    let id = flow.as_str();
    (!id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    .then(|| local_root.join("manuals").join(id))
}

fn drafts_dir(local_root: &Path, flow: &FlowId) -> Option<PathBuf> {
    manual_dir(local_root, flow).map(|d| d.join("drafts"))
}

/// What identifies a node across edits that do not change what it does:
/// its type and params, with named parts replaced by their targets (the
/// AI tries a target that the flow later keeps as a part).
pub fn fingerprint(
    step_type: &str,
    params: &Value,
    parts: Option<&BTreeMap<String, Part>>,
) -> String {
    let mut text = String::from(step_type);
    text.push('\n');
    canonical(params, parts, &mut text);
    // FNV-1a: the same in every build, unlike std's hasher.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// JSON with object keys sorted, `{ "part": name }` replaced by the part's target.
fn canonical(value: &Value, parts: Option<&BTreeMap<String, Part>>, out: &mut String) {
    match value {
        Value::Object(map) => {
            if map.len() == 1
                && let Some(Value::String(name)) = map.get("part")
                && let Some(part) = parts.and_then(|p| p.get(name))
                && !part.target.is_null()
            {
                return canonical(&part.target, None, out);
            }
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                canonical(&map[key], parts, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(item, parts, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// The pictures kept for `flow`, by fingerprint.
pub fn read(local_root: &Path, flow: &FlowId) -> BTreeMap<String, DraftShot> {
    drafts_dir(local_root, flow)
        .and_then(|dir| std::fs::read(dir.join(INDEX)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The path of a kept picture, when `file` is one of ours.
pub fn picture_path(local_root: &Path, flow: &FlowId, file: &str) -> Option<PathBuf> {
    let safe = !file.is_empty()
        && file
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        && !file.starts_with('.');
    if !safe {
        return None;
    }
    drafts_dir(local_root, flow).map(|d| d.join(file))
}

/// Taking the picture of one node tried alone: give [`Self::screens_dir`]
/// to the run as `RunOptions::screens_dir`, pass its events to
/// [`Self::on_event`], then call [`Self::finish`].
#[derive(Debug)]
pub struct DraftCapture {
    dir: PathBuf,
    tmp: PathBuf,
    local_root: PathBuf,
    flow: FlowId,
    fingerprint: String,
    source: DraftSource,
    shot: Option<DraftShot>,
}

impl DraftCapture {
    /// For a browser or desktop step of `flow`; `None` for other steps.
    pub fn new(
        local_root: &Path,
        flow: &FlowId,
        step: &Step,
        parts: Option<&BTreeMap<String, Part>>,
        source: DraftSource,
    ) -> Option<Self> {
        if !(step.step_type.starts_with("browser.") || step.step_type.starts_with("desktop.")) {
            return None;
        }
        let dir = drafts_dir(local_root, flow)?;
        let tmp = dir.join(format!("tmp-{}", RunId::generate().as_str()));
        Some(Self {
            dir,
            tmp,
            local_root: local_root.to_path_buf(),
            flow: flow.clone(),
            fingerprint: fingerprint(&step.step_type, &Value::Object(step.params.clone()), parts),
            source,
            shot: None,
        })
    }

    pub fn screens_dir(&self) -> PathBuf {
        self.tmp.clone()
    }

    pub fn on_event(&mut self, event: &RunEvent) {
        if let RunEvent::ScreenCaptured {
            file,
            width,
            height,
            mark,
            regions,
            title,
            view,
            ..
        } = event
            && self.shot.is_none()
        {
            self.shot = Some(DraftShot {
                file: file.clone(),
                width: *width,
                height: *height,
                mark: *mark,
                regions: regions.clone(),
                title: title.clone(),
                view: view.clone(),
                source: self.source,
                taken_at: now_ms(),
            });
        }
    }

    /// Keeps the picture under the node's fingerprint (replacing an older
    /// one) and removes the run's folder. Nothing is kept when the step
    /// took no picture.
    pub fn finish(self) {
        let Self {
            dir,
            tmp,
            local_root,
            flow,
            fingerprint,
            shot,
            ..
        } = self;
        if let Some(mut shot) = shot {
            let ext = shot.file.rsplit_once('.').map_or("jpg", |(_, e)| e);
            let name = format!("{fingerprint}-{}.{ext}", shot.taken_at);
            if std::fs::rename(tmp.join(&shot.file), dir.join(&name)).is_ok() {
                shot.file = name;
                let mut index = read(&local_root, &flow);
                if let Some(old) = index.insert(fingerprint, shot) {
                    let _ = std::fs::remove_file(dir.join(old.file));
                }
                while index.len() > MAX_DRAFTS {
                    let Some(oldest) = index
                        .iter()
                        .min_by_key(|(_, s)| s.taken_at)
                        .map(|(k, _)| k.clone())
                    else {
                        break;
                    };
                    if let Some(old) = index.remove(&oldest) {
                        let _ = std::fs::remove_file(dir.join(old.file));
                    }
                }
                write_index(&dir, &index);
            }
        }
        let _ = std::fs::remove_dir_all(tmp);
    }
}

fn write_index(dir: &Path, index: &BTreeMap<String, DraftShot>) {
    let Ok(bytes) = serde_json::to_vec_pretty(index) else {
        return;
    };
    let tmp = dir.join(format!("{INDEX}.{}", RunId::generate().as_str()));
    if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, dir.join(INDEX)).is_err() {
        let _ = std::fs::remove_file(tmp);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use shikigami_core::PartApp;

    #[test]
    fn a_node_is_known_by_what_it_does_whatever_the_key_order_or_part() {
        let target = json!({ "role": "button", "name": "ログイン" });
        let a = fingerprint(
            "browser.click",
            &json!({ "target": target, "context": "main" }),
            None,
        );
        let b = fingerprint(
            "browser.click",
            &json!({ "context": "main", "target": target }),
            None,
        );
        assert_eq!(a, b);
        let parts = BTreeMap::from([(
            "login".to_owned(),
            Part {
                label: "ログインボタン".into(),
                app: PartApp::Browser,
                target: target.clone(),
            },
        )]);
        let c = fingerprint(
            "browser.click",
            &json!({ "context": "main", "target": { "part": "login" } }),
            Some(&parts),
        );
        assert_eq!(a, c);
        assert_ne!(
            a,
            fingerprint(
                "browser.click",
                &json!({ "target": { "role": "button", "name": "保存" } }),
                None
            )
        );
        assert_ne!(
            a,
            fingerprint(
                "browser.hover",
                &json!({ "target": target, "context": "main" }),
                None
            )
        );
    }

    #[test]
    fn keeps_the_newest_picture_of_a_node() {
        let root = tempfile::tempdir().unwrap();
        let flow = FlowId::new("flw_test");
        let step: Step = serde_json::from_value(json!({ "id": "stp_a", "type": "browser.click", "params": { "target": { "role": "button", "name": "OK" } } })).unwrap();
        for width in [800, 1024] {
            let mut capture =
                DraftCapture::new(root.path(), &flow, &step, None, DraftSource::Ai).unwrap();
            let dir = capture.screens_dir();
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("001.jpg"), b"jpeg").unwrap();
            capture.on_event(&RunEvent::ScreenCaptured {
                step_id: "stp_a".into(),
                file: "001.jpg".into(),
                width,
                height: 600,
                mark: None,
                regions: vec![],
                title: Some("OK".into()),
                view: None,
            });
            capture.finish();
            assert!(!dir.exists());
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let index = read(root.path(), &flow);
        assert_eq!(index.len(), 1);
        let shot = index.values().next().unwrap();
        assert_eq!((shot.width, shot.source), (1024, DraftSource::Ai));
        let pictures: Vec<_> = std::fs::read_dir(root.path().join("manuals/flw_test/drafts"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".jpg"))
            .collect();
        assert_eq!(pictures.len(), 1);
        assert!(
            picture_path(root.path(), &flow, &shot.file)
                .unwrap()
                .exists()
        );
        assert!(picture_path(root.path(), &flow, "../x.jpg").is_none());
    }

    #[test]
    fn only_screens_have_pictures() {
        let root = tempfile::tempdir().unwrap();
        let step: Step =
            serde_json::from_value(json!({ "type": "variable.set", "params": {} })).unwrap();
        assert!(
            DraftCapture::new(
                root.path(),
                &FlowId::new("flw_x"),
                &step,
                None,
                DraftSource::Studio
            )
            .is_none()
        );
    }
}
