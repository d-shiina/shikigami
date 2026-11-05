//! `IDispatch` calls and the apartment thread they run on.
//!
//! This is the only module that may use `unsafe` (every COM call).

#![allow(unsafe_code)]

use std::mem::ManuallyDrop;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use shikigami_runtime::StepError;
use tokio_util::sync::CancellationToken;
use windows::Win32::Foundation::{CloseHandle, HWND, VARIANT_FALSE, VARIANT_TRUE};
use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, CLSIDFromProgID, COINIT_APARTMENTTHREADED, CoCreateInstance,
    CoInitializeEx, CoUninitialize, DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET,
    DISPATCH_PROPERTYPUT, DISPPARAMS, EXCEPINFO, IDispatch,
};
use windows::Win32::System::Ole::DISPID_PROPERTYPUT;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
use windows::Win32::System::Variant::{
    VAR_CHANGE_FLAGS, VARENUM, VARIANT, VARIANT_0_0_0, VT_BOOL, VT_BSTR, VT_DATE, VT_DISPATCH,
    VT_EMPTY, VT_I4, VT_I8, VT_NULL, VT_R8, VariantChangeType, VariantClear,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use windows::core::{BSTR, GUID, HSTRING, PCWSTR};

const LOCALE_USER_DEFAULT: u32 = 0x0400;
const POLL: Duration = Duration::from_millis(200);

/// How a wait on the apartment thread ended early.
pub enum GaveUp {
    TimedOut,
    Cancelled,
}

/// What `work` gets from [`run_on_sta`]: where to report the app's process
/// and whether the wait has given up on it.
pub struct Session {
    pid: mpsc::Sender<u32>,
    abandoned: Arc<AtomicBool>,
}

impl Session {
    /// Reports the process of the app `work` drives, for `give_up`.
    pub fn report_process(&self, pid: u32) {
        let _ = self.pid.send(pid);
    }

    /// Fails once the wait has given up (the step's error is already
    /// reported, so this one is never seen). Call it before each change
    /// to the outside world, so a session that outlives its step (an app
    /// that was still starting) does nothing.
    pub fn check(&self) -> Result<(), StepError> {
        if self.abandoned.load(Ordering::SeqCst) {
            return Err(StepError::new("CANCELLED", "the step was stopped"));
        }
        Ok(())
    }
}

/// Runs `work` on a new single-threaded apartment thread and waits for it
/// up to `timeout` or until `cancel` fires. `work` may report the process
/// of the app it drives on its [`Session`]; `give_up` gets it (if reported)
/// when the wait ends early, and returns the step's error.
pub fn run_on_sta<T: Send + 'static>(
    name: &str,
    timeout: Duration,
    cancel: &CancellationToken,
    work: impl FnOnce(&Session) -> Result<T, StepError> + Send + 'static,
    give_up: impl FnOnce(GaveUpReason) -> StepError,
) -> Result<T, StepError> {
    let (pid_tx, pid_rx) = mpsc::channel::<u32>();
    let (done_tx, done_rx) = mpsc::channel();
    let abandoned = Arc::new(AtomicBool::new(false));
    let session = Session {
        pid: pid_tx,
        abandoned: abandoned.clone(),
    };
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                // SAFETY: initialises COM for this new thread only.
                unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                    .ok()
                    .map_err(|e| StepError::new("COM_ERROR", format!("cannot start COM: {e}")))?;
                let result = work(&session);
                // SAFETY: pairs with the CoInitializeEx above; every
                // interface pointer of `work` has been released.
                unsafe { CoUninitialize() };
                result
            }))
            .unwrap_or_else(|_| Err(StepError::new("ADAPTER_CRASHED", "COM automation crashed")));
            let _ = done_tx.send(result);
        })
        .map_err(|e| {
            StepError::new(
                "ADAPTER_CRASHED",
                format!("cannot start COM automation: {e}"),
            )
        })?;

    let deadline = Instant::now() + timeout;
    loop {
        match done_rx.recv_timeout(POLL) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(StepError::new("ADAPTER_CRASHED", "COM automation stopped"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let reason = if cancel.is_cancelled() {
            GaveUp::Cancelled
        } else if Instant::now() >= deadline {
            GaveUp::TimedOut
        } else {
            continue;
        };
        // Flag first, then look for the process: `work` reports its
        // process before checking the flag, so one of the two sees the
        // other.
        abandoned.store(true, Ordering::SeqCst);
        return Err(give_up(GaveUpReason {
            reason,
            pid: pid_rx.try_recv().ok(),
        }));
    }
}

/// Why and on which app process a wait ended early.
pub struct GaveUpReason {
    pub reason: GaveUp,
    pub pid: Option<u32>,
}

/// Ends a process (an Office app started for one step that hangs).
pub fn kill_process(pid: u32) {
    // SAFETY: a process handle opened, used and closed here.
    unsafe {
        if let Ok(process) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(process, 1);
            let _ = CloseHandle(process);
        }
    }
}

/// A late-bound COM object.
#[derive(Clone)]
pub struct Object(IDispatch);

impl Object {
    /// Starts (or, for single-instance apps such as Outlook, connects to)
    /// the app registered as `prog_id`; `missing` is the error when it is
    /// not installed.
    pub fn create(prog_id: &str, missing: impl FnOnce() -> StepError) -> Result<Self, StepError> {
        // SAFETY: looks up a class and creates it out of process.
        unsafe {
            let clsid = CLSIDFromProgID(&HSTRING::from(prog_id)).map_err(|_| missing())?;
            CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER)
                .map(Self)
                .map_err(|e| {
                    StepError::new("APP_UNAVAILABLE", format!("cannot start {prog_id}: {e}"))
                })
        }
    }

    /// The process that owns the app's main window (Excel's `Hwnd`).
    pub fn window_process(&self) -> Option<u32> {
        let hwnd = self.get("Hwnd").ok()?.to_i64().ok()?;
        let mut id = 0;
        // SAFETY: reads the owner of a window handle the app reported.
        unsafe { GetWindowThreadProcessId(HWND(hwnd as _), Some(&mut id)) };
        (id != 0).then_some(id)
    }

    fn dispid(&self, name: &str) -> Result<i32, StepError> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let names = [PCWSTR(wide.as_ptr())];
        let mut id = 0;
        // SAFETY: one NUL-terminated name in, one DISPID out.
        unsafe {
            self.0.GetIDsOfNames(
                &GUID::zeroed(),
                names.as_ptr(),
                1,
                LOCALE_USER_DEFAULT,
                &mut id,
            )
        }
        .map_err(|e| StepError::new("COM_ERROR", format!("the app has no '{name}': {e}")))?;
        Ok(id)
    }

    fn invoke(&self, name: &str, flags: DISPATCH_FLAGS, args: Vec<Var>) -> Result<Var, StepError> {
        let id = self.dispid(name)?;
        // IDispatch takes the arguments last to first.
        let mut args: Vec<Var> = args.into_iter().rev().collect();
        let mut named = DISPID_PROPERTYPUT;
        let put = flags == DISPATCH_PROPERTYPUT;
        let params = DISPPARAMS {
            rgvarg: args.as_mut_ptr().cast(),
            rgdispidNamedArgs: if put {
                &mut named
            } else {
                std::ptr::null_mut()
            },
            cArgs: args.len() as u32,
            cNamedArgs: u32::from(put),
        };
        let mut result = Var::empty();
        let mut exception = EXCEPINFO::default();
        // SAFETY: `params` points at `args` and `named`, which outlive the call.
        let outcome = unsafe {
            self.0.Invoke(
                id,
                &GUID::zeroed(),
                LOCALE_USER_DEFAULT,
                flags,
                &params,
                Some(&mut result.0),
                Some(&mut exception),
                None,
            )
        };
        let description = exception.bstrDescription.to_string();
        // SAFETY: the strings belong to us now and are freed once.
        unsafe {
            ManuallyDrop::drop(&mut exception.bstrSource);
            ManuallyDrop::drop(&mut exception.bstrDescription);
            ManuallyDrop::drop(&mut exception.bstrHelpFile);
        }
        outcome.map_err(|e| {
            let message = if description.is_empty() {
                e.message()
            } else {
                description
            };
            StepError::new("COM_ERROR", message)
        })?;
        Ok(result)
    }

    /// Calls a method (or reads a property with arguments, e.g. `Item(1)`).
    pub fn call(&self, name: &str, args: Vec<Var>) -> Result<Var, StepError> {
        self.invoke(name, DISPATCH_METHOD | DISPATCH_PROPERTYGET, args)
    }

    pub fn get(&self, name: &str) -> Result<Var, StepError> {
        self.invoke(name, DISPATCH_PROPERTYGET, vec![])
    }

    pub fn put(&self, name: &str, value: Var) -> Result<(), StepError> {
        self.invoke(name, DISPATCH_PROPERTYPUT, vec![value])
            .map(drop)
    }

    /// A property or method result that is itself an object.
    pub fn object(&self, name: &str, args: Vec<Var>) -> Result<Object, StepError> {
        self.call(name, args)?.object(name)
    }
}

/// An owned VARIANT, cleared on drop. Laid out as a VARIANT so a `Vec<Var>`
/// can be passed as an argument array.
#[repr(transparent)]
pub struct Var(VARIANT);

impl Drop for Var {
    fn drop(&mut self) {
        // SAFETY: the VARIANT is owned and initialised.
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

impl Var {
    pub fn empty() -> Self {
        Self(VARIANT::default())
    }

    fn vt(&self) -> VARENUM {
        // SAFETY: every Var holds an initialised VARIANT.
        unsafe { self.0.Anonymous.Anonymous.vt }
    }

    fn with(vt: VARENUM, set: impl FnOnce(&mut VARIANT_0_0_0)) -> Self {
        let mut v = VARIANT::default();
        // SAFETY: writes the tag and the matching member of a zeroed VARIANT.
        unsafe {
            let inner = &mut *v.Anonymous.Anonymous;
            inner.vt = vt;
            set(&mut inner.Anonymous);
        }
        Self(v)
    }

    pub fn str(s: &str) -> Self {
        Self::with(VT_BSTR, |u| u.bstrVal = ManuallyDrop::new(BSTR::from(s)))
    }

    pub fn i32(n: i32) -> Self {
        Self::with(VT_I4, |u| u.lVal = n)
    }

    pub fn f64(n: f64) -> Self {
        Self::with(VT_R8, |u| u.dblVal = n)
    }

    pub fn bool(b: bool) -> Self {
        Self::with(VT_BOOL, |u| {
            u.boolVal = if b { VARIANT_TRUE } else { VARIANT_FALSE }
        })
    }

    /// Text, a number, true/false or null as an argument.
    pub fn from_json(value: &Value) -> Result<Self, StepError> {
        Ok(match value {
            Value::Null => Self::empty(),
            Value::Bool(b) => Self::bool(*b),
            Value::String(s) => Self::str(s),
            Value::Number(n) => match n.as_i64().and_then(|i| i32::try_from(i).ok()) {
                Some(i) => Self::i32(i),
                None => Self::f64(n.as_f64().unwrap_or_default()),
            },
            other => {
                return Err(StepError::permanent(
                    "INVALID_PARAMS",
                    format!("{other} cannot be passed to the app"),
                )
                .with_details(json!({ "hint": "Pass text, numbers, true/false or null." })));
            }
        })
    }

    fn changed(&self, vt: VARENUM) -> Option<Var> {
        let mut out = Var::empty();
        // SAFETY: converts between two owned VARIANTs.
        unsafe { VariantChangeType(&mut out.0, &self.0, VAR_CHANGE_FLAGS(0), vt) }.ok()?;
        Some(out)
    }

    pub fn to_f64(&self) -> Option<f64> {
        // SAFETY: the converted VARIANT is VT_R8.
        self.changed(VT_R8)
            .map(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.dblVal })
    }

    pub fn to_i64(&self) -> Result<i64, StepError> {
        self.changed(VT_I8)
            // SAFETY: the converted VARIANT is VT_I8.
            .map(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.llVal })
            .ok_or_else(|| StepError::new("COM_ERROR", "the app returned an unexpected value"))
    }

    pub fn to_bool(&self) -> bool {
        // SAFETY: the converted VARIANT is VT_BOOL.
        self.changed(VT_BOOL)
            .is_some_and(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.boolVal != VARIANT_FALSE })
    }

    pub fn to_text(&self) -> String {
        if matches!(self.vt(), VT_EMPTY | VT_NULL) {
            return String::new();
        }
        // SAFETY: the converted VARIANT is VT_BSTR.
        self.changed(VT_BSTR)
            .map(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.bstrVal.to_string() })
            .unwrap_or_default()
    }

    pub fn object(&self, what: &str) -> Result<Object, StepError> {
        if self.vt() == VT_DISPATCH {
            // SAFETY: the tag says the member is an IDispatch pointer.
            if let Some(object) =
                unsafe { (*self.0.Anonymous.Anonymous.Anonymous.pdispVal).clone() }
            {
                return Ok(Object(object));
            }
        }
        Err(StepError::new(
            "COM_ERROR",
            format!("the app did not return an object for '{what}'"),
        ))
    }

    /// Text, a number, true/false, a date as ISO text, or null (also for
    /// arrays and objects).
    pub fn to_json(&self) -> Value {
        match self.vt() {
            VT_EMPTY | VT_NULL => Value::Null,
            VT_BOOL => Value::Bool(self.to_bool()),
            VT_BSTR => Value::String(self.to_text()),
            VT_DATE => self
                .to_f64()
                .and_then(crate::ole_date_text)
                .map_or(Value::Null, Value::String),
            _ => match self.to_f64() {
                Some(n) if n.fract() == 0.0 && n.abs() < 9e15 => json!(n as i64),
                Some(n) => json!(n),
                None => Value::Null,
            },
        }
    }
}
