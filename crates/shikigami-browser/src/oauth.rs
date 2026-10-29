//! `oauth.signIn`: OAuth 2.0 sign-in through the browser.
//!
//! The person signs in and allows access on the provider's page. The
//! adapter catches the browser's request to `redirectUrl` before it leaves
//! the PC, so the redirect URL can be any fixed address registered with
//! the provider (a company site, not only localhost) and that site never
//! sees the code. The Runtime checks `state`, exchanges the code (with
//! PKCE) and keeps the tokens encrypted under the secret's name; later runs
//! reuse and refresh them without a person.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use shikigami_runtime::sidecar::SidecarClient;
use shikigami_runtime::{ActionHandler, ActionInput, BoxFuture, StepError};
use shikigami_system::oauth;

use crate::ADAPTER_TIMEOUT_MARGIN_MS;

const DEFAULT_MESSAGE: &str = "ブラウザでサインインして、アクセスを許可してください";

pub(crate) struct SignIn {
    pub(crate) client: Arc<SidecarClient>,
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, StepError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| StepError::permanent("INVALID_PARAMS", format!("'{key}' is required")))
}

impl ActionHandler for SignIn {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let params = &input.params;
            let name = text(params, "secret")?;
            shikigami_core::secret::check_name(name).map_err(StepError::invalid_params)?;
            let token_url = text(params, "tokenUrl")?;
            let redirect_url = text(params, "redirectUrl")?;
            oauth::parse_url(redirect_url, "redirectUrl")?;
            let client = oauth::client(&input, name)?;
            oauth::check_token_url(&client, token_url)?;

            let scope = params.get("scope").and_then(Value::as_str);
            if let Some((tokens, via)) = oauth::reuse(&input, &client, token_url, scope).await? {
                return Ok(tokens.summary(name, via));
            }

            let pkce = params.get("pkce").and_then(Value::as_bool).unwrap_or(true);
            let attempt = oauth::Attempt::new()?;
            let authorize_url = oauth::authorize_url(
                &client,
                &oauth::Request {
                    authorize_url: text(params, "authorizeUrl")?,
                    redirect_url,
                    scope,
                    extra: params.get("authorizeParams").and_then(Value::as_object),
                    pkce,
                },
                &attempt,
            )?;
            input.request_human(
                params
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or(DEFAULT_MESSAGE),
            );
            let mut call = Map::new();
            call.insert("runId".into(), json!(input.run_id.to_string()));
            if let Some(context) = params.get("context") {
                call.insert("context".into(), context.clone());
            }
            call.insert("url".into(), json!(authorize_url));
            call.insert("redirectUrl".into(), json!(redirect_url));
            call.insert(
                "timeoutMs".into(),
                json!(
                    input
                        .timeout_ms
                        .saturating_sub(ADAPTER_TIMEOUT_MARGIN_MS)
                        .max(1)
                ),
            );
            let result = self
                .client
                .call("authorize", Value::Object(call), &input.cancel)
                .await?;
            let returned = result.get("url").and_then(Value::as_str).ok_or_else(|| {
                StepError::permanent("OAUTH_FAILED", "the browser returned no redirect URL")
            })?;
            let code = oauth::code_from_redirect(returned, &attempt)?;
            input.mask_secret(&code);
            let tokens = oauth::exchange(
                &input,
                &client,
                token_url,
                &code,
                redirect_url,
                pkce.then_some(attempt.verifier.as_str()),
                scope,
            )
            .await?;
            Ok(tokens.summary(name, "browser"))
        })
    }
}
