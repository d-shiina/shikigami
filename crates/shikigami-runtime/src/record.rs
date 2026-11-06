//! Persistent run records.
//!
//! ```text
//! <workspace>/runs/<run-id>/events.jsonl   every event, in order (secrets masked)
//! <workspace>/runs/<run-id>/report.json    final report (written when the run ends)
//! ```
//!
//! These files are what `get_run_status`, `get_run_logs` and AI error
//! analysis read. SQLite indexing is planned for when listing many runs
//! becomes slow; the files stay the source of truth.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use shikigami_core::RunId;

use crate::event::{RunEventEnvelope, RunReport};

pub struct RunRecorder {
    workspace: PathBuf,
    run_id: RunId,
    dir: PathBuf,
    events: BufWriter<File>,
    /// `policy.json` whose `records` settings apply when the run ends.
    retention: Option<PathBuf>,
}

impl RunRecorder {
    pub fn create(workspace: &Path, run_id: &RunId) -> std::io::Result<Self> {
        let dir = run_dir(workspace, run_id)?;
        fs::create_dir_all(&dir)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("events.jsonl"))?;
        Ok(Self {
            workspace: workspace.to_path_buf(),
            run_id: run_id.clone(),
            dir,
            events: BufWriter::new(file),
            retention: None,
        })
    }

    /// When the run ends, delete the records that the `records` settings of
    /// the `policy.json` at `policy_path` no longer keep (never this one).
    pub fn prune_on_finish(mut self, policy_path: &Path) -> Self {
        self.retention = Some(policy_path.to_path_buf());
        self
    }

    pub fn write_event(&mut self, event: &RunEventEnvelope) -> std::io::Result<()> {
        serde_json::to_writer(&mut self.events, event)?;
        self.events.write_all(b"\n")?;
        self.events.flush()
    }

    pub fn finish(mut self, report: &RunReport) -> std::io::Result<()> {
        self.events.flush()?;
        let bytes = serde_json::to_vec_pretty(report)?;
        fs::write(self.dir.join("report.json"), bytes)?;
        if let Some(policy) = &self.retention {
            prune_by_policy(&self.workspace, policy, std::slice::from_ref(&self.run_id));
        }
        Ok(())
    }
}

fn run_dir(workspace: &Path, run_id: &RunId) -> std::io::Result<PathBuf> {
    if !run_id.is_well_formed() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid run id",
        ));
    }
    Ok(workspace.join("runs").join(run_id.as_str()))
}

pub fn read_report(workspace: &Path, run_id: &RunId) -> std::io::Result<Option<RunReport>> {
    let path = run_dir(workspace, run_id)?.join("report.json");
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn read_events(workspace: &Path, run_id: &RunId) -> std::io::Result<Vec<RunEventEnvelope>> {
    let path = run_dir(workspace, run_id)?.join("events.jsonl");
    let file = File::open(path)?;
    let mut out = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        if !line.trim().is_empty() {
            out.push(serde_json::from_str(&line)?);
        }
    }
    Ok(out)
}

/// Lists recorded runs, newest first (run IDs are time-ordered UUIDv7).
pub fn list_runs(workspace: &Path) -> std::io::Result<Vec<RunId>> {
    let dir = workspace.join("runs");
    let mut ids = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().to_str().map(RunId::new))
            .collect::<Vec<_>>(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    ids.sort();
    ids.reverse();
    Ok(ids)
}

/// When a run started, from its time-ordered ID (`run_<uuidv7>`), in
/// milliseconds since 1970.
fn started_ms(run_id: &RunId) -> Option<u64> {
    let hex = run_id.as_str().strip_prefix("run_")?.get(..12)?;
    u64::from_str_radix(hex, 16).ok()
}

/// Deletes run records the workspace's `records` settings no longer keep
/// (older than `keepDays`, beyond the newest `keepRuns`). Runs still going
/// (no `report.json` yet) and `keep` are never deleted. Returns how many
/// were removed; failures are logged and skipped.
pub fn prune(
    workspace: &Path,
    records: &shikigami_core::policy::RecordsPolicy,
    keep: &[RunId],
) -> usize {
    if records.keep_days.is_none() && records.keep_runs.is_none() {
        return 0;
    }
    let Ok(ids) = list_runs(workspace) else {
        return 0;
    };
    let now_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default(),
    )
    .unwrap_or(u64::MAX);
    let cutoff = records
        .keep_days
        .map(|days| now_ms.saturating_sub(u64::from(days) * 86_400_000));
    let mut removed = 0;
    for (index, id) in ids.iter().enumerate() {
        let too_many = records
            .keep_runs
            .is_some_and(|n| index >= usize::try_from(n).unwrap_or(usize::MAX));
        let too_old = match (cutoff, started_ms(id)) {
            (Some(cutoff), Some(started)) => started < cutoff,
            _ => false,
        };
        if !(too_many || too_old) || keep.contains(id) {
            continue;
        }
        let Ok(dir) = run_dir(workspace, id) else {
            continue;
        };
        if !dir.join("report.json").exists() {
            continue;
        }
        match fs::remove_dir_all(&dir) {
            Ok(()) => removed += 1,
            Err(e) => {
                tracing::warn!(run = %id.as_str(), error = %e, "could not delete an old run record")
            }
        }
    }
    removed
}

/// [`prune`] with the `records` settings of the workspace whose
/// `policy.json` is at `policy_path`. A broken policy prunes nothing.
pub fn prune_by_policy(workspace: &Path, policy_path: &Path, keep: &[RunId]) -> usize {
    match shikigami_core::Policy::load(policy_path) {
        Ok(policy) => prune(workspace, &policy.records, keep),
        Err(_) => 0,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod prune_tests {
    use super::*;
    use shikigami_core::policy::RecordsPolicy;

    fn record(root: &Path, id: &str, finished: bool) -> RunId {
        let id = RunId::new(id);
        let dir = root.join("runs").join(id.as_str());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("events.jsonl"), "").unwrap();
        if finished {
            fs::write(dir.join("report.json"), "{}").unwrap();
        }
        id
    }

    fn id_at(ms: u64, n: u32) -> String {
        format!("run_{ms:012x}7000800000000000{n:04x}")
    }

    #[test]
    fn keeps_everything_without_limits() {
        let tmp = tempfile::tempdir().unwrap();
        record(tmp.path(), &id_at(1, 1), true);
        assert_eq!(prune(tmp.path(), &RecordsPolicy::default(), &[]), 0);
        assert_eq!(list_runs(tmp.path()).unwrap().len(), 1);
    }

    #[test]
    fn removes_old_and_extra_runs_but_not_running_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let day = 86_400_000;
        let old = record(tmp.path(), &id_at(now - 40 * day, 1), true);
        let old_running = record(tmp.path(), &id_at(now - 41 * day, 2), false);
        let a = record(tmp.path(), &id_at(now - 3 * day, 3), true);
        let b = record(tmp.path(), &id_at(now - 2 * day, 4), true);
        let c = record(tmp.path(), &id_at(now - day, 5), true);

        let by_days = RecordsPolicy {
            keep_days: Some(30),
            keep_runs: None,
        };
        assert_eq!(prune(tmp.path(), &by_days, &[]), 1);
        let left = list_runs(tmp.path()).unwrap();
        assert!(!left.contains(&old));
        assert!(left.contains(&old_running));

        let by_count = RecordsPolicy {
            keep_days: None,
            keep_runs: Some(2),
        };
        assert_eq!(prune(tmp.path(), &by_count, std::slice::from_ref(&a)), 0);
        assert_eq!(prune(tmp.path(), &by_count, &[]), 1);
        let left = list_runs(tmp.path()).unwrap();
        assert_eq!(left, vec![c, b, old_running]);
    }

    #[test]
    fn a_finishing_run_prunes_others_but_not_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let policy = tmp.path().join("policy.json");
        fs::write(&policy, r#"{ "records": { "keepRuns": 1 } }"#).unwrap();
        let older = record(tmp.path(), &id_at(1, 1), true);
        let mine = RunId::new(id_at(2, 2));
        let newer = record(tmp.path(), &id_at(3, 3), true);
        let recorder = RunRecorder::create(tmp.path(), &mine)
            .unwrap()
            .prune_on_finish(&policy);
        let report: RunReport = serde_json::from_value(serde_json::json!({
            "runId": mine.as_str(), "scenarioId": "scn_a", "scenarioName": "A",
            "revision": 1, "status": "succeeded", "startedAt": "2026-11-06T00:00:00Z",
            "finishedAt": "2026-11-06T00:00:01Z", "outputs": {}
        }))
        .unwrap();
        recorder.finish(&report).unwrap();
        let left = list_runs(tmp.path()).unwrap();
        assert_eq!(left, vec![newer, mine]);
        assert!(!left.contains(&older));
    }
}
