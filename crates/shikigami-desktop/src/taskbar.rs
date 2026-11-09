//! Which taskbar button and Start menu entry a window belongs to: its
//! AppUserModelID. Writer and Runner are one exe, so Runner's window and
//! shortcut get an ID of their own (Writer's with `.runner` after it) and
//! the process gets Writer's, so each shows as its own app.
//!
//! Elsewhere than Windows these do nothing.

#![allow(unsafe_code)]

/// Gives the whole process `app_id`: its windows go under that taskbar
/// button unless a window says otherwise. Call before any window shows.
pub fn claim_process(app_id: &str) -> Result<(), String> {
    imp::claim_process(app_id)
}

/// Gives the window `hwnd` its own taskbar button under `app_id`. Pinning it
/// runs `relaunch` (a command line) and names the pin `display_name`. Call
/// on the window's own thread, best before it first shows.
pub fn own_button(
    hwnd: isize,
    app_id: &str,
    relaunch: &str,
    display_name: &str,
) -> Result<(), String> {
    imp::own_button(hwnd, app_id, relaunch, display_name)
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Storage::EnhancedStorage::{
        PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand,
        PKEY_AppUserModel_RelaunchDisplayNameResource,
    };
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, SHGetPropertyStoreForWindow,
    };
    use windows::Win32::UI::Shell::{SHStrDupW, SetCurrentProcessExplicitAppUserModelID};
    use windows::core::HSTRING;

    pub(super) fn claim_process(app_id: &str) -> Result<(), String> {
        // SAFETY: a plain call with a valid string.
        unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id)) }
            .map_err(|e| e.to_string())
    }

    pub(super) fn own_button(
        hwnd: isize,
        app_id: &str,
        relaunch: &str,
        display_name: &str,
    ) -> Result<(), String> {
        set(HWND(hwnd as *mut _), app_id, relaunch, display_name).map_err(|e| e.to_string())
    }

    fn set(
        hwnd: HWND,
        app_id: &str,
        relaunch: &str,
        display_name: &str,
    ) -> windows::core::Result<()> {
        // SAFETY: the caller passes a live top-level window of this process.
        let store: IPropertyStore = unsafe { SHGetPropertyStoreForWindow(hwnd)? };
        // The relaunch values first: the shell reads them when the ID is set.
        // SAFETY: the keys and values live across each call.
        unsafe {
            store.SetValue(&PKEY_AppUserModel_RelaunchCommand, &text(relaunch)?)?;
            store.SetValue(
                &PKEY_AppUserModel_RelaunchDisplayNameResource,
                &text(display_name)?,
            )?;
            store.SetValue(&PKEY_AppUserModel_ID, &text(app_id)?)?;
            store.Commit()
        }
    }

    /// A VT_LPWSTR value, as these properties want (InitPropVariantFromString
    /// in C, which is only a header inline). Dropping it frees the copy.
    fn text(value: &str) -> windows::core::Result<PROPVARIANT> {
        // SAFETY: SHStrDupW copies into CoTaskMem, which PROPVARIANT's drop
        // (PropVariantClear) frees for VT_LPWSTR.
        let copy = unsafe { SHStrDupW(&HSTRING::from(value))? };
        let mut v = PROPVARIANT::default();
        // SAFETY: a fresh VT_EMPTY value; vt and the pointer are set together.
        unsafe {
            let inner = &mut *v.Anonymous.Anonymous;
            inner.vt = VT_LPWSTR;
            inner.Anonymous.pwszVal = copy;
        }
        Ok(v)
    }
}

#[cfg(not(windows))]
mod imp {
    pub(super) fn claim_process(_app_id: &str) -> Result<(), String> {
        Ok(())
    }

    pub(super) fn own_button(
        _hwnd: isize,
        _app_id: &str,
        _relaunch: &str,
        _display_name: &str,
    ) -> Result<(), String> {
        Ok(())
    }
}
