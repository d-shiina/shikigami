//! The `mail.*` steps on a Microsoft 365 mailbox, through Microsoft Graph
//! as the user signed in with `oauth.signIn` (`via: "microsoft365"`): for
//! PCs without Outlook (classic), and for mailboxes no one opens in Outlook.
//! The token goes only to the sites of the secret, which must hold
//! `https://graph.microsoft.com`, as for `http.request`.

use std::path::Path;

use base64::Engine as _;
use jiff::tz::TimeZone;
use serde_json::{Value, json};
use spellsheet_runtime::{ActionInput, StepError};

use crate::{
    Answer, Draft, ListQuery, MAX_BODY_CHARS, MAX_SCANNED, Request, SaveQuery, free_name,
    html_text, matches, send,
};

pub const GRAPH_URL: &str = "https://graph.microsoft.com/v1.0";

/// Folders Graph knows by these names, whatever the mailbox's language.
const WELL_KNOWN: [&str; 7] = [
    "inbox",
    "drafts",
    "sentitems",
    "deleteditems",
    "junkemail",
    "archive",
    "outbox",
];

/// Graph calls with one signed-in user's token.
pub struct Graph {
    base: String,
    token: String,
    client: reqwest::Client,
}

fn failed(status: reqwest::StatusCode, text: &str) -> StepError {
    let (code, hint) = match status.as_u16() {
        401 => (
            "OAUTH_SIGN_IN_REQUIRED",
            "The sign-in is no longer valid: put oauth.signIn with this secret before the mail step and run it again.",
        ),
        403 => (
            "MAIL_PERMISSION_DENIED",
            "The app or the account may not do this: sign in with oauth.signIn using the scope Mail.ReadWrite (Mail.Send to send) and have the Entra app granted it.",
        ),
        404 => (
            "MESSAGE_NOT_FOUND",
            "There is no such message or folder in this mailbox. Use an `id` from mail.list with the same `via` and `account` (Outlook's ids are not Microsoft 365's).",
        ),
        _ => (
            "MAIL_REQUEST_FAILED",
            "Microsoft 365 refused the request; see `response`.",
        ),
    };
    let message = format!("Microsoft 365 answered {status}");
    let response: String = text.chars().take(1000).collect();
    let error = if matches!(status.as_u16(), 429 | 503 | 504) {
        StepError::new(code, message)
    } else {
        StepError::permanent(code, message)
    };
    error.with_details(json!({ "status": status.as_u16(), "response": response, "hint": hint }))
}

impl Graph {
    pub fn new(base: &str, token: &str) -> Result<Self, StepError> {
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            client: spellsheet_system::http_client(true)?.clone(),
        })
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("https://") || path.starts_with("http://") {
            path.to_owned()
        } else {
            format!("{}{path}", self.base)
        }
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, StepError> {
        let mut request = self
            .client
            .request(method, self.url(path))
            .bearer_auth(&self.token)
            // Bodies as text, which is what flows read.
            .header("Prefer", "outlook.body-content-type=\"text\"");
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|e| {
            if e.is_connect() {
                StepError::new(
                    "MAIL_SERVER_UNREACHABLE",
                    format!("Microsoft 365 could not be reached: {e}"),
                )
            } else {
                // The request may have arrived: only a step that changes
                // nothing twice may treat this as "try again".
                StepError::new(
                    "MAIL_CONNECTION_LOST",
                    format!("the answer from Microsoft 365 did not arrive: {e}"),
                )
            }
        })?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(failed(status, &text));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub async fn get(&self, path: &str) -> Result<Value, StepError> {
        self.call(reqwest::Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, StepError> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    pub async fn patch(&self, path: &str, body: &Value) -> Result<Value, StepError> {
        self.call(reqwest::Method::PATCH, path, Some(body)).await
    }

    /// The id of the folder `path` (`受信トレイ/請求書`, or a well-known
    /// name such as `inbox`), walking the folders by their names.
    pub async fn folder(&self, path: Option<&str>) -> Result<String, StepError> {
        let parts: Vec<&str> = path
            .unwrap_or("inbox")
            .split(['/', '\\'])
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect();
        let mut current: Option<String> = None;
        for (i, part) in parts.iter().enumerate() {
            if i == 0 && WELL_KNOWN.contains(&part.to_lowercase().as_str()) {
                current = Some(part.to_lowercase());
                continue;
            }
            let list = match &current {
                None => "/me/mailFolders?$top=100&$select=id,displayName".to_owned(),
                Some(id) => format!(
                    "/me/mailFolders/{}/childFolders?$top=100&$select=id,displayName",
                    encode(id)
                ),
            };
            // Every page of the folders (Graph gives 100 at a time).
            let mut folders = Vec::new();
            let mut next = Some(list);
            while let Some(page) = next.take() {
                let answer = self.get(&page).await?;
                folders.extend(answer["value"].as_array().cloned().unwrap_or_default());
                next = answer["@odata.nextLink"].as_str().map(str::to_owned);
            }
            let found = folders
                .iter()
                .find(|f| f["displayName"].as_str().is_some_and(|n| n == *part));
            match found.and_then(|f| f["id"].as_str()) {
                Some(id) => current = Some(id.to_owned()),
                None => {
                    let names: Vec<&str> = folders
                        .iter()
                        .filter_map(|f| f["displayName"].as_str())
                        .collect();
                    return Err(StepError::permanent(
                        "FOLDER_NOT_FOUND",
                        format!("there is no mail folder '{part}' in '{}'", path.unwrap_or("inbox")),
                    )
                    .with_details(json!({
                        "folders": names,
                        "hint": "Write the folder as a path under the mailbox, e.g. 受信トレイ/請求書 (or inbox/請求書), using names from `folders`.",
                    })));
                }
            }
        }
        Ok(current.unwrap_or_else(|| "inbox".into()))
    }
}

/// A path segment as Graph takes it.
fn encode(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'=' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn message_path(id: &str) -> String {
    format!("/me/messages/{}", encode(id))
}

fn recipients(list: &[String]) -> Value {
    list.iter()
        .map(|a| json!({ "emailAddress": { "address": a } }))
        .collect()
}

fn body(text: &str, html: bool) -> Value {
    json!({ "contentType": if html { "HTML" } else { "Text" }, "content": text })
}

/// A UTC time from Graph as this PC's time without a zone.
pub fn local_time(utc: &str, tz: &TimeZone) -> String {
    match utc.parse::<jiff::Timestamp>() {
        Ok(at) => at
            .to_zoned(tz.clone())
            .strftime("%Y-%m-%dT%H:%M:%S")
            .to_string(),
        Err(_) => utc.trim_end_matches('Z').to_owned(),
    }
}

/// `since` (a date or a time on this PC, or a time with a zone) in UTC.
pub fn utc_time(since: &str, tz: &TimeZone) -> Result<String, StepError> {
    let bad = || {
        StepError::invalid_params(format!(
            "'since' / 'before' must be a date like 2026-10-01 or a time like 2026-10-01T09:00, not '{since}'"
        ))
    };
    let at = match since.parse::<jiff::Timestamp>() {
        Ok(at) => at,
        Err(_) => {
            let civil = match since.parse::<jiff::civil::DateTime>() {
                Ok(t) => t,
                Err(_) => since
                    .parse::<jiff::civil::Date>()
                    .map_err(|_| bad())?
                    .to_datetime(jiff::civil::Time::midnight()),
            };
            civil.to_zoned(tz.clone()).map_err(|_| bad())?.timestamp()
        }
    };
    Ok(at.strftime("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// One message as mail.list gives it, whatever the mailbox.
fn listed(message: &Value, include_body: bool, tz: &TimeZone) -> Value {
    let from = &message["from"]["emailAddress"];
    let to: Vec<&str> = message["toRecipients"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|r| r["emailAddress"]["address"].as_str())
                .collect()
        })
        .unwrap_or_default();
    let attachments: Vec<&str> = message["attachments"]
        .as_array()
        .map(|list| list.iter().filter_map(|a| a["name"].as_str()).collect())
        .unwrap_or_default();
    // Graph gives UTC (2026-10-28T00:30:00Z); flows compare this PC's
    // times without a zone, as Outlook gives them.
    let received = message["receivedDateTime"]
        .as_str()
        .map(|t| local_time(t, tz))
        .unwrap_or_default();
    let mut out = json!({
        "id": message["id"],
        "subject": message["subject"].as_str().unwrap_or_default(),
        "from": from["name"].as_str().unwrap_or_default(),
        "fromAddress": from["address"].as_str().unwrap_or_default(),
        "to": to.join("; "),
        "receivedAt": received,
        "unread": !message["isRead"].as_bool().unwrap_or(true),
        "attachments": attachments,
    });
    if include_body {
        let text: String = message["body"]["content"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(MAX_BODY_CHARS)
            .collect();
        out["body"] = Value::String(text);
    }
    out
}

async fn list(graph: &Graph, query: &ListQuery) -> Result<Value, StepError> {
    let folder = graph.folder(query.folder.as_deref()).await?;
    let tz = TimeZone::system();
    // Graph wants the $orderby property first in $filter.
    let mut filters = vec!["receivedDateTime ge 1900-01-01T00:00:00Z".to_owned()];
    if query.unread_only {
        filters.push("isRead eq false".to_owned());
    }
    if let Some(since) = &query.since {
        filters[0] = format!("receivedDateTime ge {}", utc_time(since, &tz)?);
    }
    if let Some(before) = &query.before {
        filters.push(format!("receivedDateTime lt {}", utc_time(before, &tz)?));
    }
    let mut path = format!(
        "/me/mailFolders/{}/messages?$top=100&$orderby=receivedDateTime%20desc&$select=id,subject,from,toRecipients,receivedDateTime,isRead,body&$expand=attachments($select=name)",
        encode(&folder)
    );
    path.push_str("&$filter=");
    path.push_str(&filters.join(" and ").replace(' ', "%20"));
    let mut out = Vec::new();
    let mut scanned = 0;
    let mut next = Some(path);
    while let Some(page) = next.take() {
        let answer = graph.get(&page).await?;
        for message in answer["value"].as_array().into_iter().flatten() {
            scanned += 1;
            let entry = listed(message, query.include_body, &tz);
            let text = |k: &str| entry[k].as_str().unwrap_or_default().to_owned();
            if matches(query, &text("subject"), &text("from"), &text("fromAddress")) {
                out.push(entry);
                if out.len() >= query.limit {
                    return Ok(Value::Array(out));
                }
            }
        }
        if scanned < MAX_SCANNED {
            next = answer["@odata.nextLink"].as_str().map(str::to_owned);
        }
    }
    Ok(Value::Array(out))
}

async fn save_attachments(graph: &Graph, query: &SaveQuery) -> Result<Value, StepError> {
    let dir = Path::new(&query.folder);
    std::fs::create_dir_all(dir).map_err(|e| {
        StepError::permanent(
            "FILE_ERROR",
            format!("cannot create {}: {e}", dir.display()),
        )
    })?;
    let path = format!("{}/attachments", message_path(&query.id));
    let attachments = graph.get(&path).await?;
    let mut saved = Vec::new();
    for attachment in attachments["value"].as_array().into_iter().flatten() {
        // Attached messages and links have no file to save.
        if attachment["@odata.type"].as_str() != Some("#microsoft.graph.fileAttachment") {
            continue;
        }
        let name = attachment["name"].as_str().unwrap_or("attachment");
        if let Some(part) = &query.name_contains
            && !name.to_lowercase().contains(&part.to_lowercase())
        {
            continue;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(attachment["contentBytes"].as_str().unwrap_or_default())
            .map_err(|e| {
                StepError::permanent(
                    "MAIL_REQUEST_FAILED",
                    format!("the attachment {name} came back unreadable: {e}"),
                )
            })?;
        let target = free_name(dir, name);
        std::fs::write(&target, bytes).map_err(|e| {
            StepError::permanent(
                "FILE_ERROR",
                format!("cannot write {}: {e}", target.display()),
            )
        })?;
        saved.push(Value::String(target.to_string_lossy().into_owned()));
    }
    Ok(Value::Array(saved))
}

/// Adds files to a draft, one request each.
async fn attach(graph: &Graph, draft_id: &str, files: &[String]) -> Result<(), StepError> {
    for file in files {
        let bytes = std::fs::read(file).map_err(|e| {
            StepError::permanent("FILE_ERROR", format!("cannot read attachment {file}: {e}"))
        })?;
        if bytes.len() as u64 > send::GRAPH_MAX_ATTACHMENT_BYTES {
            return Err(StepError::permanent(
                "MAIL_ATTACHMENT_TOO_LARGE",
                format!("{file} is over the 3 MB Microsoft 365 takes in one request"),
            )
            .with_details(json!({ "hint": "Zip or split the file, or put a link to a shared folder in the body." })));
        }
        let name = Path::new(file)
            .file_name()
            .map_or_else(|| "attachment".into(), |n| n.to_string_lossy().into_owned());
        graph
            .post(
                &format!("{}/attachments", message_path(draft_id)),
                &json!({
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": name,
                    "contentBytes": base64::engine::general_purpose::STANDARD.encode(&bytes),
                }),
            )
            .await?;
    }
    Ok(())
}

async fn create_draft(graph: &Graph, draft: &Draft) -> Result<Value, StepError> {
    let message = send::graph_message(draft)?;
    let created = graph.post("/me/messages", &message["message"]).await?;
    Ok(json!({ "id": created["id"] }))
}

/// A reply or forward left in Drafts: Graph writes the quoted message, the
/// body goes above it.
async fn answer(graph: &Graph, answer: &Answer, forward: bool) -> Result<Value, StepError> {
    let action = match (forward, answer.all) {
        (true, _) => "createForward",
        (false, true) => "createReplyAll",
        (false, false) => "createReply",
    };
    let mut request = json!({});
    if forward {
        request["message"] = json!({ "toRecipients": recipients(&answer.to) });
    }
    let created = graph
        .post(&format!("{}/{action}", message_path(&answer.id)), &request)
        .await?;
    let id = created["id"].as_str().unwrap_or_default().to_owned();
    let quoted = created["body"]["content"].as_str().unwrap_or_default();
    let quoted_html = created["body"]["contentType"]
        .as_str()
        .is_some_and(|t| t.eq_ignore_ascii_case("html"));
    let mut patch = json!({});
    if !answer.body.is_empty() {
        // The new text above what Graph quoted, in the quoted body's kind.
        let content = match (answer.html, quoted_html) {
            (true, true) => crate::prepend_html(quoted, &answer.body),
            (false, true) => crate::prepend_html(quoted, &html_text(&answer.body)),
            // HTML asked for over a text quote: the quote becomes HTML too.
            (true, false) => format!("<div>{}</div><br>{}", answer.body, html_text(quoted)),
            (false, false) => format!("{}\r\n\r\n{quoted}", answer.body),
        };
        patch["body"] = body(&content, quoted_html || answer.html);
    }
    if !answer.cc.is_empty() {
        let mut cc: Vec<Value> = created["ccRecipients"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        cc.extend(
            recipients(&answer.cc)
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        patch["ccRecipients"] = Value::Array(cc);
    }
    if patch.as_object().is_some_and(|p| !p.is_empty()) {
        graph.patch(&message_path(&id), &patch).await?;
    }
    attach(graph, &id, &answer.attachments).await?;
    Ok(json!({ "id": id }))
}

/// Runs one mail step on the Microsoft 365 mailbox at `base`.
pub async fn run_at(base: &str, token: &str, request: Request) -> Result<Value, StepError> {
    let graph = Graph::new(base, token)?;
    match request {
        Request::List(query) => list(&graph, &query).await,
        Request::Save(query) => save_attachments(&graph, &query).await,
        Request::Draft(draft) => create_draft(&graph, &draft).await,
        Request::Move { id, folder } => {
            let destination = graph.folder(Some(&folder)).await?;
            let moved = graph
                .post(
                    &format!("{}/move", message_path(&id)),
                    &json!({ "destinationId": destination }),
                )
                .await?;
            Ok(json!({ "id": moved["id"] }))
        }
        Request::MarkRead { id, read } => {
            graph
                .patch(&message_path(&id), &json!({ "isRead": read }))
                .await?;
            Ok(Value::Null)
        }
        Request::Delete { id } => {
            graph
                .post(
                    &format!("{}/move", message_path(&id)),
                    &json!({ "destinationId": "deleteditems" }),
                )
                .await?;
            Ok(Value::Null)
        }
        Request::Reply(a) => answer(&graph, &a, false).await,
        Request::Forward(a) => answer(&graph, &a, true).await,
        Request::SendDraft { id } => {
            graph
                .post(&format!("{}/send", message_path(&id)), &json!({}))
                .await
                .map_err(|e| match e.code.as_str() {
                    // Nothing was sent: safe to retry.
                    "MAIL_SERVER_UNREACHABLE" => e,
                    "MAIL_CONNECTION_LOST" => crate::send::delivery_unknown(e.message),
                    _ => StepError {
                        retryable: false,
                        ..e
                    },
                })?;
            Ok(Value::Null)
        }
        Request::Send(_) => Err(StepError::permanent(
            "INTERNAL",
            "mail.send has its own ways",
        )),
    }
}

/// Runs one mail step on the Microsoft 365 mailbox of the secret `account`.
pub async fn run(input: &ActionInput, account: &str, request: Request) -> Result<Value, StepError> {
    let (token, sites) = spellsheet_system::oauth::access_token(input, account).await?;
    let url = reqwest::Url::parse(GRAPH_URL)
        .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?;
    spellsheet_system::check_site(account, &sites, &url)?;
    run_at(GRAPH_URL, &token, request).await
}
