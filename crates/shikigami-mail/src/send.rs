//! `mail.send` through Microsoft 365 (Graph) or an SMTP server. Sending
//! through Outlook goes with the other Outlook requests.
//!
//! - Microsoft 365: `account` is `{ "secret": "<name>", "field": "accessToken" }`
//!   of a secret signed in with `oauth.signIn` (scope Mail.Send). The token
//!   goes only to the sites of that secret, which must hold
//!   `https://graph.microsoft.com`, as for `http.request`.
//! - SMTP: `server` (`smtp.example.co.jp`, `:465` for TLS from the start,
//!   otherwise STARTTLS), `from`, and a login as secrets in `user` /
//!   `password` whose sites hold `smtp:<server>`. A password is never sent
//!   over a connection without TLS.

use std::path::Path;

use base64::Engine as _;
use serde_json::{Value, json};
use shikigami_core::secret::{SecretField, SecretRef};
use shikigami_runtime::{ActionInput, StepError};

use crate::{Draft, addresses, text};

/// The Graph endpoint that sends as the signed-in user.
pub const GRAPH_SEND_URL: &str = "https://graph.microsoft.com/v1.0/me/sendMail";
/// Graph takes a request of up to 4 MB; attachments grow by a third in base64.
pub const GRAPH_MAX_ATTACHMENT_BYTES: u64 = 3 * 1024 * 1024;
/// The whole sendMail request (JSON, attachments in base64) must fit in this.
pub const GRAPH_MAX_REQUEST_BYTES: usize = 4_000_000;

fn too_large() -> StepError {
    StepError::permanent(
        "MAIL_ATTACHMENT_TOO_LARGE",
        "the message with its attachments is over the 4 MB Microsoft 365 takes in one request (about 3 MB of attachments)",
    )
    .with_details(json!({ "hint": "Zip or split the files, put a link to a shared folder in the body, or send through Outlook (via outlook)." }))
}

/// How `mail.send` sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Via {
    Outlook,
    Microsoft365 {
        /// The secret signed in with `oauth.signIn`.
        account: String,
    },
    Smtp(Smtp),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Smtp {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub from: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Security {
    /// TLS from the start (port 465).
    Tls,
    /// Plain first, then STARTTLS; refused when the server cannot.
    StartTls,
    /// No encryption: only for servers inside the company that take mail
    /// without a login.
    None,
}

fn only_for(params: &Value, keys: &[&str], via: &str) -> Result<(), StepError> {
    match keys
        .iter()
        .find(|k| params.get(**k).is_some_and(|v| !v.is_null()))
    {
        Some(key) => Err(StepError::invalid_params(format!(
            "'{key}' is not used when sending through {via}"
        ))),
        None => Ok(()),
    }
}

impl Via {
    pub fn parse(params: &Value) -> Result<Self, StepError> {
        let via = text(params, "via").unwrap_or_else(|| "outlook".into());
        match via.as_str() {
            "outlook" => {
                only_for(
                    params,
                    &["account", "server", "from", "user", "password", "security"],
                    "Outlook",
                )?;
                Ok(Self::Outlook)
            }
            "microsoft365" => {
                only_for(
                    params,
                    &["server", "from", "user", "password", "security"],
                    "Microsoft 365",
                )?;
                let reference = params
                    .get("account")
                    .and_then(SecretRef::from_value)
                    .and_then(Result::ok)
                    .filter(|r| r.field == SecretField::AccessToken)
                    .ok_or_else(|| {
                        StepError::invalid_params("via microsoft365 needs account: { \"secret\": \"<name>\", \"field\": \"accessToken\" }")
                            .with_details(json!({ "hint": "Register the Microsoft Entra app as a secret (client ID and secret; sites https://login.microsoftonline.com and https://graph.microsoft.com), sign in with oauth.signIn (scope Mail.Send offline_access), then pass account: { \"secret\": \"<name>\", \"field\": \"accessToken\" }." }))
                    })?;
                Ok(Self::Microsoft365 {
                    account: reference.secret,
                })
            }
            "smtp" => {
                only_for(params, &["account"], "SMTP")?;
                let server = text(params, "server")
                    .ok_or_else(|| StepError::invalid_params("via smtp needs 'server', e.g. smtp.example.co.jp or smtp.example.co.jp:465"))?;
                let (host, port) = match server.rsplit_once(':') {
                    Some((host, port)) => (
                        host.to_owned(),
                        port.parse::<u16>().map_err(|_| {
                            StepError::invalid_params(format!(
                                "'{port}' in server is not a port number"
                            ))
                        })?,
                    ),
                    None => (server.clone(), 587),
                };
                let security = match text(params, "security").as_deref() {
                    None if port == 465 => Security::Tls,
                    None => Security::StartTls,
                    Some("tls") => Security::Tls,
                    Some("starttls") => Security::StartTls,
                    Some("none") => Security::None,
                    Some(other) => {
                        return Err(StepError::invalid_params(format!(
                            "security '{other}' is not one of tls, starttls, none"
                        )));
                    }
                };
                let from = addresses(
                    &json!({ "from": [text(params, "from").unwrap_or_default()] }),
                    "from",
                )?
                .pop()
                .ok_or_else(|| {
                    StepError::invalid_params("via smtp needs 'from', the sender's address")
                })?;
                Ok(Self::Smtp(Smtp {
                    host: host.trim().to_lowercase(),
                    port,
                    security,
                    from,
                }))
            }
            other => Err(StepError::invalid_params(format!(
                "via '{other}' is not one of outlook, microsoft365, smtp"
            ))),
        }
    }
}

/// Sends `draft` through Microsoft 365 or SMTP.
pub async fn send(input: &ActionInput, via: Via, draft: Draft) -> Result<Value, StepError> {
    match via {
        Via::Outlook => Err(StepError::permanent(
            "INTERNAL",
            "Outlook sends through the Outlook backend",
        )),
        Via::Microsoft365 { account } => {
            let (token, sites) = shikigami_system::oauth::access_token(input, &account).await?;
            let url = reqwest::Url::parse(GRAPH_SEND_URL)
                .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?;
            shikigami_system::check_site(&account, &sites, &url)?;
            let body = graph_message(&draft)?;
            graph_send(GRAPH_SEND_URL, &token, &body).await?;
            Ok(json!({ "via": "microsoft365" }))
        }
        Via::Smtp(smtp) => {
            // Every secret in the login must be allowed to go to this
            // server, the user name as much as the password.
            let site = format!("smtp:{}", smtp.host);
            let check_site = |secret: &shikigami_core::secret::ResolvedSecret| {
                if secret.sites.iter().any(|s| s.eq_ignore_ascii_case(&site)) {
                    return Ok(());
                }
                Err(StepError::permanent(
                    if secret.sites.is_empty() { "SECRET_SITE_NOT_SET" } else { "SECRET_SITE_MISMATCH" },
                    format!("secret '{}' may not be sent to {site}", secret.name),
                )
                .with_details(json!({
                    "secret": secret.name,
                    "sites": secret.sites,
                    "url": site,
                    "hint": format!("Call request_secret with this name and the site {site} so the user can allow it in Studio."),
                })))
            };
            let user = match input.params.get("user").filter(|v| !v.is_null()) {
                None => None,
                Some(value) => Some(match input.resolve_secret(value)? {
                    Some(secret) => {
                        check_site(&secret)?;
                        secret.value
                    }
                    None => shikigami_core::expr::to_display(value),
                }),
            };
            let password = match input.params.get("password").filter(|v| !v.is_null()) {
                None => None,
                Some(value) => {
                    let secret = input.resolve_secret(value)?.ok_or_else(|| {
                        StepError::invalid_params(
                            "'password' must be a registered secret, not text",
                        )
                    })?;
                    check_site(&secret)?;
                    Some(secret.value)
                }
            };
            if password.is_some() && smtp.security == Security::None {
                return Err(StepError::permanent(
                    "MAIL_INSECURE_LOGIN",
                    "a password is never sent over a connection without TLS",
                )
                .with_details(json!({ "hint": "Use security starttls (port 587) or tls (port 465), or a server that takes mail without a login." })));
            }
            let login = match (user, password) {
                (Some(user), Some(password)) => Some((user, password)),
                (None, None) => None,
                _ => {
                    return Err(StepError::invalid_params(
                        "give both 'user' and 'password', or neither",
                    ));
                }
            };
            smtp_send(&smtp, login, &draft, input.timeout_ms).await?;
            Ok(json!({ "via": "smtp" }))
        }
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| "attachment".into(), |n| n.to_string_lossy().into_owned())
}

fn read_attachment(path: &str) -> Result<Vec<u8>, StepError> {
    std::fs::read(path).map_err(|e| {
        StepError::permanent("FILE_ERROR", format!("cannot read attachment {path}: {e}"))
    })
}

/// The JSON body of Graph's sendMail.
pub fn graph_message(draft: &Draft) -> Result<Value, StepError> {
    let recipients = |list: &[String]| -> Value {
        list.iter()
            .map(|a| json!({ "emailAddress": { "address": a } }))
            .collect()
    };
    let mut total = 0u64;
    let mut attachments = Vec::new();
    for path in &draft.attachments {
        let bytes = read_attachment(path)?;
        total += bytes.len() as u64;
        if total > GRAPH_MAX_ATTACHMENT_BYTES {
            return Err(too_large());
        }
        attachments.push(json!({
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": file_name(path),
            "contentBytes": base64::engine::general_purpose::STANDARD.encode(&bytes),
        }));
    }
    let message = json!({
        "message": {
            "subject": draft.subject,
            "body": { "contentType": if draft.html { "HTML" } else { "Text" }, "content": draft.body },
            "toRecipients": recipients(&draft.to),
            "ccRecipients": recipients(&draft.cc),
            "bccRecipients": recipients(&draft.bcc),
            "attachments": attachments,
        },
        "saveToSentItems": true,
    });
    // The body, the recipients and the JSON around the attachments count too.
    if serde_json::to_vec(&message).map_or(usize::MAX, |b| b.len()) > GRAPH_MAX_REQUEST_BYTES {
        return Err(too_large());
    }
    Ok(message)
}

/// Posts a sendMail body; Graph answers 202 Accepted.
pub async fn graph_send(url: &str, token: &str, body: &Value) -> Result<(), StepError> {
    let client = shikigami_system::http_client(true)?;
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                // Nothing was sent: trying again is safe.
                StepError::new(
                    "MAIL_SERVER_UNREACHABLE",
                    format!("Microsoft 365 could not be reached: {e}"),
                )
            } else {
                delivery_unknown(format!("the answer of Microsoft 365 was lost: {e}"))
            }
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text: String = response
        .text()
        .await
        .unwrap_or_default()
        .chars()
        .take(1000)
        .collect();
    let (code, hint) = match status.as_u16() {
        401 => (
            "OAUTH_SIGN_IN_REQUIRED",
            "The sign-in is no longer valid: put oauth.signIn with this secret before mail.send and run it again.",
        ),
        403 => (
            "MAIL_PERMISSION_DENIED",
            "The app or the account may not send mail: sign in with oauth.signIn using the scope Mail.Send (and have the Entra app granted Mail.Send).",
        ),
        _ => (
            "MAIL_SEND_FAILED",
            "Microsoft 365 refused the message; see `response`.",
        ),
    };
    let error = format!("Microsoft 365 answered {status}");
    // 429 and 503 mean the message was not taken; after other server errors
    // it may have been sent, and sending again could send it twice.
    let error = if matches!(status.as_u16(), 429 | 503) {
        StepError::new(code, error)
    } else {
        StepError::permanent(code, error)
    };
    Err(error.with_details(json!({ "status": status.as_u16(), "response": text, "hint": hint })))
}

/// How long a Graph or SMTP send may take: less than the step's time, so
/// it ends here (as possibly sent) before the Runtime's timeout.
pub fn send_limit_ms(timeout_ms: u64) -> u64 {
    if timeout_ms > 2_000 {
        timeout_ms - 1_000
    } else {
        timeout_ms / 2
    }
}

/// The message may or may not have gone out: never retried, so a retry
/// cannot send it twice.
pub fn delivery_unknown(message: String) -> StepError {
    StepError::permanent("MAIL_DELIVERY_UNKNOWN", message).with_details(json!({
        "hint": "The message may have been sent. Look in Sent Items (or ask a recipient) before running the step again."
    }))
}

/// Builds the message for SMTP (MIME, UTF-8, attachments).
pub fn smtp_message(from: &str, draft: &Draft) -> Result<lettre::Message, StepError> {
    use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType};
    let mailbox = |address: &str| -> Result<Mailbox, StepError> {
        address.parse().map_err(|_| {
            StepError::permanent(
                "INVALID_ADDRESS",
                format!("'{address}' is not a mail address"),
            )
        })
    };
    let mut builder = lettre::Message::builder()
        .from(mailbox(from)?)
        .subject(draft.subject.clone());
    for address in &draft.to {
        builder = builder.to(mailbox(address)?);
    }
    for address in &draft.cc {
        builder = builder.cc(mailbox(address)?);
    }
    for address in &draft.bcc {
        builder = builder.bcc(mailbox(address)?);
    }
    let body = if draft.html {
        SinglePart::html(draft.body.clone())
    } else {
        SinglePart::plain(draft.body.clone())
    };
    let message = if draft.attachments.is_empty() {
        builder.singlepart(body)
    } else {
        let mut parts = MultiPart::mixed().singlepart(body);
        for path in &draft.attachments {
            let content_type = ContentType::parse("application/octet-stream")
                .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?;
            parts = parts.singlepart(
                Attachment::new(file_name(path)).body(read_attachment(path)?, content_type),
            );
        }
        builder.multipart(parts)
    };
    message.map_err(|e| StepError::permanent("MAIL_SEND_FAILED", e.to_string()))
}

pub async fn smtp_send(
    smtp: &Smtp,
    login: Option<(String, String)>,
    draft: &Draft,
    timeout_ms: u64,
) -> Result<(), StepError> {
    use lettre::transport::smtp::client::{Tls, TlsParameters};
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    let _ = rustls::crypto::ring::default_provider().install_default();
    let message = smtp_message(&smtp.from, draft)?;
    let tls = || {
        TlsParameters::new(smtp.host.clone())
            .map_err(|e| StepError::permanent("MAIL_SEND_FAILED", format!("TLS: {e}")))
    };
    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&smtp.host)
        .port(smtp.port)
        .timeout(Some(std::time::Duration::from_millis(
            send_limit_ms(timeout_ms).min(600_000),
        )))
        .tls(match smtp.security {
            Security::Tls => Tls::Wrapper(tls()?),
            Security::StartTls => Tls::Required(tls()?),
            Security::None => Tls::None,
        });
    if let Some((user, password)) = login {
        builder = builder.credentials(lettre::transport::smtp::authentication::Credentials::new(
            user, password,
        ));
    }
    builder.build().send(message).await.map_err(|e| {
        if e.is_timeout() {
            // The server may have taken the message before going quiet.
            return delivery_unknown(format!("{}:{}: {e}", smtp.host, smtp.port));
        }
        let (code, retryable) = if e.is_permanent() {
            ("MAIL_SEND_FAILED", false)
        } else if e.is_transient() {
            ("MAIL_SEND_FAILED", true)
        } else {
            ("MAIL_SERVER_UNREACHABLE", true)
        };
        let message = format!("{}:{}: {e}", smtp.host, smtp.port);
        let error = if retryable {
            StepError::new(code, message)
        } else {
            StepError::permanent(code, message)
        };
        error.with_details(json!({ "hint": "Check the server and port, the login of the secret, and whether the server takes mail from this PC." }))
    })?;
    Ok(())
}
