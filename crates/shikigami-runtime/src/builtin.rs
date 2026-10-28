//! Built-in action handlers that need no automation adapter.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::event::LogLevel;
use crate::handler::{ActionHandler, ActionInput, BoxFuture, StepError};

pub struct LogMessage;

#[derive(Deserialize)]
struct LogParams {
    message: Value,
    #[serde(default)]
    level: Option<LogLevel>,
}

impl ActionHandler for LogMessage {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let params: LogParams = input.parse_params()?;
            let message = shikigami_core::expr::to_display(&params.message);
            input.log(params.level.unwrap_or(LogLevel::Info), message);
            Ok(Value::Null)
        })
    }
}

pub struct Delay;

impl ActionHandler for Delay {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let ms = input
                .params
                .get("ms")
                .and_then(Value::as_f64)
                .filter(|ms| *ms >= 0.0)
                .ok_or_else(|| {
                    StepError::permanent("INVALID_PARAMS", "'ms' must be a non-negative number")
                })?;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let wait = Duration::from_millis(ms as u64);
            tokio::select! {
                () = input.cancel.cancelled() => {}
                () = tokio::time::sleep(wait) => {}
            }
            Ok(Value::Null)
        })
    }
}
