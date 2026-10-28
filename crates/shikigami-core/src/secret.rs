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
}

impl SecretField {
    pub const ALL: [SecretField; 3] = [Self::Username, Self::Password, Self::Totp];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Username => "username",
            Self::Password => "password",
            Self::Totp => "totp",
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
}

impl SecretError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn details(&self) -> Option<Value> {
        self.hint.as_ref().map(|hint| json!({ "hint": hint }))
    }
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SecretError {}

/// Hint shown when a secret is missing.
pub const REGISTER_HINT: &str = "Ask the user to register it in Shikigami Studio (シークレット) or with `shikigami secret set <name>`; list_secrets shows the registered names. Never ask for the password in chat.";

/// Where the Runtime looks secrets up. Implemented by the workspace vault
/// (`shikigami-secrets`); tests use an in-memory one.
pub trait SecretProvider: Send + Sync {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError>;

    /// Saved browser login state (cookies, local storage) of a session name.
    fn load_session(&self, name: &str) -> Result<Option<Value>, SecretError>;

    fn save_session(&self, name: &str, state: &Value) -> Result<(), SecretError>;
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
