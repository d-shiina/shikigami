//! The scenario interpreter.
//!
//! Control flow (`control.*`) and variable assignment are executed here;
//! every other step type is dispatched to a registered [`ActionHandler`].
//! The interpreter walks the step tree directly, so step IDs in events map
//! one-to-one to the document Studio and AI clients edit.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use shikigami_core::call::MAX_CALL_DEPTH;
use shikigami_core::expr::{self, Expr};
use shikigami_core::registry::{builtin, control, is_control_type, scenario};
use shikigami_core::resource::{ResourceDef, resource_keys};
use shikigami_core::secret::SecretProvider;
use shikigami_core::validate::LAST_ERROR_VAR;
use shikigami_core::{OnError, RetryPolicy, RunId, Scenario, ScenarioId, Step, StepId};
use time::OffsetDateTime;
use tokio::sync::{OwnedMutexGuard, Semaphore, mpsc};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::debug::{BlockKey, DebugCommand, Debugger, PauseReason, ResumeAction};
use crate::event::{
    LogLevel, RunError, RunEvent, RunEventEnvelope, RunSnapshot, RunStatus, StepOutcome,
};
use crate::handler::{ActionHandler, ActionInput, BoxFuture, StepError};

pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_WAIT_INTERVAL_MS: u64 = 500;
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
    /// `scenario.call` steps this emitter reports from inside.
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
}

impl Emitter {
    pub(crate) fn new(
        run_id: RunId,
        tx: mpsc::UnboundedSender<RunEventEnvelope>,
        snapshot: Arc<Mutex<RunSnapshot>>,
    ) -> Self {
        Self {
            inner: Arc::new(EmitterInner {
                run_id,
                seq: Mutex::new(0),
                tx,
                secrets: RwLock::new(Vec::new()),
                snapshot,
            }),
            call_path: Arc::from([]),
        }
    }

    /// The same run, reporting from inside the scenario `call` runs.
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
        // The receiver may have been dropped (fire-and-forget runs); the run
        // continues regardless.
        let _ = self.inner.tx.send(envelope);
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

#[derive(Default)]
pub(crate) struct ResourceLocks {
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
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
    async fn acquire(&self, names: &[String]) -> Vec<OwnedMutexGuard<()>> {
        let mut guards = Vec::with_capacity(names.len());
        for name in names {
            guards.push(self.lock_for(name).lock_owned().await);
        }
        guards
    }
}

// ---------------------------------------------------------------------------
// Interpreter

pub(crate) enum Flow {
    Next,
    Break,
    Continue,
    /// Interactive runs: read the step again from the current revision and
    /// run it (after a pause that swapped the scenario, or a retry).
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

type StepResult = Result<Flow, Interrupt>;

pub(crate) struct Executor {
    pub run_id: RunId,
    pub handlers: Arc<HashMap<String, Arc<dyn ActionHandler>>>,
    /// Exclusive resources per step type.
    pub resource_defs: Arc<HashMap<String, Vec<ResourceDef>>>,
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
    pub default_timeout_ms: u64,
    pub default_retry: Option<RetryPolicy>,
    pub default_on_error: OnError,
    pub resources: Arc<ResourceLocks>,
    /// Set for interactive runs, on the main line only (not in forks).
    pub debug: Option<Arc<Debugger>>,
    /// How many enclosing steps handle an error (a `try` with a `catch`, a
    /// `wait.until` with `onError: continue`): errors there do not pause.
    pub handled_depth: u32,
    /// Scenarios `scenario.call` can run, as they were when the run started.
    pub library: Arc<HashMap<ScenarioId, Arc<Scenario>>>,
}

fn expr_error(e: expr::ExprError) -> RunError {
    RunError::new(e.code(), e.to_string())
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
    pub(crate) fn new_from(scenario: &Scenario, base: Executor) -> Self {
        Self {
            default_timeout_ms: scenario
                .settings
                .default_timeout_ms
                .unwrap_or(base.default_timeout_ms),
            default_retry: scenario.settings.default_retry.or(base.default_retry),
            default_on_error: scenario.settings.on_error.unwrap_or(base.default_on_error),
            ..base
        }
    }

    /// An executor for a parallel branch: same run, own copy of the variables.
    fn fork(&self, cancel: CancellationToken) -> Self {
        Self {
            run_id: self.run_id.clone(),
            handlers: self.handlers.clone(),
            resource_defs: self.resource_defs.clone(),
            default_timeouts: self.default_timeouts.clone(),
            secrets: self.secrets.clone(),
            vars: self.vars.clone(),
            secret_vars: self.secret_vars.clone(),
            iteration: self.iteration,
            emitter: self.emitter.clone(),
            cancel,
            default_timeout_ms: self.default_timeout_ms,
            default_retry: self.default_retry,
            default_on_error: self.default_on_error,
            resources: self.resources.clone(),
            debug: None,
            handled_depth: 0,
            library: self.library.clone(),
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
            Some(debug) => self.live_block(
                debug,
                BlockKey::Child {
                    parent: parent.id.clone(),
                    name: name.to_owned(),
                },
            ),
            None => self.block(parent.block(name)),
        }
    }

    /// Runs the scenario's top-level steps.
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
                let Some(step) = debug.next_step(&key, prev.as_ref()) else {
                    break Ok(Flow::Next);
                };
                debug.set_current(Some(step.id.clone()));
                match self.step(&step).await {
                    // A step the new revision removed (skipped while paused)
                    // leaves the cursor where it was.
                    Ok(Flow::Next) if !debug.in_block(&key, &step.id) => {}
                    Ok(Flow::Next) => {
                        debug.finished(step.id.clone());
                        prev = Some(step.id);
                    }
                    Ok(Flow::Retry) => {}
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
    /// nothing in the scenario handles it.
    fn pauses_on_error(&self, step: &Step, error: &RunError) -> bool {
        let Some(debug) = &self.debug else {
            return false;
        };
        let own_on_error =
            !is_control_type(&step.step_type) || step.step_type == control::WAIT_UNTIL;
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
        debug.enter_pause(reason);
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
            revision: debug.scenario().revision,
        });
        let waited = Instant::now();
        let command = tokio::select! {
            biased;
            () = self.cancel.cancelled() => {
                debug.leave_pause();
                return Err(Interrupt::Cancelled);
            }
            command = debug.wait() => command,
        };
        debug.add_paused(duration_ms(waited));
        let updated = debug.take_updated();
        if updated {
            self.adopt(&debug.scenario());
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
            revision: updated.then(|| debug.scenario().revision),
        });
        Ok((command, updated))
    }

    /// Catches up with a revision swapped in while paused: newly declared
    /// variables get their defaults (values of the others stay), and the
    /// scenario settings apply from now on.
    fn adopt(&mut self, scenario: &Scenario) {
        self.secret_vars = scenario
            .variables
            .iter()
            .filter(|v| v.secret)
            .map(|v| v.name.clone())
            .collect();
        for var in &scenario.variables {
            if !self.vars.contains_key(&var.name) {
                let value = var.default.clone().unwrap_or(Value::Null);
                if var.secret {
                    self.emitter.add_secret(&value);
                }
                self.set_var(&var.name, value, None);
            }
        }
        self.default_timeout_ms = scenario
            .settings
            .default_timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        self.default_retry = scenario.settings.default_retry;
        self.default_on_error = scenario.settings.on_error.unwrap_or(OnError::Fail);
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
                    Flow::Next => {}
                    flow => return Ok(flow),
                }
            }
            Ok(Flow::Next)
        })
    }

    async fn step(&mut self, step: &Step) -> StepResult {
        self.check_cancel()?;
        if step.disabled {
            self.skipped(step);
            return Ok(Flow::Next);
        }
        if let Some(debug) = self.debug.clone()
            && let Some(reason) = debug.should_pause(&step.id)
        {
            match self.pause(&debug, reason, step, None).await? {
                (DebugCommand::Skip, _) => {
                    self.skipped(step);
                    return Ok(Flow::Next);
                }
                (DebugCommand::Abort, _) => return Err(Interrupt::Cancelled),
                // The step may have changed: run it as it is now.
                (_, true) => {
                    debug.skip_pause_once(step.id.clone());
                    return Ok(Flow::Retry);
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
            self.emitter.emit(RunEvent::StepStarted {
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                attempt: 1,
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
            if !matches!(
                step.step_type.as_str(),
                control::WAIT_UNTIL | scenario::CALL
            ) {
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
                Ok(Flow::Next)
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
                    format!("失敗したステップを飛ばして続行します: {}", error.message),
                    Some(step.id.clone()),
                );
                self.skipped(step);
                Ok(Flow::Next)
            }
            (DebugCommand::Abort, _) => {
                debug.give_up(error);
                result
            }
            // Retry, or resume (which starts with the failed step).
            _ => {
                debug.skip_pause_once(step.id.clone());
                Ok(Flow::Retry)
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
                loop {
                    self.check_cancel()?;
                    if !expr::truthy(&condition.eval(&self.vars).map_err(expr_error)?) {
                        break;
                    }
                    iterations += 1;
                    if iterations > max {
                        return Err(RunError::new(
                            "LOOP_LIMIT_EXCEEDED",
                            format!("loop exceeded maxIterations ({max})"),
                        )
                        .into());
                    }
                    if let Flow::Break = self.sub_block(step, "body").await? {
                        break;
                    }
                }
                Ok(Flow::Next)
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
                for i in 0..(count as u64) {
                    self.check_cancel()?;
                    if let Some(name) = &index_var {
                        self.set_var(name, Value::from(i), Some(&step.id));
                    }
                    if let Flow::Break = self.sub_block(step, "body").await? {
                        break;
                    }
                }
                Ok(Flow::Next)
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
                // `finally` runs after success or failure, but not after cancellation.
                if matches!(result, Err(Interrupt::Cancelled)) {
                    return result;
                }
                match self.sub_block(step, "finally").await {
                    Ok(Flow::Next) => result,
                    other => other,
                }
            }
            control::GROUP => self.sub_block(step, "body").await,
            control::PARALLEL => self.parallel(step).await,
            control::WAIT_UNTIL => self.wait_until(step).await,
            scenario::CALL => self.call(step).await,
            control::BREAK => Ok(Flow::Break),
            control::CONTINUE => Ok(Flow::Continue),
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
                    .unwrap_or("SCENARIO_FAILED");
                Err(RunError::new(code, expr::to_display(&message)).into())
            }
            other => Err(RunError::new(
                "UNSUPPORTED_STEP_TYPE",
                format!("unknown control step '{other}'"),
            )
            .into()),
        }
    }

    /// Runs every branch concurrently. Each branch works on a copy of the
    /// variables; afterwards the variables each branch changed are merged
    /// back. The first failure cancels the remaining branches.
    async fn parallel(&mut self, step: &Step) -> StepResult {
        let branches = step.block("branches");
        if branches.is_empty() {
            return Ok(Flow::Next);
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
                    .map(|_| Flow::Next);
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
        Ok(Flow::Next)
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
        let results = if step.params.contains_key("concurrency") {
            let concurrency = self.eval_number(step, "concurrency")?;
            if !(1.0..=64.0).contains(&concurrency) || concurrency.fract() != 0.0 {
                return Err(RunError::new(
                    "INVALID_PARAMS",
                    "concurrency must be an integer between 1 and 64",
                )
                .into());
            }
            self.for_each_isolated(step, items, collect, concurrency as usize)
                .await?
        } else {
            let mut results = Vec::with_capacity(items.len());
            for (index, item) in items.into_iter().enumerate() {
                self.check_cancel()?;
                self.bind_item(step, index, item);
                let flow = self.sub_block(step, "body").await?;
                if let Some(collect) = &collect {
                    results.push(collect.eval(&self.vars).map_err(expr_error)?);
                }
                if let Flow::Break = flow {
                    break;
                }
            }
            results
        };
        if let Some(name) = &step.save_as {
            self.set_var(name, Value::Array(results), Some(&step.id));
        }
        Ok(Flow::Next)
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
        let mut items = items.into_iter().enumerate();

        loop {
            // Start iterations lazily so a large list never holds more than
            // `limit` copies of the variables.
            while set.len() < limit && first_error.is_none() && !group.is_cancelled() {
                let Some((index, item)) = items.next() else {
                    break;
                };
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

    /// Runs the called scenario on its own variables: `inputs` (rendered
    /// here) start them, `outputs` copy its output variables back. A
    /// failure inside becomes this step's failure, with where it happened
    /// in `details.subScenario`.
    async fn call(&mut self, step: &Step) -> StepResult {
        let target = ScenarioId::new(param_str(step, "scenario")?);
        let Some(callee) = self.library.get(&target).cloned() else {
            return Err(RunError::new(
                "CALL_TARGET_NOT_FOUND",
                format!("scenario '{target}' was not provided to this run"),
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

        let result = match step.timeout_ms {
            None => child.block(&callee.steps).await,
            Some(ms) => {
                let run =
                    tokio::time::timeout(Duration::from_millis(ms), child.block(&callee.steps));
                match run.await {
                    Ok(result) => result,
                    Err(_) => Err(Interrupt::Failed(RunError::new(
                        "STEP_TIMEOUT",
                        format!("the called scenario did not finish within {ms} ms"),
                    ))),
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
                let mut details = match error.details.take() {
                    Some(Value::Object(map)) => map,
                    Some(other) => Map::from_iter([("cause".to_owned(), other)]),
                    None => Map::new(),
                };
                // A nested call already said where inside it failed.
                details.entry("subScenario").or_insert_with(|| {
                    serde_json::json!({
                        "scenarioId": callee.id,
                        "scenarioName": callee.name,
                        "stepId": error.step_id,
                        "stepType": error.step_type,
                    })
                });
                error.details = Some(Value::Object(details));
                error.step_id = Some(step.id.clone());
                error.step_type = Some(step.step_type.clone());
                return Err(error.into());
            }
            // The call itself failed (timeout): no step inside to point at.
            Err(interrupt) => return Err(interrupt),
        }
        Ok(Flow::Next)
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
                return Ok(Flow::Next);
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

        let params = expr::render_value(&Value::Object(step.params.clone()), &self.vars)
            .map_err(expr_error)?;
        let retry = step.retry.or(self.default_retry);
        let max_attempts = retry.map_or(1, |r| r.max_attempts.max(1));
        let mut delay_ms = retry.map_or(0, |r| r.backoff_ms) as f64;
        let timeout_ms = step
            .timeout_ms
            .or_else(|| self.default_timeouts.get(&step.step_type).copied())
            .unwrap_or(self.default_timeout_ms);

        let mut attempt = 1;
        loop {
            self.check_cancel()?;
            self.emitter.emit(RunEvent::StepStarted {
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                attempt,
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
            };
            // Wait for exclusive resources (not counted towards the timeout).
            let resources = self
                .resource_defs
                .get(&step.step_type)
                .map(|defs| resource_keys(defs, &params))
                .unwrap_or_default();
            let _guards = if resources.is_empty() {
                Vec::new()
            } else {
                tokio::select! {
                    biased;
                    () = self.cancel.cancelled() => return Err(Interrupt::Cancelled),
                    g = self.resources.acquire(&resources) => g,
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
                )),
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
                    if let Some(name) = &step.save_as {
                        self.set_var(name, value, Some(&step.id));
                    }
                    return Ok(Flow::Next);
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

    fn variable_set(&mut self, step: &Step) -> StepResult {
        let started = Instant::now();
        self.emitter.emit(RunEvent::StepStarted {
            step_id: step.id.clone(),
            step_type: step.step_type.clone(),
            attempt: 1,
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
                Ok(Flow::Next)
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

pub(crate) fn final_status(result: &Result<Flow, Interrupt>) -> (RunStatus, Option<RunError>) {
    match result {
        Ok(_) => (RunStatus::Succeeded, None),
        Err(Interrupt::Cancelled) => (
            RunStatus::Cancelled,
            Some(RunError::new("RUN_CANCELLED", "the run was cancelled")),
        ),
        Err(Interrupt::Failed(e)) => (RunStatus::Failed, Some(e.clone())),
    }
}
