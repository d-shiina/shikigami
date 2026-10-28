//! The workspace secret vault.
//!
//! ```text
//! <workspace>/secrets/vault.json            names, sites and encrypted values
//! <workspace>/secrets/sessions/<hash>.json  saved browser logins (encrypted)
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

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use shikigami_core::secret::{
    self, REGISTER_HINT, ResolvedSecret, SecretError, SecretField, SecretProvider, SecretRef,
};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub use keys::{Key, KeyStore, MemoryKeyStore, platform_key_store};

const VAULT_FILE: &str = "vault.json";
const SESSIONS_DIR: &str = "sessions";
const LOCK_FILE: &str = ".lock";
const REQUESTS_FILE: &str = "requests.json";
/// Longest `reason` kept on a [`SecretRequest`].
const MAX_REASON_LEN: usize = 300;

/// A secret as Studio and the CLI list it (no password or TOTP key).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub name: String,
    pub username: String,
    /// Origins the secret may be typed into, e.g. `https://example.com`.
    pub sites: Vec<String>,
    /// Fields that have a value.
    pub fields: Vec<SecretField>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub updated_at: String,
}

/// What AI clients may know about a secret: everything except the values
/// (and the user name).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretSummary {
    pub name: String,
    pub sites: Vec<String>,
    pub fields: Vec<SecretField>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

/// Registers or updates a secret. `None` keeps the stored value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretInput {
    pub name: String,
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
}

/// A login an AI client asked the user to register in Studio, or to
/// complete (a missing field or site). Holds names and sites only: the user
/// types the values in Studio, so they never pass through the AI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequest {
    pub name: String,
    /// Origins (or `app:<exe>`) the secret should be typed into.
    pub sites: Vec<String>,
    pub fields: Vec<SecretField>,
    /// Why the AI needs it, shown to the user. Written by the AI: Studio
    /// shows it as the AI's words, never as an instruction from Shikigami.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    pub requested_at: String,
}

/// Asks the user for a login (see [`Vault::request`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewSecretRequest {
    pub name: String,
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
    sites: Vec<String>,
    fields: Vec<SecretField>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
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
        }
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
                let values = open(&key, entry)?;
                Ok(SecretInfo {
                    name: entry.name.clone(),
                    username: values.username,
                    sites: entry.sites.clone(),
                    fields: entry.fields.clone(),
                    description: entry.description.clone(),
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
                name: e.name,
                sites: e.sites,
                fields: e.fields,
                description: e.description,
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
            .filter_map(|e| open(&key, e).ok())
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
        let (mut values, mut sites, mut description) = match existing {
            Some(i) => {
                let e = &file.entries[i];
                (open(&key, e)?, e.sites.clone(), e.description.clone())
            }
            None => (Values::default(), Vec::new(), String::new()),
        };
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
        let mut fields = Vec::new();
        if !values.username.is_empty() {
            fields.push(SecretField::Username);
        }
        if !values.password.is_empty() {
            fields.push(SecretField::Password);
        }
        if values.totp.is_some() {
            fields.push(SecretField::Totp);
        }
        let entry = StoredEntry {
            sealed: seal(&key, &input.name, &values)?,
            name: input.name.clone(),
            sites: sites.clone(),
            fields: fields.clone(),
            description: description.clone(),
            updated_at: now(),
        };
        let info = SecretInfo {
            name: entry.name.clone(),
            username: values.username,
            sites,
            fields,
            description,
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
        let mut fields = if input.fields.is_empty() {
            vec![SecretField::Username, SecretField::Password]
        } else {
            input.fields
        };
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
        let previous = file.requests.iter().position(|r| r.name == input.name);
        if let Some(i) = previous {
            let old = file.requests.remove(i);
            sites = merge(old.sites, sites);
            fields = merge(old.fields, fields);
            if reason.is_empty() {
                reason = old.reason;
            }
        }
        sites = merge(Vec::new(), sites);
        fields = merge(Vec::new(), fields);
        let request = SecretRequest {
            name: input.name,
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
        self.write(&file)
    }

    /// Forgets a saved browser login.
    pub fn remove_session(&self, name: &str) -> Result<bool, SecretError> {
        match std::fs::remove_file(self.session_path(name)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(io_error(e)),
        }
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
        match std::fs::remove_dir_all(self.dir.join(SESSIONS_DIR)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(e)),
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
                .with_hint("Secrets are tied to the Windows user that registered them. Ask the user to reset the secrets in Studio (シークレット) or with `shikigami secret reset`, then register them again.")
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

    fn session_path(&self, name: &str) -> PathBuf {
        let hash = Sha1::digest(name.as_bytes());
        let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        self.dir.join(SESSIONS_DIR).join(format!("{hex}.json"))
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
        let values = open(&self.key(&file, false)?, entry)?;
        let missing = || {
            SecretError::new(
                "SECRET_FIELD_EMPTY",
                format!(
                    "secret '{}' has no {}",
                    reference.secret,
                    reference.field.as_str()
                ),
            )
            .with_hint("Call request_secret with this name and the missing field: Studio then asks the user to fill it in. Never ask for it in chat.")
            .with_secret(&reference.secret)
        };
        let value = match reference.field {
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
        let bytes = match std::fs::read(self.session_path(name)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_error(e)),
        };
        let file = self.read()?;
        let Ok(key) = self.key(&file, false) else {
            return Ok(None);
        };
        let sealed: Sealed = serde_json::from_slice(&bytes).map_err(io_error)?;
        // A session saved with another key (or damaged) is just a logout.
        Ok(unseal(&key, &session_aad(name), &sealed)
            .ok()
            .and_then(|plain| serde_json::from_slice(&plain).ok()))
    }

    fn save_session(&self, name: &str, state: &Value) -> Result<(), SecretError> {
        secret::check_name(name).map_err(|m| SecretError::new("INVALID_SESSION_NAME", m))?;
        let _guard = self.lock()?;
        let file = self.read()?;
        let key = self.key(&file, true)?;
        let plain = serde_json::to_vec(state).map_err(io_error)?;
        let sealed = seal_bytes(&key, &session_aad(name), &plain)?;
        let bytes = serde_json::to_vec(&sealed).map_err(io_error)?;
        write_atomic(&self.session_path(name), &bytes)
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
/// (`app:Billing.exe` → `app:billing.exe`).
pub fn normalize_site(text: &str) -> Result<String, SecretError> {
    let invalid = || {
        SecretError::new("INVALID_SITE", format!("'{text}' is not a web address"))
            .with_hint("Write the site's address, e.g. https://example.com, or app:billing.exe for a desktop app")
    };
    let text = text.trim();
    if let Some(app) = text.strip_prefix("app:") {
        let app = app.trim().to_lowercase();
        if app.is_empty() || app.contains(['\\', '/', ':']) {
            return Err(invalid());
        }
        return Ok(format!("app:{app}"));
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

fn entry_aad(name: &str) -> Vec<u8> {
    format!("shikigami-secret:{name}").into_bytes()
}

fn session_aad(name: &str) -> Vec<u8> {
    format!("shikigami-session:{name}").into_bytes()
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
    let damaged = || {
        SecretError::new(
            "SECRET_DECRYPT_FAILED",
            "a stored secret cannot be decrypted (damaged, or saved with another key)",
        )
        .with_hint("Register the secret again in Studio (シークレット).")
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
