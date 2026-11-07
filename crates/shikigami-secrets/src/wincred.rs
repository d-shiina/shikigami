//! Logins kept in Windows Credential Manager (資格情報マネージャー).
//!
//! A secret can point at a generic credential there instead of holding the
//! values itself: the user name and password are read each time a flow uses
//! them, so a password changed in Credential Manager (by the person or by
//! the company's tools) is the one the next run types. Only generic
//! credentials (「Windows 資格情報」の「汎用資格情報」) can be read: Windows
//! never hands out the password of a domain credential to programs.

// Credential Manager is a C API: the calls and the structures it returns
// are unsafe, and kept to this module.
#![allow(unsafe_code)]

use std::sync::Mutex;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use shikigami_core::secret::SecretError;

/// One credential as read from the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsLogin {
    pub username: String,
    pub password: String,
}

/// A credential Studio offers to pick (never its password).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WindowsCredentialInfo {
    /// The credential's address (TargetName), what a secret names.
    pub target: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
}

pub trait WindowsCredentials: Send + Sync {
    /// The generic credential named `target`; none when there is none.
    fn read(&self, target: &str) -> Result<Option<WindowsLogin>, SecretError>;
    /// The generic credentials of the signed-in user.
    fn list(&self) -> Result<Vec<WindowsCredentialInfo>, SecretError>;
}

#[cfg(not(windows))]
fn unavailable() -> SecretError {
    SecretError::new(
        "WINDOWS_CREDENTIAL_UNAVAILABLE",
        "Windows Credential Manager can only be read on Windows",
    )
}

/// The store of this platform: Credential Manager on Windows, none elsewhere.
pub fn platform_windows_credentials() -> Box<dyn WindowsCredentials> {
    #[cfg(windows)]
    {
        Box::new(CredentialManager)
    }
    #[cfg(not(windows))]
    {
        Box::new(NoCredentials)
    }
}

#[cfg(not(windows))]
struct NoCredentials;

#[cfg(not(windows))]
impl WindowsCredentials for NoCredentials {
    fn read(&self, _target: &str) -> Result<Option<WindowsLogin>, SecretError> {
        Err(unavailable())
    }

    fn list(&self) -> Result<Vec<WindowsCredentialInfo>, SecretError> {
        Ok(Vec::new())
    }
}

/// A credential's password as text. The bytes alone cannot tell UTF-16
/// from UTF-8 (あいう in UTF-16 is the same bytes as "B0D0F0"), so the rule
/// is fixed: UTF-16LE, which Windows' own dialogs, cmdkey and PowerShell
/// write; UTF-8 only when the bytes cannot be UTF-16 (an odd length or a
/// broken surrogate pair). A NUL terminator some programs store is dropped.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub(crate) fn blob_text(blob: &[u8]) -> Option<String> {
    if blob.len().is_multiple_of(2) {
        let units: Vec<u16> = blob
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        if let Ok(text) = String::from_utf16(&units) {
            let text = text.trim_end_matches('\0');
            if !text.contains('\0') {
                return Some(text.to_owned());
            }
        }
    }
    std::str::from_utf8(blob)
        .ok()
        .map(|t| t.trim_end_matches('\0').to_owned())
        .filter(|t| !t.contains('\0'))
}

#[cfg(windows)]
struct CredentialManager;

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
unsafe fn pwstr(p: windows::core::PWSTR) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { p.to_string() }.unwrap_or_default()
    }
}

#[cfg(windows)]
impl WindowsCredentials for CredentialManager {
    fn read(&self, target: &str) -> Result<Option<WindowsLogin>, SecretError> {
        use windows::Win32::Foundation::ERROR_NOT_FOUND;
        use windows::Win32::Security::Credentials::{
            CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
        };
        use windows::core::PCWSTR;

        let name = wide(target);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `name` is NUL-terminated and outlives the call; `cred` is
        // freed with CredFree below.
        let read = unsafe { CredReadW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None, &mut cred) };
        if let Err(e) = read {
            if e.code() == ERROR_NOT_FOUND.to_hresult() {
                return Ok(None);
            }
            return Err(SecretError::new(
                "WINDOWS_CREDENTIAL_UNAVAILABLE",
                format!("Windows Credential Manager: {e}"),
            ));
        }
        // SAFETY: CredReadW succeeded, so `cred` points at a CREDENTIALW
        // whose blob has CredentialBlobSize bytes.
        let login = unsafe {
            let c = &*cred;
            let blob = if c.CredentialBlob.is_null() {
                &[][..]
            } else {
                std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
            };
            let password = blob_text(blob);
            let username = pwstr(c.UserName);
            CredFree(cred as *const _);
            password.map(|password| WindowsLogin { username, password })
        };
        login.map(Some).ok_or_else(|| {
            SecretError::new(
                "WINDOWS_CREDENTIAL_UNREADABLE",
                format!("the password of the Windows credential '{target}' is not text"),
            )
        })
    }

    fn list(&self) -> Result<Vec<WindowsCredentialInfo>, SecretError> {
        use windows::Win32::Security::Credentials::{
            CRED_TYPE_GENERIC, CREDENTIALW, CredEnumerateW, CredFree,
        };
        use windows::core::PCWSTR;

        let mut count = 0u32;
        let mut creds: *mut *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: out pointers are valid; the array is freed below.
        if unsafe { CredEnumerateW(PCWSTR::null(), None, &mut count, &mut creds) }.is_err() {
            // ERROR_NOT_FOUND: the user has none.
            return Ok(Vec::new());
        }
        let mut list = Vec::new();
        // SAFETY: CredEnumerateW gave `count` valid pointers.
        unsafe {
            for c in std::slice::from_raw_parts(creds, count as usize) {
                let c = &**c;
                if c.Type != CRED_TYPE_GENERIC {
                    continue;
                }
                let target = pwstr(c.TargetName);
                // Windows' and other programs' own entries are noise to
                // the person picking a login.
                if target.is_empty() || target.starts_with("Shikigami") {
                    continue;
                }
                list.push(WindowsCredentialInfo {
                    target,
                    username: pwstr(c.UserName),
                });
            }
            CredFree(creds as *const _);
        }
        list.sort_by_key(|a| a.target.to_lowercase());
        Ok(list)
    }
}

/// Credentials in memory, for tests.
#[derive(Default)]
pub struct MemoryWindowsCredentials {
    logins: Mutex<std::collections::BTreeMap<String, WindowsLogin>>,
}

impl MemoryWindowsCredentials {
    pub fn put(&self, target: &str, username: &str, password: &str) {
        if let Ok(mut logins) = self.logins.lock() {
            logins.insert(
                target.to_owned(),
                WindowsLogin {
                    username: username.to_owned(),
                    password: password.to_owned(),
                },
            );
        }
    }
}

#[cfg(test)]
impl MemoryWindowsCredentials {
    pub(crate) fn logins_for_test(
        &self,
    ) -> std::sync::MutexGuard<'_, std::collections::BTreeMap<String, WindowsLogin>> {
        self.logins.lock().unwrap()
    }
}

impl WindowsCredentials for MemoryWindowsCredentials {
    fn read(&self, target: &str) -> Result<Option<WindowsLogin>, SecretError> {
        Ok(self.logins.lock().ok().and_then(|l| l.get(target).cloned()))
    }

    fn list(&self) -> Result<Vec<WindowsCredentialInfo>, SecretError> {
        Ok(self
            .logins
            .lock()
            .map(|l| {
                l.iter()
                    .map(|(target, login)| WindowsCredentialInfo {
                        target: target.clone(),
                        username: login.username.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
}

impl<T: WindowsCredentials + ?Sized> WindowsCredentials for std::sync::Arc<T> {
    fn read(&self, target: &str) -> Result<Option<WindowsLogin>, SecretError> {
        (**self).read(target)
    }

    fn list(&self) -> Result<Vec<WindowsCredentialInfo>, SecretError> {
        (**self).list()
    }
}
