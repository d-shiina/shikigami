//! Clipboard and dialog steps. They need the Windows desktop; elsewhere they
//! fail with PLATFORM_UNSUPPORTED (their definitions and validation still
//! work, so scenarios can be written and checked on any OS).
//!
//! Dialogs run in their own PowerShell process (Windows Forms) rather than
//! in this one: when the step is stopped or times out, the process is
//! killed and the dialog closes with it.

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

/// Shared start of every dialog script: UTF-8 output and a topmost owner
/// window, so the dialog is not hidden behind the application being
/// automated.
#[cfg(windows)]
const PRELUDE: &str = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
    Add-Type -AssemblyName System.Windows.Forms; \
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }; ";

/// Runs a dialog script. Values reach it only through environment
/// variables (`SHIKIGAMI_*`), never inside the script text. Exit code 0 →
/// the printed answer; 3 → cancelled.
#[cfg(windows)]
async fn powershell(script: &str, env: &[(&str, String)]) -> Result<Option<String>, StepError> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-STA", "-Command"])
        .arg(format!("{PRELUDE}{script}"))
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(format!("SHIKIGAMI_{key}"), value);
    }
    let output = command
        .output()
        .await
        .map_err(|e| StepError::permanent("DIALOG_FAILED", e.to_string()))?;
    match output.status.code() {
        Some(0) => Ok(Some(
            String::from_utf8_lossy(&output.stdout)
                .trim_end_matches(['\r', '\n'])
                .to_owned(),
        )),
        Some(3) => Ok(None),
        _ => Err(StepError::permanent(
            "DIALOG_FAILED",
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        )),
    }
}

/// Shows a message box; returns the button pressed: ok, cancel, yes or no.
pub async fn message(params: &Value) -> Result<Value, StepError> {
    let message = text(params, "message").unwrap_or_default();
    let title = text(params, "title").unwrap_or_else(|| "Shikigami".into());
    // Mapped to fixed Windows Forms names here, so the script never sees
    // scenario text in these two.
    let buttons = match text(params, "buttons").as_deref() {
        Some("okCancel") => "OKCancel",
        Some("yesNo") => "YesNo",
        Some("yesNoCancel") => "YesNoCancel",
        _ => "OK",
    };
    let icon = match text(params, "level").as_deref() {
        Some("warning") => "Warning",
        Some("error") => "Error",
        _ => "Information",
    };
    #[cfg(windows)]
    {
        const SCRIPT: &str = "$r = [System.Windows.Forms.MessageBox]::Show($owner, $env:SHIKIGAMI_MESSAGE, $env:SHIKIGAMI_TITLE, \
            [System.Windows.Forms.MessageBoxButtons]::$env:SHIKIGAMI_BUTTONS, [System.Windows.Forms.MessageBoxIcon]::$env:SHIKIGAMI_ICON); \
            Write-Output $r";
        let answer = powershell(
            SCRIPT,
            &[
                ("MESSAGE", message),
                ("TITLE", title),
                ("BUTTONS", buttons.to_owned()),
                ("ICON", icon.to_owned()),
            ],
        )
        .await?
        .unwrap_or_default();
        Ok(serde_json::json!(match answer.trim() {
            "Yes" => "yes",
            "No" => "no",
            "Cancel" => "cancel",
            _ => "ok",
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = (message, title, buttons, icon);
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
        const SCRIPT: &str = "Add-Type -AssemblyName Microsoft.VisualBasic; \
            [Microsoft.VisualBasic.Interaction]::InputBox($env:SHIKIGAMI_MESSAGE, $env:SHIKIGAMI_TITLE, $env:SHIKIGAMI_DEFAULT)";
        let answer = powershell(
            SCRIPT,
            &[("MESSAGE", message), ("TITLE", title), ("DEFAULT", default)],
        )
        .await?;
        Ok(serde_json::json!(answer.unwrap_or_default()))
    }
    #[cfg(not(windows))]
    {
        let _ = (message, title, default);
        Err(unsupported())
    }
}

/// Lets the person pick a file, files, a folder or a save location.
/// Returns the path (a list for `files`), or null when cancelled.
pub async fn select_file(params: &Value) -> Result<Value, StepError> {
    let kind = text(params, "kind").unwrap_or_else(|| "file".into());
    let title = text(params, "title").unwrap_or_default();
    let folder = text(params, "folder").unwrap_or_default();
    let file_name = text(params, "fileName").unwrap_or_default();
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
                .filter(|x| !x.is_empty() && !x.contains(['|', ';']))
                .collect()
        })
        .unwrap_or_default();
    #[cfg(windows)]
    {
        let filter = if extensions.is_empty() {
            String::new()
        } else {
            let patterns: Vec<String> = extensions.iter().map(|e| format!("*.{e}")).collect();
            format!("{0}|{0}", patterns.join(";"))
        };
        let script = match kind.as_str() {
            "folder" => {
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog; \
                $d.Description = $env:SHIKIGAMI_TITLE; \
                if ($env:SHIKIGAMI_FOLDER) { $d.SelectedPath = $env:SHIKIGAMI_FOLDER }; \
                if ($d.ShowDialog($owner) -ne 'OK') { exit 3 }; Write-Output $d.SelectedPath"
            }
            other => {
                if other == "save" {
                    "$d = New-Object System.Windows.Forms.SaveFileDialog; "
                } else {
                    "$d = New-Object System.Windows.Forms.OpenFileDialog; \
                     $d.Multiselect = ($env:SHIKIGAMI_KIND -eq 'files'); "
                }
            }
        };
        let script = if kind == "folder" {
            script.to_owned()
        } else {
            format!(
                "{script}if ($env:SHIKIGAMI_TITLE) {{ $d.Title = $env:SHIKIGAMI_TITLE }}; \
                 if ($env:SHIKIGAMI_FOLDER) {{ $d.InitialDirectory = $env:SHIKIGAMI_FOLDER }}; \
                 if ($env:SHIKIGAMI_FILE) {{ $d.FileName = $env:SHIKIGAMI_FILE }}; \
                 if ($env:SHIKIGAMI_FILTER) {{ $d.Filter = $env:SHIKIGAMI_FILTER }}; \
                 if ($d.ShowDialog($owner) -ne 'OK') {{ exit 3 }}; $d.FileNames | ForEach-Object {{ Write-Output $_ }}"
            )
        };
        let answer = powershell(
            &script,
            &[
                ("KIND", kind.clone()),
                ("TITLE", title),
                ("FOLDER", folder),
                ("FILE", file_name),
                ("FILTER", filter),
            ],
        )
        .await?;
        let Some(answer) = answer else {
            return Ok(Value::Null);
        };
        let paths: Vec<Value> = answer
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| Value::String(l.trim_end().to_owned()))
            .collect();
        Ok(if kind == "files" {
            Value::Array(paths)
        } else {
            paths.into_iter().next().unwrap_or(Value::Null)
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (kind, title, folder, file_name, extensions);
        Err(unsupported())
    }
}
