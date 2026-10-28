//! `excel.runMacro`: the one excel.* step that needs Excel itself.

use std::time::Duration;

use serde_json::{Value, json};
use shikigami_runtime::StepError;
use tokio_util::sync::CancellationToken;

/// What to run: the workbook, the macro and its arguments.
#[derive(Debug, Clone)]
pub struct MacroRequest {
    pub path: String,
    /// `集計`, `Module1.集計`, or a full `'book.xlsm'!集計`.
    pub name: String,
    pub args: Vec<Value>,
    /// Save the workbook after the macro (default true).
    pub save: bool,
}

/// Most arguments `Application.Run` passes on.
pub const MAX_ARGS: usize = 30;

pub fn request(params: &Value) -> Result<MacroRequest, StepError> {
    let text = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| StepError::invalid_params(format!("'{key}' is required")))
    };
    let args = match params.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(args)) if args.len() <= MAX_ARGS => args.clone(),
        Some(Value::Array(_)) => {
            return Err(StepError::invalid_params(format!(
                "a macro takes at most {MAX_ARGS} arguments"
            )));
        }
        Some(_) => return Err(StepError::invalid_params("'args' must be a list")),
    };
    let request = MacroRequest {
        path: text("path")?,
        name: text("macro")?,
        args,
        save: params.get("save").and_then(Value::as_bool).unwrap_or(true),
    };
    let path = std::path::Path::new(&request.path);
    if !path.is_file() {
        return Err(StepError::permanent(
            "FILE_NOT_FOUND",
            format!("{} does not exist", request.path),
        )
        .with_details(json!({ "hint": "Give the full path of the workbook that holds the macro (usually .xlsm)." })));
    }
    if request.save && crate::book::open_in_excel(path) {
        return Err(crate::book::in_use(path));
    }
    Ok(request)
}

/// Runs the macro in a separate Excel and returns what it returned.
#[cfg(windows)]
pub fn run(
    request: MacroRequest,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    crate::com::run(request, timeout, cancel)
}

#[cfg(not(windows))]
pub fn run(
    _request: MacroRequest,
    _timeout: Duration,
    _cancel: &CancellationToken,
) -> Result<Value, StepError> {
    Err(StepError::permanent(
        "PLATFORM_UNSUPPORTED",
        "running Excel macros needs Windows with Excel installed",
    ))
}
