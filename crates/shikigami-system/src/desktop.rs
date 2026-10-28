//! Clipboard and dialog steps. They need the Windows desktop; elsewhere they
//! fail with PLATFORM_UNSUPPORTED (their definitions and validation still
//! work, so scenarios can be written and checked on any OS).

use serde_json::Value;
use shikigami_runtime::StepError;

#[cfg(not(windows))]
fn unsupported() -> StepError {
    StepError::permanent(
        "PLATFORM_UNSUPPORTED",
        "clipboard and dialog steps run only on Windows",
    )
}

fn text(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .filter(|v| !v.is_null())
        .map(shikigami_core::expr::to_display)
}

/// The clipboard's text ("" when it holds no text).
pub fn clipboard_get() -> Result<Value, StepError> {
    #[cfg(windows)]
    {
        if !clipboard_win::is_format_avail(clipboard_win::formats::CF_UNICODETEXT) {
            return Ok(serde_json::json!(""));
        }
        clipboard_win::get_clipboard_string()
            .map(Value::String)
            .map_err(|e| StepError::new("CLIPBOARD_BUSY", e.to_string()))
    }
    #[cfg(not(windows))]
    {
        Err(unsupported())
    }
}

pub fn clipboard_set(params: &Value) -> Result<Value, StepError> {
    let value = text(params, "text").unwrap_or_default();
    #[cfg(windows)]
    {
        clipboard_win::set_clipboard_string(&value)
            .map_err(|e| StepError::new("CLIPBOARD_BUSY", e.to_string()))?;
        Ok(serde_json::json!(value))
    }
    #[cfg(not(windows))]
    {
        let _ = value;
        Err(unsupported())
    }
}

/// Shows a message box; returns the button pressed: ok, cancel, yes or no.
pub fn message(params: &Value) -> Result<Value, StepError> {
    let message = text(params, "message").unwrap_or_default();
    let title = text(params, "title").unwrap_or_else(|| "Shikigami".into());
    let buttons = text(params, "buttons").unwrap_or_else(|| "ok".into());
    let level = text(params, "level").unwrap_or_else(|| "info".into());
    #[cfg(windows)]
    {
        use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
        let result = MessageDialog::new()
            .set_title(title)
            .set_description(message)
            .set_level(match level.as_str() {
                "warning" => MessageLevel::Warning,
                "error" => MessageLevel::Error,
                _ => MessageLevel::Info,
            })
            .set_buttons(match buttons.as_str() {
                "okCancel" => MessageButtons::OkCancel,
                "yesNo" => MessageButtons::YesNo,
                "yesNoCancel" => MessageButtons::YesNoCancel,
                _ => MessageButtons::Ok,
            })
            .show();
        Ok(serde_json::json!(match result {
            MessageDialogResult::Yes => "yes",
            MessageDialogResult::No => "no",
            MessageDialogResult::Cancel => "cancel",
            _ => "ok",
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = (message, title, buttons, level);
        Err(unsupported())
    }
}

/// Asks for one line of text. Returns "" when the person cancels.
pub async fn input(params: &Value) -> Result<Value, StepError> {
    let message = text(params, "message").unwrap_or_default();
    let title = text(params, "title").unwrap_or_else(|| "Shikigami".into());
    let default = text(params, "default").unwrap_or_default();
    #[cfg(windows)]
    {
        // The values travel in environment variables, never in the script.
        const SCRIPT: &str = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
            Add-Type -AssemblyName Microsoft.VisualBasic; \
            [Microsoft.VisualBasic.Interaction]::InputBox($env:SHIKIGAMI_PROMPT, $env:SHIKIGAMI_TITLE, $env:SHIKIGAMI_DEFAULT)";
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .env("SHIKIGAMI_PROMPT", message)
            .env("SHIKIGAMI_TITLE", title)
            .env("SHIKIGAMI_DEFAULT", default)
            .creation_flags(CREATE_NO_WINDOW)
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| StepError::permanent("DIALOG_FAILED", e.to_string()))?;
        let answer = String::from_utf8_lossy(&output.stdout);
        Ok(serde_json::json!(answer.trim_end_matches(['\r', '\n'])))
    }
    #[cfg(not(windows))]
    {
        let _ = (message, title, default);
        Err(unsupported())
    }
}

/// Lets the person pick a file, files, a folder or a save location.
/// Returns the path (a list for `files`), or null when cancelled.
pub fn select_file(params: &Value) -> Result<Value, StepError> {
    let kind = text(params, "kind").unwrap_or_else(|| "file".into());
    let title = text(params, "title");
    let folder = text(params, "folder");
    let file_name = text(params, "fileName");
    let extensions: Vec<String> = params
        .get("extensions")
        .and_then(Value::as_array)
        .map(|e| {
            e.iter()
                .map(|x| {
                    shikigami_core::expr::to_display(x)
                        .trim_start_matches("*.")
                        .trim_start_matches('.')
                        .to_owned()
                })
                .collect()
        })
        .unwrap_or_default();
    #[cfg(windows)]
    {
        let mut dialog = rfd::FileDialog::new();
        if let Some(title) = title {
            dialog = dialog.set_title(title);
        }
        if let Some(folder) = folder {
            dialog = dialog.set_directory(folder);
        }
        if let Some(name) = file_name {
            dialog = dialog.set_file_name(name);
        }
        if !extensions.is_empty() {
            dialog = dialog.add_filter(extensions.join(", "), &extensions);
        }
        let shown = |p: std::path::PathBuf| serde_json::json!(p.display().to_string());
        Ok(match kind.as_str() {
            "files" => dialog.pick_files().map_or(Value::Null, |ps| {
                Value::Array(ps.into_iter().map(shown).collect())
            }),
            "folder" => dialog.pick_folder().map_or(Value::Null, shown),
            "save" => dialog.save_file().map_or(Value::Null, shown),
            _ => dialog.pick_file().map_or(Value::Null, shown),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (kind, title, folder, file_name, extensions);
        Err(unsupported())
    }
}
