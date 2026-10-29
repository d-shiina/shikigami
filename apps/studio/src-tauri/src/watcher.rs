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
/// A file in a scenario's folder (input/, config/, logs/, …) was added,
/// changed or removed. Carries the scenario's ID; the frontend re-lists.
pub(crate) const PROJECT_FILES_CHANGED: &str = "project-files-changed";

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

/// What changed under `scenarios/`: a scenario document, or a file in a
/// scenario's folder.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Change {
    Scenario(String),
    Files(String),
}

fn change(root: &Path, path: &Path) -> Option<Change> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = rel.components().map(|c| c.as_os_str().to_str());
    let first = parts.next()??;
    let rest: Vec<&str> = parts.collect::<Option<_>>()?;
    match rest.as_slice() {
        // `scenarios/<id>.json`, the layout before scenario folders.
        [] => {
            let id = first.strip_suffix(".json")?;
            Some(Change::Scenario(id.to_owned()))
        }
        ["scenario.json"] => Some(Change::Scenario(first.to_owned())),
        // Temporary files of atomic writes and Office lock files.
        [.., name] if name.starts_with('.') || name.starts_with("~$") => None,
        _ => Some(Change::Files(first.to_owned())),
    }
}

fn watch(app: &AppHandle, dir: &Path) -> notify::Result<()> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(dir, RecursiveMode::Recursive)?;

    let mut pending: HashMap<Change, Instant> = HashMap::new();
    loop {
        match rx.recv_timeout(DEBOUNCE) {
            Ok(Ok(event)) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                for path in &event.paths {
                    if let Some(change) = change(dir, path) {
                        pending.insert(change, Instant::now());
                    }
                }
            }
            Ok(Err(e)) => tracing::warn!(error = %e, "watch error"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
        let now = Instant::now();
        let ready: Vec<Change> = pending
            .iter()
            .filter(|(_, at)| now.duration_since(**at) >= DEBOUNCE)
            .map(|(change, _)| change.clone())
            .collect();
        for change in ready {
            pending.remove(&change);
            let (event, scenario_id) = match change {
                Change::Scenario(id) => (SCENARIO_CHANGED, id),
                Change::Files(id) => (PROJECT_FILES_CHANGED, id),
            };
            if let Err(e) = app.emit(event, ScenarioChanged { scenario_id }) {
                tracing::warn!(error = %e, "failed to emit scenario change");
            }
        }
    }
}

pub(crate) const SECRET_REQUESTS_CHANGED: &str = "secret-requests-changed";

/// Tells the frontend when an AI client (the MCP server, another process)
/// asks the user for a login, or a request is answered or dismissed. The
/// event carries nothing: the frontend re-reads the requests.
pub(crate) fn spawn_secret_requests(app: AppHandle, dir: PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("secret-request-watcher".into())
        .spawn(move || {
            if let Err(e) = watch_secret_requests(&app, &dir) {
                tracing::error!(error = %e, dir = %dir.display(), "secret request watcher stopped");
            }
        });
    if let Err(e) = spawned {
        tracing::error!(error = %e, "failed to start secret request watcher");
    }
}

fn watch_secret_requests(app: &AppHandle, dir: &Path) -> notify::Result<()> {
    // The vault makes the folder on first use; watch it from the start.
    std::fs::create_dir_all(dir)?;
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(dir, RecursiveMode::NonRecursive)?;

    let mut pending: Option<Instant> = None;
    loop {
        match rx.recv_timeout(DEBOUNCE) {
            Ok(Ok(event)) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                // The vault itself changes too: a registration answers a request.
                let relevant = event.paths.iter().any(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n == "requests.json" || n == "vault.json")
                });
                if relevant {
                    pending = Some(Instant::now());
                }
            }
            Ok(Err(e)) => tracing::warn!(error = %e, "watch error"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
        if pending.is_some_and(|at| at.elapsed() >= DEBOUNCE) {
            pending = None;
            if let Err(e) = app.emit(SECRET_REQUESTS_CHANGED, ()) {
                tracing::warn!(error = %e, "failed to emit secret request change");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_are_told_apart() {
        let root = Path::new("/w/scenarios");
        let at = |p: &str| change(root, &root.join(p));
        assert_eq!(at("scn_1.json"), Some(Change::Scenario("scn_1".into())));
        assert_eq!(
            at("scn_1/scenario.json"),
            Some(Change::Scenario("scn_1".into()))
        );
        assert_eq!(
            at("scn_1/input/a.xlsx"),
            Some(Change::Files("scn_1".into()))
        );
        assert_eq!(at("scn_1/input"), Some(Change::Files("scn_1".into())));
        assert_eq!(at("scn_1/.tmpAbc"), None);
        assert_eq!(at("scn_1/input/~$a.xlsx"), None);
        assert_eq!(at("notes.txt"), None);
    }
}
