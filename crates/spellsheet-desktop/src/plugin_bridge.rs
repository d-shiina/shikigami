//! Ways into apps that plugins provide (`bridge` in `spellsheet-plugin.json`).
//!
//! UI Automation sees only part of some apps (SAP GUI, for one). A plugin
//! can declare which windows it reaches better and answer the `bridge.*`
//! calls for them; the `desktop.*` steps on such a window then go through
//! it, and what it cannot do falls back to UI Automation, the same as for
//! the Java Access Bridge built into SpellSheet.
//!
//! The plugin is started as its own process (the same program as its
//! steps, a second instance) and spoken to in newline JSON-RPC from the UI
//! Automation thread, one call at a time (docs/design/plugins.md §10).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spellsheet_runtime::StepError;

use crate::backend::Text;
use crate::target::process_key;

/// A window a plugin reaches: every field given must match.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowMatch {
    /// The window class, exactly (`SAP_FRONTEND_SESSION`).
    pub class_name: Option<String>,
    /// The process, without `.exe`, case-insensitive (`saplogon`).
    pub process: Option<String>,
}

impl WindowMatch {
    pub fn matches(&self, class_name: &str, process: &str) -> bool {
        let class_ok = self.class_name.as_deref().is_none_or(|c| c == class_name);
        let process_ok = self
            .process
            .as_deref()
            .is_none_or(|p| process_key(p) == process_key(process));
        (self.class_name.is_some() || self.process.is_some()) && class_ok && process_ok
    }
}

/// What a plugin declared and how to start it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeSpec {
    /// The plugin's name.
    pub plugin: String,
    /// The app name inspect_ui shows for its windows (`sapgui`).
    pub app: String,
    pub windows: Vec<WindowMatch>,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub dir: PathBuf,
}

static BRIDGES: OnceLock<Vec<BridgeSpec>> = OnceLock::new();

/// Sets the plugin bridges for this process, once (plugins are read when
/// the process starts; a newly installed plugin takes effect on restart).
/// Later calls are ignored.
pub fn register(specs: Vec<BridgeSpec>) {
    let _ = BRIDGES.set(specs);
}

/// The registered bridges.
pub fn registered() -> &'static [BridgeSpec] {
    BRIDGES.get().map_or(&[], Vec::as_slice)
}

/// The bridge whose windows include this one.
pub fn for_window(class_name: &str, process: &str) -> Option<&'static BridgeSpec> {
    registered()
        .iter()
        .find(|b| b.windows.iter().any(|w| w.matches(class_name, process)))
}

/// The prefix of the secret site that lets a plugin receive the secret
/// (`plugin:sap`), as for plugin steps.
pub const PLUGIN_SITE_PREFIX: &str = "plugin:";

/// How long one call may take before the plugin is given up on.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// A running bridge process.
pub struct Connection {
    spec: &'static BridgeSpec,
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    /// Secret values handed to the process; masked in its stderr lines.
    masked: Arc<Mutex<Vec<String>>>,
    timeout: Duration,
    next_id: u64,
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Connection {
    pub fn start(spec: &'static BridgeSpec) -> Result<Self, StepError> {
        let mut child = Command::new(&spec.program)
            .args(&spec.args)
            .current_dir(&spec.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                StepError::permanent(
                    "PLUGIN_UNAVAILABLE",
                    format!(
                        "the plugin '{}' could not be started: {e}",
                        spec.plugin
                    ),
                )
                .with_details(json!({ "hint": format!("Check that `{}` can be started and that the plugin folder {} is complete.", spec.program.display(), spec.dir.display()) }))
            })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(StepError::permanent(
                "PLUGIN_UNAVAILABLE",
                "the plugin's input and output could not be opened",
            ));
        };
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        // Diagnostics go to the log, with the secrets it was handed masked.
        let masked: Arc<Mutex<Vec<String>>> = Arc::default();
        let (to_mask, plugin) = (masked.clone(), spec.plugin.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(mut line) = line else { break };
                for value in lock(&to_mask).iter() {
                    line = line.replace(value.as_str(), "***");
                }
                tracing::debug!(target: "spellsheet::adapter", adapter = %plugin, "{line}");
            }
        });
        Ok(Self {
            spec,
            child,
            stdin,
            lines,
            masked,
            timeout: CALL_TIMEOUT,
            next_id: 1,
        })
    }

    pub fn spec(&self) -> &'static BridgeSpec {
        self.spec
    }

    /// Masks `value` in what the process writes to stderr from now on.
    pub fn mask(&self, value: &str) {
        if !value.is_empty() {
            let mut masked = lock(&self.masked);
            if !masked.iter().any(|v| v == value) {
                masked.push(value.to_owned());
            }
        }
    }

    /// Calls `method` and waits for its answer, [`CALL_TIMEOUT`] at most
    /// however much else the process writes meanwhile.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, StepError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let gone = |what: &str| {
            StepError::new(
                "PLUGIN_UNAVAILABLE",
                format!("the plugin '{}' {what}", self.spec.plugin),
            )
        };
        writeln!(self.stdin, "{request}")
            .and_then(|()| self.stdin.flush())
            .map_err(|_| gone("stopped"))?;
        let deadline = Instant::now() + self.timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = match self.lines.recv_timeout(left) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => {
                    return Err(StepError::new(
                        "TIMEOUT",
                        format!(
                            "the plugin '{}' did not answer {method} in {} s",
                            self.spec.plugin,
                            self.timeout.as_secs()
                        ),
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => return Err(gone("stopped")),
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                // Not an answer (stray output): skip it.
                continue;
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            return match message.get("error") {
                Some(error) => Err(step_error(error)),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A JSON-RPC error as a step error, the same way plugin steps report them:
/// `data.code`, `data.retryable`, `data.details`.
fn step_error(error: &Value) -> StepError {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the plugin failed")
        .to_owned();
    let data = error.get("data");
    let code = data
        .and_then(|d| d.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("PLUGIN_ERROR")
        .to_owned();
    let retryable = data
        .and_then(|d| d.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut e = if retryable {
        StepError::new(code, message)
    } else {
        StepError::permanent(code, message)
    };
    if let Some(details) = data.and_then(|d| d.get("details")) {
        e = e.with_details(details.clone());
    }
    e
}

/// Whether `text` may be handed to the plugin `plugin`: plain text always,
/// a secret only when its sites list `plugin:<name>` (the app it is typed
/// into was checked by the caller; this is about who gets to see it).
pub fn secret_allowed(text: &Text, plugin: &str) -> Result<(), StepError> {
    if text.allowed_apps.is_none()
        || text
            .allowed_plugins
            .iter()
            .any(|p| p.eq_ignore_ascii_case(plugin))
    {
        return Ok(());
    }
    let site = format!("{PLUGIN_SITE_PREFIX}{plugin}");
    Err(StepError::permanent(
        "SECRET_PLUGIN_NOT_ALLOWED",
        format!("this secret may not be passed to the {plugin} plugin, which reaches this window"),
    )
    .with_details(json!({
        "hint": format!("Ask the user to add {site} to this secret's sites in Writer (シークレット) if this plugin may use it, or type it with desktop.type, which uses the real keyboard.")
    })))
}

#[cfg(windows)]
pub use app::PluginWindow;

#[cfg(windows)]
mod app {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use serde_json::{Value, json};
    use spellsheet_runtime::StepError;

    use super::{BridgeSpec, Connection};
    use crate::backend::Text;
    use crate::bridge::AppBridge;
    use crate::keys::Chord;
    use crate::target::{ElementQuery, WindowInfo};

    thread_local! {
        /// Bridge processes kept running on the UI Automation thread, by
        /// plugin name.
        static RUNNING: RefCell<HashMap<String, Connection>> = RefCell::new(HashMap::new());
    }

    /// A window reached through a plugin.
    pub struct PluginWindow {
        spec: &'static BridgeSpec,
        hwnd: isize,
    }

    impl PluginWindow {
        /// Asks the plugin whether it reaches `window` (`bridge.attach`).
        pub fn attach(spec: &'static BridgeSpec, window: &WindowInfo) -> Result<Self, StepError> {
            let this = Self {
                spec,
                hwnd: window.handle,
            };
            this.call(
                "bridge.attach",
                json!({ "title": window.title, "process": window.process, "className": window.class_name }),
            )?;
            Ok(this)
        }

        fn call(&self, method: &str, params: Value) -> Result<Value, StepError> {
            self.call_with(method, params, None)
        }

        /// `secret`: a value in `params` to mask in the plugin's diagnostics.
        fn call_with(
            &self,
            method: &str,
            mut params: Value,
            secret: Option<&str>,
        ) -> Result<Value, StepError> {
            params["hwnd"] = json!(self.hwnd);
            RUNNING.with(|running| {
                let mut running = running.borrow_mut();
                if !running.contains_key(&self.spec.plugin) {
                    running.insert(self.spec.plugin.clone(), Connection::start(self.spec)?);
                }
                let Some(connection) = running.get_mut(&self.spec.plugin) else {
                    return Err(StepError::new(
                        "PLUGIN_UNAVAILABLE",
                        "the plugin is not running",
                    ));
                };
                if let Some(secret) = secret {
                    connection.mask(secret);
                }
                let result = connection.call(method, params);
                if result
                    .as_ref()
                    .is_err_and(|e| e.code == "PLUGIN_UNAVAILABLE" || e.code == "TIMEOUT")
                {
                    // Started again on the next call.
                    running.remove(&self.spec.plugin);
                }
                result
            })
        }

        fn element(element: &ElementQuery) -> Value {
            serde_json::to_value(element).unwrap_or(Value::Null)
        }
    }

    impl AppBridge for PluginWindow {
        fn app(&self) -> &'static str {
            &self.spec.app
        }

        fn inspect(
            &self,
            max_nodes: usize,
            root: Option<&ElementQuery>,
        ) -> Result<Value, StepError> {
            self.call(
                "bridge.inspect",
                json!({ "maxNodes": max_nodes, "root": root.map(Self::element) }),
            )
        }

        fn probe(&self, element: &ElementQuery) -> Value {
            self.call("bridge.probe", json!({ "element": Self::element(element) }))
                .unwrap_or_else(|_| json!({ "found": false, "visible": false, "enabled": false }))
        }

        fn click(&self, element: &ElementQuery) -> Result<Value, StepError> {
            self.call("bridge.click", json!({ "element": Self::element(element) }))
        }

        fn set_value(&self, element: &ElementQuery, value: &Text) -> Result<Value, StepError> {
            super::secret_allowed(value, &self.spec.plugin)?;
            let secret = value.allowed_apps.is_some();
            self.call_with(
                "bridge.setValue",
                json!({ "element": Self::element(element), "value": value.value, "secret": secret }),
                secret.then_some(value.value.as_str()),
            )
        }

        fn get_value(&self, element: &ElementQuery) -> Result<Value, StepError> {
            self.call(
                "bridge.getValue",
                json!({ "element": Self::element(element) }),
            )
        }

        fn select(&self, element: &ElementQuery, option: &str) -> Result<Value, StepError> {
            self.call(
                "bridge.select",
                json!({ "element": Self::element(element), "option": option }),
            )
        }

        fn press(&self, chord: &Chord) -> Option<Result<Value, StepError>> {
            let keys = json!({
                "modifiers": chord.modifiers.iter().map(|k| k.vk).collect::<Vec<_>>(),
                "key": chord.key.vk,
            });
            match self.call("bridge.press", json!({ "chord": keys })) {
                // `null`: the plugin leaves the key to the real keyboard.
                Ok(Value::Null) => None,
                other => Some(other),
            }
        }

        fn focus(&self, element: &ElementQuery) -> Result<(), StepError> {
            self.call("bridge.focus", json!({ "element": Self::element(element) }))
                .map(|_| ())
        }

        fn screen_rect(&self, element: &ElementQuery) -> Result<(i32, i32, i32, i32), StepError> {
            let rect = self.call(
                "bridge.screenRect",
                json!({ "element": Self::element(element) }),
            )?;
            let n = |key: &str| rect.get(key).and_then(Value::as_i64).unwrap_or(0) as i32;
            Ok((n("left"), n("top"), n("width"), n("height")))
        }

        fn menu(&self, path: &[String]) -> Result<Value, StepError> {
            self.call("bridge.menu", json!({ "path": path }))
        }

        fn table(
            &self,
            element: Option<&ElementQuery>,
            max_rows: usize,
        ) -> Result<Value, StepError> {
            self.call(
                "bridge.table",
                json!({ "element": element.map(Self::element), "maxRows": max_rows }),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_matches_need_a_field_and_all_given_fields() {
        let sap = WindowMatch {
            class_name: Some("SAP_FRONTEND_SESSION".into()),
            process: None,
        };
        assert!(sap.matches("SAP_FRONTEND_SESSION", "saplogon.exe"));
        assert!(!sap.matches("Notepad", "saplogon.exe"));
        let logon = WindowMatch {
            class_name: None,
            process: Some("SAPLogon.exe".into()),
        };
        assert!(logon.matches("#32770", "saplogon.exe"));
        assert!(logon.matches("#32770", "saplogon"));
        assert!(!WindowMatch::default().matches("x", "y"));
    }

    #[test]
    fn errors_keep_the_plugin_code_and_hint() {
        let e = step_error(&json!({
            "code": -32000,
            "message": "scripting is off",
            "data": { "code": "SAP_SCRIPTING_OFF", "retryable": false, "details": { "hint": "RZ11" } }
        }));
        assert_eq!(e.code, "SAP_SCRIPTING_OFF");
        assert!(!e.retryable);
        assert_eq!(e.details, Some(json!({ "hint": "RZ11" })));
        assert_eq!(step_error(&json!({ "message": "x" })).code, "PLUGIN_ERROR");
    }

    #[test]
    fn calls_a_running_bridge_and_skips_stray_lines() {
        let dir = tempfile::tempdir().unwrap();
        // Echoes each request's method back as the result, after a stray line.
        let script = dir.path().join("bridge.mjs");
        std::fs::write(
            &script,
            r#"import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  console.log("not json");
  if (req.method === "bridge.fail") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no", data: { code: "NOPE" } } }));
  } else {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { method: req.method, hwnd: req.params.hwnd } }));
  }
});
"#,
        )
        .unwrap();
        let Ok(node) = which_node() else {
            eprintln!("node not found: skipped");
            return;
        };
        let spec: &'static BridgeSpec = Box::leak(Box::new(BridgeSpec {
            plugin: "fake".into(),
            app: "fake".into(),
            windows: vec![],
            program: node,
            args: vec!["bridge.mjs".into()],
            dir: dir.path().to_path_buf(),
        }));
        let mut c = Connection::start(spec).unwrap();
        let r = c.call("bridge.inspect", json!({ "hwnd": 7 })).unwrap();
        assert_eq!(r, json!({ "method": "bridge.inspect", "hwnd": 7 }));
        let e = c.call("bridge.fail", json!({})).unwrap_err();
        assert_eq!(e.code, "NOPE");
        let r = c.call("bridge.click", json!({ "hwnd": 1 })).unwrap();
        assert_eq!(r["method"], "bridge.click");
    }

    #[test]
    fn a_secret_reaches_only_a_plugin_it_lists() {
        let plain = Text {
            value: "x".into(),
            allowed_apps: None,
            allowed_plugins: vec![],
        };
        assert!(secret_allowed(&plain, "sap").is_ok());
        let mut secret = Text {
            value: "pw".into(),
            allowed_apps: Some(vec!["app:saplogon.exe".into()]),
            allowed_plugins: vec![],
        };
        let e = secret_allowed(&secret, "sap").unwrap_err();
        assert_eq!(e.code, "SECRET_PLUGIN_NOT_ALLOWED");
        assert!(
            e.details.unwrap()["hint"]
                .as_str()
                .unwrap()
                .contains("plugin:sap")
        );
        secret.allowed_plugins = vec!["sap".into()];
        assert!(secret_allowed(&secret, "sap").is_ok());
        assert!(secret_allowed(&secret, "other").is_err());
    }

    #[test]
    fn a_chatty_bridge_still_times_out() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("bridge.mjs"),
            "setInterval(() => console.log('still here'), 50);\n",
        )
        .unwrap();
        let Ok(node) = which_node() else {
            eprintln!("node not found: skipped");
            return;
        };
        let spec: &'static BridgeSpec = Box::leak(Box::new(BridgeSpec {
            plugin: "chatty".into(),
            app: "chatty".into(),
            windows: vec![],
            program: node,
            args: vec!["bridge.mjs".into()],
            dir: dir.path().to_path_buf(),
        }));
        let mut c = Connection::start(spec).unwrap();
        c.timeout = Duration::from_millis(400);
        let started = Instant::now();
        let e = c.call("bridge.inspect", json!({})).unwrap_err();
        assert_eq!(e.code, "TIMEOUT");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    fn which_node() -> Result<PathBuf, ()> {
        let ok = Command::new("node")
            .arg("--version")
            .stdout(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if ok {
            Ok(PathBuf::from("node"))
        } else {
            Err(())
        }
    }
}
