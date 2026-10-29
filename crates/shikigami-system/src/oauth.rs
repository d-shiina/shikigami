//! OAuth 2.0 authorization code flow: the token half.
//!
//! `oauth.signIn` (in `shikigami-browser`) lets the person sign in and
//! allow access in the browser, catches the redirect to the registered
//! redirect URL there (so any fixed URL works, not only localhost) and
//! hands the code to [`exchange`]. Tokens are kept encrypted in the vault
//! under the secret's name; `http.request` with
//! `auth: { "secret": .., "field": "accessToken" }` gets them through
//! [`access_token`], which refreshes them when they are about to expire.
//!
//! The secret holds the client: username = client ID, password = client
//! secret (empty for public clients), sites = where the client secret and
//! the tokens may be sent (the token endpoint and the API).

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use shikigami_runtime::{ActionInput, StepError};

/// Tokens closer than this to expiry are refreshed before use.
const EXPIRY_MARGIN_SECS: i64 = 120;

/// Refreshes are one at a time: many providers (Box among them) replace
/// the refresh token on every refresh, so two at once would lose one.
static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What the vault keeps for a secret (encrypted).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    /// The token endpoint the tokens came from (refreshes go there).
    pub token_url: String,
    pub client_id: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds; `None` when the server gave no lifetime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("token_url", &self.token_url)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl Tokens {
    fn expiring(&self) -> bool {
        self.expires_at
            .is_some_and(|at| at - now_secs() < EXPIRY_MARGIN_SECS)
    }

    /// The step output: never the tokens themselves.
    pub fn summary(&self, secret: &str, via: &str) -> Value {
        let mut out = json!({ "secret": secret, "signedIn": true, "via": via });
        if let Some(at) = self.expires_at {
            out["expiresAt"] = json!(rfc3339(at));
        }
        if let Some(scope) = &self.scope {
            out["scope"] = json!(scope);
        }
        out
    }
}

/// The OAuth client registered as a secret.
pub struct Client {
    pub name: String,
    pub id: String,
    secret: Option<String>,
    /// Origins the client secret and the tokens may be sent to.
    pub sites: Vec<String>,
}

impl Client {
    #[cfg(test)]
    pub(crate) fn for_tests(name: &str, id: &str) -> Self {
        Self {
            name: name.into(),
            id: id.into(),
            secret: None,
            sites: vec![],
        }
    }
}

/// Reads the client of the secret `name`: username = client ID, password =
/// client secret (optional).
pub fn client(input: &ActionInput, name: &str) -> Result<Client, StepError> {
    let id = input
        .resolve_secret(&json!({ "secret": name, "field": "username" }))?
        .ok_or_else(|| StepError::permanent("INVALID_PARAMS", "secret name expected"))?;
    let secret = match input.resolve_secret(&json!({ "secret": name, "field": "password" })) {
        Ok(resolved) => resolved.map(|s| s.value),
        Err(e) if e.code == "SECRET_FIELD_EMPTY" => None,
        Err(e) => return Err(e),
    };
    Ok(Client {
        name: name.to_owned(),
        id: id.value,
        secret,
        sites: id.sites,
    })
}

/// One sign-in attempt: `state` ties the redirect to this attempt, the
/// PKCE verifier ties the code to it.
pub struct Attempt {
    pub state: String,
    pub verifier: String,
}

impl Attempt {
    pub fn new() -> Result<Self, StepError> {
        Ok(Self {
            state: random_token()?,
            verifier: random_token()?,
        })
    }

    fn challenge(&self) -> String {
        B64URL.encode(Sha256::digest(self.verifier.as_bytes()))
    }
}

fn random_token() -> Result<String, StepError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?;
    Ok(B64URL.encode(bytes))
}

pub fn parse_url(text: &str, param: &str) -> Result<reqwest::Url, StepError> {
    let url = reqwest::Url::parse(text).map_err(|e| {
        StepError::permanent(
            "INVALID_PARAMS",
            format!("{param} '{text}' is not a URL: {e}"),
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(StepError::permanent(
            "INVALID_PARAMS",
            format!("{param} must be an http or https URL"),
        ));
    }
    Ok(url)
}

/// Fails before anyone signs in when the client secret and the code may
/// not be sent to the token endpoint.
pub fn check_token_url(client: &Client, token_url: &str) -> Result<(), StepError> {
    crate::http::check_site(
        &client.name,
        &client.sites,
        &parse_url(token_url, "tokenUrl")?,
    )
}

/// What a sign-in asks for, from the step params.
pub struct Request<'a> {
    pub authorize_url: &'a str,
    pub redirect_url: &'a str,
    pub scope: Option<&'a str>,
    /// Extra parameters for the authorization page (e.g. `prompt`).
    pub extra: Option<&'a Map<String, Value>>,
    pub pkce: bool,
}

/// The authorization page to open for `attempt`.
pub fn authorize_url(
    client: &Client,
    request: &Request<'_>,
    attempt: &Attempt,
) -> Result<String, StepError> {
    let mut url = parse_url(request.authorize_url, "authorizeUrl")?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client.id)
            .append_pair("redirect_uri", request.redirect_url)
            .append_pair("state", &attempt.state);
        if let Some(scope) = request.scope.filter(|s| !s.trim().is_empty()) {
            query.append_pair("scope", scope);
        }
        if request.pkce {
            query
                .append_pair("code_challenge", &attempt.challenge())
                .append_pair("code_challenge_method", "S256");
        }
        for (key, value) in request.extra.into_iter().flatten() {
            if !value.is_null() {
                query.append_pair(key, &shikigami_core::expr::to_display(value));
            }
        }
    }
    Ok(url.into())
}

/// The code from the URL the browser was sent back to. The `state` must be
/// this attempt's: anything else is not the answer to our request.
pub fn code_from_redirect(url: &str, attempt: &Attempt) -> Result<String, StepError> {
    let url = reqwest::Url::parse(url)
        .map_err(|e| StepError::permanent("OAUTH_FAILED", format!("bad redirect URL: {e}")))?;
    let mut params: Map<String, Value> = Map::new();
    for (key, value) in url.query_pairs() {
        params.insert(key.into_owned(), json!(value.into_owned()));
    }
    let get = |key: &str| params.get(key).and_then(Value::as_str);
    if get("state") != Some(attempt.state.as_str()) {
        return Err(StepError::permanent(
            "OAUTH_STATE_MISMATCH",
            "the sign-in came back with a different state, so it is not the answer to this request",
        )
        .with_details(json!({ "hint": "Run the step again. If it keeps happening, another sign-in is racing this one." })));
    }
    if let Some(error) = get("error") {
        return Err(StepError::permanent(
            "OAUTH_DENIED",
            format!(
                "the sign-in was refused: {error}{}",
                get("error_description")
                    .map(|d| format!(" ({d})"))
                    .unwrap_or_default()
            ),
        )
        .with_details(json!({
            "error": error,
            "hint": "access_denied means the person did not allow access. Otherwise check the client ID, redirectUrl and scope against the app's settings at the provider.",
        })));
    }
    get("code")
        .map(str::to_owned)
        .ok_or_else(|| StepError::permanent("OAUTH_FAILED", "the redirect carried no code"))
}

/// Exchanges the code for tokens and saves them under the secret.
pub async fn exchange(
    input: &ActionInput,
    client: &Client,
    token_url: &str,
    code: &str,
    redirect_url: &str,
    verifier: Option<&str>,
) -> Result<Tokens, StepError> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_owned()),
        ("code", code.to_owned()),
        ("redirect_uri", redirect_url.to_owned()),
    ];
    if let Some(verifier) = verifier {
        form.push(("code_verifier", verifier.to_owned()));
    }
    let tokens = token_request(input, client, token_url, form, None).await?;
    save(input, &client.name, &tokens)?;
    Ok(tokens)
}

/// Saved tokens of this client and token endpoint that still work,
/// refreshed when about to expire: with the source (`saved` or
/// `refreshed`). `None` when a person has to sign in.
pub async fn reuse(
    input: &ActionInput,
    client: &Client,
    token_url: &str,
) -> Result<Option<(Tokens, &'static str)>, StepError> {
    let _turn = REFRESH.lock().await;
    let Some(tokens) = load(input, &client.name)? else {
        return Ok(None);
    };
    if tokens.client_id != client.id || tokens.token_url != token_url {
        return Ok(None);
    }
    if !tokens.expiring() {
        return Ok(Some((tokens, "saved")));
    }
    match refresh(input, client, tokens).await {
        Ok(Some(tokens)) => Ok(Some((tokens, "refreshed"))),
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    }
}

/// The access token of the secret `name` for `http.request`, refreshed
/// when about to expire, with the sites it may be sent to.
pub async fn access_token(
    input: &ActionInput,
    name: &str,
) -> Result<(String, Vec<String>), StepError> {
    let client = client(input, name)?;
    let _turn = REFRESH.lock().await;
    let mut tokens = load(input, name)?.ok_or_else(|| sign_in_required(name))?;
    if tokens.client_id != client.id {
        return Err(sign_in_required(name));
    }
    if tokens.expiring() {
        tokens = refresh(input, &client, tokens)
            .await?
            .ok_or_else(|| sign_in_required(name))?;
    }
    input.mask_secret(&tokens.access_token);
    Ok((tokens.access_token, client.sites))
}

fn sign_in_required(name: &str) -> StepError {
    StepError::permanent(
        "OAUTH_SIGN_IN_REQUIRED",
        format!("there is no usable OAuth sign-in for '{name}'"),
    )
    .with_details(json!({
        "secret": name,
        "hint": "Put an oauth.signIn step with this secret before the request. A person signs in once in the browser; later runs reuse and refresh the tokens.",
    }))
}

/// `None` when the provider no longer accepts the refresh token (a person
/// has to sign in again).
async fn refresh(
    input: &ActionInput,
    client: &Client,
    old: Tokens,
) -> Result<Option<Tokens>, StepError> {
    let Some(refresh_token) = old.refresh_token.clone() else {
        return Ok(None);
    };
    let form = vec![
        ("grant_type", "refresh_token".to_owned()),
        ("refresh_token", refresh_token),
    ];
    match token_request(input, client, &old.token_url, form, Some(&old)).await {
        Ok(tokens) => {
            save(input, &client.name, &tokens)?;
            Ok(Some(tokens))
        }
        Err(e) if e.code == "OAUTH_TOKEN_FAILED" && !e.retryable => {
            tracing::info!(secret = client.name, error = %e.message, "OAuth refresh refused; signing in again");
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

fn load(input: &ActionInput, name: &str) -> Result<Option<Tokens>, StepError> {
    Ok(input
        .secret_provider()?
        .load_oauth_tokens(name)?
        .and_then(|v| serde_json::from_value(v).ok()))
}

fn save(input: &ActionInput, name: &str, tokens: &Tokens) -> Result<(), StepError> {
    let value = serde_json::to_value(tokens)
        .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?;
    input.secret_provider()?.save_oauth_tokens(name, &value)?;
    Ok(())
}

/// POSTs to the token endpoint (client secret in the body, as
/// client_secret_post) and reads the token response. `old` supplies what a
/// refresh response leaves out.
async fn token_request(
    input: &ActionInput,
    client: &Client,
    token_url: &str,
    mut form: Vec<(&str, String)>,
    old: Option<&Tokens>,
) -> Result<Tokens, StepError> {
    let url = parse_url(token_url, "tokenUrl")?;
    crate::http::check_site(&client.name, &client.sites, &url)?;
    form.push(("client_id", client.id.clone()));
    if let Some(secret) = &client.secret {
        form.push(("client_secret", secret.clone()));
    }
    let body = form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form.iter().map(|(k, v)| (*k, v.as_str())))
        .finish();
    let origin = url.origin().ascii_serialization();
    let response = crate::http::client(true)?
        .post(url)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| {
            StepError::new("HTTP_CONNECT_FAILED", format!("{origin}: {e}"))
                .with_details(json!({ "url": origin }))
        })?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| StepError::new("HTTP_CONNECT_FAILED", e.to_string()))?;
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let text = |key: &str| body.get(key).and_then(Value::as_str).map(str::to_owned);
    if status >= 400 || text("error").is_some() {
        let error = text("error").unwrap_or_else(|| format!("status {status}"));
        let description = text("error_description");
        let failure = StepError::new(
            "OAUTH_TOKEN_FAILED",
            format!(
                "the token endpoint {origin} refused: {error}{}",
                description.as_ref().map(|d| format!(" ({d})")).unwrap_or_default()
            ),
        )
        .with_details(json!({
            "status": status,
            "error": error,
            "errorDescription": description,
            "hint": "Check the secret's username (client ID) and password (client secret), tokenUrl and redirectUrl against the app's settings at the provider.",
        }));
        return Err(if status >= 500 || status == 429 {
            failure
        } else {
            StepError {
                retryable: false,
                ..failure
            }
        });
    }
    let access_token = text("access_token").ok_or_else(|| {
        StepError::permanent(
            "OAUTH_TOKEN_FAILED",
            format!("{origin} returned no access_token"),
        )
    })?;
    input.mask_secret(&access_token);
    let refresh_token = text("refresh_token").or_else(|| old.and_then(|o| o.refresh_token.clone()));
    if let Some(token) = &refresh_token {
        input.mask_secret(token);
    }
    let expires_in = body.get("expires_in").and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    });
    Ok(Tokens {
        token_url: token_url.to_owned(),
        client_id: client.id.clone(),
        access_token,
        refresh_token,
        expires_at: expires_in.map(|secs| now_secs() + secs),
        scope: text("scope").or_else(|| old.and_then(|o| o.scope.clone())),
    })
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn rfc3339(secs: i64) -> String {
    jiff::Timestamp::from_second(secs)
        .map(|t| t.to_string())
        .unwrap_or_default()
}
