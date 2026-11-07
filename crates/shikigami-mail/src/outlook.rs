//! The Outlook backend: the Outlook (classic) on this PC through COM.
//!
//! Outlook runs one instance per user, so the steps connect to the person's
//! own Outlook (starting it if needed) and never close or kill it.

use std::time::Duration;

use serde_json::{Value, json};
use shikigami_com::{GaveUp, Object, Session, Var, run_on_sta};
use shikigami_runtime::StepError;
use tokio_util::sync::CancellationToken;

use crate::{
    Answer, Draft, ListQuery, MAX_BODY_CHARS, MAX_SCANNED, Request, SaveQuery, free_name, matches,
};

const OL_FOLDER_INBOX: i32 = 6;
const OL_FOLDER_DELETED_ITEMS: i32 = 3;
const OL_MAIL_ITEM: i32 = 0;
/// `Class` of a mail message (other items: meeting requests, reports, ...).
const OL_MAIL: i64 = 43;
pub fn run(
    request: Request,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    // A send that runs out of time may still go out when Outlook gets to
    // it, so it is never retried (it could be sent twice).
    let sending = matches!(request, Request::Send(_) | Request::SendDraft { .. });
    run_on_sta(
        "shikigami-outlook-com",
        timeout,
        cancel,
        move |session| {
            let app = Object::create("Outlook.Application", || {
                StepError::permanent("OUTLOOK_NOT_INSTALLED", "Outlook is not installed on this PC")
                    .with_details(json!({ "hint": "mail.* steps use Outlook (classic) on this PC. The new Outlook app and Outlook on the web cannot be automated this way." }))
            })?;
            let mapi = app.object("GetNamespace", vec![Var::str("MAPI")]).map_err(|e| {
                StepError::new("OUTLOOK_NOT_READY", format!("Outlook is not ready: {}", e.message))
                    .with_details(json!({ "hint": "Ask the user to start Outlook and sign in once on this PC." }))
            })?;
            match request {
                Request::Draft(draft) => create_draft(&app, &draft, session),
                Request::Send(draft) => send(&app, &draft, session),
                Request::List(query) => list(&mapi, &query),
                Request::Save(query) => save_attachments(&mapi, &query, session),
                Request::Move { id, folder: to } => {
                    let target = folder(&mapi, Some(&to))?;
                    let moved =
                        message(&mapi, &id)?.object("Move", vec![Var::from_object(&target)])?;
                    Ok(json!({ "id": moved.get("EntryID")?.to_text() }))
                }
                Request::MarkRead { id, read } => {
                    let item = message(&mapi, &id)?;
                    item.put("UnRead", Var::bool(!read))?;
                    item.call("Save", vec![])?;
                    Ok(Value::Null)
                }
                Request::Delete { id } => {
                    // Outlook moves it to Deleted Items, but deletes one
                    // already there for good: leave that one as it is.
                    let item = message(&mapi, &id)?;
                    let deleted = mapi
                        .object("GetDefaultFolder", vec![Var::i32(OL_FOLDER_DELETED_ITEMS)])?
                        .get("EntryID")?
                        .to_text();
                    let parent = item
                        .get("Parent")?
                        .object("Parent")?
                        .get("EntryID")?
                        .to_text();
                    if parent != deleted {
                        item.call("Delete", vec![])?;
                    }
                    Ok(Value::Null)
                }
                Request::Reply(answer) => respond(&mapi, &answer, false, session),
                Request::Forward(answer) => respond(&mapi, &answer, true, session),
                Request::SendDraft { id } => {
                    message(&mapi, &id)?.call("Send", vec![]).map_err(|e| {
                        StepError::permanent("MAIL_SEND_FAILED", format!("Outlook did not send the message: {}", e.message))
                            .with_details(json!({ "hint": "Outlook may have asked whether a program may send mail; ask the user to allow it, or check the addresses." }))
                    })?;
                    Ok(Value::Null)
                }
            }
        },
        |gave_up| {
            match gave_up.reason {
            GaveUp::Cancelled => StepError::new("CANCELLED", "the step was stopped"),
            GaveUp::TimedOut if sending => StepError::permanent("MAIL_DELIVERY_UNKNOWN", "Outlook did not answer in time; the message may still be sent")
                .with_details(json!({ "hint": "Outlook may be showing a dialog (a security prompt that a program is sending mail, or a sign-in). Ask the user to check the Outlook window and the Outbox / Sent Items before running the step again." })),
            GaveUp::TimedOut => StepError::new("OUTLOOK_TIMEOUT", "Outlook did not answer in time")
                .with_details(json!({ "hint": "Outlook may be showing a dialog (a security prompt that a program is accessing mail, or a sign-in). Ask the user to check the Outlook window, then run again." })),
        }
        },
    )
}

fn create_draft(app: &Object, draft: &Draft, session: &Session) -> Result<Value, StepError> {
    let item = compose(app, draft, session)?;
    item.call("Save", vec![])?;
    Ok(json!({ "id": item.get("EntryID")?.to_text() }))
}

/// Sends from the account signed in to Outlook; Outlook keeps it in Sent
/// Items (or the Outbox until it is online).
fn send(app: &Object, draft: &Draft, session: &Session) -> Result<Value, StepError> {
    let item = compose(app, draft, session)?;
    item.call("Send", vec![]).map_err(|e| {
        StepError::permanent("MAIL_SEND_FAILED", format!("Outlook did not send the message: {}", e.message))
            .with_details(json!({ "hint": "Outlook may have asked whether a program may send mail; ask the user to allow it, or check the addresses." }))
    })?;
    Ok(json!({ "via": "outlook" }))
}

/// A new message filled in from `draft`, not saved yet.
fn compose(app: &Object, draft: &Draft, session: &Session) -> Result<Object, StepError> {
    session.check()?;
    let item = app.object("CreateItem", vec![Var::i32(OL_MAIL_ITEM)])?;
    item.put("To", Var::str(&draft.to.join("; ")))?;
    if !draft.cc.is_empty() {
        item.put("CC", Var::str(&draft.cc.join("; ")))?;
    }
    if !draft.bcc.is_empty() {
        item.put("BCC", Var::str(&draft.bcc.join("; ")))?;
    }
    item.put("Subject", Var::str(&draft.subject))?;
    let body = if draft.html { "HTMLBody" } else { "Body" };
    item.put(body, Var::str(&draft.body))?;
    if !draft.attachments.is_empty() {
        let attachments = item.get("Attachments")?.object("Attachments")?;
        for path in &draft.attachments {
            attachments.call("Add", vec![Var::str(path)])?;
        }
    }
    session.check()?;
    Ok(item)
}

fn folder(mapi: &Object, path: Option<&str>) -> Result<Object, StepError> {
    let inbox = mapi.object("GetDefaultFolder", vec![Var::i32(OL_FOLDER_INBOX)])?;
    let Some(path) = path else { return Ok(inbox) };
    let inbox_name = inbox.get("Name")?.to_text();
    // Paths start under the mailbox: 受信トレイ/請求書.
    let mut current = inbox.get("Parent")?.object("Parent")?;
    for (i, part) in path
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .enumerate()
    {
        if i == 0 && part == inbox_name {
            current = inbox.clone();
            continue;
        }
        let children = current.get("Folders")?.object("Folders")?;
        match children.object("Item", vec![Var::str(part)]) {
            Ok(child) => current = child,
            Err(_) => {
                let count = children.get("Count")?.to_i64().unwrap_or(0);
                let names: Vec<String> = (1..=count)
                    .filter_map(|n| children.object("Item", vec![Var::i32(n as i32)]).ok())
                    .map(|f| f.get("Name").map(|v| v.to_text()).unwrap_or_default())
                    .collect();
                return Err(StepError::permanent(
                    "FOLDER_NOT_FOUND",
                    format!("there is no mail folder '{part}' in '{path}'"),
                )
                .with_details(json!({
                    "folders": names,
                    "hint": "Write the folder as a path under the mailbox, e.g. 受信トレイ/請求書, using names from `folders`.",
                })));
            }
        }
    }
    Ok(current)
}

fn list(mapi: &Object, query: &ListQuery) -> Result<Value, StepError> {
    let folder = folder(mapi, query.folder.as_deref())?;
    let items = folder.get("Items")?.object("Items")?;
    items.call("Sort", vec![Var::str("[ReceivedTime]"), Var::bool(true)])?;
    let mut out = Vec::new();
    let mut next = items.call("GetFirst", vec![])?;
    let mut scanned = 0;
    while let Ok(item) = next.object("GetFirst") {
        scanned += 1;
        if scanned > MAX_SCANNED || out.len() >= query.limit {
            break;
        }
        if item.get("Class")?.to_i64().unwrap_or(0) == OL_MAIL {
            let received = item.get("ReceivedTime")?.to_json();
            if let (Some(since), Some(at)) = (&query.since, received.as_str())
                && at < since.as_str()
            {
                // Sorted newest first: everything after is older.
                break;
            }
            // Newer than the window: the older ones follow.
            let too_new = matches!((&query.before, received.as_str()),
                (Some(before), Some(at)) if at >= before.as_str());
            let unread = item.get("UnRead")?.to_bool();
            let subject = item.get("Subject")?.to_text();
            let from = item.get("SenderName")?.to_text();
            let from_address = item.get("SenderEmailAddress")?.to_text();
            if !too_new
                && (!query.unread_only || unread)
                && matches(query, &subject, &from, &from_address)
            {
                let attachments = item.get("Attachments")?.object("Attachments")?;
                let count = attachments.get("Count")?.to_i64().unwrap_or(0);
                let names: Vec<String> = (1..=count)
                    .filter_map(|n| attachments.object("Item", vec![Var::i32(n as i32)]).ok())
                    .map(|a| a.get("FileName").map(|v| v.to_text()).unwrap_or_default())
                    .collect();
                let mut message = json!({
                    "id": item.get("EntryID")?.to_text(),
                    "subject": subject,
                    "from": from,
                    "fromAddress": from_address,
                    "to": item.get("To")?.to_text(),
                    "receivedAt": received,
                    "unread": unread,
                    "attachments": names,
                });
                if query.include_body {
                    let body: String = item
                        .get("Body")?
                        .to_text()
                        .chars()
                        .take(MAX_BODY_CHARS)
                        .collect();
                    message["body"] = Value::String(body);
                }
                out.push(message);
            }
        }
        next = items.call("GetNext", vec![])?;
    }
    Ok(Value::Array(out))
}

/// The message (or draft) with this EntryID.
fn message(mapi: &Object, id: &str) -> Result<Object, StepError> {
    mapi.object("GetItemFromID", vec![Var::str(id)]).map_err(|_| {
        StepError::permanent("MESSAGE_NOT_FOUND", "there is no message with that id")
            .with_details(json!({ "hint": "Use an `id` from mail.list (or the draft step) in this run; it changes when the message is moved." }))
    })
}

/// `BodyFormat` of an HTML message.
const OL_FORMAT_HTML: i64 = 2;

/// A reply or forward saved in Drafts, the body above the quoted message.
fn respond(
    mapi: &Object,
    answer: &Answer,
    forward: bool,
    session: &Session,
) -> Result<Value, StepError> {
    session.check()?;
    let original = message(mapi, &answer.id)?;
    let action = match (forward, answer.all) {
        (true, _) => "Forward",
        (false, true) => "ReplyAll",
        (false, false) => "Reply",
    };
    let item = original.object(action, vec![])?;
    if forward {
        let recipients = item.get("Recipients")?.object("Recipients")?;
        for address in &answer.to {
            recipients.call("Add", vec![Var::str(address)])?;
        }
    }
    if !answer.cc.is_empty() {
        let cc = item.get("CC")?.to_text();
        let mut all: Vec<&str> = cc
            .split(';')
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .collect();
        all.extend(answer.cc.iter().map(String::as_str));
        item.put("CC", Var::str(&all.join("; ")))?;
    }
    if !answer.body.is_empty() {
        if item.get("BodyFormat")?.to_i64().ok() == Some(OL_FORMAT_HTML) {
            let html = item.get("HTMLBody")?.to_text();
            let text = if answer.html {
                answer.body.clone()
            } else {
                crate::html_text(&answer.body)
            };
            item.put("HTMLBody", Var::str(&crate::prepend_html(&html, &text)))?;
        } else {
            let body = item.get("Body")?.to_text();
            item.put("Body", Var::str(&format!("{}\r\n\r\n{body}", answer.body)))?;
        }
    }
    if !answer.attachments.is_empty() {
        let attachments = item.get("Attachments")?.object("Attachments")?;
        for path in &answer.attachments {
            attachments.call("Add", vec![Var::str(path)])?;
        }
    }
    session.check()?;
    item.call("Save", vec![])?;
    Ok(json!({ "id": item.get("EntryID")?.to_text() }))
}

fn save_attachments(
    mapi: &Object,
    query: &SaveQuery,
    session: &Session,
) -> Result<Value, StepError> {
    let item = message(mapi, &query.id)?;
    let dir = std::path::Path::new(&query.folder);
    std::fs::create_dir_all(dir).map_err(|e| {
        StepError::permanent(
            "FILE_ERROR",
            format!("cannot create {}: {e}", dir.display()),
        )
    })?;
    let attachments = item.get("Attachments")?.object("Attachments")?;
    let count = attachments.get("Count")?.to_i64().unwrap_or(0);
    let mut saved = Vec::new();
    for n in 1..=count {
        let attachment = attachments.object("Item", vec![Var::i32(n as i32)])?;
        let name = attachment.get("FileName")?.to_text();
        if let Some(part) = &query.name_contains
            && !name.to_lowercase().contains(&part.to_lowercase())
        {
            continue;
        }
        session.check()?;
        let target = free_name(dir, &name);
        let target = target.to_string_lossy().into_owned();
        attachment.call("SaveAsFile", vec![Var::str(&target)])?;
        saved.push(Value::String(target));
    }
    Ok(Value::Array(saved))
}
