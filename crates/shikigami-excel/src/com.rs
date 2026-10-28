//! Excel itself, through COM automation: only for what the file alone
//! cannot do (running a workbook's macros).
//!
//! Each request starts its own Excel instance on its own apartment thread,
//! so the person's open Excel windows are never touched, and a macro that
//! hangs (a MsgBox, an endless loop) is ended by killing that instance
//! when the step's time is up.

use std::time::Duration;

use serde_json::{Value, json};
use shikigami_com::{GaveUp, Object, Session, Var, kill_process, run_on_sta};
use shikigami_runtime::StepError;
use tokio_util::sync::CancellationToken;

use crate::macros::MacroRequest;

/// Runs the macro and waits for it, ending Excel when `timeout` passes or
/// the step is stopped.
pub fn run(
    request: MacroRequest,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    run_on_sta(
        "shikigami-excel-com",
        timeout,
        cancel,
        move |session| run_session(&request, session),
        |gave_up| {
            if let Some(pid) = gave_up.pid {
                kill_process(pid);
            }
            match gave_up.reason {
                GaveUp::Cancelled => StepError::new(
                    "CANCELLED",
                    "the step was stopped; Excel was closed without saving",
                ),
                GaveUp::TimedOut => StepError::new(
                    "MACRO_TIMEOUT",
                    "the macro did not finish in time; Excel was closed without saving",
                )
                .with_details(json!({ "hint": "A macro that shows a MsgBox or InputBox waits for a person and never finishes unattended: remove the dialog from the macro. If it is just slow, raise the step's timeoutMs." })),
            }
        },
    )
}

fn run_session(request: &MacroRequest, session: &Session) -> Result<Value, StepError> {
    let app = Object::create("Excel.Application", || {
        StepError::permanent("EXCEL_NOT_INSTALLED", "Excel is not installed on this PC")
            .with_details(json!({ "hint": "excel.runMacro needs desktop Excel. Reading and writing cells (the other excel.* steps) works without it." }))
    })?;
    if let Some(id) = app.window_process() {
        session.report_process(id);
    }
    let result = with_app(&app, request, session);
    let _ = app.call("Quit", vec![]);
    result
}

fn with_app(app: &Object, request: &MacroRequest, session: &Session) -> Result<Value, StepError> {
    session.check()?;
    app.put("DisplayAlerts", Var::bool(false))?;
    let _ = app.put("AskToUpdateLinks", Var::bool(false));
    let books = app.get("Workbooks")?.object("Workbooks")?;
    // Workbooks.Open(Filename, UpdateLinks:=0)
    let book = books.object("Open", vec![Var::str(&request.path), Var::i32(0)])?;
    let result = with_book(app, &book, request, session);
    let _ = book.call("Close", vec![Var::bool(false)]);
    result
}

fn with_book(
    app: &Object,
    book: &Object,
    request: &MacroRequest,
    session: &Session,
) -> Result<Value, StepError> {
    if request.save && book.get("ReadOnly")?.to_bool() {
        return Err(crate::book::in_use(std::path::Path::new(&request.path)));
    }
    let name = book.get("Name")?.to_text();
    let target = if request.name.contains('!') {
        request.name.clone()
    } else {
        format!("'{}'!{}", name.replace('\'', "''"), request.name)
    };
    let mut args = vec![Var::str(&target)];
    for arg in &request.args {
        args.push(Var::from_json(arg)?);
    }
    session.check()?;
    let output = app.call("Run", args).map_err(|e| {
        StepError::permanent("MACRO_FAILED", format!("macro '{}' failed: {}", request.name, e.message))
            .with_details(json!({ "hint": "Check the macro name (Module1.集計 or 集計), that it is a Public Sub/Function in a standard module, and that `args` match its parameters. A workbook downloaded from the internet must be unblocked (file properties → 許可する) before its macros run." }))
    })?;
    if request.save {
        session.check()?;
        book.call("Save", vec![])?;
    }
    Ok(output.to_json())
}
