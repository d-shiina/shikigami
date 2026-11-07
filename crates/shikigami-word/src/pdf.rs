//! `word.exportPdf`: Word itself saves the document as PDF (layout, fonts
//! and page breaks as Word shows them), in a hidden Word of the step's own.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use shikigami_runtime::StepError;
use tokio_util::sync::CancellationToken;

/// Checks the parameters and makes `to`'s folder; Windows does the rest.
pub fn export(
    params: &Value,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    let path = crate::string(params, "path")?;
    let to = crate::string(params, "to")?;
    let source = Path::new(&path);
    let ext = |p: &Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default()
    };
    if !matches!(
        ext(source).as_str(),
        "docx" | "docm" | "dotx" | "dotm" | "doc" | "rtf"
    ) {
        return Err(StepError::permanent(
            "UNSUPPORTED_FORMAT",
            format!("{path} is not a Word document"),
        )
        .with_details(json!({ "hint": "Give a .docx, .doc or .rtf file." })));
    }
    if ext(Path::new(&to)) != "pdf" {
        return Err(StepError::invalid_params("'to' must end with .pdf"));
    }
    if !source.is_file() {
        return Err(StepError::permanent(
            "FILE_NOT_FOUND",
            format!("{path} does not exist"),
        ));
    }
    let overwrite = params.get("overwrite").and_then(Value::as_bool) == Some(true);
    if !overwrite && Path::new(&to).exists() {
        return Err(
            StepError::permanent("FILE_EXISTS", format!("{to} already exists"))
                .with_details(json!({ "hint": "Set overwrite: true to replace it." })),
        );
    }
    if let Some(parent) = Path::new(&to)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|e| {
            StepError::permanent(
                "FILE_ERROR",
                format!("cannot create {}: {e}", parent.display()),
            )
        })?;
    }
    word(path, to, timeout, cancel)
}

#[cfg(not(windows))]
fn word(
    _path: String,
    _to: String,
    _timeout: Duration,
    _cancel: &CancellationToken,
) -> Result<Value, StepError> {
    Err(StepError::permanent(
        "PLATFORM_UNSUPPORTED",
        "word.exportPdf needs Windows with desktop Word",
    ))
}

#[cfg(windows)]
fn word(
    path: String,
    to: String,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    use shikigami_com::{GaveUp, Object, Var, kill_process, run_on_sta};

    // wdExportFormatPDF
    const PDF: i32 = 17;
    let full = |p: &str| {
        std::path::absolute(p)
            .unwrap_or_else(|_| Path::new(p).to_path_buf())
            .to_string_lossy()
            .into_owned()
    };
    let (source, target) = (full(&path), full(&to));
    run_on_sta(
        "shikigami-word-com",
        timeout,
        cancel,
        move |session| {
            let app = Object::create("Word.Application", || {
                StepError::permanent("WORD_NOT_INSTALLED", "Word is not installed on this PC")
                    .with_details(json!({ "hint": "word.exportPdf needs desktop Word. The other word.* steps work without it." }))
            })?;
            let mut own = false;
            let result = (|| {
                // No macros of the document run, no dialogs wait for anyone
                // (msoAutomationSecurityForceDisable, wdAlertsNone).
                let _ = app.put("AutomationSecurity", Var::i32(3));
                let _ = app.put("DisplayAlerts", Var::i32(0));
                let _ = app.put("Visible", Var::bool(false));
                let docs = app.get("Documents")?.object("Documents")?;
                // A Word that already has documents is the person's: it is
                // never killed, even when the step gives up.
                own = docs.get("Count").and_then(|n| n.to_i64()).unwrap_or(1) == 0;
                // Its process is known before opening (which can hang on a
                // damaged file), so giving up can end it: Word tells it only
                // through a document's window.
                if own
                    && let Some(id) = docs.object("Add", vec![]).ok().and_then(|blank| {
                        let id = blank
                            .get("ActiveWindow")
                            .ok()
                            .and_then(|w| w.object("ActiveWindow").ok())
                            .and_then(|w| w.window_process());
                        let _ = blank.call("Close", vec![Var::bool(false)]);
                        id
                    })
                {
                    session.report_process(id);
                }
                // Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles,
                // PasswordDocument): an empty password keeps Word from asking.
                let doc = docs
                    .object(
                        "Open",
                        vec![
                            Var::str(&source),
                            Var::bool(false),
                            Var::bool(true),
                            Var::bool(false),
                            Var::str(""),
                        ],
                    )
                    .map_err(|e| {
                        StepError::permanent("DOCUMENT_UNREADABLE", format!("Word could not open {source}: {}", e.message))
                            .with_details(json!({ "hint": "The file may be damaged or have a password to open it." }))
                    })?;
                session.check()?;
                let saved = doc
                    .call("ExportAsFixedFormat", vec![Var::str(&target), Var::i32(PDF)])
                    .map_err(|e| {
                        StepError::permanent("SAVE_FAILED", format!("Word could not save {target}: {}", e.message))
                            .with_details(json!({ "hint": "Check that the folder can be written to and that the PDF is not open in another program." }))
                    });
                let _ = doc.call("Close", vec![Var::bool(false)]);
                saved
            })();
            // Quit only the Word started for the step (never the person's).
            if own {
                let _ = app.call("Quit", vec![Var::bool(false)]);
            }
            result.map(|_| json!({ "path": to }))
        },
        |gave_up| {
            if let Some(pid) = gave_up.pid {
                kill_process(pid);
            }
            match gave_up.reason {
                GaveUp::Cancelled => StepError::new("CANCELLED", "the step was stopped"),
                GaveUp::TimedOut => StepError::new("WORD_TIMEOUT", "Word did not finish in time")
                    .with_details(
                        json!({ "hint": "A long document may need a longer timeoutMs." }),
                    ),
            }
        },
    )
}
