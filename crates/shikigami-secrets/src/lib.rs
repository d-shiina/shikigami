//! The workspace secret vault.
//!
//! ```text
//! <workspace>/secrets/vault.json            names, sites and encrypted values
//! <workspace>/secrets/sessions/<hash>.json  saved browser logins (encrypted)
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
use std::sync::Mutex;

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

/// The secrets of one workspace.
pub struct Vault {
    dir: PathBuf,
    keys: Box<dyn KeyStore>,
    // Serialises read-modify-write within this process.
    lock: Mutex<()>,
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
            lock: Mutex::new(()),
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

    /// Registers a new secret or updates one (fields left `None` are kept).
    pub fn set(&self, input: SecretInput) -> Result<SecretInfo, SecretError> {
        let _guard = self.lock.lock().map_err(io_error)?;
        secret::check_name(&input.name).map_err(|m| SecretError::new("INVALID_SECRET_NAME", m))?;
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
        Ok(info)
    }

    pub fn remove(&self, name: &str) -> Result<(), SecretError> {
        let _guard = self.lock.lock().map_err(io_error)?;
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

    // -- storage --------------------------------------------------------------

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
                .with_hint("Secrets are tied to the Windows user that registered them. Register them again in Studio (シークレット).")
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
            .with_hint("Ask the user to fill it in Studio (シークレット).")
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
        let _guard = self.lock.lock().map_err(io_error)?;
        let file = self.read()?;
        let key = self.key(&file, true)?;
        let plain = serde_json::to_vec(state).map_err(io_error)?;
        let sealed = seal_bytes(&key, &session_aad(name), &plain)?;
        let bytes = serde_json::to_vec(&sealed).map_err(io_error)?;
        write_atomic(&self.session_path(name), &bytes)
    }
}

/// `https://example.com/login` → `https://example.com` (what browsers call
/// the page's origin).
pub fn normalize_site(text: &str) -> Result<String, SecretError> {
    let invalid = || {
        SecretError::new("INVALID_SITE", format!("'{text}' is not a web address"))
            .with_hint("Write the site's address, e.g. https://example.com")
    };
    let text = text.trim();
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
