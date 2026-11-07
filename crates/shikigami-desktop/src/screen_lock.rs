//! When this PC locks its screen by itself after no one has touched it:
//! a password-protected screen saver or the policy "Interactive logon:
//! Machine inactivity limit". Shikigami leaves both alone (they are the
//! company's security settings) but says beforehand that desktop flows will
//! stop there (docs/design/locked-runs.md).

use serde::Serialize;

/// What locks the screen, and after how long without input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenLock {
    pub after_secs: u64,
    pub by: LockBy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LockBy {
    /// A screen saver that asks for the password when it ends.
    ScreenSaver,
    /// The machine inactivity limit set by policy.
    InactivityLimit,
}

/// One set of screen saver values (`Control Panel\Desktop`), as Windows
/// keeps them: strings, missing when not set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SaverValues {
    pub active: Option<String>,
    pub secure: Option<String>,
    pub timeout: Option<String>,
    pub program: Option<String>,
}

/// What [`soonest`] reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LockSettings {
    /// The user's own choice.
    pub user: SaverValues,
    /// Set by group policy: each value wins over the user's.
    pub policy: SaverValues,
    /// `InactivityTimeoutSecs`; 0 or missing is off.
    pub inactivity_secs: Option<u32>,
}

/// The lock that comes first, if any.
pub fn soonest(settings: &LockSettings) -> Option<ScreenLock> {
    let pick = |f: fn(&SaverValues) -> &Option<String>| {
        f(&settings.policy)
            .as_deref()
            .or(f(&settings.user).as_deref())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let saver = (pick(|v| &v.active) == Some("1")
        && pick(|v| &v.secure) == Some("1")
        && pick(|v| &v.program).is_some())
    .then(|| pick(|v| &v.timeout)?.parse::<u64>().ok())
    .flatten()
    .filter(|&secs| secs > 0)
    .map(|after_secs| ScreenLock {
        after_secs,
        by: LockBy::ScreenSaver,
    });
    let limit = settings
        .inactivity_secs
        .filter(|&secs| secs > 0)
        .map(|secs| ScreenLock {
            after_secs: u64::from(secs),
            by: LockBy::InactivityLimit,
        });
    [saver, limit]
        .into_iter()
        .flatten()
        .min_by_key(|l| l.after_secs)
}

/// This PC's lock after no input, read from the registry now.
#[cfg(windows)]
pub fn current() -> Option<ScreenLock> {
    soonest(&read::settings())
}

/// Not on Windows: nothing locks.
#[cfg(not(windows))]
pub fn current() -> Option<ScreenLock> {
    None
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod read {
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW,
    };
    use windows::core::HSTRING;

    use super::{LockSettings, SaverValues};

    fn text(root: HKEY, key: &str, name: &str) -> Option<String> {
        let mut buf = [0u16; 520];
        let mut size = u32::try_from(std::mem::size_of_val(&buf)).ok()?;
        // SAFETY: the buffer and its size outlive the call that fills them.
        let read = unsafe {
            RegGetValueW(
                root,
                &HSTRING::from(key),
                &HSTRING::from(name),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if read.is_err() {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    fn number(root: HKEY, key: &str, name: &str) -> Option<u32> {
        let mut value = 0u32;
        let mut size = u32::try_from(std::mem::size_of::<u32>()).ok()?;
        // SAFETY: as above.
        let read = unsafe {
            RegGetValueW(
                root,
                &HSTRING::from(key),
                &HSTRING::from(name),
                RRF_RT_REG_DWORD,
                None,
                Some((&raw mut value).cast()),
                Some(&mut size),
            )
        };
        read.is_ok().then_some(value)
    }

    fn saver(key: &str) -> SaverValues {
        SaverValues {
            active: text(HKEY_CURRENT_USER, key, "ScreenSaveActive"),
            secure: text(HKEY_CURRENT_USER, key, "ScreenSaverIsSecure"),
            timeout: text(HKEY_CURRENT_USER, key, "ScreenSaveTimeOut"),
            program: text(HKEY_CURRENT_USER, key, "SCRNSAVE.EXE"),
        }
    }

    pub(super) fn settings() -> LockSettings {
        LockSettings {
            user: saver(r"Control Panel\Desktop"),
            policy: saver(r"Software\Policies\Microsoft\Windows\Control Panel\Desktop"),
            inactivity_secs: number(
                HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System",
                "InactivityTimeoutSecs",
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(timeout: &str) -> SaverValues {
        SaverValues {
            active: Some("1".into()),
            secure: Some("1".into()),
            timeout: Some(timeout.into()),
            program: Some(r"C:\Windows\system32\scrnsave.scr".into()),
        }
    }

    #[test]
    fn nothing_set_never_locks() {
        assert_eq!(soonest(&LockSettings::default()), None);
    }

    #[test]
    fn a_screen_saver_locks_only_with_the_password_and_a_program() {
        let lock = |user: SaverValues| {
            soonest(&LockSettings {
                user,
                ..LockSettings::default()
            })
        };
        assert_eq!(
            lock(on("600")),
            Some(ScreenLock {
                after_secs: 600,
                by: LockBy::ScreenSaver
            })
        );
        let mut no_password = on("600");
        no_password.secure = Some("0".into());
        assert_eq!(lock(no_password), None);
        let mut no_program = on("600");
        no_program.program = Some(String::new());
        assert_eq!(lock(no_program), None);
        assert_eq!(lock(on("0")), None);
    }

    #[test]
    fn policy_values_win_and_the_sooner_lock_counts() {
        let settings = LockSettings {
            user: on("1800"),
            policy: SaverValues {
                timeout: Some("900".into()),
                ..SaverValues::default()
            },
            inactivity_secs: Some(1200),
        };
        assert_eq!(
            soonest(&settings),
            Some(ScreenLock {
                after_secs: 900,
                by: LockBy::ScreenSaver
            })
        );
        let settings = LockSettings {
            policy: SaverValues {
                active: Some("0".into()),
                ..SaverValues::default()
            },
            ..settings
        };
        assert_eq!(
            soonest(&settings),
            Some(ScreenLock {
                after_secs: 1200,
                by: LockBy::InactivityLimit
            })
        );
    }
}
