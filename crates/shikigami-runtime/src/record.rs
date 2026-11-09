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

use std::collections::HashMap;

use shikigami_core::{FlowId, RunId, StepId};

use crate::event::{RunEvent, RunEventEnvelope, RunReport, StepOutcome};

pub struct RunRecorder {
    workspace: PathBuf,
    run_id: RunId,
    dir: PathBuf,
    events: BufWriter<File>,
    /// `policy.json` whose `records` settings apply when the run ends.
    retention: Option<PathBuf>,
    /// Locked while this process records the run: a record without
    /// `report.json` whose lock nobody holds was left behind by a process
    /// that ended mid-run (see [`close_interrupted`]).
    _alive: Option<File>,
}

/// The lock file that tells a run in progress from one left behind.
const ALIVE_FILE: &str = "running.lock";

impl RunRecorder {
    /// Starts the record of a run. Records that crashed processes left
    /// behind are closed first ([`close_interrupted`]).
    pub fn create(workspace: &Path, run_id: &RunId) -> std::io::Result<Self> {
        close_interrupted(workspace);
        let dir = run_dir(workspace, run_id)?;
        fs::create_dir_all(&dir)?;
        let alive = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(ALIVE_FILE))
            .ok()
            .filter(|f| f.try_lock().is_ok());
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
            _alive: alive,
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
        drop(self._alive.take());
        let _ = fs::remove_file(self.dir.join(ALIVE_FILE));
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

/// Most records [`step_times`] looks through for runs of the flow.
const STEP_TIMES_SCAN: usize = 200;

/// How long each step of a flow usually takes, in ms: the median of the
/// times it succeeded in the last `runs` finished runs of the flow (each
/// pass of a loop counts). Steps of called flows are left out. Studio
/// shows a running step's progress against it.
pub fn step_times(workspace: &Path, flow_id: &FlowId, runs: usize) -> HashMap<StepId, u64> {
    let mut samples: HashMap<StepId, Vec<u64>> = HashMap::new();
    let mut found = 0;
    for run_id in list_runs(workspace)
        .unwrap_or_default()
        .into_iter()
        .take(STEP_TIMES_SCAN)
    {
        if found >= runs {
            break;
        }
        let Ok(dir) = run_dir(workspace, &run_id) else {
            continue;
        };
        // Runs still going (or left behind) have no report yet.
        if !dir.join("report.json").is_file() || run_flow(&dir).as_ref() != Some(flow_id) {
            continue;
        }
        let Ok(events) = read_events(workspace, &run_id) else {
            continue;
        };
        found += 1;
        for env in events {
            if let RunEvent::StepFinished {
                step_id,
                outcome: StepOutcome::Succeeded,
                duration_ms,
                ..
            } = env.event
                && env.call_path.is_empty()
            {
                samples.entry(step_id).or_default().push(duration_ms);
            }
        }
    }
    samples
        .into_iter()
        .map(|(id, mut times)| {
            times.sort_unstable();
            (id, times[times.len() / 2])
        })
        .collect()
}

/// The flow a recorded run ran, from its first event.
fn run_flow(dir: &Path) -> Option<FlowId> {
    let file = File::open(dir.join("events.jsonl")).ok()?;
    let line = BufReader::new(file).lines().next()?.ok()?;
    match serde_json::from_str::<RunEventEnvelope>(&line).ok()?.event {
        RunEvent::RunStarted { flow_id, .. } => Some(flow_id),
        _ => None,
    }
}

/// Error code of runs whose process ended before they did (power loss, a
/// crash, the process killed).
pub const RUN_INTERRUPTED: &str = "RUN_INTERRUPTED";

/// Closes run records left behind by processes that ended mid-run: they get
/// a `runFinished` event and a report with status `failed` and error
/// `RUN_INTERRUPTED`, so they no longer look like they are still going.
/// Runs do not resume; start them again. Returns the runs closed.
pub fn close_interrupted(workspace: &Path) -> Vec<RunId> {
    let mut closed = Vec::new();
    for id in list_runs(workspace).unwrap_or_default() {
        let Ok(dir) = run_dir(workspace, &id) else {
            continue;
        };
        if dir.join("report.json").exists() {
            continue;
        }
        // Records from before the lock file existed are left alone.
        let Ok(alive) = OpenOptions::new().write(true).open(dir.join(ALIVE_FILE)) else {
            continue;
        };
        if alive.try_lock().is_err() {
            continue; // still running in another process
        }
        match close_one(&dir, &id) {
            Ok(()) => closed.push(id),
            Err(e) => {
                tracing::warn!(run = %id.as_str(), error = %e, "could not close an interrupted run");
            }
        }
        drop(alive);
        let _ = fs::remove_file(dir.join(ALIVE_FILE));
    }
    closed
}

fn close_one(dir: &Path, id: &RunId) -> std::io::Result<()> {
    use crate::event::{RunError, RunEvent, RunStatus};
    let events = {
        let file = File::open(dir.join("events.jsonl"))?;
        let mut out = Vec::new();
        for line in BufReader::new(file).lines() {
            // A line cut off by the crash is skipped.
            if let Ok(event) = serde_json::from_str::<RunEventEnvelope>(&line?) {
                out.push(event);
            }
        }
        out
    };
    let Some((started_at, flow_id, flow_name, revision, origin)) =
        events.iter().find_map(|e| match &e.event {
            RunEvent::RunStarted {
                flow_id,
                flow_name,
                revision,
                origin,
            } => Some((
                e.at,
                flow_id.clone(),
                flow_name.clone(),
                *revision,
                origin.clone(),
            )),
            _ => None,
        })
    else {
        // Nothing worth a report: the run never started.
        return fs::remove_dir_all(dir);
    };
    let last = events.last();
    let finished_at = last.map_or(started_at, |e| e.at);
    let error = RunError {
        step_id: events.iter().rev().find_map(|e| match &e.event {
            RunEvent::StepStarted { step_id, .. } => Some(step_id.clone()),
            _ => None,
        }),
        ..RunError::new(
            RUN_INTERRUPTED,
            "the process running this ended before the run did (crash, shutdown or killed); start the run again",
        )
    };
    let finished = RunEventEnvelope {
        run_id: id.clone(),
        seq: last.map_or(0, |e| e.seq + 1),
        at: finished_at,
        call_path: Vec::new(),
        event: RunEvent::RunFinished {
            status: RunStatus::Failed,
            error: Some(error.clone()),
            duration_ms: u64::try_from((finished_at - started_at).whole_milliseconds())
                .unwrap_or(0),
        },
    };
    // Written again in full rather than appended: the crash may have cut
    // the last line off (no newline, half an event), which would make the
    // file unreadable.
    let mut lines = Vec::new();
    for event in events.iter().chain(std::iter::once(&finished)) {
        serde_json::to_writer(&mut lines, event)?;
        lines.push(b'\n');
    }
    let path = dir.join("events.jsonl");
    let tmp = dir.join("events.jsonl.tmp");
    fs::write(&tmp, &lines)?;
    fs::rename(&tmp, &path)?;
    let report = RunReport {
        run_id: id.clone(),
        flow_id,
        flow_name,
        revision,
        version: None,
        status: RunStatus::Failed,
        started_at,
        finished_at,
        error: Some(error),
        outputs: serde_json::Map::new(),
        subflows: Vec::new(),
        origin,
        secrets_used: Vec::new(),
    };
    fs::write(dir.join("report.json"), serde_json::to_vec_pretty(&report)?)
}

/// When a run started, from its time-ordered ID (`run_<uuidv7>`), in
/// milliseconds since 1970.
fn started_ms(run_id: &RunId) -> Option<u64> {
    let hex = run_id.as_str().strip_prefix("run_")?.get(..12)?;
    u64::from_str_radix(hex, 16).ok()
}

/// Deletes run records the workspace's `records` settings no longer keep
/// (older than `keepDays`, 90 days when left out, beyond the newest
/// `keepRuns`). Runs still going
/// (no `report.json` yet) and `keep` are never deleted. Returns how many
/// were removed; failures are logged and skipped.
pub fn prune(
    workspace: &Path,
    records: &shikigami_core::policy::RecordsPolicy,
    keep: &[RunId],
) -> usize {
    let keep_days = records.days_kept();
    if keep_days.is_none() && records.keep_runs.is_none() {
        return 0;
    }
    if let Some(days) = keep_days {
        crate::audit::prune_mcp_log(workspace, days);
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
    let cutoff = keep_days.map(|days| now_ms.saturating_sub(u64::from(days) * 86_400_000));
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
mod interrupted_tests {
    use super::*;
    use crate::event::{RunEvent, RunStatus};
    use shikigami_core::FlowId;

    fn started(run_id: &RunId) -> RunEventEnvelope {
        RunEventEnvelope {
            run_id: run_id.clone(),
            seq: 0,
            at: time::OffsetDateTime::now_utc(),
            call_path: Vec::new(),
            event: RunEvent::RunStarted {
                flow_id: FlowId::new("scn_a"),
                flow_name: "A".into(),
                revision: 3,
                origin: crate::RunOrigin::new(crate::RunTrigger::Cli),
            },
        }
    }

    #[test]
    fn a_line_cut_off_by_the_crash_does_not_spoil_the_record() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = RunId::generate();
        let mut recorder = RunRecorder::create(tmp.path(), &gone).unwrap();
        recorder.write_event(&started(&gone)).unwrap();
        drop(recorder);
        let file = tmp
            .path()
            .join("runs")
            .join(gone.as_str())
            .join("events.jsonl");
        let mut whole = fs::read(&file).unwrap();
        // The process died half way through writing the next event.
        whole.extend_from_slice(b"{\"runId\":\"run_");
        fs::write(&file, whole).unwrap();

        let going = RunId::generate();
        let _live = RunRecorder::create(tmp.path(), &going).unwrap();
        let events = read_events(tmp.path(), &gone).unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[1].event, RunEvent::RunFinished { .. }));
    }

    #[test]
    fn a_run_left_behind_is_closed_but_not_one_still_going() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = RunId::generate();
        let mut recorder = RunRecorder::create(tmp.path(), &gone).unwrap();
        recorder.write_event(&started(&gone)).unwrap();
        // The process "crashes": the lock is released, no report written.
        drop(recorder);

        let going = RunId::generate();
        let mut live = RunRecorder::create(tmp.path(), &going).unwrap();
        live.write_event(&started(&going)).unwrap();
        // Creating `going` already closed `gone`.
        let report = read_report(tmp.path(), &gone).unwrap().unwrap();
        assert_eq!(report.status, RunStatus::Failed);
        assert_eq!(report.error.unwrap().code, RUN_INTERRUPTED);
        assert_eq!(report.revision, 3);
        let events = read_events(tmp.path(), &gone).unwrap();
        assert!(matches!(
            events.last().unwrap().event,
            RunEvent::RunFinished {
                status: RunStatus::Failed,
                ..
            }
        ));

        assert!(close_interrupted(tmp.path()).is_empty());
        assert!(read_report(tmp.path(), &going).unwrap().is_none());
    }

    fn finished(
        run_id: &RunId,
        seq: u64,
        step: &str,
        ms: u64,
        call_path: Vec<shikigami_core::StepId>,
    ) -> RunEventEnvelope {
        RunEventEnvelope {
            run_id: run_id.clone(),
            seq,
            at: time::OffsetDateTime::now_utc(),
            call_path,
            event: RunEvent::StepFinished {
                step_id: shikigami_core::StepId::new(step),
                step_type: "flow.delay".into(),
                outcome: crate::event::StepOutcome::Succeeded,
                duration_ms: ms,
                error: None,
                will_retry: false,
            },
        }
    }

    #[test]
    fn step_times_are_the_median_of_finished_runs_of_the_flow() {
        let tmp = tempfile::tempdir().unwrap();
        for times in [[100, 4000], [300, 6000], [200, 5000]] {
            let id = RunId::generate();
            let mut recorder = RunRecorder::create(tmp.path(), &id).unwrap();
            recorder.write_event(&started(&id)).unwrap();
            recorder
                .write_event(&finished(&id, 1, "s1", times[0], Vec::new()))
                .unwrap();
            recorder
                .write_event(&finished(&id, 2, "s2", times[1], Vec::new()))
                .unwrap();
            // A step of a called flow with the same id is not this flow's.
            recorder
                .write_event(&finished(
                    &id,
                    3,
                    "s1",
                    90_000,
                    vec![shikigami_core::StepId::new("c1")],
                ))
                .unwrap();
            fs::write(
                tmp.path()
                    .join("runs")
                    .join(id.as_str())
                    .join("report.json"),
                "{}",
            )
            .unwrap();
        }
        // A run still going does not count.
        let going = RunId::generate();
        let mut live = RunRecorder::create(tmp.path(), &going).unwrap();
        live.write_event(&started(&going)).unwrap();
        live.write_event(&finished(&going, 1, "s1", 9_000_000, Vec::new()))
            .unwrap();

        let times = step_times(tmp.path(), &FlowId::new("scn_a"), 5);
        assert_eq!(times.get(&shikigami_core::StepId::new("s1")), Some(&200));
        assert_eq!(times.get(&shikigami_core::StepId::new("s2")), Some(&5000));
        // The two newest runs only.
        let times = step_times(tmp.path(), &FlowId::new("scn_a"), 2);
        assert_eq!(times.get(&shikigami_core::StepId::new("s1")), Some(&300));
        assert!(step_times(tmp.path(), &FlowId::new("scn_b"), 5).is_empty());
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
    fn keeps_everything_with_keep_days_zero() {
        let tmp = tempfile::tempdir().unwrap();
        record(tmp.path(), &id_at(1, 1), true);
        let forever = RecordsPolicy {
            keep_days: Some(0),
            ..RecordsPolicy::default()
        };
        assert_eq!(prune(tmp.path(), &forever, &[]), 0);
        assert_eq!(list_runs(tmp.path()).unwrap().len(), 1);
    }

    #[test]
    fn keeps_ninety_days_by_default() {
        let tmp = tempfile::tempdir().unwrap();
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let day = 86_400_000;
        let old = record(tmp.path(), &id_at(now - 91 * day, 1), true);
        let recent = record(tmp.path(), &id_at(now - 89 * day, 2), true);
        assert_eq!(prune(tmp.path(), &RecordsPolicy::default(), &[]), 1);
        let left = list_runs(tmp.path()).unwrap();
        assert_eq!(left, vec![recent]);
        assert!(!left.contains(&old));
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
            failure_screenshots: None,
            manual_screens: None,
        };
        assert_eq!(prune(tmp.path(), &by_days, &[]), 1);
        let left = list_runs(tmp.path()).unwrap();
        assert!(!left.contains(&old));
        assert!(left.contains(&old_running));

        let by_count = RecordsPolicy {
            keep_days: None,
            keep_runs: Some(2),
            failure_screenshots: None,
            manual_screens: None,
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
        // keepDays 0: these ids are from 1970, so only keepRuns decides.
        fs::write(
            &policy,
            r#"{ "records": { "keepRuns": 1, "keepDays": 0 } }"#,
        )
        .unwrap();
        let older = record(tmp.path(), &id_at(1, 1), true);
        let mine = RunId::new(id_at(2, 2));
        let newer = record(tmp.path(), &id_at(3, 3), true);
        let recorder = RunRecorder::create(tmp.path(), &mine)
            .unwrap()
            .prune_on_finish(&policy);
        let report: RunReport = serde_json::from_value(serde_json::json!({
            "runId": mine.as_str(), "flowId": "scn_a", "flowName": "A",
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
