//! The pictures behind a flow's 手順書.
//!
//! A run started from the editor (not 「ここから実行」) keeps a picture of
//! each browser or desktop node's screen (see `shikigami_runtime`'s
//! `screens`) in `<local root>/manuals/<flow id>/next-<run id>/`. When the
//! run completes, a `manual.json` describing them (and how many times each
//! node ran) is written there and the folder replaces `current/`; a run
//! that does not complete leaves the last 手順書 as it was.
//!
//! The pictures can show customers' data, so they stay on this PC (the
//! local root, never the shared workspace). What the person hides on them
//! is kept in `masks.json` beside `current/`, per node, so it carries over
//! to the next run's pictures.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use shikigami_core::{ErrorPayload, Flow, FlowId, RunId, Step, StepId};
use shikigami_runtime::drafts::{self, DraftShot};
use shikigami_runtime::{RunEvent, RunEventEnvelope, RunReport, RunStatus, ScreenRect};
use tauri::State;

use crate::AppState;

type CmdResult<T> = Result<T, ErrorPayload>;

const MANIFEST: &str = "manual.json";
const MASKS: &str = "masks.json";
const CURRENT: &str = "current";

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// `<local root>/manuals/<flow id>`.
fn flow_dir(local_root: &Path, flow: &FlowId) -> CmdResult<PathBuf> {
    let id = flow.as_str();
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(err("INVALID_PARAMS", "invalid flow id"));
    }
    Ok(local_root.join("manuals").join(id))
}

/// Where a run's pictures go until it completes.
pub(crate) fn screens_dir(local_root: &Path, flow: &FlowId, run: &RunId) -> Option<PathBuf> {
    let dir = flow_dir(local_root, flow).ok()?;
    run.is_well_formed()
        .then(|| dir.join(format!("next-{}", run.as_str())))
}

/// A node's place in the run: the `flow.call` nodes it is inside, then itself.
fn key(call_path: &[StepId], step: &StepId) -> String {
    call_path
        .iter()
        .chain(std::iter::once(step))
        .map(StepId::as_str)
        .collect::<Vec<_>>()
        .join("/")
}

/// One picture.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// `<call>/<call>/<step>`: see [`key`].
    key: String,
    step_id: StepId,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    call_path: Vec<StepId>,
    file: String,
    width: u32,
    height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mark: Option<ScreenRect>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    regions: Vec<ScreenRect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    view: Option<String>,
}

/// What `manual.json` says about the run the pictures are from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    run_id: RunId,
    revision: u64,
    #[serde(with = "time::serde::rfc3339")]
    started_at: time::OffsetDateTime,
    duration_ms: u64,
    shots: Vec<Shot>,
    /// How many times each node ran (by [`key`]); nodes that did not run
    /// are left out.
    counts: BTreeMap<String, u32>,
}

/// A box the person drew over a picture.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskBox {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// `blur` or `black`.
    kind: String,
}

/// What the person hid on one node's picture.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    /// Leave the picture out of the 手順書.
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    boxes: Vec<MaskBox>,
    /// The size of the picture the boxes were drawn on: a new picture of
    /// another size asks the person to check them.
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
}

/// Collects a run's pictures and how often each node ran.
pub(crate) struct Collector {
    dir: PathBuf,
    shots: Vec<Shot>,
    counts: BTreeMap<String, u32>,
}

impl Collector {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            shots: Vec::new(),
            counts: BTreeMap::new(),
        }
    }

    pub(crate) fn on_event(&mut self, event: &RunEventEnvelope) {
        match &event.event {
            RunEvent::ScreenCaptured {
                step_id,
                file,
                width,
                height,
                mark,
                regions,
                title,
                view,
            } => self.shots.push(Shot {
                key: key(&event.call_path, step_id),
                step_id: step_id.clone(),
                call_path: event.call_path.clone(),
                file: file.clone(),
                width: *width,
                height: *height,
                mark: *mark,
                regions: regions.clone(),
                title: title.clone(),
                view: view.clone(),
            }),
            RunEvent::StepFinished {
                step_id,
                will_retry: false,
                ..
            } => {
                *self
                    .counts
                    .entry(key(&event.call_path, step_id))
                    .or_default() += 1
            }
            _ => {}
        }
    }

    /// A completed run's pictures become the 手順書's; any other run's are
    /// dropped. A completed run without pictures (nothing on a screen) still
    /// replaces the old ones, so they never describe nodes that are gone.
    pub(crate) fn finish(self, report: &RunReport) {
        let Some(parent) = self.dir.parent().map(Path::to_path_buf) else {
            return;
        };
        if report.status != RunStatus::Succeeded {
            let _ = std::fs::remove_dir_all(&self.dir);
            return;
        }
        let manifest = Manifest {
            run_id: report.run_id.clone(),
            revision: report.revision,
            started_at: report.started_at,
            duration_ms: u64::try_from(
                (report.finished_at - report.started_at).whole_milliseconds(),
            )
            .unwrap_or(0),
            shots: self.shots,
            counts: self.counts,
        };
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&self.dir)?;
            std::fs::write(
                self.dir.join(MANIFEST),
                serde_json::to_vec_pretty(&manifest)?,
            )?;
            let current = parent.join(CURRENT);
            let old = parent.join(format!("old-{}", manifest.run_id.as_str()));
            if current.exists() {
                std::fs::rename(&current, &old)?;
            }
            std::fs::rename(&self.dir, &current)?;
            let _ = std::fs::remove_dir_all(&old);
            Ok(())
        };
        if let Err(e) = write() {
            tracing::warn!(error = %e, "failed to keep the pictures for the manual");
            let _ = std::fs::remove_dir_all(&self.dir);
        }
        // Folders of runs that ended without getting here (Studio closed).
        if let Ok(entries) = std::fs::read_dir(&parent) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("old-") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

/// The 手順書's pictures and what the person hid on them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manual {
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<Manifest>,
    masks: BTreeMap<String, Mask>,
    /// 「作るときの画面」: pictures from nodes tried alone, by flow ID
    /// (the flow and the sub-flows it calls), then node ID. Only nodes
    /// whose params are still the ones tried.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    drafts: BTreeMap<String, BTreeMap<String, DraftShot>>,
}

/// Where draft pictures are named in [`image`]: `drafts/<flow id>/<file>`.
const DRAFT_PREFIX: &str = "drafts/";

/// The kept pictures that still match the nodes of `flow`.
fn drafts_of(local_root: &Path, flow: &Flow) -> BTreeMap<String, DraftShot> {
    let index = drafts::read(local_root, &flow.id);
    let mut out = BTreeMap::new();
    if index.is_empty() {
        return out;
    }
    fn walk(
        steps: &[Step],
        flow: &Flow,
        index: &BTreeMap<String, DraftShot>,
        out: &mut BTreeMap<String, DraftShot>,
    ) {
        for step in steps {
            let print = drafts::fingerprint(
                &step.step_type,
                &serde_json::Value::Object(step.params.clone()),
                Some(&flow.parts),
            );
            if let Some(shot) = index.get(&print) {
                let mut shot = shot.clone();
                shot.file = format!("{DRAFT_PREFIX}{}/{}", flow.id.as_str(), shot.file);
                out.insert(step.id.as_str().to_owned(), shot);
            }
            for block in step.blocks.values() {
                walk(block, flow, index, out);
            }
        }
    }
    walk(&flow.steps, flow, &index, &mut out);
    out
}

fn read_masks(dir: &Path) -> BTreeMap<String, Mask> {
    std::fs::read(dir.join(MASKS))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn load(local_root: &Path, flow: &FlowId, flows: &[&Flow]) -> CmdResult<Manual> {
    let dir = flow_dir(local_root, flow)?;
    let manifest = std::fs::read(dir.join(CURRENT).join(MANIFEST))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let drafts = flows
        .iter()
        .map(|f| (f.id.as_str().to_owned(), drafts_of(local_root, f)))
        .filter(|(_, d)| !d.is_empty())
        .collect();
    Ok(Manual {
        manifest,
        masks: read_masks(&dir),
        drafts,
    })
}

#[tauri::command]
pub fn get_manual(state: State<'_, AppState>, id: FlowId) -> CmdResult<Manual> {
    let local_root = state.service.store().local_root();
    let Ok(flow) = state.service.get(&id) else {
        return load(local_root, &id, &[]);
    };
    let subflows = state.service.subflows(&flow).unwrap_or_default();
    let flows: Vec<&Flow> = std::iter::once(&flow)
        .chain(subflows.iter().map(|s| &s.flow))
        .collect();
    load(local_root, &id, &flows)
}

/// A picture of the current 手順書 as a data URL.
#[tauri::command]
pub fn manual_image(state: State<'_, AppState>, id: FlowId, file: String) -> CmdResult<String> {
    image(state.service.store().local_root(), &id, &file)
}

fn image(local_root: &Path, flow: &FlowId, file: &str) -> CmdResult<String> {
    let mime = match file.rsplit_once('.').map(|(_, ext)| ext) {
        Some("jpg") => "image/jpeg",
        Some("png") => "image/png",
        _ => return Err(err("INVALID_PARAMS", "not a picture of the manual")),
    };
    let path = if let Some(rest) = file.strip_prefix(DRAFT_PREFIX) {
        let (owner, name) = rest
            .split_once('/')
            .ok_or_else(|| err("INVALID_PARAMS", "not a picture of the manual"))?;
        drafts::picture_path(local_root, &FlowId::new(owner), name)
            .ok_or_else(|| err("INVALID_PARAMS", "not a picture of the manual"))?
    } else {
        if file.contains(['/', '\\']) || file.starts_with('.') {
            return Err(err("INVALID_PARAMS", "not a picture of the manual"));
        }
        flow_dir(local_root, flow)?.join(CURRENT).join(file)
    };
    let bytes = std::fs::read(&path).map_err(|e| err("NOT_FOUND", e.to_string()))?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn save_manual_masks(
    state: State<'_, AppState>,
    id: FlowId,
    masks: BTreeMap<String, Mask>,
) -> CmdResult<()> {
    save_masks(state.service.store().local_root(), &id, &masks)
}

fn save_masks(local_root: &Path, flow: &FlowId, masks: &BTreeMap<String, Mask>) -> CmdResult<()> {
    let dir = flow_dir(local_root, flow)?;
    std::fs::create_dir_all(&dir).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    let json = serde_json::to_vec_pretty(masks).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    std::fs::write(dir.join(MASKS), json).map_err(|e| err("STORAGE_ERROR", e.to_string()))
}

/// Writes the 手順書 Studio put together (one HTML file, pictures inside)
/// to the Downloads folder and returns its path.
#[tauri::command]
pub fn save_manual_export(name: String, html: String) -> CmdResult<String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| err("STORAGE_ERROR", "保存先フォルダが見つかりません"))?;
    let path = export_path(&dir, &name);
    std::fs::write(&path, html).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    Ok(path.display().to_string())
}

fn export_path(dir: &Path, name: &str) -> PathBuf {
    let stem: String = name
        .chars()
        .map(|c| {
            if r#"\/:*?"<>|"#.contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = if stem.trim().is_empty() {
        "flow".to_owned()
    } else {
        stem.trim().to_owned()
    };
    let mut path = dir.join(format!("{stem}_手順書.html"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}_手順書 ({n}).html"));
        n += 1;
    }
    path
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::{Map, json};
    use shikigami_runtime::StepOutcome;

    fn envelope(seq: u64, call_path: Vec<StepId>, event: RunEvent) -> RunEventEnvelope {
        RunEventEnvelope {
            run_id: RunId::new("run_1"),
            seq,
            at: time::OffsetDateTime::UNIX_EPOCH,
            call_path,
            event,
        }
    }

    fn finished(step: &str, will_retry: bool) -> RunEvent {
        RunEvent::StepFinished {
            step_id: StepId::new(step),
            step_type: "browser.click".into(),
            outcome: StepOutcome::Succeeded,
            duration_ms: 1,
            error: None,
            will_retry,
        }
    }

    fn report(status: RunStatus) -> RunReport {
        serde_json::from_value(json!({
            "runId": "01890000-0000-7000-8000-000000000001",
            "flowId": "scn_a",
            "flowName": "a",
            "revision": 3,
            "status": status,
            "startedAt": "2026-11-08T09:00:00Z",
            "finishedAt": "2026-11-08T09:01:12Z",
            "outputs": Map::new(),
        }))
        .unwrap()
    }

    #[test]
    fn a_completed_run_replaces_the_pictures_and_keeps_the_masks() {
        let root = tempfile::tempdir().unwrap();
        let flow = FlowId::new("scn_a");
        let run = RunId::new("01890000-0000-7000-8000-000000000001");
        save_masks(
            root.path(),
            &flow,
            &BTreeMap::from([(
                "stp_a".to_owned(),
                Mask {
                    hidden: true,
                    ..Mask::default()
                },
            )]),
        )
        .unwrap();

        let dir = screens_dir(root.path(), &flow, &run).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("001.jpg"), [0xff, 0xd8]).unwrap();
        let mut collector = Collector::new(dir.clone());
        collector.on_event(&envelope(
            0,
            vec![StepId::new("stp_call")],
            RunEvent::ScreenCaptured {
                step_id: StepId::new("stp_a"),
                file: "001.jpg".into(),
                width: 800,
                height: 600,
                mark: Some(ScreenRect {
                    x: 1,
                    y: 2,
                    width: 3,
                    height: 4,
                }),
                regions: vec![],
                title: Some("ログイン".into()),
                view: None,
            },
        ));
        collector.on_event(&envelope(1, vec![], finished("stp_b", true)));
        collector.on_event(&envelope(2, vec![], finished("stp_b", false)));
        collector.on_event(&envelope(3, vec![], finished("stp_b", false)));
        collector.finish(&report(RunStatus::Succeeded));

        assert!(!dir.exists());
        let manual = load(root.path(), &flow, &[]).unwrap();
        let manifest = manual.manifest.unwrap();
        assert_eq!(manifest.shots[0].key, "stp_call/stp_a");
        assert_eq!(manifest.counts["stp_b"], 2);
        assert_eq!(manifest.duration_ms, 72_000);
        assert!(manual.masks["stp_a"].hidden);
        assert!(
            image(root.path(), &flow, "001.jpg")
                .unwrap()
                .starts_with("data:image/jpeg;base64,")
        );
        assert!(image(root.path(), &flow, "../masks.json").is_err());
        assert!(image(root.path(), &flow, "manual.json").is_err());

        // A failed run leaves the 手順書 as it was.
        let run2 = RunId::new("01890000-0000-7000-8000-000000000002");
        let dir2 = screens_dir(root.path(), &flow, &run2).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();
        Collector::new(dir2.clone()).finish(&report(RunStatus::Failed));
        assert!(!dir2.exists());
        assert!(load(root.path(), &flow, &[]).unwrap().manifest.is_some());
    }

    #[test]
    fn exports_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let first = export_path(dir.path(), "受注/出荷");
        assert!(first.ends_with("受注_出荷_手順書.html"));
        std::fs::write(&first, "x").unwrap();
        assert!(export_path(dir.path(), "受注/出荷").ends_with("受注_出荷_手順書 (2).html"));
    }

    #[test]
    fn flow_ids_cannot_leave_the_folder() {
        assert!(flow_dir(Path::new("/x"), &FlowId::new("../y")).is_err());
    }

    #[test]
    fn pictures_of_nodes_tried_alone_follow_the_nodes_that_still_do_the_same() {
        let root = tempfile::tempdir().unwrap();
        let mut flow: Flow = serde_json::from_value(json!({
            "schemaVersion": 1,
            "id": "flw_a",
            "name": "a",
            "steps": [
                { "id": "stp_login", "type": "browser.click", "params": { "target": { "part": "login" } } },
                { "id": "stp_group", "type": "control.group", "blocks": { "body": [
                    { "id": "stp_save", "type": "browser.click", "params": { "target": { "role": "button", "name": "保存" } } }
                ] } }
            ],
            "parts": { "login": { "label": "ログイン", "app": "browser", "target": { "role": "button", "name": "ログイン" } } }
        }))
        .unwrap();
        // The AI tried both before they were in the flow, with plain targets.
        for (name, id) in [("ログイン", "stp_x"), ("保存", "stp_y")] {
            let tried: Step = serde_json::from_value(json!({ "id": id, "type": "browser.click", "params": { "target": { "role": "button", "name": name } } })).unwrap();
            let mut capture = drafts::DraftCapture::new(
                root.path(),
                &flow.id,
                &tried,
                None,
                drafts::DraftSource::Ai,
            )
            .unwrap();
            std::fs::create_dir_all(capture.screens_dir()).unwrap();
            std::fs::write(capture.screens_dir().join("001.jpg"), b"jpeg").unwrap();
            capture.on_event(&RunEvent::ScreenCaptured {
                step_id: StepId::new(id),
                file: "001.jpg".into(),
                width: 800,
                height: 600,
                mark: None,
                regions: vec![],
                title: None,
                view: None,
            });
            capture.finish();
        }
        let found = drafts_of(root.path(), &flow);
        assert_eq!(
            found.keys().map(String::as_str).collect::<Vec<_>>(),
            ["stp_login", "stp_save"]
        );
        let file = &found["stp_login"].file;
        assert!(file.starts_with("drafts/flw_a/"));
        assert!(
            image(root.path(), &flow.id, file)
                .unwrap()
                .starts_with("data:image/jpeg;base64,")
        );
        assert!(image(root.path(), &flow.id, "drafts/flw_a/../current/x.jpg").is_err());
        // Changed since: no longer its picture.
        flow.steps[0]
            .params
            .insert("target".into(), json!({ "role": "button", "name": "送信" }));
        assert!(!drafts_of(root.path(), &flow).contains_key("stp_login"));
    }
}
