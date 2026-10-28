//! Out-of-process adapters ("sidecars") spoken to over JSON-RPC 2.0.
//!
//! An adapter written in another language (Node.js + Playwright for the
//! browser, later .NET / Python for Office or other apps) runs as a child
//! process and exchanges newline-delimited JSON-RPC messages on stdin /
//! stdout. One process serves every run; it is started on first use, and
//! when it dies, in-flight calls fail with `ADAPTER_CRASHED` (retryable) and
//! the next call starts a new one.
//!
//! Protocol: requests `{"jsonrpc":"2.0","id":1,"method":"…","params":{…}}`;
//! errors carry `data: { code, retryable, details }`, which become the
//! step's error code, retry decision and details. stderr goes to tracing.

// StepError is the handler error type; boxing it here would only move the
// allocation.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::handler::StepError;

/// How to start a sidecar.
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    /// Short name used in messages and logs, e.g. "browser".
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Working directory of the process (default: inherited).
    pub cwd: Option<PathBuf>,
    /// Why the sidecar cannot be started (e.g. its script was not found);
    /// calls then fail with `ADAPTER_UNAVAILABLE` without trying.
    pub unavailable: Option<String>,
    /// How to fix `ADAPTER_UNAVAILABLE` (shown to people and AI clients).
    pub setup_hint: String,
}

type Reply = Result<Value, StepError>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

struct Connection {
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    // Killed (with anything it started) when the client is dropped.
    _child: Child,
}

/// Shared handle to a sidecar process. Share it via `Arc`.
pub struct SidecarClient {
    config: SidecarConfig,
    connection: tokio::sync::Mutex<Option<Arc<Connection>>>,
    next_id: AtomicU64,
    /// Secret values handed to the process; masked in its stderr lines.
    masked: Arc<Mutex<Vec<String>>>,
}

fn crashed(message: impl Into<String>) -> StepError {
    StepError::new("ADAPTER_CRASHED", message)
}

impl std::fmt::Debug for SidecarClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SidecarClient")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl SidecarClient {
    pub fn new(config: SidecarConfig) -> Self {
        Self {
            config,
            connection: tokio::sync::Mutex::new(None),
            next_id: AtomicU64::new(1),
            masked: Arc::default(),
        }
    }

    /// Masks `value` in what the process writes to stderr from now on.
    /// Call it before handing a secret to the process.
    pub fn mask(&self, value: &str) {
        let mut masked = lock(&self.masked);
        if !value.is_empty() && !masked.iter().any(|v| v == value) {
            masked.push(value.to_owned());
        }
    }

    /// Whether the process is currently running.
    pub async fn is_running(&self) -> bool {
        self.connection
            .lock()
            .await
            .as_ref()
            .is_some_and(|c| c.alive.load(Ordering::SeqCst))
    }

    /// Calls one adapter method. Cancelling `cancel` stops waiting (the
    /// adapter's own timeout ends the operation).
    pub async fn call(&self, method: &str, params: Value, cancel: &CancellationToken) -> Reply {
        let connection = self.connect().await?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        lock(&connection.pending).insert(id, tx);

        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let written = {
            let mut stdin = connection.stdin.lock().await;
            match stdin.write_all(format!("{line}\n").as_bytes()).await {
                Ok(()) => stdin.flush().await,
                Err(e) => Err(e),
            }
        };
        if let Err(e) = written {
            lock(&connection.pending).remove(&id);
            connection.alive.store(false, Ordering::SeqCst);
            return Err(crashed(format!(
                "could not reach the {} adapter: {e}",
                self.config.name
            )));
        }

        tokio::select! {
            reply = rx => reply.unwrap_or_else(|_| Err(crashed(format!("the {} adapter stopped during the step", self.config.name)))),
            () = cancel.cancelled() => {
                lock(&connection.pending).remove(&id);
                Err(StepError::permanent("CANCELLED", "cancelled"))
            }
        }
    }

    async fn connect(&self) -> Result<Arc<Connection>, StepError> {
        let mut slot = self.connection.lock().await;
        if let Some(connection) = slot.as_ref()
            && connection.alive.load(Ordering::SeqCst)
        {
            return Ok(connection.clone());
        }
        let connection = Arc::new(self.spawn()?);
        *slot = Some(connection.clone());
        Ok(connection)
    }

    fn spawn(&self) -> Result<Connection, StepError> {
        let name = &self.config.name;
        let unavailable = |message: String| {
            StepError::permanent("ADAPTER_UNAVAILABLE", message)
                .with_details(json!({ "hint": self.config.setup_hint }))
        };
        if let Some(reason) = &self.config.unavailable {
            return Err(unavailable(format!("{name} adapter unavailable: {reason}")));
        }
        let mut command = Command::new(&self.config.program);
        command
            .args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &self.config.cwd {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        {
            // No console window when started from Studio.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|e| {
            unavailable(format!(
                "could not start {} for the {name} adapter: {e}",
                self.config.program.display()
            ))
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(crashed(format!("{name} adapter pipes unavailable")));
        };

        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        {
            let (pending, alive, name) = (pending.clone(), alive.clone(), name.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        tracing::warn!(%line, adapter = %name, "unexpected output from adapter");
                        continue;
                    };
                    let Some(id) = message.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    if let Some(tx) = lock(&pending).remove(&id) {
                        let _ = tx.send(reply_of(message));
                    }
                }
                // EOF: the process ended. Dropping the senders fails waiters.
                alive.store(false, Ordering::SeqCst);
                lock(&pending).clear();
                tracing::warn!(adapter = %name, "adapter exited");
            });
        }
        let log_name = name.clone();
        let masked = self.masked.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(mut line)) = lines.next_line().await {
                for value in lock(&masked).iter() {
                    line = line.replace(value.as_str(), "***");
                }
                tracing::debug!(target: "shikigami::adapter", adapter = %log_name, "{line}");
            }
        });

        Ok(Connection {
            stdin: tokio::sync::Mutex::new(stdin),
            pending,
            alive,
            _child: child,
        })
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn reply_of(message: Value) -> Reply {
    if let Some(error) = message.get("error") {
        let data = error.get("data");
        let code = data
            .and_then(|d| d.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("ADAPTER_ERROR");
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("adapter error");
        let mut err = StepError::new(code, text);
        err.retryable = data
            .and_then(|d| d.get("retryable"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        err.details = data
            .and_then(|d| d.get("details"))
            .cloned()
            .filter(|d| !d.is_null());
        return Err(err);
    }
    Ok(message.get("result").cloned().unwrap_or(Value::Null))
}
