//! API keys for the AI that Writer's chat runs (e.g. a Gemini API key).
//!
//! Not in the workspace vault: the vault holds what flows type into sites,
//! and its names are shown to the AI. An AI's own key belongs to the person
//! on this PC, not to a workspace, so it is one generic credential in
//! Windows Credential Manager per AI ("SpellSheet" / "ai <name>"),
//! protected by DPAPI for the signed-in user.

use std::path::PathBuf;
use std::sync::Mutex;

use spellsheet_core::secret::SecretError;

fn key_error(message: impl Into<String>) -> SecretError {
    SecretError::new("SECRET_KEY_UNAVAILABLE", message)
}

pub trait ApiKeys: Send + Sync {
    fn load(&self, name: &str) -> Result<Option<String>, SecretError>;
    fn store(&self, name: &str, key: &str) -> Result<(), SecretError>;
    /// Deletes the key; a key that is not there is not an error.
    fn remove(&self, name: &str) -> Result<(), SecretError>;
}

/// Windows Credential Manager on Windows; elsewhere (development and CI
/// only) a file readable only by the current user in `dir`.
pub fn platform_api_keys(dir: PathBuf) -> Box<dyn ApiKeys> {
    #[cfg(windows)]
    {
        let _ = dir;
        Box::new(CredentialApiKeys)
    }
    #[cfg(not(windows))]
    {
        Box::new(FileApiKeys { dir })
    }
}

#[cfg(windows)]
struct CredentialApiKeys;

#[cfg(windows)]
impl CredentialApiKeys {
    fn entry(name: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new("SpellSheet", &format!("ai {name}"))
            .map_err(|e| key_error(format!("Windows Credential Manager: {e}")))
    }
}

#[cfg(windows)]
impl ApiKeys for CredentialApiKeys {
    fn load(&self, name: &str) -> Result<Option<String>, SecretError> {
        match Self::entry(name)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(key_error(format!("Windows Credential Manager: {e}"))),
        }
    }

    fn store(&self, name: &str, key: &str) -> Result<(), SecretError> {
        Self::entry(name)?
            .set_password(key)
            .map_err(|e| key_error(format!("Windows Credential Manager: {e}")))
    }

    fn remove(&self, name: &str) -> Result<(), SecretError> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(key_error(format!("Windows Credential Manager: {e}"))),
        }
    }
}

#[cfg(not(windows))]
struct FileApiKeys {
    dir: PathBuf,
}

#[cfg(not(windows))]
impl FileApiKeys {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("ai-{name}.key"))
    }
}

#[cfg(not(windows))]
impl ApiKeys for FileApiKeys {
    fn load(&self, name: &str) -> Result<Option<String>, SecretError> {
        match std::fs::read_to_string(self.path(name)) {
            Ok(key) => Ok(Some(key.trim().to_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(key_error(e.to_string())),
        }
    }

    fn store(&self, name: &str, key: &str) -> Result<(), SecretError> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::create_dir_all(&self.dir).map_err(|e| key_error(e.to_string()))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(self.path(name))
            .map_err(|e| key_error(e.to_string()))?;
        file.write_all(key.as_bytes())
            .map_err(|e| key_error(e.to_string()))
    }

    fn remove(&self, name: &str) -> Result<(), SecretError> {
        match std::fs::remove_file(self.path(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(key_error(e.to_string())),
            _ => Ok(()),
        }
    }
}

/// Keys in memory, for tests.
#[derive(Default)]
pub struct MemoryApiKeys {
    keys: Mutex<std::collections::HashMap<String, String>>,
}

impl ApiKeys for MemoryApiKeys {
    fn load(&self, name: &str) -> Result<Option<String>, SecretError> {
        Ok(self
            .keys
            .lock()
            .map_err(|_| key_error("poisoned"))?
            .get(name)
            .cloned())
    }

    fn store(&self, name: &str, key: &str) -> Result<(), SecretError> {
        self.keys
            .lock()
            .map_err(|_| key_error("poisoned"))?
            .insert(name.to_owned(), key.to_owned());
        Ok(())
    }

    fn remove(&self, name: &str) -> Result<(), SecretError> {
        self.keys
            .lock()
            .map_err(|_| key_error("poisoned"))?
            .remove(name);
        Ok(())
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn a_key_file_is_kept_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let keys = platform_api_keys(dir.path().to_path_buf());
        assert_eq!(keys.load("gemini").unwrap(), None);
        keys.store("gemini", "AIza-test").unwrap();
        assert_eq!(keys.load("gemini").unwrap().as_deref(), Some("AIza-test"));
        keys.remove("gemini").unwrap();
        keys.remove("gemini").unwrap();
        assert_eq!(keys.load("gemini").unwrap(), None);
    }
}
