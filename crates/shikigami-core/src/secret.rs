//! Secrets (passwords and other login data) referenced from scenarios.
//!
//! A human registers a secret under a name in Studio or the CLI (e.g.
//! 「受注システム」 with a user name, a password and the sites it may be
//! typed into). Scenarios and AI clients only ever see that name: an input
//! step writes `{ "secret": "受注システム", "field": "password" }` as its
//! value and the Runtime looks the value up while the step runs. Values
//! never appear in scenario files, MCP results, logs or screenshots.
//!
//! This module holds the reference format and the provider interface; the
//! encrypted store lives in `shikigami-secrets`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// A reference to one field of a registered secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretRef {
    /// Name the secret was registered under (literal, no `{{ }}`).
    pub secret: String,
    pub field: SecretField,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SecretField {
    Username,
    Password,
    /// The current one-time code computed from the stored TOTP key (MFA).
    Totp,
    /// The OAuth access token `oauth.signIn` obtained with this secret's
    /// client ID and secret. Only `http.request` `auth` takes it: it is
    /// refreshed there when it expires.
    AccessToken,
}

impl SecretField {
    /// The fields a person registers (the access token is obtained by
    /// `oauth.signIn`).
    pub const ALL: [SecretField; 3] = [Self::Username, Self::Password, Self::Totp];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Username => "username",
            Self::Password => "password",
            Self::Totp => "totp",
            Self::AccessToken => "accessToken",
        }
    }

    /// Whether values of this field are masked in logs, results and
    /// screenshots. User names are not: they appear on screen anyway.
    pub fn is_sensitive(self) -> bool {
        !matches!(self, Self::Username)
    }
}

impl SecretRef {
    /// Reads a reference from a param value; `None` when the value is not
    /// an object with a `secret` key.
    pub fn from_value(value: &Value) -> Option<Result<Self, String>> {
        let map = value.as_object()?;
        map.get("secret")?;
        Some(serde_json::from_value(value.clone()).map_err(|e| e.to_string()))
    }
}

/// Max length of a secret name.
pub const MAX_NAME_LEN: usize = 64;

/// Checks a secret (or login session) name: 1–64 characters, no control
/// characters, no `{{ }}`.
pub fn check_name(name: &str) -> Result<(), String> {
    let len = name.chars().count();
    if name.trim().is_empty() || len > MAX_NAME_LEN {
        return Err(format!("a secret name must be 1–{MAX_NAME_LEN} characters"));
    }
    if name.chars().any(char::is_control) || name.contains("{{") || name.contains("}}") {
        return Err("a secret name must be literal text (no {{ }} or control characters)".into());
    }
    if name.trim() != name {
        return Err("a secret name must not start or end with spaces".into());
    }
    Ok(())
}

/// What a step gets for a [`SecretRef`].
#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedSecret {
    pub name: String,
    pub field: SecretField,
    pub value: String,
    /// Origins (`https://example.com`) the value may be typed into. Browser
    /// steps refuse other pages.
    pub sites: Vec<String>,
}

impl std::fmt::Debug for ResolvedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedSecret")
            .field("name", &self.name)
            .field("field", &self.field)
            .field("value", &"***")
            .field("sites", &self.sites)
            .finish()
    }
}

/// Error from a [`SecretProvider`], with a fix hint for humans and AI.
#[derive(Debug, Clone, PartialEq)]
pub struct SecretError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    /// The secret the error is about, so Studio can offer to register or
    /// fix it.
    pub secret: Option<String>,
    /// The field that is missing (SECRET_FIELD_EMPTY).
    pub field: Option<SecretField>,
}

impl SecretError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            hint: None,
            secret: None,
            field: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn with_secret(mut self, name: impl Into<String>) -> Self {
        self.secret = Some(name.into());
        self
    }

    pub fn with_field(mut self, field: SecretField) -> Self {
        self.field = Some(field);
        self
    }

    pub fn details(&self) -> Option<Value> {
        let mut details = serde_json::Map::new();
        if let Some(hint) = &self.hint {
            details.insert("hint".into(), json!(hint));
        }
        if let Some(name) = &self.secret {
            details.insert("secret".into(), json!(name));
        }
        if let Some(field) = self.field {
            details.insert("field".into(), json!(field.as_str()));
        }
        (!details.is_empty()).then_some(Value::Object(details))
    }
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SecretError {}

/// Hint shown when a secret is missing.
pub const REGISTER_HINT: &str = "Call request_secret with this name and the site's address: Studio then asks the user to register it. Or ask the user to register it in Shikigami Studio (シークレット) or with `shikigami secret set <name>`; list_secrets shows the registered names. Never ask for the password in chat.";

/// Where the Runtime looks secrets up. Implemented by the workspace vault
/// (`shikigami-secrets`); tests use an in-memory one.
pub trait SecretProvider: Send + Sync {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError>;

    /// Saved browser login state (cookies, local storage) of a session name.
    fn load_session(&self, name: &str) -> Result<Option<Value>, SecretError>;

    fn save_session(&self, name: &str, state: &Value) -> Result<(), SecretError>;

    /// OAuth tokens `oauth.signIn` saved for a secret (see
    /// `shikigami-system`'s `oauth` module for the shape).
    fn load_oauth_tokens(&self, name: &str) -> Result<Option<Value>, SecretError> {
        let _ = name;
        Ok(None)
    }

    /// Holds off other processes sharing the store (Studio, the CLI, the
    /// MCP server) from refreshing the tokens of `name` until the guard is
    /// dropped. Blocks while another one holds it.
    fn lock_oauth_tokens(&self, name: &str) -> Result<Box<dyn Send>, SecretError> {
        let _ = name;
        Ok(Box::new(()))
    }

    fn save_oauth_tokens(&self, name: &str, tokens: &Value) -> Result<(), SecretError> {
        let _ = (name, tokens);
        Err(SecretError::new(
            "SECRETS_UNAVAILABLE",
            "this secret store cannot keep OAuth tokens",
        ))
    }
}

/// JSON Schema of a param that takes literal text, a template, or a secret
/// reference (for input steps such as `browser.fill`).
pub fn text_or_secret_schema(description: &str) -> Value {
    json!({
        "description": description,
        "oneOf": [
            { "type": "string" },
            secret_ref_schema(),
        ]
    })
}

/// Like [`text_or_secret_schema`], for params that also take the OAuth
/// access token of a secret (`http.request` `auth`).
pub fn token_or_secret_schema(description: &str) -> Value {
    let mut reference = secret_ref_schema();
    reference["properties"]["field"] =
        json!({ "enum": ["password", "accessToken", "username", "totp"] });
    reference["description"] = json!(
        "A registered secret, e.g. { \"secret\": \"受注API\", \"field\": \"password\" }, or the OAuth access token obtained by oauth.signIn: { \"secret\": \"Box\", \"field\": \"accessToken\" }."
    );
    json!({
        "description": description,
        "oneOf": [
            { "type": "string" },
            reference,
        ]
    })
}

pub fn secret_ref_schema() -> Value {
    json!({
        "type": "object",
        "description": "A registered secret, e.g. { \"secret\": \"受注システム\", \"field\": \"password\" }. Only the name is written here; the value is looked up when the step runs.",
        "properties": {
            "secret": { "type": "string", "minLength": 1, "maxLength": MAX_NAME_LEN },
            "field": { "enum": ["username", "password", "totp"] }
        },
        "required": ["secret", "field"],
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_references() {
        let r = SecretRef::from_value(&json!({ "secret": "受注", "field": "password" }));
        assert_eq!(
            r,
            Some(Ok(SecretRef {
                secret: "受注".into(),
                field: SecretField::Password
            }))
        );
        assert!(SecretRef::from_value(&json!("text")).is_none());
        assert!(SecretRef::from_value(&json!({ "label": "x" })).is_none());
        assert!(matches!(
            SecretRef::from_value(&json!({ "secret": "受注", "field": "pin" })),
            Some(Err(_))
        ));
    }

    #[test]
    fn names_are_literal() {
        assert!(check_name("受注システム").is_ok());
        assert!(check_name("").is_err());
        assert!(check_name(" a").is_err());
        assert!(check_name("{{ x }}").is_err());
        assert!(check_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn debug_hides_the_value() {
        let s = ResolvedSecret {
            name: "a".into(),
            field: SecretField::Password,
            value: "hunter2".into(),
            sites: vec![],
        };
        assert!(!format!("{s:?}").contains("hunter2"));
    }
}
