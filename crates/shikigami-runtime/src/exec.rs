//! The flow interpreter.
//!
//! Control flow (`control.*`) and variable assignment are executed here;
//! every other step type is dispatched to a registered [`ActionHandler`].
//! The interpreter walks the step tree directly, so step IDs in events map
//! one-to-one to the document Studio and AI clients edit.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use shikigami_core::call::MAX_CALL_DEPTH;
use shikigami_core::expr::{self, Expr};
use shikigami_core::policy::{Policy, TargetDef};
use shikigami_core::project;
use shikigami_core::registry::{builtin, control, flow, is_control_type};
use shikigami_core::resource::{DESKTOP_INPUT, ResourceDef, resource_keys};
use shikigami_core::secret::SecretProvider;
use shikigami_core::validate::LAST_ERROR_VAR;
use shikigami_core::{Flow, FlowId, OnError, RetryPolicy, RunId, Step, StepId};
use time::OffsetDateTime;
use tokio::sync::{OwnedMutexGuard, Semaphore, mpsc};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::debug::{BlockKey, DebugCommand, Debugger, PauseReason, ResumeAction, Waited};
use crate::event::{
    LogLevel, RunError, RunEvent, RunEventEnvelope, RunSnapshot, RunStatus, StepOutcome,
};
use crate::handler::{ActionHandler, ActionInput, BoxFuture, StepError};
use crate::runlog::RunLog;
use crate::screens::Moment;

pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_WAIT_INTERVAL_MS: u64 = 500;
/// How long the picture of the screen at a failure may take.
const FAILURE_SHOT_LIMIT: Duration = Duration::from_secs(10);
const DEFAULT_MAX_ITERATIONS: u64 = 1000;
const MASK: &str = "***";
/// Longest value (in characters, as JSON text for arrays and objects)
/// recorded in full by `variableChanged`.
const VALUE_PREVIEW_CHARS: usize = 1000;
const MIN_SECRET_PART_CHARS: usize = 4;

// ---------------------------------------------------------------------------
// Event emission with secret masking

#[derive(Clone)]
pub struct Emitter {
    inner: Arc<EmitterInner>,
    /// `flow.call` steps this emitter reports from inside.
    call_path: Arc<[StepId]>,
}

struct EmitterInner {
    run_id: RunId,
    // Held while sending, so parallel branches deliver events in `seq` order
    // (log polling relies on it: `get_run_logs(afterSeq)`).
    seq: Mutex<u64>,
    tx: mpsc::UnboundedSender<RunEventEnvelope>,
    secrets: RwLock<Vec<String>>,
    snapshot: Arc<Mutex<RunSnapshot>>,
    /// The readable log in the flow's `logs/` folder, for full runs.
    log: Mutex<Option<RunLog>>,
    /// The last step that failed for good and its params as it rendered
    /// them, in whichever flow it ran (a called flow's variables are gone
    /// by the time the failure reaches the top).
    failed: Mutex<Option<(StepId, Value)>>,
    /// Where the pictures for the 手順書 go, and which steps have one.
    screens: Option<crate::screens::Screens>,
}

impl Emitter {
    pub(crate) fn new(
        run_id: RunId,
        tx: mpsc::UnboundedSender<RunEventEnvelope>,
        snapshot: Arc<Mutex<RunSnapshot>>,
        log: Option<RunLog>,
    ) -> Self {
        Self {
            inner: Arc::new(EmitterInner {
                run_id,
                seq: Mutex::new(0),
                tx,
                secrets: RwLock::new(Vec::new()),
                snapshot,
                log: Mutex::new(log),
                failed: Mutex::new(None),
                screens: None,
            }),
            call_path: Arc::from([]),
        }
    }

    /// Keeps pictures of the screens for the 手順書 in `dir` (see
    /// [`crate::screens`]). Call before the emitter is shared.
    pub(crate) fn with_screens(mut self, dir: PathBuf) -> Self {
        if let Some(inner) = Arc::get_mut(&mut self.inner) {
            inner.screens = Some(crate::screens::Screens::new(dir));
        }
        self
    }

    /// The next picture's path for `step`, unless it has one already (in
    /// this called flow) or the run keeps none.
    pub(crate) fn screen_path(&self, step: &StepId, extension: &str) -> Option<(PathBuf, String)> {
        self.inner
            .screens
            .as_ref()?
            .claim(&self.call_path, step, extension)
    }

    /// Gives back a claimed picture that was not taken.
    pub(crate) fn release_screen(&self, step: &StepId) {
        if let Some(screens) = self.inner.screens.as_ref() {
            screens.release(&self.call_path, step);
        }
    }

    /// The same run, reporting from inside the flow `call` runs.
    fn nested(&self, call: &StepId) -> Self {
        let mut path = self.call_path.to_vec();
        path.push(call.clone());
        Self {
            inner: self.inner.clone(),
            call_path: Arc::from(path),
        }
    }

    /// How many calls deep this emitter reports from.
    fn call_depth(&self) -> usize {
        self.call_path.len()
    }

    pub(crate) fn add_secret(&self, value: &Value) {
        self.add_secret_part(value, 0);
    }

    /// Each part of a structured secret is secret too, so copying one field
    /// elsewhere stays masked. Parts shorter than `MIN_SECRET_PART_CHARS`
    /// (ids, flags, ...) are left out: masking is by substring, and they
    /// would blank unrelated text.
    fn add_secret_part(&self, value: &Value, depth: usize) {
        match value {
            Value::Array(items) => items
                .iter()
                .for_each(|v| self.add_secret_part(v, depth + 1)),
            Value::Object(map) => map
                .values()
                .for_each(|v| self.add_secret_part(v, depth + 1)),
            Value::Null | Value::Bool(_) => return,
            _ => {}
        }
        let text = expr::to_display(value);
        if text.is_empty() || (depth > 0 && text.chars().count() < MIN_SECRET_PART_CHARS) {
            return;
        }
        if let Ok(mut secrets) = self.inner.secrets.write()
            && !secrets.contains(&text)
        {
            secrets.push(text);
            // Longest first so overlapping secrets are fully masked.
            secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        }
    }

    pub(crate) fn mask(&self, text: &str) -> String {
        let Ok(secrets) = self.inner.secrets.read() else {
            return text.to_owned();
        };
        secrets
            .iter()
            .fold(text.to_owned(), |acc, s| acc.replace(s.as_str(), MASK))
    }

    fn is_secret(&self, text: &str) -> bool {
        self.inner
            .secrets
            .read()
            .is_ok_and(|secrets| secrets.iter().any(|s| s == text))
    }

    pub(crate) fn mask_value(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.mask(s)),
            // A secret number (a PIN, ...) copied as a number.
            Value::Number(_) if self.is_secret(&expr::to_display(value)) => {
                Value::String(MASK.into())
            }
            Value::Array(items) => Value::Array(items.iter().map(|v| self.mask_value(v)).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), self.mask_value(v)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    pub(crate) fn mask_error(&self, mut error: RunError) -> RunError {
        error.message = self.mask(&error.message);
        error.details = error.details.map(|d| self.mask_value(&d));
        error
    }

    pub(crate) fn emit(&self, event: RunEvent) {
        let event = match event {
            RunEvent::Log {
                level,
                message,
                step_id,
            } => RunEvent::Log {
                level,
                message: self.mask(&message),
                step_id,
            },
            RunEvent::StepFinished {
                step_id,
                step_type,
                outcome,
                duration_ms,
                error,
                will_retry,
            } => RunEvent::StepFinished {
                step_id,
                step_type,
                outcome,
                duration_ms,
                error: error.map(|e| self.mask_error(e)),
                will_retry,
            },
            RunEvent::RunFinished {
                status,
                error,
                duration_ms,
            } => RunEvent::RunFinished {
                status,
                error: error.map(|e| self.mask_error(e)),
                duration_ms,
            },
            other => other,
        };
        let mut seq = match self.inner.seq.lock() {
            Ok(seq) => seq,
            Err(poisoned) => poisoned.into_inner(),
        };
        let envelope = RunEventEnvelope {
            run_id: self.inner.run_id.clone(),
            seq: *seq,
            at: OffsetDateTime::now_utc(),
            call_path: self.call_path.to_vec(),
            event,
        };
        *seq += 1;
        if let Ok(mut log) = self.inner.log.lock()
            && let Some(log) = log.as_mut()
        {
            log.write(&envelope);
        }
        // The receiver may have been dropped (fire-and-forget runs); the run
        // continues regardless.
        let _ = self.inner.tx.send(envelope);
    }

    /// Where a picture of the screen at the failure goes, when the run
    /// writes a readable log (whole runs of a flow in its folder).
    pub(crate) fn failure_shot_path(&self) -> Option<PathBuf> {
        let log = self.inner.log.lock().ok()?;
        log.as_ref().map(RunLog::failure_shot)
    }

    /// Keeps the params a step failed with, for [`Executor::capture_failure`].
    fn failed_with(&self, step: &StepId, params: &Value) {
        if let Ok(mut failed) = self.inner.failed.lock() {
            *failed = Some((step.clone(), params.clone()));
        }
    }

    /// The rendered params of `step`, when it is the step that failed last.
    fn failed_params(&self, step: &StepId) -> Option<Value> {
        let failed = self.inner.failed.lock().ok()?;
        failed
            .as_ref()
            .filter(|(id, _)| id == step)
            .map(|(_, params)| params.clone())
    }

    /// Names the run's log after how it ended. Call after `RunFinished`.
    pub(crate) fn finish_log(&self, status: RunStatus) {
        let log = match self.inner.log.lock() {
            Ok(mut log) => log.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(log) = log {
            log.finish(status);
        }
    }

    pub(crate) fn variable_changed(
        &self,
        name: &str,
        value: &Value,
        step_id: Option<&StepId>,
        iteration: Option<usize>,
        secret: bool,
    ) {
        let (value, truncated) = if secret {
            (Value::String(MASK.into()), false)
        } else {
            preview(self.mask_value(value))
        };
        self.emit(RunEvent::VariableChanged {
            variable: name.to_owned(),
            value,
            step_id: step_id.cloned(),
            iteration,
            secret,
            truncated,
        });
    }

    pub(crate) fn human_action_required(&self, message: String, step_id: StepId) {
        self.emit(RunEvent::HumanActionRequired {
            step_id,
            message: self.mask(&message),
        });
    }

    pub(crate) fn log(&self, level: LogLevel, message: String, step_id: Option<StepId>) {
        self.emit(RunEvent::Log {
            level,
            message,
            step_id,
        });
    }

    pub(crate) fn update_snapshot(&self, f: impl FnOnce(&mut RunSnapshot)) {
        if let Ok(mut snapshot) = self.inner.snapshot.lock() {
            f(&mut snapshot);
        }
    }
}

/// Cuts a value recorded in `variableChanged` down to a preview when it is
/// large, so loops over big tables do not bloat the run record. Returns the
/// value and whether it was cut.
fn preview(value: Value) -> (Value, bool) {
    fn cut(text: &str) -> String {
        let end = text
            .char_indices()
            .nth(VALUE_PREVIEW_CHARS)
            .map_or(text.len(), |(i, _)| i);
        format!("{}…", &text[..end])
    }
    match value {
        Value::String(s) if s.chars().count() > VALUE_PREVIEW_CHARS => {
            (Value::String(cut(&s)), true)
        }
        value @ (Value::Array(_) | Value::Object(_)) => {
            let text = value.to_string();
            if text.chars().count() > VALUE_PREVIEW_CHARS {
                (Value::String(cut(&text)), true)
            } else {
                (value, false)
            }
        }
        other => (other, false),
    }
}

// ---------------------------------------------------------------------------
// Exclusive resources shared by every run of one Runtime

/// Tells whether this PC's desktop can take mouse and keyboard input now:
/// `None` when it can, else why not (the screen is locked, nobody is signed
/// in, the remote session is disconnected).
pub type DesktopProbe = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// Keeps the screen on and the PC awake (so it does not turn off or sleep
/// between nodes) until the returned value is dropped.
pub type KeepAwake = Arc<dyn Fn() -> Box<dyn Send + Sync> + Send + Sync>;

#[derive(Default)]
pub(crate) struct ResourceLocks {
    pub(crate) locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Folder of the lock files that make [`DESKTOP_INPUT`] exclusive across
    /// processes (Studio, the MCP server, the CLI, the agent).
    pub(crate) pc_lock_dir: Option<PathBuf>,
    pub(crate) desktop_probe: Option<DesktopProbe>,
    pub(crate) keep_awake: Option<KeepAwake>,
}

/// Held while a step uses a resource.
pub(crate) enum ResourceGuard {
    #[allow(dead_code)]
    Local(OwnedMutexGuard<()>),
    /// Closing the file releases the lock.
    #[allow(dead_code)]
    Pc(std::fs::File),
}

impl ResourceLocks {
    fn lock_for(&self, name: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = match self.locks.lock() {
            Ok(locks) => locks,
            Err(poisoned) => poisoned.into_inner(),
        };
        locks.entry(name.to_owned()).or_default().clone()
    }

    /// Acquires all `names` in a fixed order so two steps needing the same
    /// set can never deadlock.
    /// `names` must be sorted and deduplicated (see `resource_keys`).
    /// [`DESKTOP_INPUT`] is also taken PC-wide, and refused while the
    /// desktop cannot take input (`DESKTOP_UNAVAILABLE`).
    /// While the screen is locked, waits up to `unlock` for it to be
    /// unlocked (`policy.json` `desktop.waitUnlockedMinutes`), calling
    /// `waiting` once when it starts to wait.
    async fn acquire(
        &self,
        names: &[String],
        unlock: Duration,
        waiting: &(dyn Fn(&str) + Sync),
    ) -> Result<Vec<ResourceGuard>, RunError> {
        let mut guards = Vec::with_capacity(names.len() + 1);
        let mut said = false;
        for name in names {
            if name == DESKTOP_INPUT {
                self.wait_desktop(unlock, waiting, &mut said).await?;
            }
            guards.push(ResourceGuard::Local(self.lock_for(name).lock_owned().await));
            if name == DESKTOP_INPUT
                && let Some(dir) = &self.pc_lock_dir
            {
                guards.push(ResourceGuard::Pc(pc_lock(dir, name).await?));
                // The screen may have locked while waiting.
                self.wait_desktop(unlock, waiting, &mut said).await?;
            }
        }
        Ok(guards)
    }

    async fn wait_desktop(
        &self,
        unlock: Duration,
        waiting: &(dyn Fn(&str) + Sync),
        said: &mut bool,
    ) -> Result<(), RunError> {
        let until = Instant::now() + unlock;
        loop {
            match self.check_desktop() {
                Err(e) if Instant::now() < until => {
                    if !*said {
                        *said = true;
                        let reason = e
                            .details
                            .as_ref()
                            .and_then(|d| d.get("reason"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        waiting(&reason);
                    }
                    tokio::time::sleep(UNLOCK_POLL.min(until - Instant::now())).await;
                }
                other => return other,
            }
        }
    }

    fn check_desktop(&self) -> Result<(), RunError> {
        match self.desktop_probe.as_ref().and_then(|probe| probe()) {
            None => Ok(()),
            Some(reason) => Err(RunError {
                details: Some(serde_json::json!({ "reason": reason })),
                ..RunError::new(
                    "DESKTOP_UNAVAILABLE",
                    format!("the desktop cannot take mouse and keyboard input now: {reason}"),
                )
            }),
        }
    }
}

/// How often a node waiting for the screen to be unlocked looks again.
const UNLOCK_POLL: Duration = Duration::from_secs(2);

/// Waits for the PC-wide lock file of `name` (polling, so the caller's
/// cancellation still applies while it waits).
async fn pc_lock(dir: &Path, name: &str) -> Result<std::fs::File, RunError> {
    let storage = |e: std::io::Error| {
        RunError::new(
            "STORAGE_ERROR",
            format!("could not open the lock for {name}: {e}"),
        )
    };
    std::fs::create_dir_all(dir).map_err(storage)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(format!("{name}.lock")))
        .map_err(storage)?;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(storage(e)),
        }
    }
}

/// How long `finally` may take after a run was cancelled.
pub(crate) const FINALLY_GRACE: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Interpreter

pub(crate) enum Proceed {
    Next,
    Break,
    Continue,
    /// Interactive runs: read the step again from the current revision and
    /// run it (after a pause that swapped the flow, or a retry).
    Retry,
}

pub(crate) enum Interrupt {
    Failed(RunError),
    Cancelled,
}

impl From<RunError> for Interrupt {
    fn from(e: RunError) -> Self {
        Self::Failed(e)
    }
}

type StepResult = Result<Proceed, Interrupt>;

pub(crate) struct Executor {
    pub run_id: RunId,
    pub handlers: Arc<HashMap<String, Arc<dyn ActionHandler>>>,
    /// Exclusive resources per step type.
    pub resource_defs: Arc<HashMap<String, Vec<ResourceDef>>>,
    /// Params naming files or folders, per step type.
    pub path_params: Arc<HashMap<String, Vec<String>>>,
    /// Folder of the flow this executor runs: relative paths in path
    /// params are resolved from it.
    pub project_dir: Option<Arc<Path>>,
    /// Folders of the flows `flow.call` can run.
    pub project_dirs: Arc<HashMap<FlowId, PathBuf>>,
    /// Step types with their own default timeout.
    pub default_timeouts: Arc<HashMap<String, u64>>,
    pub secrets: Option<Arc<dyn SecretProvider>>,
    pub vars: Map<String, Value>,
    pub secret_vars: Vec<String>,
    /// Item index when running inside an iteration of a concurrent
    /// `forEach` (the innermost one), reported with variable changes.
    pub iteration: Option<usize>,
    pub emitter: Emitter,
    pub cancel: CancellationToken,
    /// Pressed stop a second time: `finally` blocks after a stop end now
    /// instead of getting their grace period.
    pub force: CancellationToken,
    pub default_timeout_ms: u64,
    pub default_retry: Option<RetryPolicy>,
    pub default_on_error: OnError,
    pub resources: Arc<ResourceLocks>,
    /// Set for interactive runs, on the main line only (not in parallel
    /// branches), called flows included.
    pub debug: Option<Arc<Debugger>>,
    /// The called flow this runs, if any: its steps are the snapshot
    /// the run was given, not the live revision `debug` holds, so blocks run
    /// as written (still pausing) and a swapped-in revision waits for the
    /// caller.
    pub in_call: Option<FlowId>,
    /// How many enclosing steps handle an error (a `try` with a `catch`, a
    /// `wait.until` with `onError: continue`): errors there do not pause.
    pub handled_depth: u32,
    /// Flows `flow.call` can run, as they were when the run started.
    pub library: Arc<HashMap<FlowId, Arc<Flow>>>,
    /// Params naming sites and programs, per step type.
    pub target_defs: Arc<HashMap<String, Vec<TargetDef>>>,
    /// The workspace policy as it was when the run started.
    pub policy: Arc<Policy>,
}

fn expr_error(e: expr::ExprError) -> RunError {
    // The name in the details lets clients (Studio) word the error themselves.
    let details = match &e {
        expr::ExprError::UndefinedVariable(name) => Some(serde_json::json!({ "variable": name })),
        expr::ExprError::UnknownFunction(name) => Some(serde_json::json!({ "function": name })),
        _ => None,
    };
    RunError {
        details,
        ..RunError::new(e.code(), e.to_string())
    }
}

fn param_str<'a>(step: &'a Step, key: &str) -> Result<&'a str, RunError> {
    step.params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| RunError::new("INVALID_PARAMS", format!("'{key}' must be a string")))
}

fn duration_ms(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

impl Executor {
    pub(crate) fn new_from(flow: &Flow, base: Executor) -> Self {
        Self {
            default_timeout_ms: flow
                .settings
                .default_timeout_ms
                .unwrap_or(base.default_timeout_ms),
            default_retry: flow.settings.default_retry.or(base.default_retry),
            default_on_error: flow.settings.on_error.unwrap_or(base.default_on_error),
            ..base
        }
    }

    /// An executor for a parallel branch: same run, own copy of the variables.
    fn fork(&self, cancel: CancellationToken) -> Self {
        Self {
            run_id: self.run_id.clone(),
            handlers: self.handlers.clone(),
            resource_defs: self.resource_defs.clone(),
            path_params: self.path_params.clone(),
            project_dir: self.project_dir.clone(),
            project_dirs: self.project_dirs.clone(),
            default_timeouts: self.default_timeouts.clone(),
            secrets: self.secrets.clone(),
            vars: self.vars.clone(),
            secret_vars: self.secret_vars.clone(),
            iteration: self.iteration,
            emitter: self.emitter.clone(),
            cancel,
            force: self.force.clone(),
            default_timeout_ms: self.default_timeout_ms,
            default_retry: self.default_retry,
            default_on_error: self.default_on_error,
            resources: self.resources.clone(),
            debug: None,
            in_call: self.in_call.clone(),
            handled_depth: 0,
            library: self.library.clone(),
            target_defs: self.target_defs.clone(),
            policy: self.policy.clone(),
        }
    }

    fn eval(&self, source: &str) -> Result<Value, RunError> {
        expr::evaluate(source, &self.vars).map_err(expr_error)
    }

    /// Reads a numeric param: an integer literal or a `{{ expr }}` template
    /// (strings are templates in every non-expression param).
    fn eval_number(&self, step: &Step, key: &str) -> Result<f64, RunError> {
        let value = match step.params.get(key) {
            Some(text @ Value::String(_)) => {
                expr::render_value(text, &self.vars).map_err(expr_error)?
            }
            Some(other) => other.clone(),
            None => {
                return Err(RunError::new(
                    "INVALID_PARAMS",
                    format!("'{key}' is required"),
                ));
            }
        };
        value
            .as_f64()
            .ok_or_else(|| RunError::new("EXPR_TYPE", format!("'{key}' must evaluate to a number")))
    }

    /// Assigns a variable and reports it as `variableChanged`. `step_id` is
    /// the step that assigned it (`None` for inputs and defaults).
    pub(crate) fn set_var(&mut self, name: &str, value: Value, step_id: Option<&StepId>) {
        let secret = self.secret_vars.iter().any(|s| s == name);
        if secret {
            self.emitter.add_secret(&value);
        }
        self.emitter
            .variable_changed(name, &value, step_id, self.iteration, secret);
        self.vars.insert(name.to_owned(), value);
    }

    /// Runs a control step's block. Interactive runs read each step from
    /// the current revision as they reach it (see `debug`).
    fn sub_block<'a>(&'a mut self, parent: &'a Step, name: &'a str) -> BoxFuture<'a, StepResult> {
        match self.debug.clone() {
            Some(debug) => match self.in_call.clone() {
                Some(flow) => self.called_block(debug, flow, parent.block(name)),
                None => self.live_block(
                    debug,
                    BlockKey::Child {
                        parent: parent.id.clone(),
                        name: name.to_owned(),
                    },
                ),
            },
            None => self.block(parent.block(name)),
        }
    }

    /// Runs the flow's top-level steps.
    pub(crate) fn top_block<'a>(&'a mut self, steps: &'a [Step]) -> BoxFuture<'a, StepResult> {
        match self.debug.clone() {
            Some(debug) => self.live_block(debug, BlockKey::Top),
            None => self.block(steps),
        }
    }

    fn live_block(&mut self, debug: Arc<Debugger>, key: BlockKey) -> BoxFuture<'_, StepResult> {
        Box::pin(async move {
            debug.push_frame(key.clone());
            let mut prev: Option<StepId> = None;
            let result = loop {
                // A revision swapped in while paused inside a call applies
                // once the run is back in the open flow.
                if debug.take_updated() {
                    self.adopt(&debug.flow());
                }
                let Some(step) = debug.next_step(&key, prev.as_ref()) else {
                    break Ok(Proceed::Next);
                };
                debug.set_current(Some(step.id.clone()));
                match self.step(&step).await {
                    // A step the new revision removed (skipped while paused)
                    // leaves the cursor where it was.
                    Ok(Proceed::Next) if !debug.in_block(&key, &step.id) => {}
                    Ok(Proceed::Next) => {
                        debug.finished(step.id.clone());
                        prev = Some(step.id);
                    }
                    Ok(Proceed::Retry) => {}
                    other => break other,
                }
            };
            debug.pop_frame();
            result
        })
    }

    /// Runs a block of a called flow in an interactive run: the steps
    /// as given, pausing like the caller's, and running a step again when a
    /// pause says so.
    fn called_block<'a>(
        &'a mut self,
        debug: Arc<Debugger>,
        flow: FlowId,
        steps: &'a [Step],
    ) -> BoxFuture<'a, StepResult> {
        Box::pin(async move {
            debug.push_frame(BlockKey::Called { flow });
            let mut index = 0;
            let result = loop {
                let Some(step) = steps.get(index) else {
                    break Ok(Proceed::Next);
                };
                match self.step(step).await {
                    Ok(Proceed::Next) => index += 1,
                    Ok(Proceed::Retry) => {}
                    other => break other,
                }
            };
            debug.pop_frame();
            result
        })
    }

    /// Runs a block whose errors an enclosing step handles (when `handled`).
    async fn handled_block(&mut self, handled: bool, parent: &Step, name: &str) -> StepResult {
        let depth = u32::from(handled);
        self.handled_depth += depth;
        let result = self.sub_block(parent, name).await;
        self.handled_depth -= depth;
        result
    }

    fn effective_on_error(&self, step: &Step) -> OnError {
        step.on_error.unwrap_or(self.default_on_error)
    }

    /// Whether `error` at `step` should pause the run: interactive, and
    /// nothing in the flow handles it.
    fn pauses_on_error(&self, step: &Step, error: &RunError) -> bool {
        let Some(debug) = &self.debug else {
            return false;
        };
        let own_on_error = !is_control_type(&step.step_type)
            || step.step_type == control::WAIT_UNTIL
            || step.step_type == flow::CALL;
        debug.pause_on_error()
            && !debug.is_given_up(error)
            && self.handled_depth == 0
            && !(own_on_error && self.effective_on_error(step) == OnError::Continue)
    }

    /// Values of all variables for a `paused` event.
    fn variable_values(&self) -> Map<String, Value> {
        self.vars
            .iter()
            .map(|(name, value)| {
                let value = if self.secret_vars.iter().any(|s| s == name) {
                    Value::String(MASK.into())
                } else {
                    preview(self.emitter.mask_value(value)).0
                };
                (name.clone(), value)
            })
            .collect()
    }

    /// Pauses before or after `step` and waits for a person. Returns the
    /// command and whether a newer revision was swapped in meanwhile.
    async fn pause(
        &mut self,
        debug: &Debugger,
        reason: PauseReason,
        step: &Step,
        error: Option<&RunError>,
    ) -> Result<(DebugCommand, bool), Interrupt> {
        let editable = self
            .vars
            .keys()
            .filter(|name| !self.secret_vars.contains(name))
            .cloned()
            .collect();
        debug.enter_pause(reason, editable);
        self.emitter.update_snapshot(|s| {
            s.status = RunStatus::Paused;
            s.current_step = Some(step.id.clone());
        });
        self.emitter.emit(RunEvent::Paused {
            step_id: step.id.clone(),
            step_type: step.step_type.clone(),
            reason,
            error: error.map(|e| self.emitter.mask_error(e.clone())),
            variables: self.variable_values(),
            revision: debug.flow().revision,
        });
        let waited = Instant::now();
        let command = loop {
            let waited = tokio::select! {
                biased;
                () = self.cancel.cancelled() => {
                    debug.leave_pause();
                    return Err(Interrupt::Cancelled);
                }
                waited = debug.wait() => waited,
            };
            match waited {
                Waited::Resume(command) => break command,
                // A person changed a value while looking at the pause.
                Waited::Set(name, value) => self.set_var(&name, value, None),
            }
        };
        debug.add_paused(duration_ms(waited));
        // Inside a call the steps and variables are the callee's: the caller
        // adopts a new revision when it gets back (see `live_block`).
        let updated = self.in_call.is_none() && debug.take_updated();
        if updated {
            self.adopt(&debug.flow());
        }
        self.emitter
            .update_snapshot(|s| s.status = RunStatus::Running);
        self.emitter.emit(RunEvent::Resumed {
            action: match command {
                DebugCommand::StepOver => ResumeAction::StepOver,
                DebugCommand::StepInto => ResumeAction::StepInto,
                DebugCommand::StepOut => ResumeAction::StepOut,
                DebugCommand::Retry => ResumeAction::Retry,
                DebugCommand::Skip => ResumeAction::Skip,
                DebugCommand::Abort => ResumeAction::Abort,
                _ => ResumeAction::Continue,
            },
            revision: updated.then(|| debug.flow().revision),
        });
        Ok((command, updated))
    }

    /// Catches up with a revision swapped in while paused: newly declared
    /// variables get their defaults (values of the others stay), and the
    /// flow settings apply from now on.
    fn adopt(&mut self, flow: &Flow) {
        self.secret_vars = flow
            .variables
            .iter()
            .filter(|v| v.secret)
            .map(|v| v.name.clone())
            .collect();
        for var in &flow.variables {
            if !self.vars.contains_key(&var.name) {
                let value = var.default.clone().unwrap_or(Value::Null);
                if var.secret {
                    self.emitter.add_secret(&value);
                }
                self.set_var(&var.name, value, None);
            }
        }
        self.default_timeout_ms = flow
            .settings
            .default_timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        self.default_retry = flow.settings.default_retry;
        self.default_on_error = flow.settings.on_error.unwrap_or(OnError::Fail);
    }

    /// Total time this run has spent paused so far.
    fn paused_ms(&self) -> u64 {
        self.debug.as_ref().map_or(0, |d| d.paused_ms())
    }

    fn skipped(&self, step: &Step) {
        self.emitter.emit(RunEvent::StepFinished {
            step_id: step.id.clone(),
            step_type: step.step_type.clone(),
            outcome: StepOutcome::Skipped,
            duration_ms: 0,
            error: None,
            will_retry: false,
        });
    }

    fn check_cancel(&self) -> Result<(), Interrupt> {
        if self.cancel.is_cancelled() {
            Err(Interrupt::Cancelled)
        } else {
            Ok(())
        }
    }

    // Boxed with an explicit `Send` bound: the interpreter is recursive and
    // parallel branches are spawned onto the Tokio runtime.
    pub(crate) fn block<'a>(&'a mut self, steps: &'a [Step]) -> BoxFuture<'a, StepResult> {
        Box::pin(async move {
            for step in steps {
                match self.step(step).await? {
                    Proceed::Next => {}
                    other => return Ok(other),
                }
            }
            Ok(Proceed::Next)
        })
    }

    async fn step(&mut self, step: &Step) -> StepResult {
        self.check_cancel()?;
        if step.disabled {
            self.skipped(step);
            return Ok(Proceed::Next);
        }
        if let Some(debug) = self.debug.clone()
            && let Some(reason) = debug.should_pause(&step.id)
        {
            match self.pause(&debug, reason, step, None).await? {
                (DebugCommand::Skip, _) => {
                    self.skipped(step);
                    return Ok(Proceed::Next);
                }
                (DebugCommand::Abort, _) => return Err(Interrupt::Cancelled),
                // The step may have changed: run it as it is now.
                (_, true) => {
                    debug.skip_pause_once(step.id.clone());
                    return Ok(Proceed::Retry);
                }
                _ => {}
            }
        }
        // Inside a call the snapshot keeps showing the call step.
        let top_level = self.emitter.call_depth() == 0;
        self.emitter.update_snapshot(|s| {
            if top_level {
                s.current_step = Some(step.id.clone());
            }
            s.steps_executed += 1;
        });

        let is_control = is_control_type(&step.step_type);
        let started = Instant::now();
        if is_control {
            // Of the control steps only a wait and a call give up after a time.
            let limit_ms = match step.step_type.as_str() {
                control::WAIT_UNTIL => Some(step.timeout_ms.unwrap_or(self.default_timeout_ms)),
                flow::CALL => step.timeout_ms.filter(|_| self.debug.is_none()),
                _ => None,
            };
            self.emitter.emit(RunEvent::StepStarted {
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                attempt: 1,
                wait_ms: None,
                limit_ms,
            });
        }

        let result = if is_control {
            self.control(step).await
        } else {
            self.action(step).await
        };

        // Errors raised inside nested blocks already carry their own step id;
        // `at_step` only fills it in when missing.
        let result = match result {
            Err(Interrupt::Failed(e)) => {
                Err(Interrupt::Failed(e.at_step(&step.id, &step.step_type)))
            }
            other => other,
        };

        if is_control {
            let (outcome, error) = match &result {
                Err(Interrupt::Failed(e)) if e.step_id.as_ref() == Some(&step.id) => {
                    (StepOutcome::Failed, Some(e.clone()))
                }
                Err(Interrupt::Failed(_)) => (StepOutcome::Failed, None),
                _ => (StepOutcome::Succeeded, None),
            };
            if !matches!(result, Err(Interrupt::Cancelled)) {
                self.emitter.emit(RunEvent::StepFinished {
                    step_id: step.id.clone(),
                    step_type: step.step_type.clone(),
                    outcome,
                    duration_ms: duration_ms(started),
                    error,
                    will_retry: false,
                });
            }
            // A wait that times out or a call that fails may be skipped
            // with onError: continue; other control steps only pass on
            // their children's errors.
            if !matches!(step.step_type.as_str(), control::WAIT_UNTIL | flow::CALL) {
                return self.on_failure(step, result).await;
            }
        }

        let result = self.on_failure(step, result).await;
        match result {
            Err(Interrupt::Failed(error))
                if step.on_error.unwrap_or(self.default_on_error) == OnError::Continue =>
            {
                self.emitter.log(
                    LogLevel::Warn,
                    format!("エラーを無視して続行します: {}", error.message),
                    Some(step.id.clone()),
                );
                let value = error.to_value();
                self.set_var(LAST_ERROR_VAR, value, Some(&step.id));
                Ok(Proceed::Next)
            }
            other => other,
        }
    }

    /// Interactive runs: pauses on an error nothing handles and does what
    /// the person chooses. Other results pass through.
    async fn on_failure(&mut self, step: &Step, result: StepResult) -> StepResult {
        let Some(debug) = self.debug.clone() else {
            return result;
        };
        let error = match &result {
            Err(Interrupt::Failed(error)) if self.pauses_on_error(step, error) => error.clone(),
            _ => return result,
        };
        match self
            .pause(&debug, PauseReason::Error, step, Some(&error))
            .await?
        {
            (DebugCommand::Skip, _) => {
                self.emitter.log(
                    LogLevel::Warn,
                    format!("失敗したノードを飛ばして続行します: {}", error.message),
                    Some(step.id.clone()),
                );
                self.skipped(step);
                Ok(Proceed::Next)
            }
            (DebugCommand::Abort, _) => {
                debug.give_up(error);
                result
            }
            // Retry, or resume (which starts with the failed step).
            _ => {
                debug.skip_pause_once(step.id.clone());
                Ok(Proceed::Retry)
            }
        }
    }

    async fn control(&mut self, step: &Step) -> StepResult {
        match step.step_type.as_str() {
            control::IF => {
                let condition = self.eval(param_str(step, "condition")?)?;
                let branch = if expr::truthy(&condition) {
                    "then"
                } else {
                    "else"
                };
                self.sub_block(step, branch).await
            }
            control::WHILE => {
                let condition = Expr::parse(param_str(step, "condition")?).map_err(expr_error)?;
                let max = step
                    .params
                    .get("maxIterations")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_MAX_ITERATIONS);
                let mut iterations = 0u64;
                let mut left_early = false;
                loop {
                    self.check_cancel()?;
                    if !expr::truthy(&condition.eval(&self.vars).map_err(expr_error)?) {
                        break;
                    }
                    iterations += 1;
                    if iterations > max {
                        return Err(RunError {
                            details: Some(serde_json::json!({ "maxIterations": max })),
                            ..RunError::new(
                                "LOOP_LIMIT_EXCEEDED",
                                format!("loop exceeded maxIterations ({max})"),
                            )
                        }
                        .into());
                    }
                    self.loop_round(step, iterations, None);
                    if let Proceed::Break = self.sub_block(step, "body").await? {
                        left_early = true;
                        break;
                    }
                }
                self.loop_ended(step, iterations, None, left_early);
                Ok(Proceed::Next)
            }
            control::REPEAT => {
                let count = self.eval_number(step, "count")?;
                if count < 0.0 || count.fract() != 0.0 {
                    return Err(
                        RunError::new("EXPR_TYPE", "count must be a non-negative integer").into(),
                    );
                }
                let index_var = step
                    .params
                    .get("indexVar")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let total = count as u64;
                let mut rounds = 0;
                let mut left_early = false;
                for i in 0..total {
                    self.check_cancel()?;
                    if let Some(name) = &index_var {
                        self.set_var(name, Value::from(i), Some(&step.id));
                    }
                    rounds = i + 1;
                    self.loop_round(step, rounds, Some(total));
                    if let Proceed::Break = self.sub_block(step, "body").await? {
                        left_early = true;
                        break;
                    }
                }
                self.loop_ended(step, rounds, Some(total), left_early);
                Ok(Proceed::Next)
            }
            control::FOR_EACH => self.for_each(step).await,
            control::TRY => {
                let error_var = step
                    .params
                    .get("errorVar")
                    .and_then(Value::as_str)
                    .unwrap_or("error")
                    .to_owned();
                let catches = !step.block("catch").is_empty();
                let mut result = self.handled_block(catches, step, "try").await;
                if let Err(Interrupt::Failed(error)) = &result
                    && !step.block("catch").is_empty()
                {
                    self.emitter.log(
                        LogLevel::Info,
                        format!("例外を捕捉しました: {}", error.message),
                        Some(step.id.clone()),
                    );
                    let value = error.to_value();
                    self.set_var(&error_var, value, Some(&step.id));
                    result = self.sub_block(step, "catch").await;
                }
                // After cancellation `finally` still runs (to close what
                // the `try` opened), for at most FINALLY_GRACE, and the run
                // ends cancelled whatever it does. Stopping again ends it at once.
                if matches!(result, Err(Interrupt::Cancelled)) {
                    if step.block("finally").is_empty() {
                        return result;
                    }
                    self.emitter.log(
                        LogLevel::Info,
                        "取り消されたので finally だけ実行します".to_owned(),
                        Some(step.id.clone()),
                    );
                    let cleanup = CancellationToken::new();
                    let outer = std::mem::replace(&mut self.cancel, cleanup.clone());
                    // A second stop ends the clean-up too.
                    let force = self.force.clone();
                    let timer = tokio::spawn(async move {
                        tokio::select! {
                            () = tokio::time::sleep(FINALLY_GRACE) => {}
                            () = force.cancelled() => {}
                        }
                        cleanup.cancel();
                    });
                    let _ = self.sub_block(step, "finally").await;
                    timer.abort();
                    self.cancel = outer;
                    return result;
                }
                match self.sub_block(step, "finally").await {
                    Ok(Proceed::Next) => result,
                    other => other,
                }
            }
            control::SWITCH => self.switch(step).await,
            control::GROUP => self.group(step).await,
            control::CASE => self.sub_block(step, "body").await,
            control::PARALLEL => self.parallel(step).await,
            control::WAIT_UNTIL => self.wait_until(step).await,
            flow::CALL => self.call(step).await,
            control::BREAK => Ok(Proceed::Break),
            control::CONTINUE => Ok(Proceed::Continue),
            control::FAIL => {
                let message = expr::render_value(
                    &Value::String(param_str(step, "message")?.to_owned()),
                    &self.vars,
                )
                .map_err(expr_error)?;
                let code = step
                    .params
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("FLOW_FAILED");
                Err(RunError::new(code, expr::to_display(&message)).into())
            }
            other => Err(RunError::new(
                "UNSUPPORTED_STEP_TYPE",
                format!("unknown control step '{other}'"),
            )
            .into()),
        }
    }

    /// Runs the first case that matches the value, or `default`. The case
    /// runs as a step of its own, so the run shows which branch was taken.
    async fn switch(&mut self, step: &Step) -> StepResult {
        let value = self.eval(param_str(step, "value")?)?;
        for case in step.block("cases") {
            if case.disabled || case.step_type != control::CASE {
                continue;
            }
            if !self.case_matches(case, &value)? {
                continue;
            }
            // An interactive run keeps the case in its block stack, as
            // `sub_block` does, so a revision swapped in while paused in
            // the case finds the run where it is.
            let frame = self.debug.clone().filter(|_| self.in_call.is_none());
            if let Some(debug) = &frame {
                debug.push_frame(BlockKey::Child {
                    parent: step.id.clone(),
                    name: "cases".to_owned(),
                });
                debug.set_current(Some(case.id.clone()));
            }
            let result = loop {
                match self.block(std::slice::from_ref(case)).await {
                    Ok(Proceed::Retry) => {}
                    other => break other,
                }
            };
            if let Some(debug) = &frame {
                debug.pop_frame();
            }
            return result;
        }
        self.sub_block(step, "default").await
    }

    fn case_matches(&self, case: &Step, value: &Value) -> Result<bool, RunError> {
        let at = |e: RunError| e.at_step(&case.id, &case.step_type);
        if let Some(Value::Array(values)) = case.params.get("values") {
            for candidate in values {
                let candidate = expr::render_value(candidate, &self.vars)
                    .map_err(expr_error)
                    .map_err(at)?;
                if expr::loose_eq(&candidate, value) {
                    return Ok(true);
                }
            }
        }
        match case.params.get("condition").and_then(Value::as_str) {
            Some(condition) => Ok(expr::truthy(&self.eval(condition).map_err(at)?)),
            None => Ok(false),
        }
    }

    /// Runs every branch concurrently. Each branch works on a copy of the
    /// variables; afterwards the variables each branch changed are merged
    /// back. The first failure cancels the remaining branches.
    async fn parallel(&mut self, step: &Step) -> StepResult {
        let branches = step.block("branches");
        if branches.is_empty() {
            return Ok(Proceed::Next);
        }
        let limit = step
            .params
            .get("maxConcurrency")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(branches.len())
            .clamp(1, branches.len());
        let permits = Arc::new(Semaphore::new(limit));
        let group = self.cancel.child_token();
        let base = self.vars.clone();

        let mut set = JoinSet::new();
        for (index, branch) in branches.iter().enumerate() {
            let mut executor = self.fork(group.child_token());
            let branch = branch.clone();
            let permits = permits.clone();
            let group = group.clone();
            set.spawn(async move {
                let permit = tokio::select! {
                    biased;
                    () = executor.cancel.cancelled() => return (index, Err(Interrupt::Cancelled), executor.vars),
                    p = permits.acquire_owned() => p,
                };
                if executor.cancel.is_cancelled() {
                    return (index, Err(Interrupt::Cancelled), executor.vars);
                }
                // Break/continue cannot cross the branch boundary (the
                // validator rejects them), so the flow result is dropped.
                let result = executor
                    .block(std::slice::from_ref(&branch))
                    .await
                    .map(|_| Proceed::Next);
                // Fail fast: stop queued branches before freeing the permit
                // they are waiting for.
                if matches!(result, Err(Interrupt::Failed(_))) {
                    group.cancel();
                }
                drop(permit);
                (index, result, executor.vars)
            });
        }

        let mut first_error: Option<Interrupt> = None;
        let mut finished: Vec<(usize, Map<String, Value>)> = Vec::new();
        while let Some(joined) = set.join_next().await {
            let (index, result, vars) = match joined {
                Ok(done) => done,
                Err(e) => {
                    group.cancel();
                    first_error.get_or_insert(Interrupt::Failed(RunError::new(
                        "INTERNAL",
                        format!("parallel branch panicked: {e}"),
                    )));
                    continue;
                }
            };
            match result {
                Ok(_) => finished.push((index, vars)),
                Err(Interrupt::Cancelled) if first_error.is_some() => {}
                Err(interrupt) => {
                    group.cancel();
                    first_error.get_or_insert(interrupt);
                }
            }
        }
        if self.cancel.is_cancelled() {
            return Err(Interrupt::Cancelled);
        }
        if let Some(interrupt) = first_error {
            return Err(interrupt);
        }

        // Merge in branch order so the result does not depend on timing.
        finished.sort_by_key(|(index, _)| *index);
        let mut changed: HashMap<String, (usize, Value)> = HashMap::new();
        for (index, vars) in finished {
            for (name, value) in vars {
                if base.get(&name) == Some(&value) {
                    continue;
                }
                if let Some((other, previous)) = changed.get(&name)
                    && previous != &value
                {
                    return Err(RunError {
                        details: Some(serde_json::json!({
                            "variable": name,
                            "branches": [other, index],
                        })),
                        ..RunError::new(
                            "PARALLEL_VARIABLE_CONFLICT",
                            format!(
                                "branches {other} and {index} set variable '{name}' to different values"
                            ),
                        )
                    }
                    .into());
                }
                changed.insert(name, (index, value));
            }
        }
        // Each branch already reported its changes when it made them.
        for (name, (_, value)) in changed {
            self.vars.insert(name, value);
        }
        Ok(Proceed::Next)
    }

    async fn for_each(&mut self, step: &Step) -> StepResult {
        let items = match self.eval(param_str(step, "items")?)? {
            Value::Array(items) => items,
            Value::Null => Vec::new(),
            other => {
                return Err(RunError::new(
                    "EXPR_TYPE",
                    format!("items must be an array, got {other}"),
                )
                .into());
            }
        };
        let collect = match step.params.get("collect").and_then(Value::as_str) {
            Some(source) => Some(Expr::parse(source).map_err(expr_error)?),
            None => None,
        };
        let total = items.len() as u64;
        let mut rounds = 0;
        let mut left_early = false;
        let results = if step.params.contains_key("concurrency") {
            let concurrency = self.eval_number(step, "concurrency")?;
            if !(1.0..=64.0).contains(&concurrency) || concurrency.fract() != 0.0 {
                return Err(RunError::new(
                    "INVALID_PARAMS",
                    "concurrency must be an integer between 1 and 64",
                )
                .into());
            }
            let results = self
                .for_each_isolated(step, items, collect, concurrency as usize)
                .await?;
            rounds = total;
            results
        } else {
            let mut results = Vec::with_capacity(items.len());
            for (index, item) in items.into_iter().enumerate() {
                self.check_cancel()?;
                self.bind_item(step, index, item);
                rounds = index as u64 + 1;
                self.loop_round(step, rounds, Some(total));
                let proceed = self.sub_block(step, "body").await?;
                if let Some(collect) = &collect {
                    results.push(collect.eval(&self.vars).map_err(expr_error)?);
                }
                if let Proceed::Break = proceed {
                    left_early = true;
                    break;
                }
            }
            results
        };
        self.loop_ended(step, rounds, Some(total), left_early);
        if let Some(name) = &step.save_as {
            self.set_var(name, Value::Array(results), Some(&step.id));
        }
        Ok(Proceed::Next)
    }

    /// Tells Studio a loop starts its `round`-th round (see `RunEvent::LoopRound`).
    fn loop_round(&self, step: &Step, round: u64, total: Option<u64>) {
        self.emitter.emit(RunEvent::LoopRound {
            step_id: step.id.clone(),
            round,
            total,
        });
    }

    fn loop_ended(&self, step: &Step, rounds: u64, total: Option<u64>, left_early: bool) {
        self.emitter.emit(RunEvent::LoopEnded {
            step_id: step.id.clone(),
            rounds,
            total,
            left_early,
        });
    }

    fn bind_item(&mut self, step: &Step, index: usize, item: Value) {
        if let Some(name) = step.params.get("itemVar").and_then(Value::as_str) {
            self.set_var(name, item, Some(&step.id));
        }
        if let Some(name) = step.params.get("indexVar").and_then(Value::as_str) {
            self.set_var(name, Value::from(index), Some(&step.id));
        }
    }

    /// Runs iterations on copies of the variables, at most `limit` at a
    /// time, and returns the collected values in item order. Nothing else
    /// leaves an iteration. The first failure cancels the rest.
    async fn for_each_isolated(
        &mut self,
        step: &Step,
        items: Vec<Value>,
        collect: Option<Expr>,
        limit: usize,
    ) -> Result<Vec<Value>, Interrupt> {
        let group = self.cancel.child_token();
        let collect = Arc::new(collect);
        let body: Arc<Vec<Step>> = Arc::new(step.block("body").to_vec());
        let mut results = vec![Value::Null; items.len()];
        let mut first_error: Option<Interrupt> = None;
        let mut set = JoinSet::new();
        let total = items.len() as u64;
        let mut items = items.into_iter().enumerate();

        loop {
            // Start iterations lazily so a large list never holds more than
            // `limit` copies of the variables.
            while set.len() < limit && first_error.is_none() && !group.is_cancelled() {
                let Some((index, item)) = items.next() else {
                    break;
                };
                // Rounds counted as they start, several at once.
                self.loop_round(step, index as u64 + 1, Some(total));
                let mut executor = self.fork(group.child_token());
                executor.iteration = Some(index);
                executor.bind_item(step, index, item);
                let (body, collect, group) = (body.clone(), collect.clone(), group.clone());
                set.spawn(async move {
                    let mut result =
                        executor
                            .block(&body)
                            .await
                            .and_then(|_| match collect.as_ref() {
                                Some(c) => c.eval(&executor.vars).map_err(|e| expr_error(e).into()),
                                None => Ok(Value::Null),
                            });
                    if let Err(Interrupt::Failed(error)) = &mut result {
                        let mut details = match error.details.take() {
                            Some(Value::Object(map)) => map,
                            Some(other) => Map::from_iter([("cause".to_owned(), other)]),
                            None => Map::new(),
                        };
                        details.insert("index".into(), Value::from(index));
                        error.details = Some(Value::Object(details));
                        group.cancel();
                    }
                    (index, result)
                });
            }
            let Some(joined) = set.join_next().await else {
                break;
            };
            match joined {
                Ok((index, Ok(value))) => results[index] = value,
                Ok((_, Err(Interrupt::Cancelled))) if first_error.is_some() => {}
                Ok((_, Err(interrupt))) => {
                    group.cancel();
                    first_error.get_or_insert(interrupt);
                }
                Err(e) => {
                    group.cancel();
                    first_error.get_or_insert(Interrupt::Failed(RunError::new(
                        "INTERNAL",
                        format!("forEach iteration panicked: {e}"),
                    )));
                }
            }
        }
        if self.cancel.is_cancelled() {
            return Err(Interrupt::Cancelled);
        }
        match first_error {
            Some(interrupt) => Err(interrupt),
            None => Ok(results),
        }
    }

    /// Runs the called flow on its own variables: `inputs` (rendered
    /// here) start them, `outputs` copy its output variables back. A
    /// failure inside becomes this step's failure, with where it happened
    /// in `details.subFlow`.
    async fn call(&mut self, step: &Step) -> StepResult {
        let target = FlowId::new(param_str(step, "flow")?);
        let Some(callee) = self.library.get(&target).cloned() else {
            return Err(RunError::new(
                "CALL_TARGET_NOT_FOUND",
                format!("flow '{target}' was not provided to this run"),
            )
            .into());
        };
        if self.emitter.call_depth() >= MAX_CALL_DEPTH {
            return Err(RunError::new(
                "CALL_TOO_DEEP",
                format!("calls are nested more than {MAX_CALL_DEPTH} deep"),
            )
            .into());
        }
        let inputs = match step.params.get("inputs") {
            Some(value) => match expr::render_value(value, &self.vars).map_err(expr_error)? {
                Value::Object(map) => map,
                _ => Map::new(),
            },
            None => Map::new(),
        };

        let cancel = self.cancel.child_token();
        let mut child = self.fork(cancel.clone());
        // Interactive runs pause inside the call too. Errors the call step
        // handles (`onError: continue`, an enclosing `try`) do not pause there.
        child.debug = self.debug.clone();
        child.in_call = Some(callee.id.clone());
        // Its relative paths are its own folder's.
        child.project_dir = self
            .project_dirs
            .get(&callee.id)
            .map(|dir| Arc::from(dir.as_path()));
        child.handled_depth =
            self.handled_depth + u32::from(self.effective_on_error(step) == OnError::Continue);
        child.vars = Map::new();
        child.secret_vars = callee
            .variables
            .iter()
            .filter(|v| v.secret)
            .map(|v| v.name.clone())
            .collect();
        child.iteration = None;
        child.emitter = self.emitter.nested(&step.id);
        child.default_timeout_ms = callee
            .settings
            .default_timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        child.default_retry = callee.settings.default_retry;
        child.default_on_error = callee.settings.on_error.unwrap_or(OnError::Fail);
        crate::init_variables(&callee, &inputs, &mut child)?;
        let initial = child.vars.clone();

        let body = match child.debug.clone() {
            Some(debug) => child.called_block(debug, callee.id.clone(), &callee.steps),
            None => child.block(&callee.steps),
        };
        // No timeout counts while paused, so a call that can pause has none.
        let timeout_ms = step.timeout_ms.filter(|_| self.debug.is_none());
        let result = match timeout_ms {
            None => body.await,
            Some(ms) => {
                let run = tokio::time::timeout(Duration::from_millis(ms), body);
                match run.await {
                    Ok(result) => result,
                    Err(_) => Err(Interrupt::Failed(RunError {
                        details: Some(serde_json::json!({ "timeoutMs": ms })),
                        ..RunError::new(
                            "STEP_TIMEOUT",
                            format!("the called flow did not finish within {ms} ms"),
                        )
                    })),
                }
            }
        };
        cancel.cancel();
        // Outputs come back even when the call fails, but only those it
        // assigned: like steps run in place, whatever they wrote before the
        // failure stays visible to the caller's catch / onError: continue.
        let failed = result.is_err();
        let outputs = step.params.get("outputs").and_then(Value::as_object);
        for (name, target) in outputs.into_iter().flatten() {
            let Some(target) = target.as_str() else {
                continue;
            };
            let value = child.vars.get(name).cloned().unwrap_or(Value::Null);
            if failed && initial.get(name) == Some(&value) {
                continue;
            }
            self.set_var(target, value, Some(&step.id));
        }
        match result {
            Ok(_) => {}
            Err(Interrupt::Cancelled) => return Err(Interrupt::Cancelled),
            Err(Interrupt::Failed(mut error)) if error.step_id.is_some() => {
                // Let fail inside (Abort at an error pause there): the call
                // step must not pause on it again on its way out.
                let given_up = self.debug.as_ref().is_some_and(|d| d.is_given_up(&error));
                let mut details = match error.details.take() {
                    Some(Value::Object(map)) => map,
                    Some(other) => Map::from_iter([("cause".to_owned(), other)]),
                    None => Map::new(),
                };
                // A nested call already said where inside it failed; its call
                // step joins `callPath`, the calls from this callee down to
                // that flow (one flow can be called from several places).
                match details.get_mut("subFlow").and_then(Value::as_object_mut) {
                    Some(sub) => {
                        let mut path = vec![serde_json::json!(error.step_id)];
                        if let Some(Value::Array(rest)) = sub.remove("callPath") {
                            path.extend(rest);
                        }
                        sub.insert("callPath".to_owned(), Value::Array(path));
                    }
                    None => {
                        details.insert(
                            "subFlow".to_owned(),
                            serde_json::json!({
                                "flowId": callee.id,
                                "flowName": callee.name,
                                "stepId": error.step_id,
                                "stepType": error.step_type,
                            }),
                        );
                    }
                }
                error.details = Some(Value::Object(details));
                error.step_id = Some(step.id.clone());
                error.step_type = Some(step.step_type.clone());
                if given_up && let Some(debug) = &self.debug {
                    debug.give_up(error.clone());
                }
                return Err(error.into());
            }
            // The call itself failed (timeout): no step inside to point at.
            Err(interrupt) => return Err(interrupt),
        }
        Ok(Proceed::Next)
    }

    /// Polls `condition` (after running `check`) until it holds or the
    /// step's timeout passes. The last check happens at the deadline.
    async fn wait_until(&mut self, step: &Step) -> StepResult {
        let condition = Expr::parse(param_str(step, "condition")?).map_err(expr_error)?;
        let interval_ms = if step.params.contains_key("intervalMs") {
            let ms = self.eval_number(step, "intervalMs")?;
            if !(50.0..=60_000.0).contains(&ms) {
                return Err(RunError::new(
                    "INVALID_PARAMS",
                    "intervalMs must be between 50 and 60000",
                )
                .into());
            }
            ms as u64
        } else {
            DEFAULT_WAIT_INTERVAL_MS
        };
        let timeout_ms = step.timeout_ms.unwrap_or(self.default_timeout_ms);
        let started = Instant::now();
        // Time spent paused inside the check does not count towards the timeout.
        let paused_before = self.paused_ms();
        let mut polls = 0u64;
        loop {
            self.check_cancel()?;
            let handles = self.effective_on_error(step) == OnError::Continue;
            self.handled_block(handles, step, "check").await?;
            polls += 1;
            if expr::truthy(&condition.eval(&self.vars).map_err(expr_error)?) {
                return Ok(Proceed::Next);
            }
            let elapsed_ms = duration_ms(started).saturating_sub(self.paused_ms() - paused_before);
            if elapsed_ms >= timeout_ms {
                return Err(RunError {
                    details: Some(serde_json::json!({ "elapsedMs": elapsed_ms, "polls": polls })),
                    ..RunError::new(
                        "WAIT_TIMEOUT",
                        format!("condition was still false after {elapsed_ms} ms ({polls} checks)"),
                    )
                }
                .into());
            }
            let pause = interval_ms.min(timeout_ms - elapsed_ms);
            tokio::select! {
                biased;
                () = self.cancel.cancelled() => return Err(Interrupt::Cancelled),
                () = tokio::time::sleep(Duration::from_millis(pause)) => {}
            }
        }
    }

    async fn action(&mut self, step: &Step) -> StepResult {
        if step.step_type == builtin::VARIABLE_SET {
            return self.variable_set(step);
        }
        let handler = self.handlers.get(&step.step_type).cloned().ok_or_else(|| {
            RunError::new(
                "UNSUPPORTED_STEP_TYPE",
                format!("no handler for step type '{}'", step.step_type),
            )
        })?;

        let mut params = expr::render_value(&Value::Object(step.params.clone()), &self.vars)
            .map_err(expr_error)?;
        if let (Some(dir), Some(keys)) = (&self.project_dir, self.path_params.get(&step.step_type))
        {
            project::resolve_params(&mut params, keys, dir);
        }
        // Sites and programs are checked after rendering, so a template
        // cannot lead a step somewhere the workspace does not allow.
        if let Some(defs) = self.target_defs.get(&step.step_type)
            && let Err(refusal) = self.policy.check_targets(defs, &params)
        {
            let error = RunError {
                details: Some(refusal.details),
                ..RunError::new(refusal.code, refusal.message)
            };
            return Err(error.at_step(&step.id, &step.step_type).into());
        }
        let retry = step.retry.or(self.default_retry);
        let max_attempts = retry.map_or(1, |r| r.max_attempts.max(1));
        let mut delay_ms = retry.map_or(0, |r| r.backoff_ms) as f64;
        let timeout_ms = step
            .timeout_ms
            .or_else(|| self.default_timeouts.get(&step.step_type).copied())
            .unwrap_or(self.default_timeout_ms);

        // A delay ends when its time is up (or at the timeout before that).
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let wait_ms = (step.step_type == builtin::FLOW_DELAY)
            .then(|| params.get("ms").and_then(Value::as_f64))
            .flatten()
            .filter(|ms| *ms >= 0.0)
            .map(|ms| (ms as u64).min(timeout_ms));

        self.capture_screen(step, &params, Moment::Before).await;
        let mut attempt = 1;
        loop {
            self.check_cancel()?;
            self.emitter.emit(RunEvent::StepStarted {
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                attempt,
                wait_ms,
                limit_ms: Some(timeout_ms),
            });
            let started = Instant::now();
            let attempt_cancel = self.cancel.child_token();
            let input = ActionInput {
                run_id: self.run_id.clone(),
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                attempt,
                params: params.clone(),
                cancel: attempt_cancel.clone(),
                timeout_ms,
                emitter: self.emitter.clone(),
                secrets: self.secrets.clone(),
                sites_restricted: !self.policy.sites.is_empty(),
            };
            // Wait for exclusive resources (not counted towards the timeout).
            let resources = self
                .resource_defs
                .get(&step.step_type)
                .map(|defs| resource_keys(defs, &params))
                .unwrap_or_default();
            let waiting = |reason: &str| {
                self.emitter.emit(RunEvent::Log {
                    level: LogLevel::Warn,
                    message: format!(
                        "画面のロックが解かれるのを待っています（最大 {} 分）：{reason}",
                        self.policy.desktop.wait_unlocked_minutes.unwrap_or(0)
                    ),
                    step_id: Some(step.id.clone()),
                });
            };
            let _guards = if resources.is_empty() {
                Vec::new()
            } else {
                tokio::select! {
                    biased;
                    () = self.cancel.cancelled() => return Err(Interrupt::Cancelled),
                    g = self.resources.acquire(&resources, self.policy.desktop.wait_unlocked(), &waiting) => match g {
                        Ok(g) => g,
                        Err(e) => return Err(e.at_step(&step.id, &step.step_type).into()),
                    },
                }
            };
            let outcome = tokio::select! {
                biased;
                () = self.cancel.cancelled() => None,
                r = tokio::time::timeout(Duration::from_millis(timeout_ms), handler.execute(input)) => Some(r),
            };
            drop(_guards);
            attempt_cancel.cancel();
            let result: Result<Value, StepError> = match outcome {
                None => return Err(Interrupt::Cancelled),
                Some(Ok(r)) => r,
                Some(Err(_)) => Err(StepError::new(
                    "STEP_TIMEOUT",
                    format!("step timed out after {timeout_ms} ms"),
                )
                .with_details(serde_json::json!({ "timeoutMs": timeout_ms }))),
            };

            match result {
                Ok(value) => {
                    self.emitter.emit(RunEvent::StepFinished {
                        step_id: step.id.clone(),
                        step_type: step.step_type.clone(),
                        outcome: StepOutcome::Succeeded,
                        duration_ms: duration_ms(started),
                        error: None,
                        will_retry: false,
                    });
                    self.capture_screen(step, &params, Moment::After).await;
                    if let Some(name) = &step.save_as {
                        self.set_var(name, value, Some(&step.id));
                    }
                    return Ok(Proceed::Next);
                }
                Err(err) => {
                    let will_retry = err.retryable && attempt < max_attempts;
                    let error = RunError::from(err).at_step(&step.id, &step.step_type);
                    self.emitter.emit(RunEvent::StepFinished {
                        step_id: step.id.clone(),
                        step_type: step.step_type.clone(),
                        outcome: StepOutcome::Failed,
                        duration_ms: duration_ms(started),
                        error: Some(error.clone()),
                        will_retry,
                    });
                    if !will_retry {
                        self.emitter.failed_with(&step.id, &params);
                        return Err(error.into());
                    }
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let wait = Duration::from_millis(delay_ms as u64);
                    tokio::select! {
                        () = self.cancel.cancelled() => return Err(Interrupt::Cancelled),
                        () = tokio::time::sleep(wait) => {}
                    }
                    delay_ms *= retry.map_or(1.0, |r| r.backoff_multiplier.max(1.0));
                    attempt += 1;
                }
            }
        }
    }

    /// Saves a picture of the screen the failed step worked on (its browser
    /// context or its window) beside the run's log, and adds its path to the
    /// error as `details.screenshot`, so an unattended failure can be seen
    /// afterwards. Uses the adapter's own screenshot step; does nothing for
    /// other steps, when the run writes no log, or when the screen is gone.
    pub(crate) async fn capture_failure(&self, flow: &Flow, error: &mut RunError) {
        if self.policy.records.failure_screenshots == Some(false) {
            return;
        }
        // A step that failed in a called flow is named in `subFlow` (the
        // error itself points at the call).
        let inner = error
            .details
            .as_ref()
            .and_then(|d| d.get("subFlow"))
            .and_then(|sub| {
                Some((
                    sub.get("flowId")?.as_str()?.to_owned(),
                    StepId::new(sub.get("stepId")?.as_str()?),
                    sub.get("stepType")?.as_str()?.to_owned(),
                ))
            });
        let (step_id, step_type, called) = match (&inner, &error.step_id, &error.step_type) {
            (Some((flow_id, id, ty)), _, _) => (id.clone(), ty.clone(), Some(flow_id.as_str())),
            (None, Some(id), Some(ty)) => (id.clone(), ty.clone(), None),
            _ => return,
        };
        let step_id = &step_id;
        let step_type = &step_type;
        let Some(path) = self.emitter.failure_shot_path() else {
            return;
        };
        let step = match called {
            Some(flow_id) => self
                .library
                .values()
                .find(|f| f.id.as_str() == flow_id)
                .and_then(|f| f.find_step(step_id)),
            None => flow.find_step(step_id),
        };
        // The context or window as the step rendered it (it may be a
        // template, and inside a called flow it used that flow's variables);
        // rendered here again when the step failed before it ran.
        let rendered = self.emitter.failed_params(step_id);
        let param = |pointer: &str| -> Option<Value> {
            match &rendered {
                Some(rendered) => rendered.pointer(pointer).cloned(),
                None => {
                    let raw = Value::Object(step?.params.clone());
                    expr::render_value(raw.pointer(pointer)?, &self.vars).ok()
                }
            }
        };
        let mut params = Map::new();
        params.insert("path".into(), Value::String(path.display().to_string()));
        let shot_type = match step_type.split('.').next() {
            Some("browser") => {
                let declared = match &rendered {
                    Some(rendered) => rendered.get("context").is_some(),
                    None => step.is_some_and(|s| s.params.contains_key("context")),
                };
                if declared {
                    let Some(context) = param("/context") else {
                        return;
                    };
                    params.insert("context".into(), context);
                }
                "browser.screenshot"
            }
            Some("desktop") => {
                let Some(window) = param("/target/window") else {
                    return;
                };
                params.insert("target".into(), json!({ "window": window }));
                "desktop.screenshot"
            }
            _ => return,
        };
        let Some(handler) = self.handlers.get(shot_type).cloned() else {
            return;
        };
        let cancel = CancellationToken::new();
        let input = ActionInput {
            run_id: self.run_id.clone(),
            step_id: step_id.clone(),
            step_type: shot_type.to_owned(),
            attempt: 1,
            params: Value::Object(params),
            cancel: cancel.clone(),
            timeout_ms: FAILURE_SHOT_LIMIT.as_millis() as u64,
            emitter: self.emitter.clone(),
            secrets: self.secrets.clone(),
            sites_restricted: false,
        };
        let taken = tokio::time::timeout(FAILURE_SHOT_LIMIT, handler.execute(input)).await;
        cancel.cancel();
        if !matches!(taken, Ok(Ok(_))) || !path.is_file() {
            return;
        }
        let shown = path.display().to_string();
        match error.details.get_or_insert_with(|| json!({})) {
            Value::Object(details) => {
                details.insert("screenshot".into(), Value::String(shown.clone()));
            }
            _ => return,
        }
        self.emitter.log(
            LogLevel::Info,
            format!("失敗したときの画面を保存しました: {shown}"),
            error.step_id.clone(),
        );
    }

    /// `control.group`: its `body`, and with `retry` the whole body again from
    /// its first step when anything in it fails (UiPath's Retry Scope). Every
    /// failure counts, not only retryable ones: the body as a whole is what
    /// is tried again (open, sign in, go to the page…).
    async fn group(&mut self, step: &Step) -> StepResult {
        let Some(retry) = step.retry else {
            return self.sub_block(step, "body").await;
        };
        let max_attempts = retry.max_attempts.max(1);
        let mut delay_ms = retry.backoff_ms as f64;
        let mut attempt = 1;
        loop {
            // A failure that will be retried is handled: it does not pause the run.
            let result = self
                .handled_block(attempt < max_attempts, step, "body")
                .await;
            match result {
                Err(Interrupt::Failed(error)) if attempt < max_attempts => {
                    self.emitter.log(
                        LogLevel::Warn,
                        format!(
                            "グループの {attempt} 回目が失敗したので、最初からやり直します（{attempt}/{max_attempts}）: {}",
                            error.message
                        ),
                        Some(step.id.clone()),
                    );
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let wait = Duration::from_millis(delay_ms as u64);
                    tokio::select! {
                        () = self.cancel.cancelled() => return Err(Interrupt::Cancelled),
                        () = tokio::time::sleep(wait) => {}
                    }
                    delay_ms *= retry.backoff_multiplier.max(1.0);
                    attempt += 1;
                }
                other => return other,
            }
        }
    }

    fn variable_set(&mut self, step: &Step) -> StepResult {
        let started = Instant::now();
        self.emitter.emit(RunEvent::StepStarted {
            step_id: step.id.clone(),
            step_type: step.step_type.clone(),
            attempt: 1,
            wait_ms: None,
            limit_ms: None,
        });
        let result = (|| {
            let name = param_str(step, "name")?.to_owned();
            let value = match (step.params.get("expression"), step.params.get("value")) {
                (Some(Value::String(src)), _) => self.eval(src)?,
                (_, Some(value)) => expr::render_value(value, &self.vars).map_err(expr_error)?,
                _ => {
                    return Err(RunError::new(
                        "INVALID_PARAMS",
                        "either 'value' or 'expression' is required",
                    ));
                }
            };
            Ok((name, value))
        })();
        match result {
            Ok((name, value)) => {
                self.set_var(&name, value.clone(), Some(&step.id));
                if let Some(save_as) = &step.save_as {
                    self.set_var(save_as, value, Some(&step.id));
                }
                self.emitter.emit(RunEvent::StepFinished {
                    step_id: step.id.clone(),
                    step_type: step.step_type.clone(),
                    outcome: StepOutcome::Succeeded,
                    duration_ms: duration_ms(started),
                    error: None,
                    will_retry: false,
                });
                Ok(Proceed::Next)
            }
            Err(e) => {
                let error = e.at_step(&step.id, &step.step_type);
                self.emitter.emit(RunEvent::StepFinished {
                    step_id: step.id.clone(),
                    step_type: step.step_type.clone(),
                    outcome: StepOutcome::Failed,
                    duration_ms: duration_ms(started),
                    error: Some(error.clone()),
                    will_retry: false,
                });
                Err(error.into())
            }
        }
    }
}

pub(crate) fn final_status(result: &Result<Proceed, Interrupt>) -> (RunStatus, Option<RunError>) {
    match result {
        Ok(_) => (RunStatus::Succeeded, None),
        Err(Interrupt::Cancelled) => (
            RunStatus::Cancelled,
            Some(RunError::new("RUN_CANCELLED", "the run was cancelled")),
        ),
        Err(Interrupt::Failed(e)) => (RunStatus::Failed, Some(e.clone())),
    }
}
