//! `spellsheet audit` and `spellsheet session`: the audit trail, and
//! locking the screen while an unattended run works.

use super::*;
use crate::cli::SessionCmd;

/// "2026-11-01" (that day, local midnight as UTC) or an RFC 3339 time.
pub(crate) fn parse_when(text: &str) -> Result<time::OffsetDateTime> {
    use time::format_description::well_known::Rfc3339;
    if let Ok(t) = time::OffsetDateTime::parse(text, &Rfc3339) {
        return Ok(t);
    }
    let format = time::macros::format_description!("[year]-[month]-[day]");
    let day = time::Date::parse(text, &format)
        .map_err(|_| anyhow::anyhow!("'{text}' is not a day (2026-11-01) or an RFC 3339 time"))?;
    Ok(day.midnight().assume_utc())
}

pub(crate) fn audit_cmd(
    svc: &FlowService,
    since: Option<&str>,
    until: Option<&str>,
    flow: Option<&str>,
    json: bool,
) -> Result<()> {
    use spellsheet_runtime::audit::{self, AuditQuery};
    let query = AuditQuery {
        since: since.map(parse_when).transpose()?,
        until: until.map(parse_when).transpose()?,
        flow_id: flow.map(FlowId::new),
    };
    let entries = audit::collect(svc.store(), &query);
    if json {
        for e in &entries {
            println!("{}", serde_json::to_string(e)?);
        }
        return Ok(());
    }
    if entries.is_empty() {
        println!("nothing recorded");
    }
    for e in &entries {
        let at =
            e.at.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default();
        let who = e
            .who
            .as_deref()
            .map(|w| format!(" ({w})"))
            .unwrap_or_default();
        let flow = e.flow_id.as_deref().unwrap_or("-");
        let ok = if e.ok { "" } else { " FAILED" };
        let code = e
            .error_code
            .as_deref()
            .map(|c| format!(" {c}"))
            .unwrap_or_default();
        let detail = if e.detail.is_empty() {
            String::new()
        } else {
            format!("  {}", e.detail)
        };
        let secrets = if e.secrets.is_empty() {
            String::new()
        } else {
            format!("  secrets: {}", e.secrets.join(", "))
        };
        println!(
            "{at}  {}{who}  {}  {flow}{ok}{code}{detail}{secrets}",
            e.actor, e.action
        );
    }
    Ok(())
}

pub(crate) fn session_cmd(cmd: &SessionCmd) -> Result<ExitCode> {
    use spellsheet_desktop::screen_lock::{self, LockBy};
    match cmd {
        SessionCmd::Status { json } => {
            #[cfg(windows)]
            let (unavailable, remote) = (
                spellsheet_desktop::session::desktop_unavailable(),
                spellsheet_desktop::session::is_remote(),
            );
            #[cfg(not(windows))]
            let (unavailable, remote) = (Some("not Windows".to_owned()), false);
            let lock = screen_lock::current();
            if *json {
                println!(
                    "{}",
                    serde_json::json!({
                        "desktop": unavailable.is_none(),
                        "reason": unavailable,
                        "remote": remote,
                        "screenLock": lock,
                    })
                );
                return Ok(ExitCode::SUCCESS);
            }
            match &unavailable {
                None => println!("screen: takes mouse and keyboard input"),
                Some(reason) => println!("screen: cannot take input ({reason})"),
            }
            if remote {
                println!(
                    "remote desktop: yes (closing the window locks it; `spellsheet session release` does not)"
                );
            }
            match lock {
                Some(lock) => println!(
                    "locks after {} min without input ({}): desktop flows stop there",
                    lock.after_secs.div_ceil(60),
                    match lock.by {
                        LockBy::ScreenSaver => "password-protected screen saver",
                        LockBy::InactivityLimit => "inactivity limit set by policy",
                    }
                ),
                None => println!("does not lock by itself"),
            }
            Ok(ExitCode::SUCCESS)
        }
        SessionCmd::Release => {
            #[cfg(windows)]
            {
                match spellsheet_desktop::session::release_to_console() {
                    Ok(()) => Ok(ExitCode::SUCCESS),
                    Err(e) => {
                        eprintln!("error: {e}");
                        Ok(ExitCode::FAILURE)
                    }
                }
            }
            #[cfg(not(windows))]
            {
                eprintln!("error: only on Windows");
                Ok(ExitCode::FAILURE)
            }
        }
    }
}
