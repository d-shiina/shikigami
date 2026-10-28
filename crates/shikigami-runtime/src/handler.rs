//! Action handler interface implemented by automation adapters.
//!
//! Handlers receive fully rendered params (templates already evaluated) and
//! return an output value. They cannot read or write scenario variables
//! directly; data flows in through params and out through `saveAs`. This keeps
//! adapters stateless with respect to scenarios and easy to test in isolation.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
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
    pub(crate) emitter: Emitter,
}

impl ActionInput {
    /// Writes a message to the run log (secrets are masked automatically).
    pub fn log(&self, level: LogLevel, message: impl Into<String>) {
        self.emitter
            .log(level, message.into(), Some(self.step_id.clone()));
    }

    /// Deserialises params into a typed struct.
    pub fn parse_params<T: serde::de::DeserializeOwned>(&self) -> Result<T, StepError> {
        serde_json::from_value(self.params.clone()).map_err(StepError::invalid_params)
    }
}

pub trait ActionHandler: Send + Sync + 'static {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>>;

    /// Resources this step type uses exclusively, e.g. [`DESKTOP_INPUT`] for
    /// real mouse and keyboard input. Steps that need the same resource never
    /// run at the same time, even across parallel branches and concurrent
    /// runs of one [`crate::Runtime`]. Waiting for a resource does not count
    /// towards the step timeout.
    fn exclusive_resources(&self) -> &'static [&'static str] {
        &[]
    }
}

/// The physical mouse, keyboard and foreground window: one per desktop.
pub const DESKTOP_INPUT: &str = "desktop.input";
