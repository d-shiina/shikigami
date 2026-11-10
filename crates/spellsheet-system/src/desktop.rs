//! Clipboard and dialog steps. They need the Windows desktop; elsewhere they
//! fail with PLATFORM_UNSUPPORTED (their definitions and validation still
//! work, so flows can be written and checked on any OS).
//!
//! Dialogs run in their own PowerShell process (dialog.ps1: WPF in Studio's
//! look, Explorer pickers for files) rather than in this one: when the step
//! is stopped or times out, the process is killed and the dialog closes with
//! it.

use serde_json::Value;
use spellsheet_runtime::StepError;

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
        .map(spellsheet_core::expr::to_display)
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
/// through environment variables (`SPELLSHEET_*`), never inside the script
/// text. Exit code 0 → the printed answer; 3 → cancelled.
#[cfg(windows)]
async fn powershell(mode: &str, env: &[(&str, String)]) -> Result<Option<String>, StepError> {
    use base64::Engine as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-STA", "-Command"])
        .arg("& ([scriptblock]::Create($env:SPELLSHEET_SCRIPT))")
        .env("SPELLSHEET_SCRIPT", DIALOG_SCRIPT)
        .env("SPELLSHEET_MODE", mode)
        .env(
            "SPELLSHEET_MARK",
            base64::engine::general_purpose::STANDARD.encode(MARK_PNG),
        )
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(format!("SPELLSHEET_{key}"), value);
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
        // PowerShell's own errors (before the script sets UTF-8) come in the
        // console's code page.
        _ => Err(StepError::permanent(
            "DIALOG_FAILED",
            spellsheet_files::encoding::console_text(&output.stderr)
                .trim()
                .to_owned(),
        )),
    }
}

/// Shows a message; returns the button pressed: ok, cancel, yes or no.
pub async fn message(params: &Value) -> Result<Value, StepError> {
    let message = text(params, "message").unwrap_or_default();
    let title = text(params, "title").unwrap_or_default();
    // Mapped to fixed names here, so the script never sees flow text in
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

/// The kinds of `dialog.form` fields.
pub const FIELD_TYPES: [&str; 6] = ["text", "multiline", "number", "date", "select", "checkbox"];

/// Checks `fields` and turns them into what dialog.ps1 reads: each with a
/// name, a label (the name when none), a known type, and its default and
/// options as the type takes them.
pub fn form_fields(params: &Value) -> Result<Vec<Value>, StepError> {
    let fields = params
        .get("fields")
        .and_then(Value::as_array)
        .filter(|f| !f.is_empty())
        .ok_or_else(|| StepError::invalid_params("'fields' must list at least one field"))?;
    let mut names = std::collections::HashSet::new();
    fields
        .iter()
        .map(|field| {
            let name = field
                .get("name")
                .map(spellsheet_core::expr::to_display)
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| StepError::invalid_params("every field needs a 'name'"))?;
            // The form's answers are keyed without regard to case (PowerShell).
            if !names.insert(name.to_lowercase()) {
                return Err(StepError::invalid_params(format!(
                    "two fields are named '{name}' (names differing only in upper / lower case count as the same)"
                )));
            }
            let kind = field.get("type").and_then(Value::as_str).unwrap_or("text");
            if !FIELD_TYPES.contains(&kind) {
                return Err(StepError::invalid_params(format!(
                    "field '{name}': type must be one of {}",
                    FIELD_TYPES.join(", ")
                )));
            }
            let label = text(field, "label").unwrap_or_else(|| name.clone());
            let default = field.get("default").filter(|v| !v.is_null());
            let options: Vec<String> = match field.get("options") {
                Some(Value::Array(items)) => {
                    items.iter().map(spellsheet_core::expr::to_display).collect()
                }
                _ => Vec::new(),
            };
            if kind == "select" && options.is_empty() {
                return Err(StepError::invalid_params(format!(
                    "field '{name}': a select needs 'options'"
                )));
            }
            let default = match (kind, default) {
                (_, None) => Value::Null,
                ("checkbox", Some(v)) => Value::Bool(match v {
                    Value::Bool(b) => *b,
                    Value::String(s) => s == "true",
                    _ => false,
                }),
                ("date", Some(v)) => {
                    let day = spellsheet_core::expr::to_display(v);
                    let day: String = day.chars().take(10).collect();
                    if !is_day(&day) {
                        return Err(StepError::invalid_params(format!(
                            "field '{name}': the default date must look like 2026-10-28"
                        )));
                    }
                    Value::String(day)
                }
                (_, Some(v)) => Value::String(spellsheet_core::expr::to_display(v)),
            };
            Ok(serde_json::json!({
                "name": name,
                "label": label,
                "type": kind,
                "required": field.get("required").and_then(Value::as_bool).unwrap_or(false),
                "default": default,
                "options": options,
            }))
        })
        .collect()
}

/// `2026-10-28`.
fn is_day(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let number = |s: &str, len: usize| {
        (s.len() == len && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u32>().ok())
            .flatten()
    };
    matches!(
        (parts.as_slice(), parts.first().and_then(|y| number(y, 4))),
        ([_, m, d], Some(_)) if number(m, 2).is_some_and(|m| (1..=12).contains(&m)) && number(d, 2).is_some_and(|d| (1..=31).contains(&d))
    )
}

/// The form's answers as the flow gets them: whole numbers without `.0`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn form_answers(printed: &str) -> Result<Value, StepError> {
    let mut answers: Value = serde_json::from_str(printed.trim())
        .map_err(|e| StepError::permanent("DIALOG_FAILED", format!("unreadable answers: {e}")))?;
    if let Some(map) = answers.as_object_mut() {
        for value in map.values_mut() {
            if let Some(n) = value.as_f64()
                && n.fract() == 0.0
                && n.abs() < 9_007_199_254_740_992.0
            {
                *value = serde_json::json!(n as i64);
            }
        }
    }
    Ok(answers)
}

/// Asks for several values at once. Returns them by field name, or null
/// when the person cancels.
pub async fn form(params: &Value) -> Result<Value, StepError> {
    let fields = form_fields(params)?;
    let message = text(params, "message").unwrap_or_default();
    let title = text(params, "title").unwrap_or_default();
    #[cfg(windows)]
    {
        let answer = powershell(
            "form",
            &[
                ("MESSAGE", message),
                ("TITLE", title),
                ("FIELDS", Value::Array(fields).to_string()),
            ],
        )
        .await?;
        match answer {
            Some(printed) => form_answers(&printed),
            None => Ok(Value::Null),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (fields, message, title);
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
                    spellsheet_core::expr::to_display(x)
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
/// go to SPELLSHEET_SNAPSHOT_DIR when set (CI keeps them), otherwise to a
/// temporary folder.
#[cfg(all(test, windows))]
mod snapshots {
    use super::powershell;

    /// Picture name, dialog mode, theme, SPELLSHEET_* values, expected answer.
    type Case = (
        &'static str,
        &'static str,
        &'static str,
        &'static [(&'static str, &'static str)],
        &'static str,
    );

    #[tokio::test]
    async fn dialogs_draw_in_both_themes_and_languages() {
        let temp = tempfile::tempdir().unwrap();
        let dir = spellsheet_core::paths::env_var("SNAPSHOT_DIR")
            .map_or_else(|| temp.path().to_path_buf(), std::path::PathBuf::from);
        std::fs::create_dir_all(&dir).unwrap();
        let cases: [Case; 8] = [
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
                "message-ok",
                "message",
                "light",
                &[("MESSAGE", "請求書を 12 件作りました。")],
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
                "form",
                "form",
                "light",
                &[
                    ("TITLE", "請求書の発行"),
                    ("MESSAGE", "今回の条件を入れてください"),
                    (
                        "FIELDS",
                        r#"[{"name":"month","label":"対象月","type":"text","required":true,"default":"2026-10","options":[]},{"name":"due","label":"支払期限","type":"date","required":false,"default":"2026-11-30","options":[]},{"name":"office","label":"営業所","type":"select","required":true,"default":"大阪","options":["東京","大阪"]},{"name":"min","label":"最低金額","type":"number","required":false,"default":"10,000","options":[]},{"name":"note","label":"備考","type":"multiline","required":false,"default":null,"options":[]},{"name":"mail","label":"メールでも送る","type":"checkbox","required":false,"default":true,"options":[]}]"#,
                    ),
                ],
                r#"{"month":"2026-10","due":"2026-11-30","office":"大阪","min":10000,"note":"","mail":true}"#,
            ),
            (
                "form-incomplete-dark",
                "form",
                "dark",
                &[(
                    "FIELDS",
                    r#"[{"name":"month","label":"対象月","type":"text","required":true,"default":null,"options":[]},{"name":"min","label":"最低金額","type":"number","required":false,"default":"たくさん","options":[]}]"#,
                )],
                "",
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
            if mode == "form" {
                // A form left incomplete does not close: snapshot mode
                // reports it as cancelled.
                let expected = (!expected.is_empty())
                    .then(|| serde_json::from_str::<serde_json::Value>(expected).unwrap());
                let answer = answer.map(|a| super::form_answers(&a).unwrap());
                assert_eq!(answer, expected, "{name}");
            } else {
                assert_eq!(answer.as_deref(), Some(expected), "{name}");
            }
            assert!(std::fs::metadata(&file).unwrap().len() > 1000, "{name}");
        }
    }
}

#[cfg(test)]
mod form_tests {
    use serde_json::json;

    use super::{form_answers, form_fields};

    #[test]
    fn fields_are_checked_and_filled_in() {
        let fields = form_fields(&json!({ "fields": [
            { "name": "month", "required": true, "default": "2026-10" },
            { "name": "due", "type": "date", "default": "2026-11-30T00:00:00" },
            { "name": "office", "type": "select", "options": ["東京", 2] },
            { "name": "mail", "type": "checkbox", "default": "true" },
        ] }))
        .unwrap();
        assert_eq!(fields[0]["label"], "month");
        assert_eq!(fields[0]["type"], "text");
        assert_eq!(fields[1]["default"], "2026-11-30");
        assert_eq!(fields[2]["options"], json!(["東京", "2"]));
        assert_eq!(fields[3]["default"], true);
        for bad in [
            json!({ "fields": [] }),
            json!({ "fields": [{ "name": "a" }, { "name": "a" }] }),
            json!({ "fields": [{ "name": "a", "type": "password" }] }),
            json!({ "fields": [{ "name": "a", "type": "select" }] }),
            json!({ "fields": [{ "name": "a", "type": "date", "default": "11/30" }] }),
        ] {
            assert!(form_fields(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn whole_numbers_come_back_whole() {
        assert_eq!(
            form_answers(r#"{"min":10000.0,"rate":0.5,"name":"山田","mail":false,"due":null}"#)
                .unwrap(),
            json!({ "min": 10000, "rate": 0.5, "name": "山田", "mail": false, "due": null })
        );
    }
}
