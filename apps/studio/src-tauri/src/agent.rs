//! The AI pane: runs the person's own coding agent (Claude Code by default)
//! in the background with Shikigami's MCP server, one process per message.
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

pub(crate) const AGENT_EVENT: &str = "agent-event";

/// Name the MCP server is given in the agent; tool names start with
/// `mcp__shikigami__` in Claude Code.
const SERVER: &str = "shikigami";
const TOOL_PREFIX: &str = "mcp__shikigami__";
const STDERR_TAIL: usize = 2000;
const TOOL_ERROR_LEN: usize = 300;

const SYSTEM_PROMPT: &str = "\
あなたは Shikigami Studio（Windows 向け RPA）の画面の中から呼ばれた AI です。話し相手は Studio を使っている人です。
- シナリオの読み書き・試し実行は shikigami の MCP ツールだけで行います。ファイルの読み書きやコマンドは使えません。
- 編集するときは summary に「何を・なぜ」を日本語で一文書きます。あなたの編集は Studio の「確認待ち」に並び、人が確かめてから本番で使われます。
- 差し戻しを直すよう頼まれたら、get_scenario の feedback（詳しくは get_review）を読み、指摘どおりに直して、何を直したかを短く報告します。
- パスワードや認証コードを尋ねたり受け取ったりしません。ログインはシークレットの名前で参照し、必要なシークレットが無ければ Studio の「シークレット」から登録してもらうよう伝えます。
- 返事は日本語で短く。何をしたか、次に人が何をすればよいかを書きます。";

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// `config.json` → `agent`. Without it Studio looks for Claude Code.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfig {
    #[serde(default)]
    kind: AgentKind,
    /// The executable. Claude Code is looked up on PATH when omitted.
    command: Option<PathBuf>,
    /// For `command`: its arguments. `{mcpConfig}` becomes the path of an MCP
    /// config file for Shikigami and `{workspace}` the workspace folder. The
    /// message is written to stdin; each stdout line is shown as the reply.
    #[serde(default)]
    args: Vec<String>,
    /// Shown in the pane, e.g. "Gemini CLI".
    name: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum AgentKind {
    #[default]
    ClaudeCode,
    Command,
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
        self.name.clone().unwrap_or_else(|| match self.kind {
            AgentKind::ClaudeCode => "Claude Code".to_owned(),
            AgentKind::Command => "AI".to_owned(),
        })
    }

    fn executable(&self) -> Option<PathBuf> {
        match (&self.command, self.kind) {
            (Some(command), _) => resolve(command),
            (None, AgentKind::ClaudeCode) => find_claude(),
            (None, AgentKind::Command) => None,
        }
    }
}

/// What the pane shows before the first message.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    available: bool,
    name: String,
    command: Option<String>,
    /// Why the agent cannot be used, in words for the person.
    problem: Option<String>,
    /// Whether a conversation continues across messages (`--resume`).
    remembers: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    message: String,
    /// The conversation to continue, from an earlier `session` event.
    session_id: Option<String>,
    /// The scenario open in Studio, so "this step" has a meaning.
    scenario: Option<ScenarioRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioRef {
    id: String,
    name: String,
    /// The step selected on the flow chart.
    step_id: Option<String>,
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
    /// A Shikigami tool call; `detail` is the edit's summary when it has one.
    Tool {
        name: String,
        detail: Option<String>,
    },
    ToolFailed {
        message: String,
    },
    Done {
        ok: bool,
        message: Option<String>,
        cost_usd: Option<f64>,
    },
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
    let config = AgentConfig::load();
    let command = config.executable();
    let problem = match (&command, cli_path()) {
        (None, _) if config.kind == AgentKind::ClaudeCode => Some(
            "Claude Code が見つかりません。インストールしてログインすると、ここから話しかけられます。"
                .to_owned(),
        ),
        (None, _) => Some("config.json の agent.command が見つかりません。".to_owned()),
        (Some(_), None) => Some(
            "shikigami コマンド（MCP サーバー）が見つかりません。Studio と同じフォルダに置いてください。"
                .to_owned(),
        ),
        _ => None,
    };
    AgentInfo {
        available: problem.is_none(),
        name: config.name(),
        command: command.map(|p| p.display().to_string()),
        problem,
        remembers: config.kind == AgentKind::ClaudeCode,
    }
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
    let Some(cli) = cli_path() else {
        return Err(err(
            "AGENT_NOT_FOUND",
            agent_info().problem.unwrap_or_default(),
        ));
    };
    let workspace = state.service.store().root().to_path_buf();
    let dir = agent_dir();
    std::fs::create_dir_all(&dir).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    let mcp_config = dir.join("mcp.json");
    let server = json!({ "mcpServers": { SERVER: {
        "command": cli,
        "args": ["--workspace", workspace, "mcp"],
    }}});
    std::fs::write(&mcp_config, server.to_string())
        .map_err(|e| err("STORAGE_ERROR", e.to_string()))?;
    let system = dir.join("system-prompt.md");
    std::fs::write(&system, SYSTEM_PROMPT).map_err(|e| err("STORAGE_ERROR", e.to_string()))?;

    let args = match config.kind {
        AgentKind::ClaudeCode => claude_args(&mcp_config, &system, input.session_id.as_deref()),
        AgentKind::Command => config
            .args
            .iter()
            .map(|a| {
                a.replace("{mcpConfig}", &mcp_config.display().to_string())
                    .replace("{workspace}", &workspace.display().to_string())
            })
            .collect(),
    };
    let mut command = Command::new(&program);
    command
        .args(&args)
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
    let prompt = with_context(message, input.scenario.as_ref());
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
                            let events = match kind {
                                AgentKind::ClaudeCode => parse_claude_line(&line),
                                AgentKind::Command => vec![AgentEvent::Text { text: format!("{line}\n") }],
                            };
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
            emit(AgentEvent::Done {
                ok: false,
                message: Some("止めました".to_owned()),
                cost_usd: None,
            });
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
            emit(AgentEvent::Done {
                ok,
                message,
                cost_usd: None,
            });
        }
        lock(&app.state::<AgentTurns>().running).remove(&id);
    });
    Ok(turn_id)
}

#[tauri::command]
pub fn agent_stop(turns: State<'_, AgentTurns>, turn_id: String) {
    if let Some(cancel) = lock(&turns.running).remove(&turn_id) {
        cancel.cancel();
    }
}

fn claude_args(mcp_config: &Path, system: &Path, session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        // Only Shikigami: not the person's other MCP servers, nor files or shell.
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .map(str::to_owned)
    .into();
    args.push(mcp_config.display().to_string());
    args.extend(["--tools", "", "--allowedTools", "mcp__shikigami"].map(str::to_owned));
    args.push("--append-system-prompt-file".to_owned());
    args.push(system.display().to_string());
    if let Some(session) = session.filter(|s| !s.is_empty()) {
        args.push("--resume".to_owned());
        args.push(session.to_owned());
    }
    args
}

fn with_context(message: &str, scenario: Option<&ScenarioRef>) -> String {
    match scenario {
        Some(s) => {
            let step = s
                .step_id
                .as_deref()
                .map(|id| format!("、選んでいる手順 stepId={id}"))
                .unwrap_or_default();
            format!(
                "（Studio で開いているシナリオ：「{}」 id={}{step}）\n\n{message}",
                s.name, s.id
            )
        }
        None => message.to_owned(),
    }
}

/// One line of `claude -p --output-format stream-json --verbose`.
pub(crate) fn parse_claude_line(line: &str) -> Vec<AgentEvent> {
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
                    let name = str_of(b, "name")?;
                    Some(AgentEvent::Tool {
                        name: name.strip_prefix(TOOL_PREFIX).unwrap_or(&name).to_owned(),
                        detail: b.get("input").and_then(|i| str_of(i, "summary")),
                    })
                }
                _ => None,
            })
            .collect(),
        Some("user") => blocks(&v)
            .filter(|b| {
                b.get("type").and_then(Value::as_str) == Some("tool_result")
                    && b.get("is_error").and_then(Value::as_bool) == Some(true)
            })
            .map(|b| AgentEvent::ToolFailed {
                message: truncate(&result_text(b.get("content")), TOOL_ERROR_LEN),
            })
            .collect(),
        Some("result") => {
            let ok = !v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            vec![AgentEvent::Done {
                ok,
                message: if ok { None } else { str_of(&v, "result") },
                cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            }]
        }
        _ => Vec::new(),
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

fn truncate(s: &str, max: usize) -> String {
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
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Shikigami")
        .join("agent")
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
fn cli_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(exe("shikigami"))))
        .filter(|p| p.is_file())
        .or_else(|| find_on_path(&[&exe("shikigami")]))
}

fn find_claude() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd"]
    } else {
        &["claude"]
    };
    find_on_path(names).or_else(|| {
        // The native installer's folder is not always on PATH for GUI apps.
        let home = dirs::home_dir()?;
        names
            .iter()
            .map(|n| home.join(".local").join("bin").join(n))
            .find(|p| p.is_file())
    })
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

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
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
            {"type":"tool_use","name":"mcp__shikigami__get_scenario","input":{}}]}}"#
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
                    name: "get_scenario".into(),
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
            vec![AgentEvent::Done {
                ok: true,
                message: None,
                cost_usd: Some(0.01)
            }]
        );
        assert_eq!(
            parse_claude_line(r#"{"type":"result","is_error":true,"result":"Not logged in"}"#),
            vec![AgentEvent::Done {
                ok: false,
                message: Some("Not logged in".into()),
                cost_usd: None
            }]
        );
    }

    #[test]
    fn ignores_noise() {
        assert!(parse_claude_line("not json").is_empty());
        assert!(parse_claude_line(r#"{"type":"stream_event","event":{}}"#).is_empty());
        assert!(parse_claude_line(r#"{"type":"rate_limit_event"}"#).is_empty());
    }

    #[test]
    fn events_serialize_camel_cased() {
        let e = Envelope {
            turn_id: "t".into(),
            event: AgentEvent::Done {
                ok: true,
                message: None,
                cost_usd: Some(0.5),
            },
        };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            json!({ "turnId": "t", "kind": "done", "ok": true, "message": null, "costUsd": 0.5 })
        );
    }

    #[test]
    fn claude_only_gets_shikigami_and_resumes() {
        let args = claude_args(Path::new("m.json"), Path::new("s.md"), Some("sess"));
        let joined = args.join(" ");
        assert!(joined.contains("--strict-mcp-config --mcp-config m.json"));
        assert!(joined.contains("--allowedTools mcp__shikigami"));
        assert!(joined.ends_with("--resume sess"));
        let i = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[i + 1], "");
        assert!(
            !claude_args(Path::new("m"), Path::new("s"), Some("")).contains(&"--resume".to_owned())
        );
    }

    #[test]
    fn names_the_open_scenario() {
        let s = ScenarioRef {
            id: "scn_1".into(),
            name: "受注".into(),
            step_id: None,
        };
        assert!(
            with_context("直して", Some(&s))
                .starts_with("（Studio で開いているシナリオ：「受注」 id=scn_1）")
        );
        let s = ScenarioRef {
            step_id: Some("stp_9".into()),
            ..s
        };
        assert!(with_context("直して", Some(&s)).starts_with(
            "（Studio で開いているシナリオ：「受注」 id=scn_1、選んでいる手順 stepId=stp_9）"
        ));
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
    }
}
