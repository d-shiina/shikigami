//! Clipboard and dialog steps. They need the Windows desktop; elsewhere they
//! fail with PLATFORM_UNSUPPORTED (their definitions and validation still
//! work, so scenarios can be written and checked on any OS).
//!
//! Dialogs run in their own PowerShell process (dialog.ps1: WPF in Studio's
//! look, Explorer pickers for files) rather than in this one: when the step
//! is stopped or times out, the process is killed and the dialog closes with
//! it.

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

/// The dialogs, drawn in Studio's look (see the script's header).
#[cfg(windows)]
const DIALOG_SCRIPT: &str = include_str!("dialog.ps1");
/// The logo mark for the dialog's corner and taskbar button.
#[cfg(windows)]
const MARK_PNG: &[u8] = include_bytes!("dialog-mark.png");

/// Runs dialog.ps1 in `mode` (message, input or file). Values reach it only
/// through environment variables (`SHIKIGAMI_*`), never inside the script
/// text. Exit code 0 → the printed answer; 3 → cancelled.
#[cfg(windows)]
async fn powershell(mode: &str, env: &[(&str, String)]) -> Result<Option<String>, StepError> {
    use base64::Engine as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-STA", "-Command"])
        .arg("& ([scriptblock]::Create($env:SHIKIGAMI_SCRIPT))")
        .env("SHIKIGAMI_SCRIPT", DIALOG_SCRIPT)
        .env("SHIKIGAMI_MODE", mode)
        .env(
            "SHIKIGAMI_MARK",
            base64::engine::general_purpose::STANDARD.encode(MARK_PNG),
        )
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

/// Shows a message; returns the button pressed: ok, cancel, yes or no.
pub async fn message(params: &Value) -> Result<Value, StepError> {
    let message = text(params, "message").unwrap_or_default();
    let title = text(params, "title").unwrap_or_default();
    // Mapped to fixed names here, so the script never sees scenario text in
    // these two.
    let buttons = match text(params, "buttons").as_deref() {
        Some("okCancel") => "okCancel",
        Some("yesNo") => "yesNo",
        Some("yesNoCancel") => "yesNoCancel",
        _ => "ok",
    };
    let level = match text(params, "level").as_deref() {
        Some("warning") => "warning",
        Some("error") => "error",
        _ => "info",
    };
    #[cfg(windows)]
    {
        let answer = powershell(
            "message",
            &[
                ("MESSAGE", message),
                ("TITLE", title),
                ("BUTTONS", buttons.to_owned()),
                ("LEVEL", level.to_owned()),
            ],
        )
        .await?
        .unwrap_or_default();
        Ok(serde_json::json!(match answer.trim() {
            "yes" => "yes",
            "no" => "no",
            "cancel" => "cancel",
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
    let title = text(params, "title").unwrap_or_default();
    let default = text(params, "default").unwrap_or_default();
    #[cfg(windows)]
    {
        let answer = powershell(
            "input",
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
        let answer = powershell(
            "file",
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

/// Draws each kind of dialog into a PNG (dialog.ps1's snapshot mode), which
/// checks that the script and its layout load on this Windows. The pictures
/// go to SHIKIGAMI_SNAPSHOT_DIR when set (CI keeps them), otherwise to a
/// temporary folder.
#[cfg(all(test, windows))]
mod snapshots {
    use super::powershell;

    #[tokio::test]
    async fn dialogs_draw_in_both_themes_and_languages() {
        let temp = tempfile::tempdir().unwrap();
        let dir = std::env::var_os("SHIKIGAMI_SNAPSHOT_DIR")
            .map_or_else(|| temp.path().to_path_buf(), std::path::PathBuf::from);
        std::fs::create_dir_all(&dir).unwrap();
        let cases: [(&str, &str, &str, &[(&str, &str)], &str); 5] = [
            (
                "message-info",
                "message",
                "light",
                &[
                    ("MESSAGE", "12 件を登録します。よろしいですか？"),
                    ("TITLE", "受注の登録"),
                    ("BUTTONS", "yesNo"),
                    ("LEVEL", "info"),
                ],
                "yes",
            ),
            (
                "message-warning-dark",
                "message",
                "dark",
                &[
                    (
                        "MESSAGE",
                        "請求書フォルダーに同じ名前のファイルがあります。上書きしますか？",
                    ),
                    ("BUTTONS", "yesNoCancel"),
                    ("LEVEL", "warning"),
                ],
                "yes",
            ),
            (
                "message-error-en",
                "message",
                "light",
                &[
                    (
                        "MESSAGE",
                        "The order system did not answer. Try again later.",
                    ),
                    ("TITLE", "Upload failed"),
                    ("BUTTONS", "okCancel"),
                    ("LEVEL", "error"),
                ],
                "ok",
            ),
            (
                "input",
                "input",
                "light",
                &[
                    ("MESSAGE", "対象月を入力してください（例: 2026-10）"),
                    ("TITLE", "月次集計"),
                    ("DEFAULT", "2026-10"),
                ],
                "2026-10",
            ),
            (
                "input-dark",
                "input",
                "dark",
                &[
                    ("MESSAGE", "担当者名を入力してください"),
                    ("DEFAULT", "山田"),
                ],
                "山田",
            ),
        ];
        for (name, mode, theme, params, expected) in cases {
            let file = dir.join(format!("{name}.png"));
            let mut env: Vec<(&str, String)> =
                params.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
            env.push(("THEME", theme.to_owned()));
            env.push((
                "LANG",
                if name.ends_with("-en") { "en" } else { "ja" }.to_owned(),
            ));
            env.push(("SNAPSHOT", file.display().to_string()));
            let answer = powershell(mode, &env).await.unwrap();
            assert_eq!(answer.as_deref(), Some(expected), "{name}");
            assert!(std::fs::metadata(&file).unwrap().len() > 1000, "{name}");
        }
    }
}
