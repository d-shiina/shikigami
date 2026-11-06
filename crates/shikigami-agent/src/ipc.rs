//! The local pipe other processes use to talk to the agent: one JSON
//! request per line, one JSON response per line.
//!
//! ```text
//! {"op":"status"}                                   → {"ok":true,"status":{…}}
//! {"op":"run","request":{"scenarioId":"scn_…"}}     → {"ok":true,"runId":"run_…"}
//! {"op":"cancel","runId":"run_…"}                   → {"ok":true,"cancelled":true}
//! {"op":"stop"}                                     → {"ok":true}
//! ```
//!
//! Windows: the named pipe `\\.\pipe\shikigami-agent-<hash>`, which only
//! the same user's processes on this PC can write to. Elsewhere (development,
//! CI): a Unix socket in the temp folder. `<hash>` comes from the per-PC
//! folder of the workspace, so each workspace has its own agent.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use shikigami_core::{ErrorPayload, RunId};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use crate::agent::{Agent, AgentStatus, RunRequest};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Status,
    Run { request: RunRequest },
    Cancel { run_id: RunId },
    Stop,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorPayload>,
}

fn ok() -> Response {
    Response {
        ok: true,
        ..Response::default()
    }
}

/// The pipe's name for the workspace whose per-PC folder is `local_root`.
pub fn endpoint(local_root: &Path) -> String {
    // FNV-1a: stable across builds (unlike `DefaultHasher`).
    let text = local_root.to_string_lossy().to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    let name = format!("shikigami-agent-{hash:016x}");
    if cfg!(windows) {
        format!(r"\\.\pipe\{name}")
    } else {
        std::env::temp_dir()
            .join(format!("{name}.sock"))
            .display()
            .to_string()
    }
}

fn single_instance(local_root: &Path) -> std::io::Result<std::fs::File> {
    let dir = local_root.join("agent");
    std::fs::create_dir_all(&dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("agent.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "the agent is already running for this workspace",
        )),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

/// The agent's end of the pipe. Holding it keeps other agents for the same
/// workspace from starting.
pub struct Listener {
    _instance: std::fs::File,
    name: String,
    #[cfg(unix)]
    inner: tokio::net::UnixListener,
    #[cfg(windows)]
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}

impl Listener {
    pub fn bind(local_root: &Path) -> std::io::Result<Self> {
        let instance = single_instance(local_root)?;
        let name = endpoint(local_root);
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&name);
            let inner = tokio::net::UnixListener::bind(&name)?;
            Ok(Self {
                _instance: instance,
                name,
                inner,
            })
        }
        #[cfg(windows)]
        {
            let next = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(&name)?;
            Ok(Self {
                _instance: instance,
                name,
                next,
            })
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

#[cfg(unix)]
impl Drop for Listener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.name);
    }
}

/// Answers requests until the task is aborted.
#[cfg_attr(unix, allow(unused_mut))]
pub async fn serve(mut listener: Listener, agent: Arc<Agent>) {
    loop {
        #[cfg(unix)]
        let conn = match listener.inner.accept().await {
            Ok((conn, _)) => conn,
            Err(e) => {
                tracing::warn!(error = %e, "agent pipe");
                continue;
            }
        };
        #[cfg(windows)]
        let conn = {
            if let Err(e) = listener.next.connect().await {
                tracing::warn!(error = %e, "agent pipe");
                continue;
            }
            let fresh = match tokio::net::windows::named_pipe::ServerOptions::new()
                .reject_remote_clients(true)
                .create(&listener.name)
            {
                Ok(fresh) => fresh,
                Err(e) => {
                    tracing::warn!(error = %e, "agent pipe");
                    return;
                }
            };
            std::mem::replace(&mut listener.next, fresh)
        };
        tokio::spawn(handle(conn, Arc::clone(&agent)));
    }
}

async fn handle<C: AsyncRead + AsyncWrite + Unpin>(conn: C, agent: Arc<Agent>) {
    let (read, mut write) = tokio::io::split(conn);
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => answer(&agent, request),
            Err(e) => Response {
                error: Some(ErrorPayload {
                    code: "INVALID_REQUEST".into(),
                    message: e.to_string(),
                    details: None,
                }),
                ..Response::default()
            },
        };
        let Ok(mut out) = serde_json::to_vec(&response) else {
            return;
        };
        out.push(b'\n');
        if write.write_all(&out).await.is_err() {
            return;
        }
    }
}

fn answer(agent: &Arc<Agent>, request: Request) -> Response {
    match request {
        Request::Status => Response {
            status: Some(agent.status()),
            ..ok()
        },
        Request::Run { request } => match agent.start(request, None) {
            Ok(run_id) => Response {
                run_id: Some(run_id),
                ..ok()
            },
            Err(e) => Response {
                error: Some(e),
                ..Response::default()
            },
        },
        Request::Cancel { run_id } => Response {
            cancelled: Some(agent.cancel(&run_id)),
            ..ok()
        },
        Request::Stop => {
            agent.stop();
            ok()
        }
    }
}

/// Sends one request to the agent of the workspace at `local_root`.
/// `NotFound` / `ConnectionRefused` mean no agent is running.
pub async fn call(local_root: &Path, request: &Request) -> std::io::Result<Response> {
    let name = endpoint(local_root);
    #[cfg(unix)]
    let conn = tokio::net::UnixStream::connect(&name).await?;
    #[cfg(windows)]
    let conn = {
        let mut tries = 0;
        loop {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(&name) {
                Ok(conn) => break conn,
                // ERROR_PIPE_BUSY: every instance is taken; try again shortly.
                Err(e) if e.raw_os_error() == Some(231) && tries < 50 => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(e) => return Err(e),
            }
        }
    };
    let (read, mut write) = tokio::io::split(conn);
    let mut line = serde_json::to_vec(request)?;
    line.push(b'\n');
    write.write_all(&line).await?;
    let mut lines = BufReader::new(read).lines();
    match lines.next_line().await? {
        Some(line) => Ok(serde_json::from_str(&line)?),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the agent closed the pipe",
        )),
    }
}

/// Whether no agent answers (as opposed to another failure).
pub fn not_running(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
    )
}
