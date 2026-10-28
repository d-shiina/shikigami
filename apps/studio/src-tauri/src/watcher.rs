//! Watches the workspace's scenario directory and tells the frontend when a
//! scenario file changes, whoever changed it (Studio itself, an MCP client,
//! the CLI, or a `git pull`). The frontend then re-fetches through Core, so
//! the file system is the single source of truth across processes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub(crate) const SCENARIO_CHANGED: &str = "scenario-changed";

/// Bursts of file events (temp file + rename) are coalesced per scenario.
const DEBOUNCE: Duration = Duration::from_millis(120);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioChanged {
    scenario_id: String,
}

pub(crate) fn spawn(app: AppHandle, dir: PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("scenario-watcher".into())
        .spawn(move || {
            if let Err(e) = watch(&app, &dir) {
                tracing::error!(error = %e, dir = %dir.display(), "scenario watcher stopped");
            }
        });
    if let Err(e) = spawned {
        tracing::error!(error = %e, "failed to start scenario watcher");
    }
}

fn scenario_id(path: &Path) -> Option<String> {
    if path.extension()?.to_str()? != "json" {
        return None;
    }
    Some(path.file_stem()?.to_str()?.to_owned())
}

fn watch(app: &AppHandle, dir: &Path) -> notify::Result<()> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(dir, RecursiveMode::NonRecursive)?;

    let mut pending: HashMap<String, Instant> = HashMap::new();
    loop {
        match rx.recv_timeout(DEBOUNCE) {
            Ok(Ok(event)) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                for path in &event.paths {
                    if let Some(id) = scenario_id(path) {
                        pending.insert(id, Instant::now());
                    }
                }
            }
            Ok(Err(e)) => tracing::warn!(error = %e, "watch error"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
        let now = Instant::now();
        let ready: Vec<String> = pending
            .iter()
            .filter(|(_, at)| now.duration_since(**at) >= DEBOUNCE)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ready {
            pending.remove(&id);
            if let Err(e) = app.emit(SCENARIO_CHANGED, ScenarioChanged { scenario_id: id }) {
                tracing::warn!(error = %e, "failed to emit scenario change");
            }
        }
    }
}
