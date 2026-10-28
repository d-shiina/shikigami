//! Excel itself, through COM automation: only for what the file alone
//! cannot do (running a workbook's macros).
//!
//! Each request starts its own Excel instance on its own single-threaded
//! apartment thread, so the person's open Excel windows are never touched
//! and a macro that hangs (a MsgBox, an endless loop) is ended by killing
//! that instance when the step's time is up.
//!
//! This is the only module of the crate that may use `unsafe` (every COM
//! call).

#![allow(unsafe_code)]

use std::mem::ManuallyDrop;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc;
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
    VAR_CHANGE_FLAGS, VARENUM, VARIANT, VT_BOOL, VT_BSTR, VT_DATE, VT_DISPATCH, VT_EMPTY, VT_I4,
    VT_I8, VT_NULL, VT_R8, VariantChangeType, VariantClear,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use windows::core::{BSTR, GUID, PCWSTR, w};

use crate::date;
use crate::macros::MacroRequest;

const LOCALE_USER_DEFAULT: u32 = 0x0400;
const POLL: Duration = Duration::from_millis(200);

/// Runs the macro and waits for it, ending Excel when `timeout` passes or
/// the step is stopped.
pub fn run(
    request: MacroRequest,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    let (pid_tx, pid_rx) = mpsc::channel::<u32>();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("shikigami-excel-com".into())
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| session(&request, &pid_tx)))
                .unwrap_or_else(|_| {
                    Err(StepError::new(
                        "ADAPTER_CRASHED",
                        "Excel automation crashed",
                    ))
                });
            let _ = done_tx.send(result);
        })
        .map_err(|e| {
            StepError::new(
                "ADAPTER_CRASHED",
                format!("cannot start Excel automation: {e}"),
            )
        })?;

    let deadline = Instant::now() + timeout;
    loop {
        match done_rx.recv_timeout(POLL) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(StepError::new(
                    "ADAPTER_CRASHED",
                    "Excel automation stopped",
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let stopped = cancel.is_cancelled();
        if stopped || Instant::now() >= deadline {
            if let Ok(pid) = pid_rx.try_recv() {
                kill(pid);
            }
            return Err(if stopped {
                StepError::new(
                    "CANCELLED",
                    "the step was stopped; Excel was closed without saving",
                )
            } else {
                StepError::new("MACRO_TIMEOUT", "the macro did not finish in time; Excel was closed without saving")
                    .with_details(json!({ "hint": "A macro that shows a MsgBox or InputBox waits for a person and never finishes unattended: remove the dialog from the macro. If it is just slow, raise the step's timeoutMs." }))
            });
        }
    }
}

fn kill(pid: u32) {
    // SAFETY: a process handle opened, used and closed here.
    unsafe {
        if let Ok(process) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(process, 1);
            let _ = CloseHandle(process);
        }
    }
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: pairs with the CoInitializeEx in `session`.
        unsafe { CoUninitialize() };
    }
}

fn session(request: &MacroRequest, pid: &mpsc::Sender<u32>) -> Result<Value, StepError> {
    // SAFETY: COM is initialised for this thread, and every interface
    // pointer is used and released on it.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| StepError::new("COM_ERROR", format!("cannot start COM: {e}")))?;
    }
    let _apartment = Apartment;
    // SAFETY: as above.
    let app: IDispatch = unsafe {
        let clsid = CLSIDFromProgID(w!("Excel.Application")).map_err(|_| {
            StepError::permanent("EXCEL_NOT_INSTALLED", "Excel is not installed on this PC")
                .with_details(json!({ "hint": "excel.runMacro needs desktop Excel. Reading and writing cells (the other excel.* steps) works without it." }))
        })?;
        CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER)
            .map_err(|e| StepError::new("EXCEL_UNAVAILABLE", format!("cannot start Excel: {e}")))?
    };
    if let Ok(hwnd) = get(&app, "Hwnd").and_then(|v| v.to_i64()) {
        let mut id = 0;
        // SAFETY: reads the owner of a window handle Excel reported.
        unsafe { GetWindowThreadProcessId(HWND(hwnd as _), Some(&mut id)) };
        if id != 0 {
            let _ = pid.send(id);
        }
    }
    let result = with_app(&app, request);
    let _ = call(&app, "Quit", DISPATCH_METHOD, vec![]);
    result
}

fn with_app(app: &IDispatch, request: &MacroRequest) -> Result<Value, StepError> {
    put(app, "DisplayAlerts", Var::bool(false))?;
    let _ = put(app, "AskToUpdateLinks", Var::bool(false));
    let books = get(app, "Workbooks")?.dispatch("Workbooks")?;
    // Workbooks.Open(Filename, UpdateLinks:=0)
    let book = call(
        &books,
        "Open",
        DISPATCH_METHOD | DISPATCH_PROPERTYGET,
        vec![Var::str(&request.path), Var::i32(0)],
    )?
    .dispatch("Workbook")?;
    let result = with_book(app, &book, request);
    let _ = call(&book, "Close", DISPATCH_METHOD, vec![Var::bool(false)]);
    result
}

fn with_book(
    app: &IDispatch,
    book: &IDispatch,
    request: &MacroRequest,
) -> Result<Value, StepError> {
    if request.save && get(book, "ReadOnly")?.to_bool() {
        return Err(crate::book::in_use(std::path::Path::new(&request.path)));
    }
    let name = get(book, "Name")?.to_text();
    let target = if request.name.contains('!') {
        request.name.clone()
    } else {
        format!("'{}'!{}", name.replace('\'', "''"), request.name)
    };
    let mut args = vec![Var::str(&target)];
    for arg in &request.args {
        args.push(Var::from_json(arg)?);
    }
    let output = call(app, "Run", DISPATCH_METHOD | DISPATCH_PROPERTYGET, args).map_err(|e| {
        StepError::permanent("MACRO_FAILED", format!("macro '{}' failed: {}", request.name, e.message))
            .with_details(json!({ "hint": "Check the macro name (Module1.集計 or 集計), that it is a Public Sub/Function in a standard module, and that `args` match its parameters. A workbook downloaded from the internet must be unblocked (file properties → 許可する) before its macros run." }))
    })?;
    if request.save {
        call(book, "Save", DISPATCH_METHOD, vec![])?;
    }
    Ok(output.to_json())
}

// -- IDispatch ----------------------------------------------------------------

/// An owned VARIANT, cleared on drop. Laid out as a VARIANT so a `Vec<Var>`
/// can be passed as an argument array.
#[repr(transparent)]
struct Var(VARIANT);

impl Drop for Var {
    fn drop(&mut self) {
        // SAFETY: the VARIANT is owned and initialised.
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

impl Var {
    fn empty() -> Self {
        Self(VARIANT::default())
    }

    fn vt(&self) -> VARENUM {
        // SAFETY: every Var holds an initialised VARIANT.
        unsafe { self.0.Anonymous.Anonymous.vt }
    }

    fn with(
        vt: VARENUM,
        set: impl FnOnce(&mut windows::Win32::System::Variant::VARIANT_0_0_0),
    ) -> Self {
        let mut v = VARIANT::default();
        // SAFETY: writes the tag and the matching member of a zeroed VARIANT.
        unsafe {
            let inner = &mut *v.Anonymous.Anonymous;
            inner.vt = vt;
            set(&mut inner.Anonymous);
        }
        Self(v)
    }

    fn str(s: &str) -> Self {
        Self::with(VT_BSTR, |u| u.bstrVal = ManuallyDrop::new(BSTR::from(s)))
    }

    fn i32(n: i32) -> Self {
        Self::with(VT_I4, |u| u.lVal = n)
    }

    fn f64(n: f64) -> Self {
        Self::with(VT_R8, |u| u.dblVal = n)
    }

    fn bool(b: bool) -> Self {
        Self::with(VT_BOOL, |u| {
            u.boolVal = if b { VARIANT_TRUE } else { VARIANT_FALSE }
        })
    }

    fn from_json(value: &Value) -> Result<Self, StepError> {
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
                    format!("a macro argument cannot be {other}"),
                )
                .with_details(
                    json!({ "hint": "Macro arguments are text, numbers, true/false or null." }),
                ));
            }
        })
    }

    fn changed(&self, vt: VARENUM) -> Option<Var> {
        let mut out = Var::empty();
        // SAFETY: converts between two owned VARIANTs.
        unsafe { VariantChangeType(&mut out.0, &self.0, VAR_CHANGE_FLAGS(0), vt) }.ok()?;
        Some(out)
    }

    fn to_f64(&self) -> Option<f64> {
        // SAFETY: the converted VARIANT is VT_R8.
        self.changed(VT_R8)
            .map(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.dblVal })
    }

    fn to_i64(&self) -> Result<i64, StepError> {
        self.changed(VT_I8)
            // SAFETY: the converted VARIANT is VT_I8.
            .map(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.llVal })
            .ok_or_else(|| StepError::new("COM_ERROR", "Excel returned an unexpected value"))
    }

    fn to_bool(&self) -> bool {
        // SAFETY: the converted VARIANT is VT_BOOL.
        self.changed(VT_BOOL)
            .is_some_and(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.boolVal } != VARIANT_FALSE)
    }

    fn to_text(&self) -> String {
        // SAFETY: the converted VARIANT is VT_BSTR.
        self.changed(VT_BSTR)
            .map(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.bstrVal.to_string() })
            .unwrap_or_default()
    }

    fn dispatch(&self, what: &str) -> Result<IDispatch, StepError> {
        if self.vt() == VT_DISPATCH {
            // SAFETY: the tag says the member is an IDispatch pointer.
            if let Some(object) =
                unsafe { (*self.0.Anonymous.Anonymous.Anonymous.pdispVal).clone() }
            {
                return Ok(object);
            }
        }
        Err(StepError::new(
            "COM_ERROR",
            format!("Excel did not return a {what}"),
        ))
    }

    /// A macro's return value: text, a number, true/false, a date as ISO
    /// text, or null (also for arrays and objects).
    fn to_json(&self) -> Value {
        match self.vt() {
            VT_EMPTY | VT_NULL => Value::Null,
            VT_BOOL => Value::Bool(self.to_bool()),
            VT_BSTR => Value::String(self.to_text()),
            VT_DATE => {
                let serial = self.to_f64().unwrap_or_default();
                let kind = if serial.fract() == 0.0 {
                    date::Kind::Date
                } else {
                    date::Kind::DateTime
                };
                date::to_text(serial, kind, false).map_or(Value::Null, Value::String)
            }
            _ => match self.to_f64() {
                Some(n) if n.fract() == 0.0 && n.abs() < 9e15 => json!(n as i64),
                Some(n) => json!(n),
                None => Value::Null,
            },
        }
    }
}

fn dispid(object: &IDispatch, name: &str) -> Result<i32, StepError> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let names = [PCWSTR(wide.as_ptr())];
    let mut id = 0;
    // SAFETY: one NUL-terminated name in, one DISPID out.
    unsafe {
        object.GetIDsOfNames(
            &GUID::zeroed(),
            names.as_ptr(),
            1,
            LOCALE_USER_DEFAULT,
            &mut id,
        )
    }
    .map_err(|e| StepError::new("COM_ERROR", format!("Excel has no '{name}': {e}")))?;
    Ok(id)
}

fn call(
    object: &IDispatch,
    name: &str,
    flags: DISPATCH_FLAGS,
    args: Vec<Var>,
) -> Result<Var, StepError> {
    let id = dispid(object, name)?;
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
        object.Invoke(
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

fn get(object: &IDispatch, name: &str) -> Result<Var, StepError> {
    call(object, name, DISPATCH_PROPERTYGET, vec![])
}

fn put(object: &IDispatch, name: &str, value: Var) -> Result<(), StepError> {
    call(object, name, DISPATCH_PROPERTYPUT, vec![value]).map(drop)
}
