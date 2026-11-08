//! The AI pane: runs the person's own coding agent (Claude Code, Codex,
//! Gemini CLI or GitHub Copilot) in the background with Shikigami's MCP
//! server, one process per message. What differs between them is in
//! `providers`.
//!
//! Studio never talks to a model itself. The agent sees exactly what any MCP
//! client sees, its edits land in the review queue like any other AI edit,
//! and a message carrying a registered secret value is refused before it
//! leaves the PC. See docs/design/studio-ai-pane.md.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use shikigami_core::{ErrorPayload, UserConfig};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::AppState;

mod providers;
pub use providers::AgentKind;
use providers::{CodexStream, CopilotStream, GeminiStream, KNOWN, Turn, child_path};

pub(crate) const AGENT_EVENT: &str = "agent-event";

/// Name the MCP server is given in the agent; tool names start with
/// `mcp__shikigami__` in Claude Code.
pub(crate) const SERVER: &str = "shikigami";
const STDERR_TAIL: usize = 2000;
pub(crate) const TOOL_ERROR_LEN: usize = 300;

const SYSTEM_PROMPT: &str = "\
You are an AI called from inside Shikigami Studio (RPA for Windows). You are talking with the person using Studio.
- Read, edit and test-run flows only with the shikigami MCP tools. Files and commands are not available.
- When you edit, write `summary` in the person's language and plain words, no step types or expressions: the first line says what the flow now does differently, then why. Put anything only the person can decide (your assumptions about their business) in `checks`, one question each. Your edits are already in the flow; they queue up in Studio's review, where a person checks what they do.
- The person watches the flow chart while you work, so build a new flow where they can see it grow: when the flow open in Studio has no steps, build in it (update_flow, add_step) instead of creating another; otherwise create_flow with just its name and variables (no steps). Then add the steps in flow order, a few at a time (one update_flow with a handful of addStep ops per call), not all in one call.
- When asked to fix something that was sent back, read the feedback in get_flow (details in get_review), fix it as noted, and briefly report what you fixed.
- Never ask for or accept passwords or authentication codes. Refer to logins by secret name; if a secret is missing, ask the person to register it under Secrets in Studio.
- Reply briefly, in the language the person writes in (Japanese or English): what you did, and what the person should do next.";

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// `config.json` → `agent`. Without it Studio looks for Claude Code.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfig {
    #[serde(default)]
    kind: AgentKind,
    /// The executable. A known agent is looked up on PATH when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<PathBuf>,
    /// For `command`: its arguments. `{mcpConfig}` becomes the path of an MCP
    /// config file for Shikigami and `{workspace}` the workspace folder. The
    /// message is written to stdin; each stdout line is shown as the reply.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    args: Vec<String>,
    /// Shown in the pane, e.g. "Gemini CLI".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

impl AgentConfig {
    fn load() -> Self {
        let Some(value) = UserConfig::load().extra.get("agent").cloned() else {
            return Self::default();
        };
        serde_json::from_value(value).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "ignoring unreadable agent settings");
            Self::default()
        })
    }

    fn name(&self) -> String {
        self.name
            .clone()
            .unwrap_or_else(|| self.kind.label().to_owned())
    }

    fn executable(&self) -> Option<PathBuf> {
        match &self.command {
            Some(command) => resolve(command),
            None => self.kind.find(),
        }
    }

    /// Switches to `kind`. The settings that belong to one agent (its own
    /// `command`, `args`, `name`) are put aside under `saved.<kind>` and come
    /// back when that agent is chosen again, so trying another is harmless.
    fn select(kind: AgentKind) -> CmdResult<()> {
        let mut config = UserConfig::load();
        let agent = config.extra.get("agent").cloned().unwrap_or_default();
        config
            .extra
            .insert("agent".to_owned(), Self::switched(agent, kind));
        config
            .save()
            .map_err(|e| err("STORAGE_ERROR", e.to_string()))
    }

    fn switched(agent: Value, kind: AgentKind) -> Value {
        const OWN: [&str; 3] = ["command", "args", "name"];
        let mut agent = match agent {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        let from = agent
            .get("kind")
            .cloned()
            .and_then(|k| serde_json::from_value::<AgentKind>(k).ok())
            .unwrap_or_default();
        if from == kind {
            return Value::Object(agent);
        }
        let mut saved = match agent.remove("saved") {
            Some(Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        let own: serde_json::Map<String, Value> = OWN
            .iter()
            .filter_map(|k| agent.remove(*k).map(|v| ((*k).to_owned(), v)))
            .collect();
        let key = |k: AgentKind| {
            serde_json::to_value(k)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        };
        if !own.is_empty() {
            saved.insert(key(from), Value::Object(own));
        }
        if let Some(Value::Object(back)) = saved.remove(&key(kind)) {
            agent.extend(back);
        }
        agent.insert("kind".to_owned(), json!(kind));
        if !saved.is_empty() {
            agent.insert("saved".to_owned(), Value::Object(saved));
        }
        Value::Object(agent)
    }
}

/// What the pane shows before the first message.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    available: bool,
    kind: AgentKind,
    name: String,
    command: Option<String>,
    /// Why the agent cannot be used, in words for the person.
    problem: Option<String>,
    /// Whether a conversation continues across messages (`--resume`).
    remembers: bool,
    /// Studio can install the agent itself (a known one, not found yet).
    installable: bool,
    /// The pane can sign it in (`agent_login`).
    signs_in: bool,
}

/// One of the agents Studio knows, for choosing which to use.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChoice {
    kind: AgentKind,
    name: &'static str,
    maker: &'static str,
    /// Found on this PC.
    installed: bool,
    /// The one in use.
    selected: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    message: String,
    /// The conversation to continue, from an earlier `session` event.
    session_id: Option<String>,
    /// The flow open in Studio, so "this step" has a meaning.
    #[serde(alias = "scenario")]
    flow: Option<FlowRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRef {
    id: String,
    name: String,
    /// The step selected on the flow chart.
    step_id: Option<String>,
    /// The flow has no steps yet (e.g. just made with 新規作成).
    #[serde(default)]
    empty: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    /// The conversation id to send with the next message.
    Session {
        session_id: String,
    },
    Text {
        text: String,
    },
    /// The agent has begun writing a Shikigami tool call (its input is still
    /// being written, which takes a while for a large edit).
    Preparing {
        name: String,
    },
    /// A Shikigami tool call; `detail` is the edit's summary when it has one.
    Tool {
        name: String,
        detail: Option<String>,
    },
    ToolFailed {
        message: String,
    },
    /// The agent created a flow, so a conversation that began without
    /// one now belongs to it.
    Created {
        flow_id: String,
        name: String,
    },
    Done {
        ok: bool,
        message: Option<String>,
        cost_usd: Option<f64>,
        /// The agent is signed out or its login expired: `agent_login` fixes it.
        needs_login: bool,
    },
}

impl AgentEvent {
    fn done(ok: bool, message: Option<String>, cost_usd: Option<f64>) -> Self {
        let needs_login = !ok && message.as_deref().is_some_and(is_login_error);
        Self::Done {
            ok,
            message,
            cost_usd,
            needs_login,
        }
    }
}

/// An agent's wording when it cannot use the account, e.g. Claude Code's
/// "Failed to authenticate: OAuth session expired" or "Not logged in · Please
/// run /login", Codex's "401 Unauthorized", Gemini CLI's "API key not valid",
/// Copilot's "No authentication information found".
fn is_login_error(message: &str) -> bool {
    let m = message.to_lowercase();
    [
        "oauth",
        "not logged in",
        "failed to authenticate",
        "/login",
        "invalid api key",
        "authentication_error",
        "codex login",
        "401 unauthorized",
        "api key not valid",
        "auth method",
        "no authentication",
        "not authenticated",
    ]
    .iter()
    .any(|k| m.contains(k))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    turn_id: String,
    #[serde(flatten)]
    event: AgentEvent,
}

/// Turns in flight, so the pane can stop one.
#[derive(Default)]
pub(crate) struct AgentTurns {
    next: AtomicU64,
    running: Mutex<HashMap<String, CancellationToken>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[tauri::command]
pub fn agent_info() -> AgentInfo {
    // A dev build rebuilds the MCP server before the first message; start
    // now, while the person is still typing, instead of after they send.
    #[cfg(debug_assertions)]
    tauri::async_runtime::spawn(async {
        let _ = refresh_dev_cli().await;
    });
    let config = AgentConfig::load();
    let command = config.executable();
    let problem = match (&command, cli_path()) {
        (None, _) if config.kind != AgentKind::Command && config.command.is_none() => Some(format!(
            "{} がまだインストールされていません。AI ペインの「AI を使う準備」から、その場でインストールしてサインインできます。",
            config.name()
        )),
        (None, _) => Some("config.json の agent.command が見つかりません。".to_owned()),
        (Some(_), None) => Some(
            "shikigami コマンド（MCP サーバー）が見つかりません。Studio と同じフォルダに置いてください。"
                .to_owned(),
        ),
        _ => None,
    };
    AgentInfo {
        available: problem.is_none(),
        // Only the default lookup: an explicit `agent.command` that is missing
        // is the person's path to fix, and the installer would not put it there.
        installable: command.is_none()
            && config.kind != AgentKind::Command
            && config.command.is_none(),
        kind: config.kind,
        signs_in: config.kind.login_args().is_some() || config.kind == AgentKind::Gemini,
        name: config.name(),
        command: command.map(|p| p.display().to_string()),
        problem,
        remembers: config.kind.remembers(),
    }
}

/// The agents Studio can run, and which are on this PC.
#[tauri::command]
pub fn agent_choices() -> Vec<AgentChoice> {
    let config = AgentConfig::load();
    KNOWN
        .iter()
        .map(|&kind| AgentChoice {
            kind,
            name: kind.label(),
            maker: kind.maker(),
            installed: kind.find().is_some(),
            selected: config.kind == kind,
        })
        .collect()
}

/// Uses `kind` from the next message on (`config.json` → `agent.kind`).
#[tauri::command]
pub fn agent_select(kind: AgentKind) -> CmdResult<AgentInfo> {
    AgentConfig::select(kind)?;
    Ok(agent_info())
}

pub(crate) const INSTALL_EVENT: &str = "agent-install";

/// Progress of the agent's installer run in the background for the pane.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InstallEvent {
    /// A line the installer printed (downloading, done…).
    Progress { line: String },
    Done {
        ok: bool,
        message: Option<String>,
        /// Installed but not signed in yet: `agent_login` is the next step.
        needs_login: bool,
    },
    /// Stopped on request, and the installer is gone: another can start.
    Cancelled,
}

/// The installer in flight, so the pane can stop it.
#[derive(Default)]
pub(crate) struct AgentInstall {
    cancel: Mutex<Option<CancellationToken>>,
}

/// Installs an agent from the pane, for the person's own account, without a
/// terminal: Claude Code with its own installer (the one its documentation
/// gives: a PowerShell script on Windows, a shell script elsewhere), the
/// others with npm, after installing Node.js with winget when it is missing.
/// Progress arrives as `agent-install`; once installed, it is the one used.
#[tauri::command]
pub async fn agent_install(
    app: AppHandle,
    install: State<'_, AgentInstall>,
    kind: AgentKind,
) -> CmdResult<()> {
    let config = AgentConfig::load();
    if kind == AgentKind::Command || (config.kind == kind && config.command.is_some()) {
        return Err(err(
            "AGENT_INSTALL_UNSUPPORTED",
            "この AI は、その AI の手順でインストールしてください",
        ));
    }
    if lock(&install.cancel).is_some() {
        return Err(err(
            "AGENT_INSTALL_RUNNING",
            "インストールが進んでいます。終わるまでお待ちください",
        ));
    }
    let script = install_script(kind);
    let mut command = if cfg!(windows) {
        let mut c = Command::new("powershell");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &script]);
        c
    };
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    // Its own process group, so stopping it stops the pipeline (curl | bash), not only the shell.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| err("AGENT_FAILED", format!("インストールを始められません: {e}")))?;
    let cancel = CancellationToken::new();
    *lock(&install.cancel) = Some(cancel.clone());

    tauri::async_runtime::spawn(async move {
        let emit = |event: InstallEvent| {
            let _ = app.emit(INSTALL_EVENT, event);
        };
        let mut stderr = child.stderr.take();
        let stderr_task = tauri::async_runtime::spawn(async move {
            let mut buf = Vec::new();
            if let Some(s) = stderr.as_mut() {
                let _ = s.read_to_end(&mut buf).await;
            }
            String::from_utf8_lossy(&buf).into_owned()
        });
        let mut stopped = false;
        if let Some(stdout) = child.stdout.take() {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                tokio::select! {
                    () = cancel.cancelled() => {
                        kill_tree(&mut child);
                        stopped = true;
                        break;
                    }
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => {
                            let line = strip_ansi(line.trim());
                            if !line.is_empty() {
                                emit(InstallEvent::Progress { line });
                            }
                        }
                        Ok(None) | Err(_) => break,
                    }
                }
            }
        }
        let status = child.wait().await;
        let stderr = stderr_task.await.unwrap_or_default();
        // The next installer may start once this one is gone.
        *lock(&app.state::<AgentInstall>().cancel) = None;
        if stopped {
            emit(InstallEvent::Cancelled);
            return;
        }
        let installed = kind.find();
        let ok =
            status.as_ref().is_ok_and(std::process::ExitStatus::success) && installed.is_some();
        if ok && let Err(e) = AgentConfig::select(kind) {
            tracing::warn!(error = %e.message, "cannot switch to the installed agent");
        }
        let needs_login = match &installed {
            Some(program) if ok => !logged_in(kind, program).await,
            _ => false,
        };
        let message = (!ok).then(|| {
            let tail = tail(strip_ansi(stderr.trim()).trim(), STDERR_TAIL);
            if tail.is_empty() {
                "インストールできませんでした".to_owned()
            } else {
                tail
            }
        });
        emit(InstallEvent::Done {
            ok,
            message,
            needs_login,
        });
    });
    Ok(())
}

/// The installer for `kind`, run by PowerShell on Windows and `sh` elsewhere.
fn install_script(kind: AgentKind) -> String {
    let Some(package) = kind.npm_package() else {
        return if cfg!(windows) {
            "irm https://claude.ai/install.ps1 | iex".to_owned()
        } else {
            "curl -fsSL https://claude.ai/install.sh | bash".to_owned()
        };
    };
    if cfg!(windows) {
        // Node.js first when npm is missing (winget asks for permission
        // itself); then npm from where that installer put it.
        format!(
            "$ErrorActionPreference = 'Stop'; \
             if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {{ \
               Write-Output 'Node.js をインストールしています…'; \
               winget install --exact --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements; \
               $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') \
             }}; \
             npm install --global {package}; \
             if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}"
        )
    } else {
        format!("npm install --global {package}")
    }
}

/// Asks the installer to stop; `agent-install` says `cancelled` once it is gone.
#[tauri::command]
pub fn agent_install_cancel(install: State<'_, AgentInstall>) {
    if let Some(cancel) = lock(&install.cancel).as_ref() {
        cancel.cancel();
    }
}

/// Stops the child and, on Unix, everything it started (its process group).
fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // `kill(1)` with a negative id signals the whole process group; this crate forbids `unsafe`.
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .status();
    }
    let _ = child.start_kill();
}

/// Installers colour their output; the pane shows plain lines.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Starts one turn and returns its id; progress arrives as `agent-event`.
/// Async so it runs on Tauri's Tokio runtime, which spawning a
/// `tokio::process` child requires.
#[tauri::command]
pub async fn agent_send(
    app: AppHandle,
    state: State<'_, AppState>,
    turns: State<'_, AgentTurns>,
    input: AgentRequest,
) -> CmdResult<String> {
    let message = input.message.trim();
    if message.is_empty() {
        return Err(err("INVALID_INPUT", "メッセージが空です"));
    }
    if state.vault.mask(message) != message {
        return Err(err(
            "SECRET_IN_MESSAGE",
            "登録済みのパスワードか認証コードが含まれているため、AI に送りませんでした。シークレットは名前で伝えてください。",
        ));
    }
    let config = AgentConfig::load();
    let Some(program) = config.executable() else {
        return Err(err(
            "AGENT_NOT_FOUND",
            agent_info().problem.unwrap_or_default(),
        ));
    };
    #[cfg(debug_assertions)]
    refresh_dev_cli().await?;
    let Some(cli) = cli_path() else {
        return Err(err(
            "AGENT_NOT_FOUND",
            agent_info().problem.unwrap_or_default(),
        ));
    };
    let workspace = state.service.store().root().to_path_buf();
    let dir = agent_dir();
    std::fs::create_dir_all(&dir).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    let (mut args, env) = providers::prepare(
        config.kind,
        &Turn {
            dir: &dir,
            cli: &cli,
            workspace: &workspace,
            system_prompt: SYSTEM_PROMPT,
            session: input.session_id.as_deref(),
        },
    )
    .map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    if config.kind == AgentKind::Command {
        let mcp_config = dir.join("mcp.json").display().to_string();
        args = config
            .args
            .iter()
            .map(|a| {
                a.replace("{mcpConfig}", &mcp_config)
                    .replace("{workspace}", &workspace.display().to_string())
            })
            .collect();
    }
    let mut command = Command::new(&program);
    command.args(&args).envs(env);
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
    command
        .current_dir(&dir)
        // Started from a Claude Code terminal, it would refuse to nest.
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| {
        err(
            "AGENT_FAILED",
            format!("{} を起動できません: {e}", config.name()),
        )
    })?;

    let turn_id = format!(
        "turn_{}_{}",
        std::process::id(),
        turns.next.fetch_add(1, Ordering::Relaxed)
    );
    let cancel = CancellationToken::new();
    lock(&turns.running).insert(turn_id.clone(), cancel.clone());
    let prompt = with_context(message, input.flow.as_ref());
    let kind = config.kind;
    let id = turn_id.clone();
    tauri::async_runtime::spawn(async move {
        let emit = |event: AgentEvent| {
            let _ = app.emit(
                AGENT_EVENT,
                Envelope {
                    turn_id: id.clone(),
                    event,
                },
            );
        };
        // Dropping stdin afterwards ends the prompt.
        if let Some(mut stdin) = child.stdin.take()
            && let Err(e) = stdin.write_all(prompt.as_bytes()).await
        {
            tracing::warn!(error = %e, "cannot write to the agent");
        }
        let mut stderr = child.stderr.take();
        let stderr_task = tauri::async_runtime::spawn(async move {
            let mut buf = Vec::new();
            if let Some(s) = stderr.as_mut() {
                let _ = s.read_to_end(&mut buf).await;
            }
            String::from_utf8_lossy(&buf).into_owned()
        });
        let mut finished = false;
        let mut stopped = false;
        let mut stream = Stream::new(kind);
        if let Some(stdout) = child.stdout.take() {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                tokio::select! {
                    () = cancel.cancelled() => {
                        let _ = child.start_kill();
                        stopped = true;
                        break;
                    }
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => {
                            let events = stream.line(&line);
                            for event in events {
                                finished |= matches!(event, AgentEvent::Done { .. });
                                emit(event);
                            }
                        }
                        Ok(None) | Err(_) => break,
                    }
                }
            }
        }
        let status = child.wait().await;
        let stderr = stderr_task.await.unwrap_or_default();
        if stopped {
            emit(AgentEvent::done(false, Some("止めました".to_owned()), None));
        } else if !finished {
            let ok = status.as_ref().is_ok_and(std::process::ExitStatus::success);
            let message = (!ok).then(|| {
                let tail = tail(stderr.trim(), STDERR_TAIL);
                if tail.is_empty() {
                    "AI が途中で終了しました".to_owned()
                } else {
                    tail
                }
            });
            let mut done = AgentEvent::done(ok, message, None);
            // A `command` agent cannot be signed in from the pane; it keeps its message.
            if let AgentEvent::Done { needs_login, .. } = &mut done {
                *needs_login &= kind != AgentKind::Command;
            }
            emit(done);
        }
        lock(&app.state::<AgentTurns>().running).remove(&id);
    });
    Ok(turn_id)
}

pub(crate) const LOGIN_EVENT: &str = "agent-login";

/// Progress of the agent's sign-in (e.g. `claude auth login`) run in the background for the pane.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LoginEvent {
    /// The sign-in page; the agent opens it in the browser itself.
    Url {
        url: String,
    },
    Done {
        ok: bool,
        message: Option<String>,
    },
}

/// The sign-in in progress: its stdin takes the code the sign-in page shows
/// when the browser cannot hand it back by itself.
#[derive(Default)]
pub(crate) struct AgentLogin {
    /// Tagged with the sign-in it belongs to, so a cancelled one finishing
    /// late does not close a newer one's input.
    stdin: tokio::sync::Mutex<Option<(u64, tokio::process::ChildStdin)>>,
    generation: AtomicU64,
    cancel: Mutex<Option<CancellationToken>>,
}

/// Signs the agent in from the pane: runs its sign-in command (e.g. `claude
/// auth login`) hidden, hands the sign-in URL to the pane and reports when
/// the account is usable. Studio never sees the account's tokens; the agent
/// stores them as usual. Gemini CLI signs in only on its own screen, so that
/// screen is opened instead.
#[tauri::command]
pub async fn agent_login(app: AppHandle, login: State<'_, AgentLogin>) -> CmdResult<()> {
    let config = AgentConfig::load();
    let kind = config.kind;
    let Some(program) = config.executable() else {
        return Err(err(
            "AGENT_NOT_FOUND",
            agent_info().problem.unwrap_or_default(),
        ));
    };
    if kind == AgentKind::Gemini {
        return open_gemini(&program);
    }
    let Some(login_args) = kind.login_args().filter(|_| kind != AgentKind::Command) else {
        return Err(err(
            "AGENT_LOGIN_UNSUPPORTED",
            format!(
                "{} へのログインは、その AI の画面から行ってください",
                config.name()
            ),
        ));
    };
    if let Some(previous) = lock(&login.cancel).take() {
        previous.cancel();
    }
    let mut command = Command::new(&program);
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
    command
        .args(login_args)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|e| err("AGENT_FAILED", format!("ログインを始められません: {e}")))?;
    let generation = login.generation.fetch_add(1, Ordering::Relaxed) + 1;
    *login.stdin.lock().await = child.stdin.take().map(|stdin| (generation, stdin));
    let cancel = CancellationToken::new();
    *lock(&login.cancel) = Some(cancel.clone());

    tauri::async_runtime::spawn(async move {
        let emit = |event: LoginEvent| {
            let _ = app.emit(LOGIN_EVENT, event);
        };
        // Some agents print the sign-in page on stderr.
        let stderr = child.stderr.take();
        let stderr_app = app.clone();
        let stderr_task = tauri::async_runtime::spawn(async move {
            let mut text = String::new();
            if let Some(s) = stderr {
                let mut lines = BufReader::new(s).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(url) = login_url(kind, &line) {
                        let _ = stderr_app.emit(LOGIN_EVENT, LoginEvent::Url { url });
                    }
                    text.push_str(&line);
                    text.push('\n');
                }
            }
            text
        });
        let mut stopped = false;
        if let Some(stdout) = child.stdout.take() {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                tokio::select! {
                    () = cancel.cancelled() => {
                        let _ = child.start_kill();
                        stopped = true;
                        break;
                    }
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => {
                            if let Some(url) = login_url(kind, &line) {
                                emit(LoginEvent::Url { url });
                            }
                        }
                        Ok(None) | Err(_) => break,
                    }
                }
            }
        }
        let status = child.wait().await;
        let stderr = stderr_task.await.unwrap_or_default();
        {
            let login = app.state::<AgentLogin>();
            let mut stdin = login.stdin.lock().await;
            if stdin.as_ref().is_some_and(|(g, _)| *g == generation) {
                *stdin = None;
            }
        }
        if stopped {
            return;
        }
        let ok = status.as_ref().is_ok_and(std::process::ExitStatus::success)
            && logged_in(kind, &program).await;
        let message = (!ok).then(|| {
            let tail = tail(stderr.trim(), STDERR_TAIL);
            if tail.is_empty() {
                "ログインできませんでした".to_owned()
            } else {
                tail
            }
        });
        emit(LoginEvent::Done { ok, message });
    });
    Ok(())
}

/// The code the sign-in page shows, for when the browser could not return
/// to Claude Code by itself.
#[tauri::command]
pub async fn agent_login_code(login: State<'_, AgentLogin>, code: String) -> CmdResult<()> {
    let code = code.trim();
    if code.is_empty() {
        return Err(err("INVALID_INPUT", "コードが空です"));
    }
    let mut stdin = login.stdin.lock().await;
    let Some((_, stdin)) = stdin.as_mut() else {
        return Err(err("AGENT_LOGIN_NOT_RUNNING", "ログインが始まっていません"));
    };
    stdin
        .write_all(format!("{code}\n").as_bytes())
        .await
        .map_err(|e| err("AGENT_FAILED", e.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|e| err("AGENT_FAILED", e.to_string()))
}

#[tauri::command]
pub fn agent_login_cancel(login: State<'_, AgentLogin>) {
    if let Some(cancel) = lock(&login.cancel).take() {
        cancel.cancel();
    }
}

/// Opens the sign-in page, or one of Shikigami's own docs pages (the
/// tutorials), in the default browser. Nothing else.
#[tauri::command]
pub fn agent_open_url(url: String) -> CmdResult<()> {
    if !is_sign_in_url(&url) && !is_docs_url(&url) {
        return Err(err("INVALID_INPUT", "開けない URL です"));
    }
    agent_open_any(&url)
}

/// Hands an address already checked by the caller to the default browser.
fn agent_open_any(url: &str) -> CmdResult<()> {
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("explorer");
        c.arg(url);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    command
        .spawn()
        .map(drop)
        .map_err(|e| err("AGENT_FAILED", format!("ブラウザを開けません: {e}")))
}

/// Opens a web page the AI linked to in its reply, in the default browser.
/// Only a plain http(s) address: no other scheme (file:, ms-settings: and
/// the like would start programs), and nothing that could split the argument.
#[tauri::command]
pub fn agent_open_link(url: String) -> CmdResult<()> {
    if !is_web_link(&url) {
        return Err(err("INVALID_INPUT", "開けない URL です"));
    }
    agent_open_any(&url)
}

fn is_web_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = match lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    {
        Some(rest) => rest,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty()
        && url.len() <= 2048
        && !url
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "\"<>\\^`{|}".contains(c))
}

/// A sign-in page of any agent Studio knows.
fn is_sign_in_url(url: &str) -> bool {
    KNOWN.iter().any(|&kind| is_sign_in_url_of(kind, url))
}

fn is_sign_in_url_of(kind: AgentKind, url: &str) -> bool {
    kind.sign_in_pages().iter().any(|p| url.starts_with(p)) && !url.contains(char::is_whitespace)
}

/// Gemini CLI signs in only on its own screen: open it in a window of its
/// own, where the person picks "Sign in with Google".
fn open_gemini(program: &Path) -> CmdResult<()> {
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "start", "Gemini CLI"]).arg(program);
        c
    } else {
        let mut c = std::process::Command::new("x-terminal-emulator");
        c.arg("-e").arg(program);
        c
    };
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
    command.current_dir(agent_dir());
    command.spawn().map(drop).map_err(|e| {
        err(
            "AGENT_FAILED",
            format!("Gemini CLI の画面を開けません: {e}"),
        )
    })?;
    Err(err(
        "AGENT_LOGIN_OWN_SCREEN",
        "Gemini CLI の画面を開きました。「Sign in with Google」を選んでサインインし、終わったらその画面を閉じて、もう一度送ってください。",
    ))
}

/// Shikigami's own pages on GitHub (the tutorials Studio links to).
fn is_docs_url(url: &str) -> bool {
    url.starts_with("https://github.com/d-shiina/shikigami/blob/main/docs/")
        && !url.contains(char::is_whitespace)
        && !url.contains("..")
}

fn login_url(kind: AgentKind, line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    is_sign_in_url_of(kind, &url).then_some(url)
}

/// Whether the agent has an account to use: `claude auth status --json` →
/// `loggedIn`, `codex login status`'s exit code. The others cannot tell
/// without a message, which says so when they are not.
async fn logged_in(kind: AgentKind, program: &Path) -> bool {
    let args: &[&str] = match kind {
        AgentKind::ClaudeCode => &["auth", "status", "--json"],
        AgentKind::Codex => &["login", "status"],
        _ => return true,
    };
    let mut command = Command::new(program);
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
    command
        .args(args)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let Ok(out) = command.output().await else {
        return false;
    };
    if kind == AgentKind::Codex {
        return out.status.success();
    }
    serde_json::from_slice::<Value>(&out.stdout)
        .ok()
        .and_then(|v| v.get("loggedIn").and_then(Value::as_bool))
        .unwrap_or(false)
}

#[tauri::command]
pub fn agent_stop(turns: State<'_, AgentTurns>, turn_id: String) {
    if let Some(cancel) = lock(&turns.running).remove(&turn_id) {
        cancel.cancel();
    }
}

fn with_context(message: &str, flow: Option<&FlowRef>) -> String {
    match flow {
        Some(s) => {
            let step = s
                .step_id
                .as_deref()
                .map(|id| format!(", selected step stepId={id}"))
                .unwrap_or_default();
            let empty = if s.empty { ", no steps yet" } else { "" };
            format!(
                "(Open in Studio: flow \"{}\" id={}{empty}{step})\n\n{message}",
                s.name, s.id
            )
        }
        None => message.to_owned(),
    }
}

/// Reads one agent's output, line by line, as what the pane shows.
pub(crate) enum Stream {
    Claude(ClaudeStream),
    Codex(CodexStream),
    Gemini(GeminiStream),
    Copilot(CopilotStream),
    /// Each line is the reply.
    Plain,
}

impl Stream {
    fn new(kind: AgentKind) -> Self {
        match kind {
            AgentKind::ClaudeCode => Self::Claude(ClaudeStream::default()),
            AgentKind::Codex => Self::Codex(CodexStream),
            AgentKind::Gemini => Self::Gemini(GeminiStream::default()),
            AgentKind::Copilot => Self::Copilot(CopilotStream::default()),
            AgentKind::Command => Self::Plain,
        }
    }

    fn line(&mut self, line: &str) -> Vec<AgentEvent> {
        match self {
            Self::Claude(s) => s.line(line),
            Self::Codex(s) => s.line(line),
            Self::Gemini(s) => s.line(line),
            Self::Copilot(s) => s.line(line),
            Self::Plain => vec![AgentEvent::Text {
                text: format!("{line}\n"),
            }],
        }
    }
}

/// Reads `claude -p --output-format stream-json --verbose` line by line,
/// remembering which tool each call was so its result can be told apart.
#[derive(Default)]
pub(crate) struct ClaudeStream {
    tools: HashMap<String, String>,
}

#[cfg(test)]
pub(crate) fn parse_claude_line(line: &str) -> Vec<AgentEvent> {
    ClaudeStream::default().line(line)
}

impl ClaudeStream {
    pub(crate) fn line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let str_of = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
        match v.get("type").and_then(Value::as_str) {
            Some("system") if str_of(&v, "subtype").as_deref() == Some("init") => {
                str_of(&v, "session_id")
                    .map(|session_id| vec![AgentEvent::Session { session_id }])
                    .unwrap_or_default()
            }
            Some("assistant") => blocks(&v)
                .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                    Some("text") => str_of(b, "text")
                        .filter(|t| !t.trim().is_empty())
                        .map(|text| AgentEvent::Text { text }),
                    Some("tool_use") => {
                        let raw = str_of(b, "name")?;
                        let name = providers::tool_name(&raw).unwrap_or(raw);
                        if let Some(id) = str_of(b, "id") {
                            self.tools.insert(id, name.clone());
                        }
                        Some(AgentEvent::Tool {
                            name,
                            detail: b.get("input").and_then(|i| str_of(i, "summary")),
                        })
                    }
                    _ => None,
                })
                .collect(),
            // Of the partial messages, only the start of a Shikigami tool call.
            Some("stream_event") => v
                .get("event")
                .filter(|e| e.get("type").and_then(Value::as_str) == Some("content_block_start"))
                .and_then(|e| e.get("content_block"))
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .and_then(|b| str_of(b, "name"))
                .and_then(|name| providers::tool_name(&name))
                .map(|name| vec![AgentEvent::Preparing { name }])
                .unwrap_or_default(),
            Some("user") => blocks(&v)
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                .filter_map(|b| {
                    let tool = str_of(b, "tool_use_id").and_then(|id| self.tools.remove(&id));
                    if b.get("is_error").and_then(Value::as_bool) == Some(true) {
                        return Some(AgentEvent::ToolFailed {
                            message: truncate(&result_text(b.get("content")), TOOL_ERROR_LEN),
                        });
                    }
                    if tool.as_deref() != Some("create_flow") {
                        return None;
                    }
                    providers::created(&result_text(b.get("content")))
                })
                .collect(),
            Some("result") => {
                let ok = !v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                vec![AgentEvent::done(
                    ok,
                    if ok { None } else { str_of(&v, "result") },
                    v.get("total_cost_usd").and_then(Value::as_f64),
                )]
            }
            _ => Vec::new(),
        }
    }
}

fn blocks(v: &Value) -> impl Iterator<Item = &Value> {
    v.pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_owned();
    }
    s.chars().skip(n - max).collect()
}

/// Per-PC working folder for the agent, outside the (maybe shared) workspace.
fn agent_dir() -> PathBuf {
    shikigami_core::paths::local_dir().join("agent")
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// The `shikigami` CLI next to Studio (installed, or `target/<profile>` in
/// development), else on PATH.
pub(crate) fn cli_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(exe("shikigami"))))
        .filter(|p| p.is_file())
        .or_else(|| find_on_path(&[&exe("shikigami")]))
}

/// In development `tauri dev` rebuilds only Studio, so after a pull the
/// CLI in target/debug lags behind and its MCP server rejects what this
/// Studio's AI writes (unknown functions or steps). Bring it up to date
/// once per Studio process, before the first turn; when nothing changed
/// the build takes about a second.
#[cfg(debug_assertions)]
async fn refresh_dev_cli() -> CmdResult<()> {
    static FRESH: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    FRESH
        .get_or_try_init(|| async {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let mut out = build_cli(&root).await;
            // Windows cannot replace a running exe, and the person's own
            // Claude Code keeps this MCP server running. It can rename one,
            // though: move the old exe aside and build again.
            if let Ok(o) = &out
                && !o.status.success()
                && String::from_utf8_lossy(&o.stderr).contains("failed to remove file")
                && set_aside_cli(&root.join("target/debug"))
            {
                out = build_cli(&root).await;
            }
            match out {
                Ok(out) if out.status.success() => Ok(()),
                Ok(out) => Err(err(
                    "AGENT_FAILED",
                    format!(
                        "shikigami コマンド（MCP サーバー）を最新のソースでビルドできませんでした。\n{}",
                        tail(String::from_utf8_lossy(&out.stderr).trim(), 1500)
                    ),
                )),
                // No cargo: not a source checkout, use the CLI as it is.
                Err(_) => Ok(()),
            }
        })
        .await
        .map(|_| ())
}

#[cfg(debug_assertions)]
async fn build_cli(root: &Path) -> std::io::Result<std::process::Output> {
    let mut command = Command::new("cargo");
    command
        .args(["build", "--quiet", "--package", "shikigami-cli"])
        .current_dir(root)
        // Only the errors, not a progress bar per crate.
        .env("CARGO_TERM_PROGRESS_WHEN", "never")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command.output().await
}

/// Renames `shikigami(.exe)` in `dir` to a `.old-*` name a running process
/// can keep, and removes earlier ones nothing uses any more. Whether there
/// was one to move.
#[cfg(debug_assertions)]
fn set_aside_cli(dir: &Path) -> bool {
    let name = exe("shikigami");
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{name}.old-"))
            {
                // Still running ones refuse; they go next time.
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    std::fs::rename(dir.join(&name), dir.join(format!("{name}.old-{stamp}"))).is_ok()
}

fn resolve(command: &Path) -> Option<PathBuf> {
    if command.components().count() > 1 {
        return command.is_file().then(|| command.to_path_buf());
    }
    let name = command.to_string_lossy();
    if cfg!(windows) && command.extension().is_none() {
        find_on_path(&[&format!("{name}.exe"), &format!("{name}.cmd")])
    } else {
        find_on_path(&[&name])
    }
}

pub(crate) fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_session_text_tools_and_result() {
        assert_eq!(
            parse_claude_line(r#"{"type":"system","subtype":"init","session_id":"s1","tools":[]}"#),
            vec![AgentEvent::Session {
                session_id: "s1".into()
            }]
        );
        let assistant = r#"{"type":"assistant","message":{"content":[
            {"type":"text","text":"直します"},
            {"type":"tool_use","name":"mcp__shikigami__update_step","input":{"summary":"待ち時間を延ばした"}},
            {"type":"tool_use","name":"mcp__shikigami__get_flow","input":{}}]}}"#
            .replace('\n', "");
        assert_eq!(
            parse_claude_line(&assistant),
            vec![
                AgentEvent::Text {
                    text: "直します".into()
                },
                AgentEvent::Tool {
                    name: "update_step".into(),
                    detail: Some("待ち時間を延ばした".into())
                },
                AgentEvent::Tool {
                    name: "get_flow".into(),
                    detail: None
                },
            ]
        );
        assert_eq!(
            parse_claude_line(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":[{"type":"text","text":"STEP_NOT_FOUND"}]},{"type":"tool_result","content":"ok"}]}}"#
            ),
            vec![AgentEvent::ToolFailed {
                message: "STEP_NOT_FOUND".into()
            }]
        );
        assert_eq!(
            parse_claude_line(
                r#"{"stop_reason":"end_turn","is_error":false,"result":"done","type":"result","total_cost_usd":0.01}"#
            ),
            vec![AgentEvent::done(true, None, Some(0.01))]
        );
        assert_eq!(
            parse_claude_line(r#"{"type":"result","is_error":true,"result":"Not logged in"}"#),
            vec![AgentEvent::Done {
                ok: false,
                message: Some("Not logged in".into()),
                cost_usd: None,
                needs_login: true,
            }]
        );
    }

    #[test]
    fn tells_which_flow_a_conversation_created() {
        let mut stream = ClaudeStream::default();
        stream.line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"mcp__shikigami__create_flow","input":{"name":"請求書"}},{"type":"tool_use","id":"tu_2","name":"mcp__shikigami__get_flow","input":{}}]}}"#);
        let result = json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "tu_2", "content": [{ "type": "text", "text": json!({ "flow": { "id": "scn_other", "name": "参考" } }).to_string() }] },
            { "type": "tool_result", "tool_use_id": "tu_1", "content": [{ "type": "text", "text": json!({ "flow": { "id": "scn_new", "name": "請求書", "revision": 1 } }).to_string() }] },
        ]}});
        assert_eq!(
            stream.line(&result.to_string()),
            vec![AgentEvent::Created {
                flow_id: "scn_new".into(),
                name: "請求書".into()
            }]
        );
    }

    #[test]
    fn ignores_noise() {
        assert!(parse_claude_line("not json").is_empty());
        assert!(parse_claude_line(r#"{"type":"stream_event","event":{}}"#).is_empty());
        assert!(parse_claude_line(r#"{"type":"rate_limit_event"}"#).is_empty());
        // Partial text and the input as it is written are left to the whole message.
        assert!(parse_claude_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}"#
        )
        .is_empty());
        // Another server's tool is not ours to show.
        assert!(parse_claude_line(
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}"#
        )
        .is_empty());
    }

    #[test]
    fn says_when_a_tool_call_begins() {
        assert_eq!(
            parse_claude_line(
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"mcp__shikigami__create_flow","input":{}}}}"#
            ),
            vec![AgentEvent::Preparing {
                name: "create_flow".into()
            }]
        );
    }

    #[test]
    fn events_serialize_camel_cased() {
        let e = Envelope {
            turn_id: "t".into(),
            event: AgentEvent::done(true, None, Some(0.5)),
        };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            json!({ "turnId": "t", "kind": "done", "ok": true, "message": null, "costUsd": 0.5, "needsLogin": false })
        );
    }

    #[test]
    fn finds_the_sign_in_url_only_on_the_agents_pages() {
        assert_eq!(
            login_url(
                AgentKind::ClaudeCode,
                "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x"
            ),
            Some("https://claude.com/cai/oauth/authorize?code=true&state=x".into())
        );
        assert_eq!(
            login_url(AgentKind::ClaudeCode, "Opening browser to sign in…"),
            None
        );
        assert_eq!(
            login_url(
                AgentKind::ClaudeCode,
                "visit https://evil.example/claude.com/"
            ),
            None
        );
        // Each agent's own pages only.
        assert_eq!(
            login_url(
                AgentKind::Codex,
                "Open https://auth.openai.com/oauth/authorize?x=1"
            ),
            Some("https://auth.openai.com/oauth/authorize?x=1".into())
        );
        assert_eq!(login_url(AgentKind::Codex, "https://claude.com/x"), None);
        assert!(is_sign_in_url(
            "https://github.com/login/oauth/authorize?c=1"
        ));
        assert!(!is_sign_in_url("https://github.com/d-shiina/shikigami"));
        assert!(!is_sign_in_url("https://claude.com/ x"));
        assert!(is_docs_url(
            "https://github.com/d-shiina/shikigami/blob/main/docs/ja/tutorials/README.md"
        ));
        assert!(!is_docs_url(
            "https://github.com/d-shiina/shikigami/blob/main/docs/../../x"
        ));
        assert!(!is_docs_url(
            "https://github.com/someone/else/blob/main/docs/a.md"
        ));
        assert!(!is_sign_in_url(
            "https://github.com/d-shiina/shikigami/blob/main/docs/a.md"
        ));

        assert!(is_web_link("https://example.com/a?b=1&c=2#d"));
        assert!(is_web_link("HTTP://example.com"));
        assert!(!is_web_link("https://"));
        assert!(!is_web_link("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_web_link("javascript:alert(1)"));
        assert!(!is_web_link("ms-settings:"));
        assert!(!is_web_link("https://example.com/ x"));
        assert!(!is_web_link("https://example.com/\"x"));
        assert!(!is_web_link("https://example.com/\nx"));
    }

    #[test]
    fn tells_an_expired_login_from_other_failures() {
        assert!(is_login_error(
            "Failed to authenticate: OAuth session expired and could not be refreshed"
        ));
        assert!(is_login_error("Invalid API key · Please run /login"));
        assert!(is_login_error("unexpected status 401 Unauthorized"));
        assert!(is_login_error("Please set an Auth method in your settings"));
        assert!(!is_login_error("STEP_NOT_FOUND"));
        assert!(!is_login_error("止めました"));
        let AgentEvent::Done { needs_login, .. } =
            AgentEvent::done(true, Some("oauth".into()), None)
        else {
            unreachable!()
        };
        assert!(!needs_login);
    }

    #[test]
    fn claude_only_gets_shikigami_and_resumes() {
        let args = providers::claude_args(Path::new("m.json"), Path::new("s.md"), Some("sess"));
        let joined = args.join(" ");
        assert!(joined.contains("--strict-mcp-config --mcp-config m.json"));
        assert!(joined.contains("--allowedTools mcp__shikigami"));
        assert!(joined.ends_with("--resume sess"));
        let i = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[i + 1], "");
        assert!(
            !providers::claude_args(Path::new("m"), Path::new("s"), Some(""))
                .contains(&"--resume".to_owned())
        );
    }

    #[test]
    fn names_the_open_flow() {
        let s = FlowRef {
            id: "scn_1".into(),
            name: "受注".into(),
            step_id: None,
            empty: false,
        };
        assert!(
            with_context("直して", Some(&s))
                .starts_with("(Open in Studio: flow \"受注\" id=scn_1)")
        );
        let s = FlowRef {
            step_id: Some("stp_9".into()),
            ..s
        };
        assert!(
            with_context("直して", Some(&s)).starts_with(
                "(Open in Studio: flow \"受注\" id=scn_1, selected step stepId=stp_9)"
            )
        );
        let s = FlowRef {
            step_id: None,
            empty: true,
            ..s
        };
        assert!(
            with_context("作って", Some(&s))
                .starts_with("(Open in Studio: flow \"受注\" id=scn_1, no steps yet)")
        );
        assert_eq!(with_context("直して", None), "直して");
    }

    #[test]
    fn config_defaults_to_claude_code() {
        let c: AgentConfig = serde_json::from_value(json!({})).unwrap();
        assert_eq!(c.kind, AgentKind::ClaudeCode);
        assert_eq!(c.name(), "Claude Code");
        let c: AgentConfig = serde_json::from_value(
            json!({ "kind": "command", "command": "gemini", "args": ["-p"], "name": "Gemini CLI" }),
        )
        .unwrap();
        assert_eq!(c.kind, AgentKind::Command);
        assert_eq!(c.name(), "Gemini CLI");
        // Trying another agent keeps a custom one's settings for later.
        let custom =
            json!({ "kind": "command", "command": "my-ai", "args": ["-p"], "name": "My AI" });
        let codex = AgentConfig::switched(custom.clone(), AgentKind::Codex);
        assert_eq!(codex["kind"], "codex");
        assert!(codex.get("command").is_none());
        assert_eq!(AgentConfig::switched(codex, AgentKind::Command), custom);
        let c: AgentConfig = serde_json::from_value(json!({ "kind": "codex" })).unwrap();
        assert_eq!(c.kind, AgentKind::Codex);
        assert_eq!(c.name(), "Codex");
    }
}
