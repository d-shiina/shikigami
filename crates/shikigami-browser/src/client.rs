//! The adapter child process and its JSON-RPC connection.
//!
//! One Node.js process (packages/browser-adapter) serves every run. It is
//! started on first use; when it dies, in-flight steps fail with
//! `ADAPTER_CRASHED` (retryable) and the next call starts a new one.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use shikigami_runtime::StepError;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Path of the adapter entry point inside the repository / install dir.
pub const ADAPTER_SCRIPT: &str = "packages/browser-adapter/src/main.ts";

/// How to start the adapter.
#[derive(Debug, Clone)]
pub struct BrowserConfig {
    /// Node.js executable (22.18 or later).
    pub node: PathBuf,
    /// The adapter's `main.ts`; `None` when it could not be found.
    pub script: Option<PathBuf>,
}

impl BrowserConfig {
    /// `SHIKIGAMI_NODE` / `SHIKIGAMI_BROWSER_ADAPTER` when set, otherwise
    /// `node` on PATH and the adapter found next to the executable (or the
    /// current directory) or in one of their parents.
    pub fn discover() -> Self {
        let node =
            std::env::var_os("SHIKIGAMI_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from);
        let script = std::env::var_os("SHIKIGAMI_BROWSER_ADAPTER")
            .map(PathBuf::from)
            .or_else(|| {
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(Path::to_path_buf));
                let cwd = std::env::current_dir().ok();
                [exe_dir, cwd]
                    .into_iter()
                    .flatten()
                    .find_map(|start| find_upwards(&start))
            });
        Self { node, script }
    }
}

fn find_upwards(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .map(|dir| dir.join(ADAPTER_SCRIPT))
        .find(|candidate| candidate.is_file())
}

type Reply = Result<Value, StepError>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

struct Connection {
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    // Killed (with its browsers) when the client is dropped.
    _child: Child,
}

/// Shared handle to the adapter process. Cheap to clone via `Arc`.
pub struct BrowserClient {
    config: BrowserConfig,
    connection: tokio::sync::Mutex<Option<Arc<Connection>>>,
    next_id: AtomicU64,
}

fn crashed(message: impl Into<String>) -> StepError {
    StepError::new("ADAPTER_CRASHED", message)
}

impl std::fmt::Debug for BrowserClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserClient")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl BrowserClient {
    pub fn new(config: BrowserConfig) -> Self {
        Self {
            config,
            connection: tokio::sync::Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
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
            return Err(crashed(format!("could not reach the browser adapter: {e}")));
        }

        tokio::select! {
            reply = rx => reply.unwrap_or_else(|_| Err(crashed("the browser adapter stopped during the step"))),
            () = cancel.cancelled() => {
                lock(&connection.pending).remove(&id);
                Err(StepError::permanent("CANCELLED", "cancelled"))
            }
        }
    }

    /// Closes the browser contexts of a finished run (if the adapter runs).
    pub async fn close_run(&self, run_id: &str) {
        let running = self
            .connection
            .lock()
            .await
            .as_ref()
            .is_some_and(|c| c.alive.load(Ordering::SeqCst));
        if running {
            let _ = self
                .call(
                    "closeRun",
                    json!({ "runId": run_id }),
                    &CancellationToken::new(),
                )
                .await;
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
        let unavailable = |message: String| {
            StepError::permanent("ADAPTER_UNAVAILABLE", message).with_details(json!({
                "hint": "Install Node.js 22.18+ and run `pnpm install` in the Shikigami folder, or set SHIKIGAMI_BROWSER_ADAPTER to packages/browser-adapter/src/main.ts."
            }))
        };
        let Some(script) = &self.config.script else {
            return Err(unavailable(format!(
                "browser adapter not found ({ADAPTER_SCRIPT})"
            )));
        };
        let mut command = Command::new(&self.config.node);
        command
            .arg("--experimental-strip-types")
            .arg("--disable-warning=ExperimentalWarning")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // No console window when started from Studio.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|e| {
            unavailable(format!(
                "could not start {} for the browser adapter: {e}",
                self.config.node.display()
            ))
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(crashed("browser adapter pipes unavailable"));
        };

        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        {
            let (pending, alive) = (pending.clone(), alive.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        tracing::warn!(%line, "unexpected output from the browser adapter");
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
                tracing::warn!("browser adapter exited");
            });
        }
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "shikigami_browser::adapter", "{line}");
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
            .unwrap_or("BROWSER_ERROR");
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("browser adapter error");
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
