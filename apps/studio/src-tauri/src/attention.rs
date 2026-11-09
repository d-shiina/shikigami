//! Calling the person when a run waits for them (a login in the browser,
//! a pause on an error, an AI asking for something) while they work in
//! another window: the taskbar button flashes until they come back, and a
//! Windows notification says what is waiting. Clicking it brings the
//! window that asked to the front. As Teams and Outlook do, nothing takes
//! the focus by itself, and nothing is shown while the window is in front
//! (its own banner says it there). docs/design/attention.md.

#[cfg(windows)]
use tauri::Manager;
use tauri::{UserAttentionType, WebviewWindow};

/// How long a tag may be (Windows refuses longer ones).
const TAG_MAX: usize = 64;

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn tag_of(tag: &str) -> String {
    tag.chars().take(TAG_MAX).collect()
}

/// Calls the person for what `title` and `body` say, unless the window is
/// in front. `tag` names the wait, so [`clear_attention`] takes back its
/// notification once it is over.
#[tauri::command]
pub fn call_attention(window: WebviewWindow, title: String, body: String, tag: String) {
    if window.is_focused().unwrap_or(false) {
        return;
    }
    if let Err(e) = window.request_user_attention(Some(UserAttentionType::Informational)) {
        tracing::warn!(error = %e, "cannot flash the taskbar button");
    }
    #[cfg(windows)]
    toast::show(&window, &title, &body, &tag_of(&tag));
    #[cfg(not(windows))]
    let _ = (title, body, tag);
}

/// The wait is over: its notification leaves the notification center and
/// the taskbar button stops flashing.
#[tauri::command]
pub fn clear_attention(window: WebviewWindow, tag: String) {
    let _ = window.request_user_attention(None);
    #[cfg(windows)]
    toast::remove(window.app_handle(), &tag_of(&tag));
    #[cfg(not(windows))]
    let _ = tag;
}

/// The words of a notification as Windows reads them (XML).
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn toast_xml(title: &str, body: &str) -> String {
    let esc = |s: &str| {
        s.chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .map(|c| match c {
                '&' => "&amp;".to_owned(),
                '<' => "&lt;".to_owned(),
                '>' => "&gt;".to_owned(),
                '"' => "&quot;".to_owned(),
                '\'' => "&apos;".to_owned(),
                c => c.to_string(),
            })
            .collect::<String>()
    };
    // `long`: about 25 seconds on screen, as for a call; then it waits in
    // the notification center until the wait is over.
    format!(
        "<toast duration=\"long\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        esc(title),
        esc(body)
    )
}

#[cfg(windows)]
mod toast {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    use tauri::{AppHandle, Manager, WebviewWindow};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::{HSTRING, IInspectable};

    const GROUP: &str = "waiting";

    /// The installer gives the Start menu shortcuts this ID (Tauri's NSIS
    /// `SetLnkAppUserModelId`): notifications show under SpellSheet's name
    /// and icon. A build that was not installed has no shortcut, so it
    /// borrows PowerShell's ID to show its notifications at all.
    fn app_id(app: &AppHandle) -> HSTRING {
        if cfg!(debug_assertions) {
            HSTRING::from(
                "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe",
            )
        } else {
            HSTRING::from(app.config().identifier.as_str())
        }
    }

    /// Shown notifications by tag: kept so their click still comes, and
    /// so they can be taken back.
    fn shown() -> &'static Mutex<HashMap<String, ToastNotification>> {
        static SHOWN: OnceLock<Mutex<HashMap<String, ToastNotification>>> = OnceLock::new();
        SHOWN.get_or_init(Default::default)
    }

    pub(super) fn show(window: &WebviewWindow, title: &str, body: &str, tag: &str) {
        if let Err(e) = try_show(window, title, body, tag) {
            tracing::warn!(error = %e, "cannot show a notification");
        }
    }

    fn try_show(
        window: &WebviewWindow,
        title: &str,
        body: &str,
        tag: &str,
    ) -> windows::core::Result<()> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(super::toast_xml(title, body)))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        toast.SetTag(&HSTRING::from(tag))?;
        toast.SetGroup(&HSTRING::from(GROUP))?;
        let app = window.app_handle().clone();
        let label = window.label().to_owned();
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, _| {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                Ok(())
            },
        ))?;
        ToastNotificationManager::CreateToastNotifierWithId(&app_id(window.app_handle()))?
            .Show(&toast)?;
        if let Ok(mut shown) = shown().lock() {
            shown.insert(tag.to_owned(), toast);
        }
        Ok(())
    }

    pub(super) fn remove(app: &AppHandle, tag: &str) {
        let toast = shown().lock().ok().and_then(|mut s| s.remove(tag));
        if let Some(toast) = toast {
            if let Ok(notifier) = ToastNotificationManager::CreateToastNotifierWithId(&app_id(app))
            {
                let _ = notifier.Hide(&toast);
            }
        }
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.RemoveGroupedTagWithId(
                &HSTRING::from(tag),
                &HSTRING::from(GROUP),
                &app_id(app),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_words_are_escaped() {
        let xml = toast_xml("「A&B」が操作を待っています", "<b>ログイン</b>\u{7}");
        assert!(xml.contains("「A&amp;B」が操作を待っています"));
        assert!(xml.contains("&lt;b&gt;ログイン&lt;/b&gt;</text>"));
        assert!(!xml.contains('\u{7}'));
    }

    #[test]
    fn tags_fit_windows() {
        assert_eq!(tag_of(&"x".repeat(100)).len(), TAG_MAX);
        assert_eq!(tag_of("run_1:human:s1"), "run_1:human:s1");
    }
}
