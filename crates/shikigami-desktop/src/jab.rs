//! Java apps (Swing, AWT) through the Java Access Bridge.
//!
//! UI Automation sees only the frame of a Java window, so when a target's
//! window is Java's and the bridge answers, the `desktop.*` steps act
//! through it: elements are Java's accessible components, found by role +
//! name like any other element.
//!
//! The bridge (`WindowsAccessBridge-64.dll`, part of every JDK / JRE)
//! talks to Java with window messages, so it lives on its own thread that
//! keeps pumping them; requests are sent to that thread. Java must have
//! the bridge switched on (`jabswitch -enable`, then restart the app).
//!
//! This is one of the modules that may use `unsafe` (the bridge's C API).

#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use shikigami_runtime::StepError;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage,
};
use windows::core::{HSTRING, PCSTR};

use crate::backend::Text;
use crate::bridge::AppBridge;
use crate::jabmap::{self, has_state, wide};
use crate::keys::Chord;
use crate::menu;
use crate::table::{self, Grid};
use crate::target::{ElementQuery, NodeInfo, WindowInfo, pick_element, render_tree};

const DLL: &str = "WindowsAccessBridge-64.dll";
/// Most components read from one Java window.
const TREE_LIMIT: usize = 4_000;
/// Children read from one list (long lists are read with getTable).
const CHILD_LIMIT: i32 = 1_000;
/// How long a request may wait for the bridge thread.
const REQUEST_LIMIT: Duration = Duration::from_secs(60);

type Ctx = i64;

#[repr(C)]
struct ContextInfo {
    name: [u16; 1024],
    description: [u16; 1024],
    role: [u16; 256],
    role_en_us: [u16; 256],
    states: [u16; 256],
    states_en_us: [u16; 256],
    index_in_parent: i32,
    children_count: i32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    accessible_component: i32,
    accessible_action: i32,
    accessible_selection: i32,
    accessible_text: i32,
    accessible_interfaces: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ActionInfo {
    name: [u16; 256],
}

#[repr(C)]
struct Actions {
    count: i32,
    info: [ActionInfo; 256],
}

#[repr(C)]
struct ActionsToDo {
    count: i32,
    actions: [ActionInfo; 32],
}

#[repr(C)]
#[derive(Default)]
struct TextInfo {
    char_count: i32,
    caret_index: i32,
    index_at_point: i32,
}

#[repr(C)]
#[derive(Default)]
struct TableInfo {
    caption: Ctx,
    summary: Ctx,
    row_count: i32,
    column_count: i32,
    context: Ctx,
    table: Ctx,
}

#[repr(C)]
#[derive(Default)]
struct TableCellInfo {
    context: Ctx,
    index: i32,
    row: i32,
    column: i32,
    row_extent: i32,
    column_extent: i32,
    selected: u8,
}

/// The bridge's functions.
struct Api {
    _dll: HMODULE,
    is_java_window: unsafe extern "C" fn(HWND) -> i32,
    context_from_hwnd: unsafe extern "C" fn(HWND, *mut i32, *mut Ctx) -> i32,
    context_info: unsafe extern "C" fn(i32, Ctx, *mut ContextInfo) -> i32,
    child: unsafe extern "C" fn(i32, Ctx, i32) -> Ctx,
    release: unsafe extern "C" fn(i32, Ctx),
    actions: unsafe extern "C" fn(i32, Ctx, *mut Actions) -> i32,
    do_actions: unsafe extern "C" fn(i32, Ctx, *mut ActionsToDo, *mut i32) -> i32,
    set_text: unsafe extern "C" fn(i32, Ctx, *const u16) -> i32,
    request_focus: unsafe extern "C" fn(i32, Ctx) -> i32,
    text_info: unsafe extern "C" fn(i32, Ctx, *mut TextInfo, i32, i32) -> i32,
    text_range: unsafe extern "C" fn(i32, Ctx, i32, i32, *mut u16, i16) -> i32,
    table_info: unsafe extern "C" fn(i32, Ctx, *mut TableInfo) -> i32,
    table_cell: unsafe extern "C" fn(i32, Ctx, i32, i32, *mut TableCellInfo) -> i32,
    column_header: unsafe extern "C" fn(i32, Ctx, *mut TableInfo) -> i32,
    add_selection: unsafe extern "C" fn(i32, Ctx, i32) -> i32,
}

fn bridge_missing(reason: &str) -> StepError {
    StepError::permanent(
        "JAVA_BRIDGE_OFF",
        format!("the Java Access Bridge cannot reach this Java window ({reason})"),
    )
    .with_details(json!({
        "hint": "Ask the user to switch the bridge on: run `jabswitch -enable` (in the bin folder of the Java the app uses), then restart the Java app. Without it only the window itself, OCR and images work."
    }))
}

impl Api {
    /// Loads the bridge from the system, the Java the app runs on, or
    /// JAVA_HOME, and starts it on this thread.
    fn load(java_dirs: &[PathBuf]) -> Result<Self, String> {
        let mut candidates: Vec<PathBuf> = vec![PathBuf::from(DLL)];
        for dir in java_dirs {
            candidates.push(dir.join(DLL));
        }
        if let Some(home) = std::env::var_os("JAVA_HOME") {
            candidates.push(Path::new(&home).join("bin").join(DLL));
        }
        // SAFETY: loads a DLL by path; the handle is kept for the thread's
        // life.
        let dll = candidates
            .iter()
            .find_map(|path| unsafe { LoadLibraryW(&HSTRING::from(path.as_os_str())) }.ok())
            .ok_or_else(|| format!("{DLL} was not found next to the app's Java or in JAVA_HOME"))?;
        macro_rules! function {
            ($name:literal) => {{
                // SAFETY: the bridge exports this C function with this
                // signature (AccessBridgeCalls.h).
                let f = unsafe { GetProcAddress(dll, PCSTR(concat!($name, "\0").as_ptr())) }
                    .ok_or_else(|| format!("{DLL} has no {}", $name))?;
                #[allow(clippy::missing_transmute_annotations)]
                unsafe {
                    std::mem::transmute(f)
                }
            }};
        }
        let run: unsafe extern "C" fn() = function!("Windows_run");
        let api = Self {
            _dll: dll,
            is_java_window: function!("isJavaWindow"),
            context_from_hwnd: function!("getAccessibleContextFromHWND"),
            context_info: function!("getAccessibleContextInfo"),
            child: function!("getAccessibleChildFromContext"),
            release: function!("releaseJavaObject"),
            actions: function!("getAccessibleActions"),
            do_actions: function!("doAccessibleActions"),
            set_text: function!("setTextContents"),
            request_focus: function!("requestFocus"),
            text_info: function!("getAccessibleTextInfo"),
            text_range: function!("getAccessibleTextRange"),
            table_info: function!("getAccessibleTableInfo"),
            table_cell: function!("getAccessibleTableCellInfo"),
            column_header: function!("getAccessibleTableColumnHeader"),
            add_selection: function!("addAccessibleSelectionFromContext"),
        };
        // SAFETY: starts the bridge on this thread, which pumps messages.
        unsafe { run() };
        pump_for(Duration::from_millis(700));
        Ok(api)
    }

    fn info(&self, vm: i32, ctx: Ctx) -> Option<Box<ContextInfo>> {
        // SAFETY: a zeroed plain-data struct the bridge fills in.
        let mut info: Box<ContextInfo> = unsafe { zeroed_box() };
        // SAFETY: the bridge writes into the struct it is given.
        (unsafe { (self.context_info)(vm, ctx, &mut *info) } != 0).then_some(info)
    }

    fn text(&self, vm: i32, ctx: Ctx) -> Option<String> {
        let mut info = TextInfo::default();
        // SAFETY: the bridge writes into the structs and buffer it is given.
        unsafe {
            if (self.text_info)(vm, ctx, &mut info, 0, 0) == 0 {
                return None;
            }
            if info.char_count <= 0 {
                return Some(String::new());
            }
            let len = info.char_count.min(30_000);
            let mut buffer = vec![0u16; len as usize + 1];
            if (self.text_range)(
                vm,
                ctx,
                0,
                len - 1,
                buffer.as_mut_ptr(),
                (len + 1).min(i16::MAX as i32) as i16,
            ) == 0
            {
                return None;
            }
            Some(wide(&buffer))
        }
    }

    /// The first action of an element (click, toggle...), done.
    fn act(&self, vm: i32, ctx: Ctx) -> Result<(), StepError> {
        // SAFETY: zeroed plain-data structs the bridge fills in / reads.
        unsafe {
            let mut actions: Box<Actions> = zeroed_box();
            if (self.actions)(vm, ctx, &mut *actions) == 0 || actions.count <= 0 {
                return Err(StepError::permanent(
                    "NOT_CLICKABLE",
                    "this Java component has no action to do",
                )
                .with_details(json!({ "hint": "Use desktop.mouseClick with the same target." })));
            }
            let mut todo: Box<ActionsToDo> = zeroed_box();
            todo.count = 1;
            todo.actions[0] = actions.info[0];
            let mut failure = 0;
            if (self.do_actions)(vm, ctx, &mut *todo, &mut failure) == 0 {
                return Err(StepError::new(
                    "ACTION_FAILED",
                    format!("Java did not do '{}'", wide(&actions.info[0].name)),
                ));
            }
        }
        Ok(())
    }
}

/// A heap value with every byte zero (the bridge's structs are large).
///
/// # Safety
/// `T` must be plain data for which all-zero bytes are a valid value.
unsafe fn zeroed_box<T>() -> Box<T> {
    let layout = std::alloc::Layout::new::<T>();
    // SAFETY: the layout is not zero-sized (the bridge's structs), the
    // memory is zeroed, which the caller says is a valid T, and Box frees
    // it with the same layout.
    unsafe {
        let ptr = std::alloc::alloc_zeroed(layout).cast::<T>();
        if ptr.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        Box::from_raw(ptr)
    }
}

/// Dispatches the window messages waiting for this thread.
fn pump() {
    let mut msg = MSG::default();
    // SAFETY: the standard message loop on this thread's own queue.
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn pump_for(time: Duration) {
    let until = Instant::now() + time;
    while Instant::now() < until {
        pump();
        std::thread::sleep(Duration::from_millis(20));
    }
}

// -- the bridge thread -----------------------------------------------------------

struct State {
    api: Option<Api>,
    failure: Option<String>,
}

impl State {
    fn api(&mut self, java_dirs: &[PathBuf]) -> Result<&Api, StepError> {
        if self.api.is_none() {
            match Api::load(java_dirs) {
                Ok(api) => {
                    self.api = Some(api);
                    self.failure = None;
                }
                Err(reason) => self.failure = Some(reason),
            }
        }
        match &self.api {
            Some(api) => Ok(api),
            None => Err(bridge_missing(
                self.failure.as_deref().unwrap_or("not loaded"),
            )),
        }
    }
}

type Job = Box<dyn FnOnce(&mut State) + Send>;

fn queue() -> &'static Mutex<Option<mpsc::Sender<Job>>> {
    static QUEUE: OnceLock<Mutex<Option<mpsc::Sender<Job>>>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(None))
}

fn worker(rx: mpsc::Receiver<Job>) {
    let mut state = State {
        api: None,
        failure: None,
    };
    loop {
        pump();
        match rx.recv_timeout(Duration::from_millis(30)) {
            Ok(job) => {
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut state)))
                    .is_err()
                {
                    tracing::error!("a Java Access Bridge request panicked");
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Runs `work` on the bridge thread and waits for it.
fn on_thread<T: Send + 'static>(
    work: impl FnOnce(&mut State) -> Result<T, StepError> + Send + 'static,
) -> Result<T, StepError> {
    let (tx, rx) = mpsc::channel();
    let job: Job = Box::new(move |state| {
        let _ = tx.send(work(state));
    });
    {
        let mut queue = queue().lock().map_err(|_| {
            StepError::new("ADAPTER_CRASHED", "the Java Access Bridge queue is broken")
        })?;
        let job = match queue.as_ref() {
            Some(q) => match q.send(job) {
                Ok(()) => None,
                Err(mpsc::SendError(job)) => Some(job),
            },
            None => Some(job),
        };
        if let Some(job) = job {
            let (sender, receiver) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("shikigami-jab".into())
                .spawn(move || worker(receiver))
                .map_err(|e| {
                    StepError::new(
                        "ADAPTER_CRASHED",
                        format!("cannot start the Java Access Bridge thread: {e}"),
                    )
                })?;
            sender.send(job).map_err(|_| {
                StepError::new("ADAPTER_CRASHED", "the Java Access Bridge thread stopped")
            })?;
            *queue = Some(sender);
        }
    }
    rx.recv_timeout(REQUEST_LIMIT).unwrap_or_else(|_| {
        Err(StepError::new(
            "APP_NOT_RESPONDING",
            "the Java app did not answer the Access Bridge in time",
        ))
    })
}

// -- one window --------------------------------------------------------------------

/// A Java window reached through the Access Bridge. Each request walks
/// the window's components anew on the bridge thread.
pub struct JavaWindow {
    hwnd: isize,
    java_dirs: Vec<PathBuf>,
}

/// One component met on a walk, with its place on the screen.
struct Found {
    ctx: Ctx,
    node: NodeInfo,
    java_role: String,
    rect: (i32, i32, i32, i32),
    text: bool,
}

/// The components of a window, released when dropped.
struct Walk<'a> {
    api: &'a Api,
    vm: i32,
    found: Vec<Found>,
    owned: Vec<Ctx>,
}

impl Drop for Walk<'_> {
    fn drop(&mut self) {
        for ctx in self.owned.drain(..) {
            // SAFETY: each object was handed to us by the bridge once.
            unsafe { (self.api.release)(self.vm, ctx) };
        }
    }
}

impl<'a> Walk<'a> {
    fn new(api: &'a Api, hwnd: isize) -> Result<Self, StepError> {
        let window = HWND(hwnd as *mut core::ffi::c_void);
        let until = Instant::now() + Duration::from_secs(2);
        // A Java app the bridge has just met answers after a moment.
        // SAFETY: plain calls into the bridge with a window handle.
        while unsafe { (api.is_java_window)(window) } == 0 {
            if Instant::now() >= until {
                // Retried until the step's time is up: a Java app just
                // started answers a little after its window appears.
                return Err(StepError::new(
                    "JAVA_NOT_READY",
                    "the Java app does not answer the Java Access Bridge",
                )
                .with_details(json!({
                    "hint": "If this lasts, the bridge is off for this app: ask the user to run `jabswitch -enable` (in the bin folder of the Java the app uses) and restart the app."
                })));
            }
            pump_for(Duration::from_millis(100));
        }
        let (mut vm, mut root) = (0, 0);
        // SAFETY: the bridge writes the VM id and the root object.
        if unsafe { (api.context_from_hwnd)(window, &mut vm, &mut root) } == 0 || root == 0 {
            return Err(bridge_missing("no accessible context for the window"));
        }
        let mut walk = Walk {
            api,
            vm,
            found: Vec::new(),
            owned: vec![root],
        };
        walk.visit(root, 0);
        Ok(walk)
    }

    fn visit(&mut self, ctx: Ctx, depth: usize) {
        if self.found.len() >= TREE_LIMIT {
            return;
        }
        let Some(info) = self.api.info(self.vm, ctx) else {
            return;
        };
        let java_role = wide(&info.role_en_us);
        let states = wide(&info.states_en_us);
        let role = jabmap::role(&java_role);
        let checked = matches!(role, "checkbox" | "radio" | "button")
            .then(|| has_state(&states, "checked"))
            .filter(|c| *c || role != "button");
        let password = java_role.trim() == "password text";
        let value = (role == "textbox" && !password && info.accessible_text != 0)
            .then(|| self.api.text(self.vm, ctx))
            .flatten();
        let mut name = wide(&info.name).trim().to_owned();
        if name.is_empty() {
            name = wide(&info.description).trim().to_owned();
        }
        self.found.push(Found {
            ctx,
            node: NodeInfo {
                depth,
                name,
                id: String::new(),
                role,
                class_name: java_role.clone(),
                enabled: has_state(&states, "enabled"),
                offscreen: !has_state(&states, "showing"),
                password,
                value,
                checked,
            },
            java_role: java_role.clone(),
            rect: (info.x, info.y, info.width, info.height),
            text: info.accessible_text != 0,
        });
        if jabmap::holds_cells(&java_role) {
            return;
        }
        for i in 0..info.children_count.min(CHILD_LIMIT) {
            // SAFETY: asks the bridge for a child of an object it gave us.
            let child = unsafe { (self.api.child)(self.vm, ctx, i) };
            if child == 0 {
                continue;
            }
            self.owned.push(child);
            self.visit(child, depth + 1);
        }
    }

    fn nodes(&self) -> Vec<NodeInfo> {
        self.found.iter().map(|f| f.node.clone()).collect()
    }

    fn pick(&self, query: &ElementQuery) -> Result<&Found, StepError> {
        if query.id.is_some() && query.role.is_none() && query.name.is_none() {
            return Err(StepError::permanent(
                "INVALID_PARAMS",
                "Java components have no id; target them with role + name as inspect_ui lists them",
            ));
        }
        let query = ElementQuery {
            id: None,
            ..query.clone()
        };
        let nodes = self.nodes();
        Ok(&self.found[pick_element(&query, &nodes)?])
    }
}

impl JavaWindow {
    /// The Java window, when the Access Bridge reaches it.
    pub fn attach(window: &WindowInfo) -> Result<Self, StepError> {
        let java_dirs: Vec<PathBuf> = crate::uia::process_path(window.pid)
            .and_then(|p| Path::new(&p).parent().map(Path::to_path_buf))
            .into_iter()
            .collect();
        let me = Self {
            hwnd: window.handle,
            java_dirs,
        };
        me.with(|_| Ok(()))?;
        Ok(me)
    }

    /// Runs `work` on a fresh walk of the window, on the bridge thread.
    fn with<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Walk<'_>) -> Result<T, StepError> + Send + 'static,
    ) -> Result<T, StepError> {
        let hwnd = self.hwnd;
        let dirs = self.java_dirs.clone();
        on_thread(move |state| {
            let api = state.api(&dirs)?;
            let walk = Walk::new(api, hwnd)?;
            work(&walk)
        })
    }
}

impl AppBridge for JavaWindow {
    fn app(&self) -> &'static str {
        "java"
    }

    fn inspect(&self, max_nodes: usize, root: Option<&ElementQuery>) -> Result<Value, StepError> {
        let root = root.cloned();
        self.with(move |walk| {
            let nodes = walk.nodes();
            let nodes = match &root {
                None => nodes,
                Some(query) => {
                    let ctx = walk.pick(query)?.ctx;
                    let start = walk.found.iter().position(|f| f.ctx == ctx).unwrap_or(0);
                    let depth = nodes[start].depth;
                    nodes[start..]
                        .iter()
                        .enumerate()
                        .take_while(|(i, n)| *i == 0 || n.depth > depth)
                        .map(|(_, n)| NodeInfo { depth: n.depth - depth, ..n.clone() })
                        .collect()
                }
            };
            Ok(json!({
                "backend": "java",
                "snapshot": render_tree(&nodes, max_nodes),
                "hint": "Target a Java component with role + name as listed, e.g. { \"window\": …, \"element\": { \"role\": \"button\", \"name\": \"OK\" } }. Java components have no id.",
            }))
        })
    }

    fn probe(&self, element: &ElementQuery) -> Value {
        let query = element.clone();
        self.with(move |walk| {
            Ok(match walk.pick(&query) {
                Ok(f) => json!({ "found": true, "visible": !f.node.offscreen, "enabled": f.node.enabled }),
                Err(_) => json!({ "found": false, "visible": false, "enabled": false }),
            })
        })
        .unwrap_or_else(|_| json!({ "found": false, "visible": false, "enabled": false }))
    }

    fn click(&self, element: &ElementQuery) -> Result<Value, StepError> {
        let query = element.clone();
        self.with(move |walk| {
            let f = walk.pick(&query)?;
            if !f.node.enabled {
                return Err(StepError::new(
                    "ELEMENT_DISABLED",
                    "the element is disabled",
                ));
            }
            walk.api.act(walk.vm, f.ctx)?;
            Ok(Value::Null)
        })
    }

    fn set_value(&self, element: &ElementQuery, value: &Text) -> Result<Value, StepError> {
        let query = element.clone();
        let text = value.value.clone();
        self.with(move |walk| {
            let f = walk.pick(&query)?;
            if !f.text {
                return Err(StepError::permanent(
                    "NOT_SUPPORTED",
                    format!("the {} does not take a value", f.node.role),
                )
                .with_details(
                    json!({ "hint": "Use desktop.type to type into it with the keyboard." }),
                ));
            }
            let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: a NUL-terminated string the bridge copies.
            if unsafe { (walk.api.set_text)(walk.vm, f.ctx, wide.as_ptr()) } == 0 {
                return Err(StepError::permanent(
                    "READ_ONLY",
                    "Java did not take the text (the field may be read-only)",
                )
                .with_details(
                    json!({ "hint": "Use desktop.type to type into it with the keyboard." }),
                ));
            }
            Ok(Value::Null)
        })
    }

    fn get_value(&self, element: &ElementQuery) -> Result<Value, StepError> {
        let query = element.clone();
        self.with(move |walk| {
            let f = walk.pick(&query)?;
            if f.node.password {
                return Err(StepError::permanent(
                    "PASSWORD_FIELD",
                    "password fields cannot be read",
                ));
            }
            if matches!(f.node.role, "checkbox" | "radio") {
                return Ok(Value::Bool(f.node.checked.unwrap_or(false)));
            }
            let text = f
                .text
                .then(|| walk.api.text(walk.vm, f.ctx))
                .flatten()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| f.node.name.clone());
            Ok(Value::String(text))
        })
    }

    fn select(&self, element: &ElementQuery, option: &str) -> Result<Value, StepError> {
        let query = element.clone();
        let option = option.to_owned();
        self.with(move |walk| {
            let f = walk.pick(&query)?;
            let start = walk.found.iter().position(|x| x.ctx == f.ctx).unwrap_or(0);
            let depth = f.node.depth;
            let items: Vec<menu::Item> = walk.found[start + 1..]
                .iter()
                .take_while(|x| x.node.depth > depth)
                .filter(|x| x.node.role == "listitem")
                .map(|x| menu::Item { name: x.node.name.clone(), popup: false, enabled: true })
                .collect();
            let index = menu::pick(&option, &items).map_err(|_| {
                StepError::new("OPTION_NOT_FOUND", format!("no option named '{option}'")).with_details(json!({
                    "options": items.iter().take(50).map(|i| i.name.clone()).collect::<Vec<_>>(),
                    "hint": "Use one of the options listed."
                }))
            })?;
            // SAFETY: selects a child of an object the bridge gave us.
            if unsafe { (walk.api.add_selection)(walk.vm, f.ctx, index as i32) } == 0 {
                return Err(StepError::permanent("NOT_SUPPORTED", "Java did not select the option"));
            }
            Ok(Value::Null)
        })
    }

    fn press(&self, _chord: &Chord) -> Option<Result<Value, StepError>> {
        None
    }

    fn focus(&self, element: &ElementQuery) -> Result<(), StepError> {
        let query = element.clone();
        self.with(move |walk| {
            let f = walk.pick(&query)?;
            // SAFETY: a plain call on an object the bridge gave us.
            unsafe { (walk.api.request_focus)(walk.vm, f.ctx) };
            Ok(())
        })
    }

    fn screen_rect(&self, element: &ElementQuery) -> Result<(i32, i32, i32, i32), StepError> {
        let query = element.clone();
        self.with(move |walk| Ok(walk.pick(&query)?.rect))
    }

    fn menu(&self, path: &[String]) -> Result<Value, StepError> {
        let path = path.to_vec();
        let hwnd = self.hwnd;
        let dirs = self.java_dirs.clone();
        on_thread(move |state| {
            let api = state.api(&dirs)?;
            // The names of the menus opened so far; each level is looked
            // for again under them (Java may build a menu as it opens).
            let mut opened: Vec<String> = Vec::new();
            for (i, name) in path.iter().enumerate() {
                let walk = Walk::new(api, hwnd)?;
                let mut scope = 0..walk.found.len();
                // The menu bar, then the menu last opened.
                let bar = walk.found.iter().position(|f| f.node.role == "menubar");
                if let Some(b) = bar {
                    scope = b..subtree_end(&walk.found, b);
                }
                for open in &opened {
                    if let Some(p) = scope.clone().find(|&j| {
                        walk.found[j].node.role == "menuitem"
                            && menu::normalize(&walk.found[j].node.name) == menu::normalize(open)
                    }) {
                        scope = p + 1..subtree_end(&walk.found, p);
                    }
                }
                // The items of this level: the shallowest menu items in scope.
                let items_in_scope: Vec<usize> = scope
                    .filter(|&j| {
                        matches!(walk.found[j].node.role, "menuitem" | "checkbox" | "radio")
                    })
                    .collect();
                let depth = items_in_scope
                    .iter()
                    .map(|&j| walk.found[j].node.depth)
                    .min()
                    .unwrap_or(0);
                let candidates: Vec<usize> = items_in_scope
                    .into_iter()
                    .filter(|&j| walk.found[j].node.depth == depth)
                    .collect();
                let items: Vec<menu::Item> = candidates
                    .iter()
                    .map(|&j| menu::Item {
                        name: walk.found[j].node.name.clone(),
                        popup: false,
                        enabled: walk.found[j].node.enabled,
                    })
                    .collect();
                let chosen = &walk.found[candidates[menu::pick(name, &items)?]];
                if !chosen.node.enabled {
                    return Err(StepError::permanent(
                        "ELEMENT_DISABLED",
                        format!("the menu item '{}' is greyed out", chosen.node.name),
                    ));
                }
                let last = i + 1 == path.len();
                if !last && chosen.java_role.trim() != "menu" {
                    return Err(StepError::permanent(
                        "MENU_ITEM_NOT_FOUND",
                        format!("'{}' has no submenu", chosen.node.name),
                    ));
                }
                api.act(walk.vm, chosen.ctx)?;
                opened.push(chosen.node.name.clone());
                drop(walk);
                if !last {
                    pump_for(Duration::from_millis(150));
                }
            }
            Ok(Value::Null)
        })
    }

    fn table(&self, element: Option<&ElementQuery>, max_rows: usize) -> Result<Value, StepError> {
        let query = element.cloned();
        self.with(move |walk| {
            let f = match &query {
                Some(q) => walk.pick(q)?,
                None => walk
                    .found
                    .iter()
                    .find(|f| f.node.role == "table" && !f.node.offscreen)
                    .ok_or_else(|| {
                        StepError::new("ELEMENT_NOT_FOUND", "no table is shown in this Java window")
                    })?,
            };
            let api = walk.api;
            let vm = walk.vm;
            let mut info = TableInfo::default();
            // SAFETY: the bridge fills in the struct.
            if unsafe { (api.table_info)(vm, f.ctx, &mut info) } == 0 {
                return Err(StepError::permanent(
                    "NOT_SUPPORTED",
                    format!("the {} is not a table", f.node.role),
                ));
            }
            let mut owned = vec![info.context, info.table, info.caption, info.summary];
            let cell_text = |table: Ctx, row: i32, col: i32, owned: &mut Vec<Ctx>| -> String {
                let mut cell = TableCellInfo::default();
                // SAFETY: the bridge fills in the struct.
                if unsafe { (api.table_cell)(vm, table, row, col, &mut cell) } == 0
                    || cell.context == 0
                {
                    return String::new();
                }
                owned.push(cell.context);
                let text = api
                    .info(vm, cell.context)
                    .map(|i| wide(&i.name))
                    .filter(|t| !t.trim().is_empty())
                    .or_else(|| api.text(vm, cell.context))
                    .unwrap_or_default();
                table::clean_cell(&text)
            };
            let mut header = TableInfo::default();
            let mut headers = Vec::new();
            // SAFETY: the bridge fills in the struct.
            if unsafe { (api.column_header)(vm, f.ctx, &mut header) } != 0 {
                owned.extend([header.context, header.table, header.caption, header.summary]);
                for c in 0..header.column_count {
                    headers.push(cell_text(header.table, 0, c, &mut owned));
                }
            }
            let rows = info.row_count.max(0) as usize;
            let take = rows.min(max_rows);
            let mut cells = Vec::with_capacity(take);
            for r in 0..take {
                let row = (0..info.column_count)
                    .map(|c| cell_text(info.table, r as i32, c, &mut owned))
                    .collect();
                cells.push(row);
                // Release as we go: a long table holds many objects.
                for ctx in owned.drain(4..) {
                    if ctx != 0 {
                        // SAFETY: each object was handed to us once.
                        unsafe { (api.release)(vm, ctx) };
                    }
                }
            }
            for ctx in owned {
                if ctx != 0 && ctx != f.ctx {
                    // SAFETY: each object was handed to us once.
                    unsafe { (api.release)(vm, ctx) };
                }
            }
            let mut grid = Grid {
                headers,
                rows: cells,
                truncated: rows > max_rows,
            };
            grid.drop_blank_columns();
            Ok(grid.to_json())
        })
    }
}

/// The index after the last descendant of `found[i]`.
fn subtree_end(found: &[Found], i: usize) -> usize {
    let depth = found[i].node.depth;
    found[i + 1..]
        .iter()
        .position(|f| f.node.depth <= depth)
        .map_or(found.len(), |p| i + 1 + p)
}
