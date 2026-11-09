//! The workspace secret vault.
//!
//! ```text
//! <workspace>/secrets/vault.json            names, sites and encrypted values
//! <workspace>/secrets/sessions/<hash>.json  saved browser logins (encrypted)
//! <workspace>/secrets/oauth/<hash>.json     OAuth tokens from oauth.signIn (encrypted)
//! <workspace>/secrets/requests.json         logins an AI asked the user for
//! ```
//!
//! Values are encrypted with AES-256-GCM. The key is kept outside the
//! workspace by a [`KeyStore`] (Windows Credential Manager: one entry per
//! workspace), so copying the workspace folder does not copy the secrets.
//! Names, sites and which fields are set are stored in clear text: they are
//! what Studio lists and what AI clients may see.

mod keys;
mod totp;
mod wincred;

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use spellsheet_core::secret::{
    self, REGISTER_HINT, ResolvedSecret, SecretError, SecretField, SecretKind, SecretProvider,
    SecretRef,
};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub use keys::{Key, KeyStore, MemoryKeyStore, platform_key_store};
pub use wincred::{
    MemoryWindowsCredentials, WindowsCredentialInfo, WindowsCredentials, WindowsLogin,
    platform_windows_credentials,
};

const VAULT_FILE: &str = "vault.json";
const SESSIONS_DIR: &str = "sessions";
const OAUTH_DIR: &str = "oauth";
const LOCK_FILE: &str = ".lock";
const REQUESTS_FILE: &str = "requests.json";
/// Longest `reason` kept on a [`SecretRequest`].
const MAX_REASON_LEN: usize = 300;

/// A secret as Studio and the CLI list it (no password or TOTP key).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub name: String,
    pub kind: SecretKind,
    pub username: String,
    /// Origins the secret may be typed into, e.g. `https://example.com`.
    pub sites: Vec<String>,
    /// Fields that have a value.
    pub fields: Vec<SecretField>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// `oauth.signIn` has saved tokens for this secret.
    #[serde(default)]
    pub signed_in: bool,
    /// When the saved OAuth tokens expire and were last obtained.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthStatus>,
    /// The user name and password are read from this generic credential of
    /// Windows Credential Manager each time they are used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows_credential: Option<String>,
    pub updated_at: String,
}

/// The state of the OAuth tokens `oauth.signIn` saved (never the tokens).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatus {
    /// When the access token expires (RFC 3339); none when the provider
    /// gave no lifetime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// When the provider last gave tokens (sign-in or refresh).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obtained_at: Option<String>,
    /// A refresh token is kept, so an expired access token is renewed
    /// without a person.
    pub refreshable: bool,
}

/// What AI clients may know about a secret: everything except the values
/// (and the user name).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretSummary {
    pub name: String,
    pub kind: SecretKind,
    pub sites: Vec<String>,
    pub fields: Vec<SecretField>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// `oauth.signIn` has saved tokens for this secret, so
    /// `{ "field": "accessToken" }` works without a person.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub signed_in: bool,
    /// The values live in Windows Credential Manager under this name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows_credential: Option<String>,
}

/// Registers or updates a secret. `None` keeps the stored value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretInput {
    pub name: String,
    /// Fields the kind does not use are removed. `None` keeps the kind.
    #[serde(default)]
    pub kind: Option<SecretKind>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// Base32 key or `otpauth://` text of the MFA QR code; empty removes it.
    #[serde(default)]
    pub totp: Option<String>,
    /// Sites (URLs or origins) the secret may be typed into.
    #[serde(default)]
    pub sites: Option<Vec<String>>,
    #[serde(default)]
    pub description: Option<String>,
    /// Read the user name and password from this generic credential of
    /// Windows Credential Manager instead of keeping them in the vault;
    /// empty goes back to values kept in the vault.
    #[serde(default)]
    pub windows_credential: Option<String>,
}

/// A login an AI client asked the user to register in Studio, or to
/// complete (a missing field or site). Holds names and sites only: the user
/// types the values in Studio, so they never pass through the AI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequest {
    pub name: String,
    /// What to register; none for a login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<SecretKind>,
    /// Origins (or `app:<exe>`) the secret should be typed into.
    pub sites: Vec<String>,
    pub fields: Vec<SecretField>,
    /// Why the AI needs it, shown to the user. Written by the AI: Studio
    /// shows it as the AI's words, never as an instruction from SpellSheet.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    pub requested_at: String,
}

/// Asks the user for a login (see [`Vault::request`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewSecretRequest {
    pub name: String,
    /// `apiKey` for a key of a web API, `oauth` for an app registered at an
    /// OAuth provider. Defaults to a login.
    #[serde(default)]
    pub kind: Option<SecretKind>,
    #[serde(default)]
    pub sites: Vec<String>,
    /// Defaults to username and password.
    #[serde(default)]
    pub fields: Vec<SecretField>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// What a registered secret still lacks for a request.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Missing {
    /// False when no secret has the name yet.
    pub registered: bool,
    pub fields: Vec<SecretField>,
    pub sites: Vec<String>,
}

impl Missing {
    pub fn is_empty(&self) -> bool {
        self.registered && self.fields.is_empty() && self.sites.is_empty()
    }
}

/// A request Studio still has to show, with what is missing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingSecretRequest {
    #[serde(flatten)]
    pub request: SecretRequest,
    pub missing: Missing,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestsFile {
    version: u32,
    requests: Vec<SecretRequest>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    version: u32,
    /// Names the key in the key store.
    id: String,
    entries: Vec<StoredEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    name: String,
    /// None in vaults written before kinds: see [`Vault::kind_of`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<SecretKind>,
    sites: Vec<String>,
    fields: Vec<SecretField>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    /// Where the user name and password live instead (see [`wincred`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    windows_credential: Option<String>,
    updated_at: String,
    #[serde(flatten)]
    sealed: Sealed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sealed {
    nonce: String,
    data: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Values {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    totp: Option<String>,
}

/// Shortest value [`Vault::mask`] replaces.
const MIN_MASKED_LEN: usize = 4;
const MASK: &str = "***";

/// The secrets of one workspace.
pub struct Vault {
    dir: PathBuf,
    keys: Box<dyn KeyStore>,
    windows: Box<dyn WindowsCredentials>,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault").field("dir", &self.dir).finish()
    }
}

fn io_error(e: impl std::fmt::Display) -> SecretError {
    SecretError::new("SECRET_STORAGE_ERROR", e.to_string())
}

fn not_found(name: &str) -> SecretError {
    SecretError::new("SECRET_NOT_FOUND", format!("no secret named '{name}'"))
        .with_hint(REGISTER_HINT)
        .with_secret(name)
}

fn windows_missing(name: &str, target: &str) -> SecretError {
    SecretError::new(
        "WINDOWS_CREDENTIAL_NOT_FOUND",
        format!("Windows Credential Manager has no generic credential '{target}' (used by secret '{name}')"),
    )
    .with_hint("Ask the user to add it in Windows Credential Manager (資格情報マネージャー → Windows 資格情報 → 汎用資格情報の追加) with this address, or to change the secret in Writer.")
    .with_secret(name)
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

impl Vault {
    /// The vault of a workspace, with the platform key store.
    pub fn open(workspace_root: &Path) -> Self {
        let dir = workspace_root.join("secrets");
        let keys = platform_key_store(dir.clone());
        Self::with_key_store(workspace_root, keys)
    }

    pub fn with_key_store(workspace_root: &Path, keys: Box<dyn KeyStore>) -> Self {
        Self {
            dir: workspace_root.join("secrets"),
            keys,
            windows: platform_windows_credentials(),
        }
    }

    /// The same vault reading Windows credentials from `windows` (tests).
    pub fn with_windows_credentials(mut self, windows: Box<dyn WindowsCredentials>) -> Self {
        self.windows = windows;
        self
    }

    /// The generic credentials Studio offers to link a secret to.
    pub fn windows_credentials(&self) -> Result<Vec<WindowsCredentialInfo>, SecretError> {
        self.windows.list()
    }

    /// The stored values of `entry`, with the user name and password read
    /// from Windows Credential Manager when it points there.
    fn values(&self, key: &Key, entry: &StoredEntry) -> Result<Values, SecretError> {
        let mut values = open(key, entry)?;
        if let Some(target) = &entry.windows_credential {
            let login = self
                .windows
                .read(target)?
                .ok_or_else(|| windows_missing(&entry.name, target))?;
            values.username = login.username;
            values.password = login.password;
        }
        Ok(values)
    }

    /// Where the key is kept, for display.
    pub fn key_location(&self) -> String {
        self.keys.describe()
    }

    pub fn list(&self) -> Result<Vec<SecretInfo>, SecretError> {
        let file = self.read()?;
        if file.entries.is_empty() {
            return Ok(Vec::new());
        }
        let key = self.key(&file, false)?;
        file.entries
            .iter()
            .map(|entry| {
                // A credential missing from Credential Manager shows as an
                // empty user name; using the secret says what is wrong.
                let values = match self.values(&key, entry) {
                    Ok(values) => values,
                    Err(_) if entry.windows_credential.is_some() => Values::default(),
                    Err(e) => return Err(e),
                };
                let oauth = self.oauth_status(&key, &entry.name);
                Ok(SecretInfo {
                    name: entry.name.clone(),
                    kind: self.kind_of(entry),
                    username: values.username,
                    sites: entry.sites.clone(),
                    fields: entry.fields.clone(),
                    description: entry.description.clone(),
                    signed_in: oauth.is_some(),
                    oauth,
                    windows_credential: entry.windows_credential.clone(),
                    updated_at: entry.updated_at.clone(),
                })
            })
            .collect()
    }

    /// Names, sites and fields only (for AI clients). Needs no key.
    pub fn summaries(&self) -> Result<Vec<SecretSummary>, SecretError> {
        Ok(self
            .read()?
            .entries
            .into_iter()
            .map(|e| SecretSummary {
                signed_in: self.oauth_path(&e.name).is_file(),
                kind: self.kind_of(&e),
                name: e.name,
                sites: e.sites,
                fields: e.fields,
                description: e.description,
                windows_credential: e.windows_credential,
            })
            .collect())
    }

    /// Replaces every registered password (and TOTP key) that appears in
    /// `text` with `***`, e.g. before an AI's view of a screen is stored as
    /// review evidence. Without a key on this PC nothing can be matched and
    /// the text is returned unchanged.
    pub fn mask(&self, text: &str) -> String {
        let Ok(file) = self.read() else {
            return text.to_owned();
        };
        if file.entries.is_empty() {
            return text.to_owned();
        }
        let Ok(key) = self.key(&file, false) else {
            return text.to_owned();
        };
        let mut values: Vec<String> = file
            .entries
            .iter()
            .filter_map(|e| self.values(&key, e).ok())
            .flat_map(|v| [Some(v.password), v.totp])
            .flatten()
            // Very short values would mask ordinary words.
            .filter(|v| v.chars().count() >= MIN_MASKED_LEN)
            .collect();
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        values
            .iter()
            .fold(text.to_owned(), |acc, v| acc.replace(v.as_str(), MASK))
    }

    /// Registers a new secret or updates one (fields left `None` are kept).
    pub fn set(&self, input: SecretInput) -> Result<SecretInfo, SecretError> {
        secret::check_name(&input.name).map_err(|m| SecretError::new("INVALID_SECRET_NAME", m))?;
        let _guard = self.lock()?;
        let mut file = self.read()?;
        let key = self.key(&file, true)?;
        if file.id.is_empty() {
            // `key` created the id.
            file = self.read()?;
        }
        let existing = file.entries.iter().position(|e| e.name == input.name);
        let (mut values, mut sites, mut description, old_kind, mut windows) = match existing {
            Some(i) => {
                let e = &file.entries[i];
                (
                    open(&key, e)?,
                    e.sites.clone(),
                    e.description.clone(),
                    Some(self.kind_of(e)),
                    e.windows_credential.clone(),
                )
            }
            None => (Values::default(), Vec::new(), String::new(), None, None),
        };
        if let Some(target) = input.windows_credential {
            let target = target.trim().to_owned();
            windows = (!target.is_empty()).then_some(target);
        }
        let kind = input.kind.or(old_kind).unwrap_or_default();
        if let Some(username) = input.username {
            values.username = username;
        }
        if let Some(password) = input.password {
            values.password = password;
        }
        if let Some(totp) = input.totp {
            let totp = totp.trim().to_owned();
            if totp.is_empty() {
                values.totp = None;
            } else {
                totp::TotpSpec::parse(&totp).map_err(|m| {
                    SecretError::new("INVALID_TOTP", m).with_hint(
                        "Paste the setup key shown next to the MFA QR code (base32), or the otpauth:// text of the QR code.",
                    )
                })?;
                values.totp = Some(totp);
            }
        }
        if let Some(list) = input.sites {
            sites = list
                .iter()
                .filter(|s| !s.trim().is_empty())
                .map(|s| normalize_site(s))
                .collect::<Result<Vec<_>, _>>()?;
            sites.dedup();
        }
        if let Some(text) = input.description {
            description = text.trim().to_owned();
        }
        // A value the kind has no field for would be kept but never shown.
        let used = kind.fields();
        if !used.contains(&SecretField::Username) {
            values.username.clear();
        }
        if !used.contains(&SecretField::Totp) {
            values.totp = None;
        }
        // Linked to Credential Manager: the vault keeps no user name or
        // password of its own, and the credential must be there now.
        let (username, password) = match &windows {
            Some(target) => {
                values.username.clear();
                values.password.clear();
                let login = self
                    .windows
                    .read(target)?
                    .ok_or_else(|| windows_missing(&input.name, target))?;
                (login.username, login.password)
            }
            None => (values.username.clone(), values.password.clone()),
        };
        let username = if used.contains(&SecretField::Username) {
            username
        } else {
            String::new()
        };
        let mut fields = Vec::new();
        if !username.is_empty() {
            fields.push(SecretField::Username);
        }
        if !password.is_empty() {
            fields.push(SecretField::Password);
        }
        if values.totp.is_some() {
            fields.push(SecretField::Totp);
        }
        let entry = StoredEntry {
            sealed: seal(&key, &input.name, &values)?,
            name: input.name.clone(),
            kind: Some(kind),
            sites: sites.clone(),
            fields: fields.clone(),
            description: description.clone(),
            windows_credential: windows.clone(),
            updated_at: now(),
        };
        let oauth = self.oauth_status(&key, &input.name);
        let info = SecretInfo {
            name: entry.name.clone(),
            kind,
            username,
            sites,
            fields,
            description,
            signed_in: oauth.is_some(),
            oauth,
            windows_credential: windows,
            updated_at: entry.updated_at.clone(),
        };
        match existing {
            Some(i) => file.entries[i] = entry,
            None => file.entries.push(entry),
        }
        self.write(&file)?;
        // A request this answers is done. Failing to tidy the requests
        // never fails the registration.
        if let Err(e) = self.prune_requests(&file) {
            tracing::warn!(error = %e, "could not update secret requests");
        }
        Ok(info)
    }

    // -- requests from AI clients ----------------------------------------------

    /// What the secret `name` lacks to be typed as `fields` into `sites`.
    /// Needs no key.
    pub fn missing(
        &self,
        name: &str,
        sites: &[String],
        fields: &[SecretField],
    ) -> Result<Missing, SecretError> {
        Ok(missing_in(&self.read()?, name, sites, fields))
    }

    /// Asks the user (through Studio) to register a login, or to complete
    /// one. A request for a name already asked for is merged into it.
    pub fn request(&self, input: NewSecretRequest) -> Result<SecretRequest, SecretError> {
        secret::check_name(&input.name).map_err(|m| SecretError::new("INVALID_SECRET_NAME", m))?;
        let mut sites = input
            .sites
            .iter()
            .filter(|s| !s.trim().is_empty())
            .map(|s| normalize_site(s))
            .collect::<Result<Vec<_>, _>>()?;
        // The access token comes from oauth.signIn, never from the user.
        let asked: Vec<SecretField> = input
            .fields
            .into_iter()
            .filter(|f| *f != SecretField::AccessToken)
            .collect();
        let mut reason: String = input
            .reason
            .unwrap_or_default()
            .trim()
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(MAX_REASON_LEN)
            .collect();
        let _guard = self.lock()?;
        let mut file = self.read_requests()?;
        let previous = file
            .requests
            .iter()
            .position(|r| r.name == input.name)
            .map(|i| file.requests.remove(i));
        // A saved secret keeps its kind (Studio adds to it as it is); else
        // the kind asked for now, or the one asked for before.
        let saved = self
            .read()?
            .entries
            .iter()
            .find(|e| e.name == input.name)
            .map(|e| self.kind_of(e));
        let kind = saved
            .or(input.kind)
            .or(previous.as_ref().and_then(|old| old.kind));
        let effective = kind.unwrap_or_default();
        let mut fields = if asked.is_empty() {
            effective.default_request_fields()
        } else {
            asked
        };
        if let Some(old) = previous {
            sites = merge(old.sites, sites);
            fields = merge(old.fields, fields);
            if reason.is_empty() {
                reason = old.reason;
            }
        }
        sites = merge(Vec::new(), sites);
        // A field the kind has no place for could never be filled in.
        let usable = effective.fields();
        fields = merge(Vec::new(), fields)
            .into_iter()
            .filter(|f| usable.contains(f))
            .collect();
        if fields.is_empty() && sites.is_empty() {
            fields = effective.default_request_fields();
        }
        let request = SecretRequest {
            name: input.name,
            kind,
            sites,
            fields,
            reason,
            requested_at: now(),
        };
        file.requests.push(request.clone());
        self.write_requests(&file)?;
        Ok(request)
    }

    /// Requests Studio should show, oldest first: those a registered secret
    /// already answers are left out.
    pub fn requests(&self) -> Result<Vec<PendingSecretRequest>, SecretError> {
        let vault = self.read()?;
        Ok(self
            .read_requests()?
            .requests
            .into_iter()
            .filter_map(|request| {
                let missing = missing_in(&vault, &request.name, &request.sites, &request.fields);
                (!missing.is_empty()).then_some(PendingSecretRequest { request, missing })
            })
            .collect())
    }

    /// Whether a request for `name` is still waiting (not dismissed and not
    /// answered by a registration).
    pub fn is_requested(&self, name: &str) -> Result<bool, SecretError> {
        Ok(self.requests()?.iter().any(|r| r.request.name == name))
    }

    /// The user declined a request (or will handle it later). Returns false
    /// when there was none.
    pub fn dismiss_request(&self, name: &str) -> Result<bool, SecretError> {
        let _guard = self.lock()?;
        let mut file = self.read_requests()?;
        let before = file.requests.len();
        file.requests.retain(|r| r.name != name);
        if file.requests.len() == before {
            return Ok(false);
        }
        self.write_requests(&file)?;
        Ok(true)
    }

    /// Drops the requests the registered secrets answer, each checked
    /// against its current (possibly merged) requirements.
    pub fn tidy_requests(&self) -> Result<(), SecretError> {
        let _guard = self.lock()?;
        let vault = self.read()?;
        self.prune_requests(&vault)
    }

    /// Drops the requests `vault` answers. Called with the lock held.
    fn prune_requests(&self, vault: &VaultFile) -> Result<(), SecretError> {
        let mut file = self.read_requests()?;
        let before = file.requests.len();
        file.requests
            .retain(|r| !missing_in(vault, &r.name, &r.sites, &r.fields).is_empty());
        if file.requests.len() != before {
            self.write_requests(&file)?;
        }
        Ok(())
    }

    fn read_requests(&self) -> Result<RequestsFile, SecretError> {
        match std::fs::read(self.dir.join(REQUESTS_FILE)) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| io_error(format!("secrets/{REQUESTS_FILE} is damaged: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RequestsFile {
                version: 1,
                ..RequestsFile::default()
            }),
            Err(e) => Err(io_error(e)),
        }
    }

    fn write_requests(&self, file: &RequestsFile) -> Result<(), SecretError> {
        let file = RequestsFile {
            version: 1,
            requests: file.requests.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(io_error)?;
        write_atomic(&self.dir.join(REQUESTS_FILE), &bytes)
    }

    pub fn remove(&self, name: &str) -> Result<(), SecretError> {
        let _guard = self.lock()?;
        let mut file = self.read()?;
        let before = file.entries.len();
        file.entries.retain(|e| e.name != name);
        if file.entries.len() == before {
            return Err(not_found(name));
        }
        self.write(&file)?;
        // Tokens obtained with the secret's client ID belong to it.
        remove_if_present(&self.oauth_path(name))?;
        Ok(())
    }

    /// Forgets a saved sign-in: the browser login and the OAuth tokens
    /// saved under `name`. False when there was neither.
    pub fn remove_session(&self, name: &str) -> Result<bool, SecretError> {
        let session = remove_if_present(&self.session_path(name))?;
        let tokens = remove_if_present(&self.oauth_path(name))?;
        Ok(session || tokens)
    }

    /// True when secrets are registered but their key is not on this PC /
    /// Windows user (the workspace was copied from elsewhere). The names are
    /// still listed; the values can only be registered again after
    /// [`Vault::reset`].
    pub fn key_missing(&self) -> Result<bool, SecretError> {
        let file = self.read()?;
        Ok(!file.id.is_empty() && self.keys.load(&file.id)?.is_none())
    }

    /// Deletes every secret, every saved login and the key, so secrets can
    /// be registered again (the way out of `SECRET_KEY_MISSING`). Returns
    /// the number of secrets deleted.
    pub fn reset(&self) -> Result<usize, SecretError> {
        let _guard = self.lock()?;
        let file = self.read()?;
        for dir in [SESSIONS_DIR, OAUTH_DIR] {
            match std::fs::remove_dir_all(self.dir.join(dir)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_error(e)),
            }
        }
        self.write(&VaultFile {
            version: 1,
            ..VaultFile::default()
        })?;
        if !file.id.is_empty() {
            self.keys.remove(&file.id)?;
        }
        Ok(file.entries.len())
    }

    // -- storage --------------------------------------------------------------

    /// Serialises read-modify-write of the vault across threads and
    /// processes (Studio, the CLI and the MCP server share a workspace),
    /// including the first-time creation of the key. Released on drop.
    fn lock(&self) -> Result<std::fs::File, SecretError> {
        std::fs::create_dir_all(&self.dir).map_err(io_error)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.dir.join(LOCK_FILE))
            .map_err(io_error)?;
        file.lock().map_err(io_error)?;
        Ok(file)
    }

    fn read(&self) -> Result<VaultFile, SecretError> {
        match std::fs::read(self.dir.join(VAULT_FILE)) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| io_error(format!("secrets/{VAULT_FILE} is damaged: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(VaultFile {
                version: 1,
                ..VaultFile::default()
            }),
            Err(e) => Err(io_error(e)),
        }
    }

    fn write(&self, file: &VaultFile) -> Result<(), SecretError> {
        let bytes = serde_json::to_vec_pretty(file).map_err(io_error)?;
        write_atomic(&self.dir.join(VAULT_FILE), &bytes)
    }

    /// The vault key. With `create`, makes the vault ID and key on first use.
    fn key(&self, file: &VaultFile, create: bool) -> Result<Key, SecretError> {
        if !file.id.is_empty() {
            return self.keys.load(&file.id)?.ok_or_else(|| {
                SecretError::new(
                    "SECRET_KEY_MISSING",
                    "the key of this workspace's secrets is not on this PC / Windows user",
                )
                .with_hint("Secrets are tied to the Windows user that registered them. Ask the user to reset the secrets in Writer (シークレット) or with `spellsheet secret reset`, then register them again.")
            });
        }
        if !create {
            return Err(SecretError::new(
                "SECRET_KEY_MISSING",
                "no secrets registered",
            ));
        }
        let id = uuid::Uuid::now_v7().simple().to_string();
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).map_err(io_error)?;
        self.keys.store(&id, &key)?;
        self.write(&VaultFile {
            version: 1,
            id,
            entries: file.entries.clone(),
        })?;
        Ok(key)
    }

    /// The kind of an entry. Entries written before kinds count as OAuth
    /// apps once `oauth.signIn` saved tokens for them, as logins otherwise.
    fn kind_of(&self, entry: &StoredEntry) -> SecretKind {
        entry.kind.unwrap_or_else(|| {
            if self.oauth_path(&entry.name).is_file() {
                SecretKind::Oauth
            } else {
                SecretKind::Login
            }
        })
    }

    /// What Studio shows about the OAuth tokens of `name`: none when there
    /// are none (or they cannot be read, which means signing in again).
    fn oauth_status(&self, key: &Key, name: &str) -> Option<OAuthStatus> {
        let text = std::fs::read(self.oauth_path(name)).ok()?;
        let sealed: Sealed = serde_json::from_slice(&text).ok()?;
        let plain = unseal(key, &oauth_aad(name), &sealed).ok()?;
        let tokens: Value = serde_json::from_slice(&plain).ok()?;
        let time = |field: &str| {
            tokens
                .get(field)
                .and_then(Value::as_i64)
                .and_then(|secs| OffsetDateTime::from_unix_timestamp(secs).ok())
                .and_then(|at| at.format(&Rfc3339).ok())
        };
        Some(OAuthStatus {
            expires_at: time("expiresAt"),
            obtained_at: time("obtainedAt"),
            refreshable: tokens
                .get("refreshToken")
                .and_then(Value::as_str)
                .is_some_and(|t| !t.is_empty()),
        })
    }

    fn session_path(&self, name: &str) -> PathBuf {
        self.dir.join(SESSIONS_DIR).join(hashed_file(name))
    }

    fn oauth_path(&self, name: &str) -> PathBuf {
        self.dir.join(OAUTH_DIR).join(hashed_file(name))
    }

    /// Reads a file sealed with `aad`; `None` when it is missing, there is
    /// no key, or it cannot be decrypted (saved with another key, damaged).
    fn load_sealed(&self, path: &Path, aad: &[u8]) -> Result<Option<Value>, SecretError> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_error(e)),
        };
        let file = self.read()?;
        let Ok(key) = self.key(&file, false) else {
            return Ok(None);
        };
        let sealed: Sealed = serde_json::from_slice(&bytes).map_err(io_error)?;
        Ok(unseal(&key, aad, &sealed)
            .ok()
            .and_then(|plain| serde_json::from_slice(&plain).ok()))
    }

    fn save_sealed(&self, path: &Path, aad: &[u8], value: &Value) -> Result<(), SecretError> {
        let _guard = self.lock()?;
        let file = self.read()?;
        let key = self.key(&file, true)?;
        let plain = serde_json::to_vec(value).map_err(io_error)?;
        let sealed = seal_bytes(&key, aad, &plain)?;
        let bytes = serde_json::to_vec(&sealed).map_err(io_error)?;
        write_atomic(path, &bytes)
    }
}

fn hashed_file(name: &str) -> String {
    let hash = Sha1::digest(name.as_bytes());
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}.json")
}

fn remove_if_present(path: &Path) -> Result<bool, SecretError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io_error(e)),
    }
}

impl SecretProvider for Vault {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError> {
        let file = self.read()?;
        let entry = file
            .entries
            .iter()
            .find(|e| e.name == reference.secret)
            .ok_or_else(|| not_found(&reference.secret))?;
        let values = self.values(&self.key(&file, false)?, entry)?;
        let missing = || {
            SecretError::new(
                "SECRET_FIELD_EMPTY",
                format!(
                    "secret '{}' has no {}",
                    reference.secret,
                    reference.field.as_str()
                ),
            )
            .with_hint("Call request_secret with this name and the missing field: Writer then asks the user to fill it in. Never ask for it in chat.")
            .with_secret(&reference.secret)
            .with_field(reference.field)
        };
        let value = match reference.field {
            SecretField::AccessToken => {
                return Err(SecretError::new(
                    "SECRET_FIELD_NOT_ALLOWED",
                    "accessToken can only be used as the auth of http.request or in a custom node's secret setting",
                )
                .with_hint("Use { \"secret\": .., \"field\": \"accessToken\" } as http.request auth or in a custom node's secret setting, after oauth.signIn.")
                .with_secret(&reference.secret));
            }
            SecretField::Username => values.username,
            SecretField::Password => values.password,
            SecretField::Totp => {
                let spec = values.totp.ok_or_else(missing)?;
                totp::TotpSpec::parse(&spec)
                    .map_err(|m| SecretError::new("INVALID_TOTP", m))?
                    .code_now()
            }
        };
        if value.is_empty() {
            return Err(missing());
        }
        Ok(ResolvedSecret {
            name: entry.name.clone(),
            field: reference.field,
            value,
            sites: entry.sites.clone(),
        })
    }

    fn load_session(&self, name: &str) -> Result<Option<Value>, SecretError> {
        // A session saved with another key (or damaged) is just a logout.
        self.load_sealed(&self.session_path(name), &session_aad(name))
    }

    fn save_session(&self, name: &str, state: &Value) -> Result<(), SecretError> {
        secret::check_name(name).map_err(|m| SecretError::new("INVALID_SESSION_NAME", m))?;
        self.save_sealed(&self.session_path(name), &session_aad(name), state)
    }

    fn load_oauth_tokens(&self, name: &str) -> Result<Option<Value>, SecretError> {
        // Unreadable tokens just mean signing in again.
        self.load_sealed(&self.oauth_path(name), &oauth_aad(name))
    }

    fn lock_oauth_tokens(&self, name: &str) -> Result<Box<dyn Send>, SecretError> {
        let path = self.oauth_path(name).with_extension("lock");
        std::fs::create_dir_all(self.dir.join(OAUTH_DIR)).map_err(io_error)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(io_error)?;
        file.lock().map_err(io_error)?;
        Ok(Box::new(file))
    }

    fn save_oauth_tokens(&self, name: &str, tokens: &Value) -> Result<(), SecretError> {
        secret::check_name(name).map_err(|m| SecretError::new("INVALID_SECRET_NAME", m))?;
        self.save_sealed(&self.oauth_path(name), &oauth_aad(name), tokens)
    }
}

fn missing_in(vault: &VaultFile, name: &str, sites: &[String], fields: &[SecretField]) -> Missing {
    let Some(entry) = vault.entries.iter().find(|e| e.name == name) else {
        return Missing {
            registered: false,
            fields: fields.to_vec(),
            sites: sites.to_vec(),
        };
    };
    Missing {
        registered: true,
        fields: fields
            .iter()
            .filter(|f| !entry.fields.contains(f))
            .copied()
            .collect(),
        sites: sites
            .iter()
            .filter(|s| !entry.sites.contains(s))
            .cloned()
            .collect(),
    }
}

/// `a` followed by the items of `b` it lacks.
fn merge<T: PartialEq>(mut a: Vec<T>, b: Vec<T>) -> Vec<T> {
    for item in b {
        if !a.contains(&item) {
            a.push(item);
        }
    }
    a
}

/// `https://example.com/login` → `https://example.com` (what browsers call
/// the page's origin). Desktop apps are written `app:<exe name>`
/// (`app:Billing.exe` → `app:billing.exe`), node plugins `plugin:<name>`.
pub fn normalize_site(text: &str) -> Result<String, SecretError> {
    let invalid = || {
        SecretError::new("INVALID_SITE", format!("'{text}' is not a web address"))
            .with_hint("Write the site's address, e.g. https://example.com, app:billing.exe for a desktop app, db:<server> for a database, smtp:<server> for a mail server, or plugin:<name> for a plugin")
    };
    let text = text.trim();
    // A database server as db.* steps name it: the Server, Data Source,
    // DSN or DBQ of the connection string (db01\sqlexpress, 基幹).
    // A mail server as mail.send names it (smtp:smtp.example.co.jp).
    for prefix in ["db:", "smtp:"] {
        if let Some(server) = text.strip_prefix(prefix) {
            let server = server.trim().to_lowercase();
            if server.is_empty() || server.starts_with("//") {
                return Err(invalid());
            }
            return Ok(format!("{prefix}{server}"));
        }
    }
    for prefix in ["app:", "plugin:"] {
        if let Some(name) = text.strip_prefix(prefix) {
            let name = name.trim().to_lowercase();
            if name.is_empty() || name.contains(['\\', '/', ':']) {
                return Err(invalid());
            }
            return Ok(format!("{prefix}{name}"));
        }
    }
    let (scheme, rest) = text.split_once("://").ok_or_else(invalid)?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(invalid());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority
        .rsplit('@')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if host_port.is_empty() || host_port.starts_with(':') {
        return Err(invalid());
    }
    let host_port = match (scheme.as_str(), host_port.rsplit_once(':')) {
        ("https", Some((host, "443"))) | ("http", Some((host, "80"))) => host.to_owned(),
        _ => host_port,
    };
    Ok(format!("{scheme}://{host_port}"))
}

/// The label sealed with every value (AES-GCM associated data):
/// `spellsheet-secret:<name>`, `spellsheet-session:<name>`, ….
const AAD_PREFIX: &str = "spellsheet-";

/// The label's prefix under the product's old name. Values sealed before the
/// rename still open with it, and get the new label when next saved.
fn legacy_aad_prefix() -> String {
    format!(
        "{}-",
        spellsheet_core::paths::LEGACY_APP_DIR.to_ascii_lowercase()
    )
}

fn entry_aad(name: &str) -> Vec<u8> {
    format!("{AAD_PREFIX}secret:{name}").into_bytes()
}

fn session_aad(name: &str) -> Vec<u8> {
    format!("{AAD_PREFIX}session:{name}").into_bytes()
}

fn oauth_aad(name: &str) -> Vec<u8> {
    format!("{AAD_PREFIX}oauth:{name}").into_bytes()
}

fn seal(key: &Key, name: &str, values: &Values) -> Result<Sealed, SecretError> {
    let plain = serde_json::to_vec(values).map_err(io_error)?;
    seal_bytes(key, &entry_aad(name), &plain)
}

fn open(key: &Key, entry: &StoredEntry) -> Result<Values, SecretError> {
    let plain = unseal(key, &entry_aad(&entry.name), &entry.sealed)?;
    serde_json::from_slice(&plain).map_err(io_error)
}

fn seal_bytes(key: &Key, aad: &[u8], plain: &[u8]) -> Result<Sealed, SecretError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(io_error)?;
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(io_error)?;
    let data = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| io_error("encryption failed"))?;
    Ok(Sealed {
        nonce: B64.encode(nonce),
        data: B64.encode(data),
    })
}

fn unseal(key: &Key, aad: &[u8], sealed: &Sealed) -> Result<Vec<u8>, SecretError> {
    unseal_with(key, aad, sealed).or_else(|e| {
        let rest = aad
            .strip_prefix(AAD_PREFIX.as_bytes())
            .ok_or_else(|| e.clone())?;
        let legacy = [legacy_aad_prefix().as_bytes(), rest].concat();
        unseal_with(key, &legacy, sealed).map_err(|_| e)
    })
}

fn unseal_with(key: &Key, aad: &[u8], sealed: &Sealed) -> Result<Vec<u8>, SecretError> {
    let damaged = || {
        SecretError::new(
            "SECRET_DECRYPT_FAILED",
            "a stored secret cannot be decrypted (damaged, or saved with another key)",
        )
        .with_hint("Register the secret again in Writer (シークレット).")
    };
    let cipher = Aes256Gcm::new_from_slice(key).map_err(io_error)?;
    let nonce = B64.decode(&sealed.nonce).map_err(|_| damaged())?;
    let data = B64.decode(&sealed.data).map_err(|_| damaged())?;
    if nonce.len() != 12 {
        return Err(damaged());
    }
    cipher
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &data, aad })
        .map_err(|_| damaged())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), SecretError> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| io_error("invalid path"))?;
    std::fs::create_dir_all(dir).map_err(io_error)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(io_error)?;
    tmp.write_all(bytes).map_err(io_error)?;
    tmp.as_file().sync_all().map_err(io_error)?;
    tmp.persist(path).map_err(|e| io_error(e.error))?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
