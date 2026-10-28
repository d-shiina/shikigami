//! The scenario interpreter.
//!
//! Control flow (`control.*`) and variable assignment are executed here;
//! every other step type is dispatched to a registered [`ActionHandler`].
//! The interpreter walks the step tree directly, so step IDs in events map
//! one-to-one to the document Studio and AI clients edit.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use shikigami_core::expr::{self, Expr};
use shikigami_core::registry::{builtin, control};
use shikigami_core::validate::LAST_ERROR_VAR;
use shikigami_core::{OnError, RetryPolicy, RunId, Scenario, Step, StepId};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::event::{
    LogLevel, RunError, RunEvent, RunEventEnvelope, RunSnapshot, RunStatus, StepOutcome,
};
use crate::handler::{ActionHandler, ActionInput, StepError};

pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
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
    seq: AtomicU64,
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
                seq: AtomicU64::new(0),
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
        let envelope = RunEventEnvelope {
            run_id: self.inner.run_id.clone(),
            seq: self.inner.seq.fetch_add(1, Ordering::SeqCst),
            at: OffsetDateTime::now_utc(),
            event,
        };
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
    pub vars: Map<String, Value>,
    pub secret_vars: Vec<String>,
    pub emitter: Emitter,
    pub cancel: CancellationToken,
    pub default_timeout_ms: u64,
    pub default_retry: Option<RetryPolicy>,
    pub default_on_error: OnError,
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

    fn eval(&self, source: &str) -> Result<Value, RunError> {
        expr::evaluate(source, &self.vars).map_err(expr_error)
    }

    /// Evaluates a param that may be a literal or an expression string.
    fn eval_number(&self, step: &Step, key: &str) -> Result<f64, RunError> {
        let value = match step.params.get(key) {
            Some(Value::String(src)) => self.eval(src)?,
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

    pub(crate) async fn block(&mut self, steps: &[Step]) -> StepResult {
        for step in steps {
            match Box::pin(self.step(step)).await? {
                Flow::Next => {}
                flow => return Ok(flow),
            }
        }
        Ok(Flow::Next)
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

        let is_control = step.step_type.starts_with("control.");
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
            return result;
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
            let outcome = tokio::select! {
                biased;
                () = self.cancel.cancelled() => None,
                r = tokio::time::timeout(Duration::from_millis(timeout_ms), handler.execute(input)) => Some(r),
            };
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
