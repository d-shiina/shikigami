//! Pointing at the screen from Studio: the picker ("画面から選ぶ") and the
//! highlight ("光らせる") of a node's target. Both go through the adapter's
//! `inspect` with an `action`, the same entry the AI uses, so the target
//! Studio fills in is built in one place (the adapter).

use serde_json::Value;
use shikigami_core::ErrorPayload;
use tauri::{AppHandle, Manager, State};

use crate::AppState;

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}

/// Runs `params` (with `action: "pick" | "highlight"`) on the `adapter`
/// (`desktop` / `browser`). `session` is the run whose browser to use.
/// While picking, Studio gets out of the way: it is minimised, and comes
/// back when the user has clicked (or pressed Esc).
#[tauri::command]
pub async fn point_at(
    app: AppHandle,
    state: State<'_, AppState>,
    adapter: String,
    session: Option<String>,
    params: Value,
) -> CmdResult<Value> {
    let Some(found) = state.adapters.iter().find(|a| a.name() == adapter).cloned() else {
        return Err(err("NOT_SUPPORTED", format!("no adapter named {adapter}")));
    };
    let picking = params.get("action").and_then(Value::as_str) == Some("pick");
    let window = app.get_webview_window("main");
    if picking && adapter == "desktop" {
        if let Some(w) = &window {
            let _ = w.minimize();
        }
        // Let the windows underneath repaint before the frame follows the mouse.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let result = found
        .inspect(session.as_deref().unwrap_or("default"), params)
        .await;
    if picking && let Some(w) = &window {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    result.map_err(|e| ErrorPayload {
        code: e.code,
        message: e.message,
        details: e.details,
    })
}
