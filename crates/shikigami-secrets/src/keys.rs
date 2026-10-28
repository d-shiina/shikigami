//! Where the vault's encryption key is kept.
//!
//! On Windows the key is one generic credential in Windows Credential
//! Manager per workspace ("Shikigami vault <id>"), protected by DPAPI for
//! the signed-in user. Everything else stays in the workspace, so the
//! credential list does not fill up with one entry per secret.

use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use shikigami_core::secret::SecretError;

pub type Key = [u8; 32];

pub trait KeyStore: Send + Sync {
    fn load(&self, vault_id: &str) -> Result<Option<Key>, SecretError>;
    fn store(&self, vault_id: &str, key: &Key) -> Result<(), SecretError>;
    /// Deletes the key; a key that is not there is not an error.
    fn remove(&self, vault_id: &str) -> Result<(), SecretError>;
    /// Shown in Studio and the CLI.
    fn describe(&self) -> String;
}

fn key_error(message: impl Into<String>) -> SecretError {
    SecretError::new("SECRET_KEY_UNAVAILABLE", message)
}

fn decode(text: &str) -> Result<Key, SecretError> {
    B64.decode(text.trim())
        .ok()
        .and_then(|bytes| Key::try_from(bytes.as_slice()).ok())
        .ok_or_else(|| key_error("the stored vault key is damaged"))
}

/// The key store of this platform: Windows Credential Manager on Windows,
/// a key file next to the vault elsewhere (development and CI only).
pub fn platform_key_store(secrets_dir: PathBuf) -> Box<dyn KeyStore> {
    #[cfg(windows)]
    {
        let _ = secrets_dir;
        Box::new(CredentialManager)
    }
    #[cfg(not(windows))]
    {
        Box::new(KeyFile { dir: secrets_dir })
    }
}

#[cfg(windows)]
pub struct CredentialManager;

#[cfg(windows)]
impl CredentialManager {
    fn entry(vault_id: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new("Shikigami", &format!("vault {vault_id}"))
            .map_err(|e| key_error(format!("Windows Credential Manager: {e}")))
    }
}

#[cfg(windows)]
impl KeyStore for CredentialManager {
    fn load(&self, vault_id: &str) -> Result<Option<Key>, SecretError> {
        match Self::entry(vault_id)?.get_password() {
            Ok(text) => decode(&text).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(key_error(format!("Windows Credential Manager: {e}"))),
        }
    }

    fn store(&self, vault_id: &str, key: &Key) -> Result<(), SecretError> {
        Self::entry(vault_id)?
            .set_password(&B64.encode(key))
            .map_err(|e| key_error(format!("Windows Credential Manager: {e}")))
    }

    fn remove(&self, vault_id: &str) -> Result<(), SecretError> {
        match Self::entry(vault_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(key_error(format!("Windows Credential Manager: {e}"))),
        }
    }

    fn describe(&self) -> String {
        "Windows 資格情報マネージャー".into()
    }
}

/// Key in a file readable only by the current user. Not a protection on its
/// own: used on non-Windows development machines and CI.
#[cfg(not(windows))]
pub struct KeyFile {
    dir: PathBuf,
}

#[cfg(not(windows))]
impl KeyStore for KeyFile {
    fn load(&self, vault_id: &str) -> Result<Option<Key>, SecretError> {
        match std::fs::read_to_string(self.dir.join(format!("{vault_id}.key"))) {
            Ok(text) => decode(&text).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(key_error(e.to_string())),
        }
    }

    fn store(&self, vault_id: &str, key: &Key) -> Result<(), SecretError> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::create_dir_all(&self.dir).map_err(|e| key_error(e.to_string()))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(self.dir.join(format!("{vault_id}.key")))
            .map_err(|e| key_error(e.to_string()))?;
        file.write_all(B64.encode(key).as_bytes())
            .map_err(|e| key_error(e.to_string()))
    }

    fn remove(&self, vault_id: &str) -> Result<(), SecretError> {
        match std::fs::remove_file(self.dir.join(format!("{vault_id}.key"))) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(key_error(e.to_string())),
            _ => Ok(()),
        }
    }

    fn describe(&self) -> String {
        "鍵ファイル（開発用。Windows では資格情報マネージャー）".into()
    }
}

/// Keys in memory, for tests.
#[derive(Default)]
pub struct MemoryKeyStore {
    keys: Mutex<std::collections::HashMap<String, Key>>,
}

impl KeyStore for MemoryKeyStore {
    fn load(&self, vault_id: &str) -> Result<Option<Key>, SecretError> {
        Ok(self
            .keys
            .lock()
            .map_err(|_| key_error("poisoned"))?
            .get(vault_id)
            .copied())
    }

    fn store(&self, vault_id: &str, key: &Key) -> Result<(), SecretError> {
        self.keys
            .lock()
            .map_err(|_| key_error("poisoned"))?
            .insert(vault_id.to_owned(), *key);
        Ok(())
    }

    fn remove(&self, vault_id: &str) -> Result<(), SecretError> {
        self.keys
            .lock()
            .map_err(|_| key_error("poisoned"))?
            .remove(vault_id);
        Ok(())
    }

    fn describe(&self) -> String {
        "memory".into()
    }
}
