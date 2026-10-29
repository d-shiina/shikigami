//! Action handler interface implemented by automation adapters.
//!
//! Handlers receive fully rendered params (templates already evaluated) and
//! return an output value. They cannot read or write scenario variables
//! directly; data flows in through params and out through `saveAs`. This keeps
//! adapters stateless with respect to scenarios and easy to test in isolation.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Value, json};
use shikigami_core::secret::{ResolvedSecret, SecretError, SecretProvider, SecretRef};
use shikigami_core::{RunId, StepId};
use tokio_util::sync::CancellationToken;

use crate::event::{LogLevel, RunError};
use crate::exec::Emitter;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Error returned by a handler.
#[derive(Debug, Clone, PartialEq)]
pub struct StepError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
    /// Whether a retry may succeed (transient failures such as timeouts or
    /// elements not yet present). Non-retryable errors skip the retry policy.
    pub retryable: bool,
}

impl StepError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
            retryable: true,
        }
    }

    pub fn permanent(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            retryable: false,
            ..Self::new(code, message)
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn invalid_params(err: impl std::fmt::Display) -> Self {
        Self::permanent("INVALID_PARAMS", err.to_string())
    }
}

impl From<StepError> for RunError {
    fn from(e: StepError) -> Self {
        RunError {
            code: e.code,
            message: e.message,
            step_id: None,
            step_type: None,
            details: e.details,
        }
    }
}

/// Everything a handler gets for one attempt.
pub struct ActionInput {
    pub run_id: RunId,
    pub step_id: StepId,
    pub step_type: String,
    pub attempt: u32,
    /// Params after template rendering.
    pub params: Value,
    /// Cancelled when the run is stopped or the attempt times out. Long
    /// operations should observe it; the Runtime also drops the future.
    pub cancel: CancellationToken,
    /// This attempt's time limit (the step's `timeoutMs`). A handler that
    /// hands work to another process should pass on a slightly shorter limit,
    /// so the operation has stopped by the time the Runtime retries or moves
    /// on (dropping the future cannot stop work in another process).
    pub timeout_ms: u64,
    pub(crate) emitter: Emitter,
    pub(crate) secrets: Option<Arc<dyn SecretProvider>>,
}

impl From<SecretError> for StepError {
    fn from(e: SecretError) -> Self {
        let details = e.details();
        let error = StepError::permanent(e.code, e.message);
        match details {
            Some(details) => error.with_details(details),
            None => error,
        }
    }
}

impl ActionInput {
    /// Writes a message to the run log (secrets are masked automatically).
    pub fn log(&self, level: LogLevel, message: impl Into<String>) {
        self.emitter
            .log(level, message.into(), Some(self.step_id.clone()));
    }

    /// Tells the person at the PC that the step waits for them (shown in
    /// Studio while the step runs).
    pub fn request_human(&self, message: impl Into<String>) {
        self.emitter
            .human_action_required(message.into(), self.step_id.clone());
    }

    /// Looks up `value` when it is a secret reference
    /// (`{ "secret": "受注システム", "field": "password" }`); `None` for any
    /// other value. Sensitive values are masked in this run's logs, errors
    /// and outputs from now on.
    pub fn resolve_secret(&self, value: &Value) -> Result<Option<ResolvedSecret>, StepError> {
        let Some(reference) = SecretRef::from_value(value) else {
            return Ok(None);
        };
        let reference = reference.map_err(StepError::invalid_params)?;
        let resolved = self.secret_provider()?.resolve(&reference)?;
        if resolved.field.is_sensitive() {
            self.emitter
                .add_secret(&Value::String(resolved.value.clone()));
        }
        Ok(Some(resolved))
    }

    /// The Runtime's secret store (also holds saved browser logins).
    /// Masks `value` in this run's logs, errors and outputs from now on
    /// (for values a step obtains itself, such as an OAuth access token).
    pub fn mask_secret(&self, value: &str) {
        self.emitter.add_secret(&Value::String(value.to_owned()));
    }

    pub fn secret_provider(&self) -> Result<&Arc<dyn SecretProvider>, StepError> {
        self.secrets.as_ref().ok_or_else(|| {
            StepError::permanent("SECRETS_UNAVAILABLE", "this runtime has no secret store")
                .with_details(json!({ "hint": "Run the scenario from Studio, the CLI or the MCP server of a workspace." }))
        })
    }

    /// Deserialises params into a typed struct.
    pub fn parse_params<T: serde::de::DeserializeOwned>(&self) -> Result<T, StepError> {
        serde_json::from_value(self.params.clone()).map_err(StepError::invalid_params)
    }
}

pub trait ActionHandler: Send + Sync + 'static {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>>;
}
