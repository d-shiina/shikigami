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
use shikigami_core::expr::{self, Expr};
use shikigami_core::registry::{builtin, control, is_control_type};
use shikigami_core::resource::{ResourceDef, resource_keys};
use shikigami_core::validate::LAST_ERROR_VAR;
use shikigami_core::{OnError, RetryPolicy, RunId, Scenario, Step, StepId};
use time::OffsetDateTime;
use tokio::sync::{OwnedMutexGuard, Semaphore, mpsc};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::event::{
    LogLevel, RunError, RunEvent, RunEventEnvelope, RunSnapshot, RunStatus, StepOutcome,
};
use crate::handler::{ActionHandler, ActionInput, BoxFuture, StepError};

pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_WAIT_INTERVAL_MS: u64 = 500;
const DEFAULT_MAX_ITERATIONS: u64 = 1000;
const MASK: &str = "***";

// ---------------------------------------------------------------------------
// Event emission with secret masking

#[derive(Clone)]
pub struct Emitter {
    inner: Arc<EmitterInner>,
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
        }
    }

    pub(crate) fn add_secret(&self, value: &Value) {
        let text = expr::to_display(value);
        if text.is_empty() {
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

    pub(crate) fn mask_value(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.mask(s)),
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
            event,
        };
        *seq += 1;
        // The receiver may have been dropped (fire-and-forget runs); the run
        // continues regardless.
        let _ = self.inner.tx.send(envelope);
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
    pub vars: Map<String, Value>,
    pub secret_vars: Vec<String>,
    pub emitter: Emitter,
    pub cancel: CancellationToken,
    pub default_timeout_ms: u64,
    pub default_retry: Option<RetryPolicy>,
    pub default_on_error: OnError,
    pub resources: Arc<ResourceLocks>,
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
            vars: self.vars.clone(),
            secret_vars: self.secret_vars.clone(),
            emitter: self.emitter.clone(),
            cancel,
            default_timeout_ms: self.default_timeout_ms,
            default_retry: self.default_retry,
            default_on_error: self.default_on_error,
            resources: self.resources.clone(),
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

    pub(crate) fn set_var(&mut self, name: &str, value: Value) {
        if self.secret_vars.iter().any(|s| s == name) {
            self.emitter.add_secret(&value);
        }
        self.vars.insert(name.to_owned(), value);
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
            self.emitter.emit(RunEvent::StepFinished {
                step_id: step.id.clone(),
                step_type: step.step_type.clone(),
                outcome: StepOutcome::Skipped,
                duration_ms: 0,
                error: None,
                will_retry: false,
            });
            return Ok(Flow::Next);
        }
        self.emitter.update_snapshot(|s| {
            s.current_step = Some(step.id.clone());
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
            // A wait that times out may be skipped with onError: continue;
            // other control steps only pass on their children's errors.
            if step.step_type != control::WAIT_UNTIL {
                return result;
            }
        }

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
                self.set_var(LAST_ERROR_VAR, value);
                Ok(Flow::Next)
            }
            other => other,
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
                self.block(step.block(branch)).await
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
                    if let Flow::Break = self.block(step.block("body")).await? {
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
                        self.set_var(name, Value::from(i));
                    }
                    if let Flow::Break = self.block(step.block("body")).await? {
                        break;
                    }
                }
                Ok(Flow::Next)
            }
            control::FOR_EACH => {
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
                let item_var = param_str(step, "itemVar")?.to_owned();
                let index_var = step
                    .params
                    .get("indexVar")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                for (i, item) in items.into_iter().enumerate() {
                    self.check_cancel()?;
                    self.set_var(&item_var, item);
                    if let Some(name) = &index_var {
                        self.set_var(name, Value::from(i));
                    }
                    if let Flow::Break = self.block(step.block("body")).await? {
                        break;
                    }
                }
                Ok(Flow::Next)
            }
            control::TRY => {
                let error_var = step
                    .params
                    .get("errorVar")
                    .and_then(Value::as_str)
                    .unwrap_or("error")
                    .to_owned();
                let mut result = self.block(step.block("try")).await;
                if let Err(Interrupt::Failed(error)) = &result
                    && !step.block("catch").is_empty()
                {
                    self.emitter.log(
                        LogLevel::Info,
                        format!("例外を捕捉しました: {}", error.message),
                        Some(step.id.clone()),
                    );
                    let value = error.to_value();
                    self.set_var(&error_var, value);
                    result = self.block(step.block("catch")).await;
                }
                // `finally` runs after success or failure, but not after cancellation.
                if matches!(result, Err(Interrupt::Cancelled)) {
                    return result;
                }
                match self.block(step.block("finally")).await {
                    Ok(Flow::Next) => result,
                    other => other,
                }
            }
            control::GROUP => self.block(step.block("body")).await,
            control::PARALLEL => self.parallel(step).await,
            control::WAIT_UNTIL => self.wait_until(step).await,
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
        for (name, (_, value)) in changed {
            self.set_var(&name, value);
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
        let mut polls = 0u64;
        loop {
            self.check_cancel()?;
            self.block(step.block("check")).await?;
            polls += 1;
            if expr::truthy(&condition.eval(&self.vars).map_err(expr_error)?) {
                return Ok(Flow::Next);
            }
            let elapsed_ms = duration_ms(started);
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
        let timeout_ms = step.timeout_ms.unwrap_or(self.default_timeout_ms);

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
                emitter: self.emitter.clone(),
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
                        self.set_var(name, value);
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
                self.set_var(&name, value.clone());
                if let Some(save_as) = &step.save_as {
                    self.set_var(save_as, value);
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
