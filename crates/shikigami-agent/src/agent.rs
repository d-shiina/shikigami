//! The agent's runs and its schedule loop.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::Zoned;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shikigami_core::{ErrorPayload, Policy, RunId, ScenarioId, ScenarioService};
use shikigami_runtime::record::RunRecorder;
use shikigami_runtime::{RunOptions, RunOrigin, RunReport, RunTrigger, Runtime};
use tokio_util::sync::CancellationToken;

use crate::schedule::{Schedule, ScheduleState, Schedules, When, name_matches};

/// A run the agent is asked for. Agent runs are unattended: they execute
/// the published version, as `shikigami run <id>` does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub scenario_id: ScenarioId,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub inputs: Map<String, Value>,
    #[serde(default)]
    pub origin: RunOrigin,
}

/// A run in progress.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunningRun {
    pub run_id: RunId,
    pub scenario_id: ScenarioId,
    pub scenario_name: String,
    pub origin: RunOrigin,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
}

/// A schedule as the agent sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStatus {
    pub id: String,
    pub name: String,
    pub scenario_id: ScenarioId,
    pub enabled: bool,
    /// When it fires next (local time, RFC 3339); none for file triggers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<String>,
}

/// What `shikigami agent status` shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub pid: u32,
    pub started_at: String,
    pub workspace: String,
    pub running: Vec<RunningRun>,
    pub schedules: Vec<ScheduleStatus>,
    /// Why schedules are not being read (a broken `schedules.json`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// Called with every report of a run the agent started (notifications).
pub type FinishedHook = Arc<dyn Fn(&RunReport) + Send + Sync>;

struct Active {
    info: RunningRun,
    cancel: CancellationToken,
}

/// What the schedule loop remembers between ticks.
#[derive(Default)]
struct Loop {
    schedules: Vec<Schedule>,
    modified: Option<std::time::SystemTime>,
    next: HashMap<String, Zoned>,
    /// File triggers: files seen per schedule, and new files with the size
    /// they had at the last look (started once the size stops changing).
    seen: HashMap<String, HashSet<PathBuf>>,
    growing: HashMap<String, HashMap<PathBuf, u64>>,
    problem: Option<String>,
}

pub struct Agent {
    svc: Arc<ScenarioService>,
    runtime: Runtime,
    started_at: String,
    active: Mutex<HashMap<RunId, Active>>,
    hooks: Mutex<Vec<FinishedHook>>,
    state: Mutex<Loop>,
    stop: CancellationToken,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Local time with its offset, e.g. `2026-11-06T08:00:00+09:00`.
pub(crate) fn local_text(t: &Zoned) -> String {
    t.strftime("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

fn now_text() -> String {
    local_text(&Zoned::now())
}

impl Agent {
    /// `runtime` should already have the workspace's secrets and policy
    /// (`with_secrets`, `with_policy`) and the PC-wide locks.
    pub fn new(svc: Arc<ScenarioService>, runtime: Runtime) -> Arc<Self> {
        Arc::new(Self {
            svc,
            runtime,
            started_at: now_text(),
            active: Mutex::new(HashMap::new()),
            hooks: Mutex::new(Vec::new()),
            state: Mutex::new(Loop::default()),
            stop: CancellationToken::new(),
        })
    }

    pub fn service(&self) -> &ScenarioService {
        &self.svc
    }

    pub fn local_root(&self) -> &Path {
        self.svc.store().local_root()
    }

    pub fn on_finished(&self, hook: FinishedHook) {
        lock(&self.hooks).push(hook);
    }

    /// Starts the published version of a scenario. Fails like
    /// `shikigami run` does (`NOT_PUBLISHED`, `UNATTENDED_NOT_ALLOWED`, …).
    pub fn start(
        self: &Arc<Self>,
        request: RunRequest,
        schedule_id: Option<String>,
    ) -> Result<RunId, ErrorPayload> {
        let run = self.svc.unattended_run(&request.scenario_id)?;
        let project_dir = self.svc.project_dir(&request.scenario_id).ok();
        let run_id = RunId::generate();
        let root = self.local_root().to_path_buf();
        let mut recorder = RunRecorder::create(&root, &run_id)
            .map_err(|e| ErrorPayload {
                code: "STORAGE_ERROR".into(),
                message: e.to_string(),
                details: None,
            })?
            .prune_on_finish(&Policy::path(self.svc.store().root()));
        let mut origin = request.origin;
        if origin.trigger.is_none() {
            origin.trigger = Some(RunTrigger::Remote);
        }
        let scenario_name = run.scenario.name.clone();
        let handle = self
            .runtime
            .start(
                run.scenario,
                RunOptions {
                    inputs: request.inputs,
                    run_id: Some(run_id.clone()),
                    version: Some(run.version),
                    subscenarios: run.subscenarios,
                    project_dir,
                    full_run: true,
                    origin: origin.clone(),
                    ..RunOptions::default()
                },
            )
            .map_err(|e| {
                let _ = std::fs::remove_dir_all(root.join("runs").join(run_id.as_str()));
                ErrorPayload {
                    code: e.code,
                    message: e.message,
                    details: e.details,
                }
            })?;
        lock(&self.active).insert(
            run_id.clone(),
            Active {
                info: RunningRun {
                    run_id: run_id.clone(),
                    scenario_id: request.scenario_id,
                    scenario_name,
                    origin,
                    started_at: now_text(),
                    schedule_id,
                },
                cancel: handle.cancel_token(),
            },
        );
        let agent = Arc::clone(self);
        let id = run_id.clone();
        tokio::spawn(async move {
            let result = handle
                .wait_with(|e| {
                    if let Err(err) = recorder.write_event(e) {
                        tracing::warn!(error = %err, "failed to record event");
                    }
                })
                .await;
            match result {
                Ok(report) => {
                    if let Err(err) = recorder.finish(&report) {
                        tracing::warn!(error = %err, "failed to write the run report");
                    }
                    let hooks = lock(&agent.hooks).clone();
                    for hook in hooks {
                        hook(&report);
                    }
                }
                Err(e) => tracing::warn!(error = %e, "run task failed"),
            }
            lock(&agent.active).remove(&id);
        });
        Ok(run_id)
    }

    /// Cancels a run the agent started. `false` when it is not running.
    pub fn cancel(&self, run_id: &RunId) -> bool {
        match lock(&self.active).get(run_id) {
            Some(active) => {
                active.cancel.cancel();
                true
            }
            None => false,
        }
    }

    pub fn running(&self) -> Vec<RunningRun> {
        let mut runs: Vec<RunningRun> = lock(&self.active)
            .values()
            .map(|a| a.info.clone())
            .collect();
        runs.sort_by(|a, b| a.run_id.cmp(&b.run_id));
        runs
    }

    pub fn status(&self) -> AgentStatus {
        let state = lock(&self.state);
        let saved = ScheduleState::load(&ScheduleState::path(self.local_root()));
        AgentStatus {
            pid: std::process::id(),
            started_at: self.started_at.clone(),
            workspace: self.svc.store().root().display().to_string(),
            running: self.running(),
            schedules: state
                .schedules
                .iter()
                .map(|s| ScheduleStatus {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    scenario_id: s.scenario_id.clone(),
                    enabled: s.enabled,
                    next: s
                        .enabled
                        .then(|| state.next.get(&s.id).map(local_text))
                        .flatten(),
                    last: saved.last(&s.id).map(|t| local_text(&t)),
                })
                .collect(),
            problem: state.problem.clone(),
        }
    }

    /// Ends [`Agent::serve`] (runs in progress are cancelled).
    pub fn stop(&self) {
        self.stop.cancel();
    }

    pub fn stopping(&self) -> CancellationToken {
        self.stop.clone()
    }

    /// Runs the schedule loop and the local pipe until [`Agent::stop`].
    pub async fn serve(self: Arc<Self>) -> std::io::Result<()> {
        let listener = crate::ipc::Listener::bind(self.local_root())?;
        let ipc = tokio::spawn(crate::ipc::serve(listener, Arc::clone(&self)));
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut n: u64 = 0;
        loop {
            tokio::select! {
                () = self.stop.cancelled() => break,
                _ = tick.tick() => {}
            }
            self.tick(&Zoned::now(), n.is_multiple_of(5));
            n += 1;
        }
        ipc.abort();
        let running: Vec<CancellationToken> = lock(&self.active)
            .values()
            .map(|a| a.cancel.clone())
            .collect();
        for cancel in running {
            cancel.cancel();
        }
        // Give `finally` blocks and records a moment.
        for _ in 0..100 {
            if lock(&self.active).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(())
    }

    /// One look at the schedules: reload them when the file changed, start
    /// what is due, and (when `files`) look for new files.
    pub fn tick(self: &Arc<Self>, now: &Zoned, files: bool) {
        self.reload(now);
        let due: Vec<Schedule> = {
            let mut state = lock(&self.state);
            let due: Vec<Schedule> = state
                .schedules
                .iter()
                .filter(|s| s.enabled)
                .filter(|s| state.next.get(&s.id).is_some_and(|t| t <= now))
                .cloned()
                .collect();
            for s in &due {
                match s.when.next_after(now) {
                    Some(t) => state.next.insert(s.id.clone(), t),
                    None => state.next.remove(&s.id),
                };
            }
            due
        };
        for schedule in due {
            self.fire(&schedule, Map::new(), now);
        }
        if files {
            self.look_for_files(now);
        }
    }

    fn reload(&self, now: &Zoned) {
        let path = Schedules::path(self.local_root());
        let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        let mut state = lock(&self.state);
        if state.modified == modified && (modified.is_some() || state.schedules.is_empty()) {
            return;
        }
        state.modified = modified;
        let schedules = match Schedules::load(&path) {
            Ok(s) => {
                state.problem = None;
                s.schedules
            }
            Err(e) => {
                tracing::warn!(error = %e, "schedules not read");
                state.problem = Some(e.to_string());
                return;
            }
        };
        let saved = ScheduleState::load(&ScheduleState::path(self.local_root()));
        let mut next = HashMap::new();
        for s in &schedules {
            // From the last fire (so an edit does not fire twice), but never
            // making up for times missed while the agent was off.
            let from = match saved.last(&s.id) {
                Some(last) if last > *now => last,
                _ => now.clone(),
            };
            if let Some(t) = s.when.next_after(&from) {
                next.insert(s.id.clone(), t);
            }
        }
        // File triggers keep what they have seen; new ones start from the
        // files there now.
        let ids: HashSet<String> = schedules.iter().map(|s| s.id.clone()).collect();
        state.seen.retain(|id, _| ids.contains(id));
        state.growing.retain(|id, _| ids.contains(id));
        state.schedules = schedules;
        state.next = next;
        let file_schedules: Vec<Schedule> = state
            .schedules
            .iter()
            .filter(|s| matches!(s.when, When::FileAdded { .. }))
            .cloned()
            .collect();
        for s in file_schedules {
            if !state.seen.contains_key(&s.id) {
                let files = self
                    .matching_files(&s)
                    .into_iter()
                    .map(|(p, _)| p)
                    .collect();
                state.seen.insert(s.id.clone(), files);
            }
        }
    }

    fn watched_folder(&self, s: &Schedule) -> Option<PathBuf> {
        let When::FileAdded { folder, .. } = &s.when else {
            return None;
        };
        let folder = Path::new(folder);
        if folder.is_absolute() {
            Some(folder.to_path_buf())
        } else {
            Some(self.svc.project_dir(&s.scenario_id).ok()?.join(folder))
        }
    }

    fn matching_files(&self, s: &Schedule) -> Vec<(PathBuf, u64)> {
        let When::FileAdded { pattern, .. } = &s.when else {
            return Vec::new();
        };
        let Some(folder) = self.watched_folder(s) else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(&folder) else {
            return Vec::new();
        };
        let mut files: Vec<(PathBuf, u64)> = entries
            .filter_map(Result::ok)
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                let name = e.file_name().to_string_lossy().into_owned();
                // Office lock files and partial downloads are not new files.
                let temporary = name.starts_with("~$")
                    || name.ends_with(".crdownload")
                    || name.ends_with(".partial")
                    || name.ends_with(".tmp");
                (meta.is_file() && !temporary && name_matches(pattern, &name))
                    .then(|| (e.path(), meta.len()))
            })
            .collect();
        files.sort();
        files
    }

    fn look_for_files(self: &Arc<Self>, now: &Zoned) {
        let schedules: Vec<Schedule> = lock(&self.state)
            .schedules
            .iter()
            .filter(|s| s.enabled && matches!(s.when, When::FileAdded { .. }))
            .cloned()
            .collect();
        for s in schedules {
            let files = self.matching_files(&s);
            let ready: Vec<PathBuf> = {
                let mut state = lock(&self.state);
                let seen = state.seen.get(&s.id).cloned().unwrap_or_default();
                let before = state.growing.remove(&s.id).unwrap_or_default();
                let mut growing = HashMap::new();
                let mut ready = Vec::new();
                for (path, size) in files {
                    if seen.contains(&path) {
                        continue;
                    }
                    // Started once its size is the same as at the last look.
                    if before.get(&path) == Some(&size) {
                        ready.push(path);
                    } else {
                        growing.insert(path, size);
                    }
                }
                state.growing.insert(s.id.clone(), growing);
                let seen = state.seen.entry(s.id.clone()).or_default();
                seen.extend(ready.iter().cloned());
                ready
            };
            let When::FileAdded { input, .. } = &s.when else {
                continue;
            };
            for path in ready {
                let mut inputs = Map::new();
                if let Some(name) = input {
                    inputs.insert(name.clone(), Value::String(path.display().to_string()));
                }
                self.fire(&s, inputs, now);
            }
        }
    }

    fn fire(self: &Arc<Self>, s: &Schedule, extra: Map<String, Value>, now: &Zoned) {
        let state_path = ScheduleState::path(self.local_root());
        let mut saved = ScheduleState::load(&state_path);
        saved
            .last_fired
            .insert(s.id.clone(), now.timestamp().to_string());
        saved.save(&state_path);
        // A file trigger may start several runs; a timed schedule waits for
        // its last run to end.
        let timed = !matches!(s.when, When::FileAdded { .. });
        if timed
            && self
                .running()
                .iter()
                .any(|r| r.schedule_id.as_deref() == Some(s.id.as_str()))
        {
            tracing::warn!(schedule = %s.name, "skipped: the previous run is still going");
            return;
        }
        let mut inputs = s.inputs.clone();
        inputs.extend(extra);
        let request = RunRequest {
            scenario_id: s.scenario_id.clone(),
            inputs,
            origin: RunOrigin {
                job_id: Some(s.id.clone()),
                ..RunOrigin::new(RunTrigger::Schedule).requested_by(s.name.clone())
            },
        };
        match self.start(request, Some(s.id.clone())) {
            Ok(run_id) => tracing::info!(schedule = %s.name, run = %run_id.as_str(), "started"),
            Err(e) => {
                tracing::warn!(schedule = %s.name, code = %e.code, error = %e.message, "could not start");
                self.report_refusal(s, &e, now);
            }
        }
    }

    /// A schedule that could not start (not published, refused by the
    /// policy) is told to the finished hooks as a failed report, so it is
    /// noticed like a failed run.
    fn report_refusal(&self, s: &Schedule, e: &ErrorPayload, now: &Zoned) {
        let at = time::OffsetDateTime::from_unix_timestamp(now.timestamp().as_second())
            .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
        let report = RunReport {
            run_id: RunId::generate(),
            scenario_id: s.scenario_id.clone(),
            scenario_name: self
                .svc
                .get(&s.scenario_id)
                .map(|sc| sc.name)
                .unwrap_or_else(|_| s.scenario_id.to_string()),
            revision: 0,
            version: None,
            status: shikigami_runtime::RunStatus::Failed,
            started_at: at,
            finished_at: at,
            error: Some(shikigami_runtime::RunError {
                details: e.details.clone(),
                ..shikigami_runtime::RunError::new(e.code.clone(), e.message.clone())
            }),
            outputs: Map::new(),
            subscenarios: Vec::new(),
            origin: RunOrigin {
                job_id: Some(s.id.clone()),
                ..RunOrigin::new(RunTrigger::Schedule).requested_by(s.name.clone())
            },
        };
        let hooks = lock(&self.hooks).clone();
        for hook in hooks {
            hook(&report);
        }
    }
}
