//! `http.request`: calls a web API and returns its response.

use std::path::Path;
use std::sync::OnceLock;

use serde_json::{Map, Value, json};
use shikigami_runtime::{ActionInput, StepError};

/// Most of a response body kept in error details.
const ERROR_BODY_CHARS: usize = 2000;

fn client() -> Result<&'static reqwest::Client, StepError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // reqwest is built without its own crypto provider (the same
            // TLS stack as Studio's updater); use ring for this process.
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .user_agent(concat!("Shikigami/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| StepError::permanent("HTTP_UNAVAILABLE", e.clone()))
}

fn text_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .filter(|v| !v.is_null())
        .map(shikigami_core::expr::to_display)
}

/// `scheme://host[:port]` of a URL, the form secrets list their sites in.
fn origin(url: &reqwest::Url) -> String {
    url.origin().ascii_serialization()
}

/// A secret is sent only to the origins registered with it.
fn check_site(
    secret: &shikigami_core::secret::ResolvedSecret,
    url: &reqwest::Url,
) -> Result<(), StepError> {
    let origin = origin(url);
    if secret
        .sites
        .iter()
        .any(|s| s.trim_end_matches('/') == origin)
    {
        return Ok(());
    }
    Err(StepError::permanent(
        if secret.sites.is_empty() { "SECRET_SITE_NOT_SET" } else { "SECRET_SITE_MISMATCH" },
        format!("secret '{}' may not be sent to {origin}", secret.name),
    )
    .with_details(json!({
        "secret": secret.name,
        "sites": secret.sites,
        "url": origin,
        "hint": "Call request_secret with this name and the API's origin (e.g. https://api.example.com) so the user can allow it in Studio.",
    })))
}

fn authorize(
    input: &ActionInput,
    request: reqwest::RequestBuilder,
    url: &reqwest::Url,
) -> Result<reqwest::RequestBuilder, StepError> {
    let Some(auth) = input.params.get("auth").filter(|v| !v.is_null()) else {
        return Ok(request);
    };
    let kind = text_param(&input.params, "authType").unwrap_or_else(|| "bearer".into());
    if kind == "basic" {
        // Both fields of one secret: { "secret": "受注API", "field": "password" }.
        let Some(Ok(reference)) = shikigami_core::secret::SecretRef::from_value(auth) else {
            return Err(StepError::permanent(
                "INVALID_PARAMS",
                "authType basic takes a secret: { \"secret\": \"<name>\", \"field\": \"password\" }",
            ));
        };
        let password = input
            .resolve_secret(&json!({ "secret": reference.secret, "field": "password" }))?
            .ok_or_else(|| StepError::permanent("INVALID_PARAMS", "auth must be a secret"))?;
        check_site(&password, url)?;
        let user = input
            .resolve_secret(&json!({ "secret": reference.secret, "field": "username" }))?
            .map(|s| s.value)
            .unwrap_or_default();
        return Ok(request.basic_auth(user, Some(password.value)));
    }
    let value = match input.resolve_secret(auth)? {
        Some(secret) => {
            check_site(&secret, url)?;
            secret.value
        }
        None => shikigami_core::expr::to_display(auth),
    };
    Ok(match kind.as_str() {
        "header" => {
            let name = text_param(&input.params, "authHeader").ok_or_else(|| {
                StepError::permanent(
                    "INVALID_PARAMS",
                    "authType header needs authHeader, e.g. \"X-API-Key\"",
                )
            })?;
            request.header(name, value)
        }
        _ => request.bearer_auth(value),
    })
}

fn query_pairs(params: &Value) -> Vec<(String, String)> {
    params
        .get("query")
        .and_then(Value::as_object)
        .map(|q| {
            q.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), shikigami_core::expr::to_display(v)))
                .collect()
        })
        .unwrap_or_default()
}

fn form_body(form: &Map<String, Value>) -> String {
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(
            form.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, shikigami_core::expr::to_display(v))),
        )
        .finish()
}

/// Decodes a text body by its declared charset, else UTF-8 / Shift_JIS.
fn decode(bytes: &[u8], content_type: &str) -> String {
    let charset = content_type
        .split(';')
        .filter_map(|p| p.trim().strip_prefix("charset="))
        .next()
        .and_then(|label| encoding_rs::Encoding::for_label(label.trim_matches('"').as_bytes()));
    match charset {
        Some(encoding) => encoding.decode(bytes).0.into_owned(),
        None => shikigami_files::encoding::decode(bytes, "auto", "response")
            .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned()),
    }
}

pub async fn request(input: &ActionInput) -> Result<Value, StepError> {
    let params = &input.params;
    let raw_url = text_param(params, "url")
        .ok_or_else(|| StepError::permanent("INVALID_PARAMS", "'url' is required"))?;
    let mut url = reqwest::Url::parse(&raw_url).map_err(|e| {
        StepError::permanent("INVALID_PARAMS", format!("'{raw_url}' is not a URL: {e}"))
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(StepError::permanent(
            "INVALID_PARAMS",
            "only http and https URLs are allowed",
        ));
    }
    let pairs = query_pairs(params);
    if !pairs.is_empty() {
        url.query_pairs_mut().extend_pairs(pairs);
    }
    let method_name = text_param(params, "method")
        .unwrap_or_else(|| "GET".into())
        .to_uppercase();
    let method = reqwest::Method::from_bytes(method_name.as_bytes()).map_err(|_| {
        StepError::permanent("INVALID_PARAMS", format!("unknown method {method_name}"))
    })?;
    let mut request = client()?.request(method, url.clone());
    if let Some(headers) = params.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            request = request.header(name.as_str(), shikigami_core::expr::to_display(value));
        }
    }
    request = authorize(input, request, &url)?;
    let bodies = ["json", "form", "body"]
        .iter()
        .filter(|k| params.get(**k).is_some_and(|v| !v.is_null()))
        .count();
    if bodies > 1 {
        return Err(StepError::permanent(
            "INVALID_PARAMS",
            "give only one of json, form and body",
        ));
    }
    if let Some(body) = params.get("json").filter(|v| !v.is_null()) {
        let text = serde_json::to_string(body).map_err(StepError::invalid_params)?;
        request = request
            .header("content-type", "application/json")
            .body(text);
    } else if let Some(form) = params.get("form").and_then(Value::as_object) {
        request = request
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form_body(form));
    } else if let Some(body) = text_param(params, "body") {
        request = request.body(body);
    }

    let response = request.send().await.map_err(|e| {
        StepError::new("HTTP_CONNECT_FAILED", format!("{}: {e}", origin(&url)))
            .with_details(json!({ "url": origin(&url) }))
    })?;
    let status = response.status().as_u16();
    let mut headers = Map::new();
    for (name, value) in response.headers() {
        headers.insert(
            name.as_str().to_owned(),
            json!(value.to_str().unwrap_or_default()),
        );
    }
    let content_type = headers
        .get("content-type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| StepError::new("HTTP_CONNECT_FAILED", e.to_string()))?;

    if status >= 400 {
        let text: String = decode(&bytes, &content_type)
            .chars()
            .take(ERROR_BODY_CHARS)
            .collect();
        let error = StepError::new(
            "HTTP_ERROR",
            format!("{} {} returned {status}", method_name, origin(&url)),
        )
        .with_details(json!({ "status": status, "body": text }));
        return Err(if status >= 500 || status == 429 || status == 408 {
            error
        } else {
            StepError {
                retryable: false,
                ..error
            }
        });
    }

    let body = if let Some(path) = text_param(params, "saveTo") {
        if input.cancel.is_cancelled() {
            return Err(StepError::new(
                "CANCELLED",
                "the step was stopped before the file was saved",
            ));
        }
        shikigami_files::ops::write_atomic(Path::new(&path), &bytes)?;
        json!(path)
    } else {
        let text = decode(&bytes, &content_type);
        if content_type.contains("json") {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        } else {
            Value::String(text)
        }
    };
    Ok(json!({ "status": status, "headers": headers, "body": body }))
}
