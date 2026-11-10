//! What differs between the AI command-line tools the pane can run: where
//! each is installed, how it is started with only SpellSheet's MCP tools, how
//! its output reads, and how it signs in.
//!
//! Every one runs headless, one process per message, in the agent folder
//! (empty but for the files written here), with SpellSheet as its only MCP
//! server and its own file and shell tools turned off. Instructions go in
//! files each tool reads from its working folder, never in arguments: on
//! Windows the npm-installed tools are `.cmd` files, which cannot carry
//! newlines in an argument.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{AgentEvent, SERVER, TOOL_ERROR_LEN, find_on_path, truncate};

/// `config.json` → `agent.kind`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    #[default]
    ClaudeCode,
    /// OpenAI Codex CLI.
    Codex,
    Gemini,
    /// GitHub Copilot CLI.
    Copilot,
    /// Cursor's Agent CLI (`cursor-agent`).
    Cursor,
    /// Any other program: the message on stdin, stdout lines as the reply.
    Command,
}

/// The ones Studio knows how to run, in the order the pane offers them.
pub(crate) const KNOWN: [AgentKind; 5] = [
    AgentKind::ClaudeCode,
    AgentKind::Codex,
    AgentKind::Gemini,
    AgentKind::Copilot,
    AgentKind::Cursor,
];

/// Built-in Gemini CLI tools, all turned off: only SpellSheet's tools remain.
/// (`tools.core` would also hide MCP tools.) Tools a newer Gemini CLI adds
/// still need approval, which a headless run cannot give, so they are refused.
const GEMINI_BUILTIN_TOOLS: &[&str] = &[
    "update_topic",
    "list_directory",
    "read_file",
    "read_many_files",
    "grep_search",
    "search_file_content",
    "glob",
    "replace",
    "write_file",
    "web_fetch",
    "run_shell_command",
    "list_background_processes",
    "read_background_output",
    "google_web_search",
    "write_todos",
    "save_memory",
    "enter_plan_mode",
    "exit_plan_mode",
    "invoke_agent",
    "activate_skill",
    "ask_user",
];

impl AgentKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::Gemini => "Gemini CLI",
            Self::Copilot => "GitHub Copilot",
            Self::Cursor => "Cursor",
            Self::Command => "AI",
        }
    }

    /// Who makes it, for the list in the pane.
    pub(crate) fn maker(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Anthropic",
            Self::Codex => "OpenAI",
            Self::Gemini => "Google",
            Self::Copilot => "GitHub",
            Self::Cursor => "Cursor",
            Self::Command => "",
        }
    }

    fn program(self) -> Option<&'static str> {
        match self {
            Self::ClaudeCode => Some("claude"),
            Self::Codex => Some("codex"),
            Self::Gemini => Some("gemini"),
            Self::Copilot => Some("copilot"),
            Self::Cursor => Some("cursor-agent"),
            Self::Command => None,
        }
    }

    /// Its npm package; Claude Code has its own installer instead.
    pub(crate) fn npm_package(self) -> Option<&'static str> {
        match self {
            Self::Codex => Some("@openai/codex"),
            Self::Gemini => Some("@google/gemini-cli"),
            Self::Copilot => Some("@github/copilot"),
            Self::ClaudeCode | Self::Cursor | Self::Command => None,
        }
    }

    /// Whether the message goes on the command line (`cursor-agent -p
    /// <prompt>`) rather than stdin.
    pub(crate) fn prompt_as_argument(self) -> bool {
        self == Self::Cursor
    }

    /// Arguments that come before the rest when `program` is not the tool
    /// itself: Cursor's Windows launcher (`agent.cmd` → PowerShell 5.1)
    /// drops `"` and `!` from arguments and cannot pass a line break, so on
    /// Windows its own Node.js runs its script directly, as Cursor advises.
    pub(crate) fn leading_args(self, program: &Path) -> Vec<String> {
        let is_node = program
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("node.exe"));
        match program.parent() {
            Some(dir) if self == Self::Cursor && is_node => {
                vec![dir.join("index.js").display().to_string()]
            }
            _ => Vec::new(),
        }
    }

    /// Whether a conversation continues across messages.
    pub(crate) fn remembers(self) -> bool {
        self != Self::Command
    }

    /// Finds the installed program: on PATH, else where its installer puts
    /// it (a GUI app's PATH is the one from when it started, so a tool just
    /// installed is not on it yet).
    pub(crate) fn find(self) -> Option<PathBuf> {
        if self == Self::Cursor
            && let Some(node) = cursor_windows_node()
        {
            return Some(node);
        }
        let name = self.program()?;
        let names: Vec<String> = if cfg!(windows) {
            vec![format!("{name}.exe"), format!("{name}.cmd")]
        } else {
            vec![name.to_owned()]
        };
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        find_on_path(&names).or_else(|| {
            install_dirs()
                .into_iter()
                .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
                .find(|p| p.is_file())
        })
    }

    /// Pages its sign-in may open, so the pane opens only those.
    pub(crate) fn sign_in_pages(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &[
                "https://claude.com/",
                "https://claude.ai/",
                "https://console.anthropic.com/",
                "https://platform.claude.com/",
            ],
            Self::Codex => &["https://auth.openai.com/", "https://chatgpt.com/"],
            Self::Copilot => &["https://github.com/login/"],
            Self::Cursor => &["https://cursor.com/"],
            Self::Gemini | Self::Command => &[],
        }
    }

    /// The command that signs it in, run hidden. Gemini CLI signs in only
    /// from its own screen.
    pub(crate) fn login_args(self) -> Option<&'static [&'static str]> {
        match self {
            Self::ClaudeCode => Some(&["auth", "login"]),
            Self::Codex => Some(&["login"]),
            Self::Copilot => Some(&["login", "--web-flow"]),
            Self::Cursor => Some(&["login"]),
            Self::Gemini | Self::Command => None,
        }
    }
}

/// Cursor's Agent CLI on Windows: the newest version its installer put in
/// `%LOCALAPPDATA%\cursor-agent\versions\<version>\` (`node.exe` and
/// `index.js`). Versions are named by date (`2026.10.15-…`), so the
/// greatest name is the newest.
fn cursor_windows_node() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let versions = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("cursor-agent")
        .join("versions");
    newest_cursor_version(&versions).map(|dir| dir.join("node.exe"))
}

fn newest_cursor_version(versions: &Path) -> Option<PathBuf> {
    std::fs::read_dir(versions)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|dir| dir.join("node.exe").is_file() && dir.join("index.js").is_file())
        .max_by(|a, b| a.file_name().cmp(&b.file_name()))
}

/// Where installers put these tools besides PATH.
fn install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // Claude Code's native installer.
        dirs.push(home.join(".local").join("bin"));
    }
    if cfg!(windows) {
        // `npm install -g` (the default prefix).
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    } else if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".npm-global").join("bin"));
    }
    dirs
}

/// PATH for the tool's process: Studio's own, plus where Node.js and npm
/// tools are installed. An npm tool is a script run by `node`, which a
/// Node.js installed after Studio started is not on Studio's PATH for.
pub(crate) fn child_path() -> Option<std::ffi::OsString> {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let mut extra = install_dirs();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(dir) = std::env::var_os(var) {
                extra.push(PathBuf::from(dir).join("nodejs"));
            }
        }
    }
    for dir in extra {
        if dir.is_dir() && !paths.contains(&dir) {
            paths.push(dir);
        }
    }
    std::env::join_paths(paths).ok()
}

/// Environment variables the tool needs.
pub(crate) type Env = Vec<(&'static str, String)>;

/// Everything one turn needs to start the tool.
pub(crate) struct Turn<'a> {
    pub dir: &'a Path,
    pub cli: &'a Path,
    pub workspace: &'a Path,
    pub system_prompt: &'a str,
    pub session: Option<&'a str>,
    /// This turn's own folder: the messages the person sends while it runs
    /// ([`INBOX`]), and the settings that name that folder.
    pub own: Option<&'a Path>,
}

/// The folder in a turn's own folder for what the person sends meanwhile.
pub(crate) const INBOX: &str = "inbox";
/// Gemini reads its settings from the agent folder, which every turn
/// shares: they name the inbox through this variable, set for each turn.
const INBOX_VAR: &str = "SPELLSHEET_CHAT_INBOX";

/// The tool's arguments and environment for one message (written to its
/// stdin), after writing the files it reads its settings from.
pub(crate) fn prepare(kind: AgentKind, turn: &Turn<'_>) -> std::io::Result<(Vec<String>, Env)> {
    let session = turn.session.filter(|s| !s.is_empty());
    let mut server_args = vec![
        "--workspace".to_owned(),
        turn.workspace.display().to_string(),
        "mcp".to_owned(),
    ];
    // The pane shows ask_user_to_choose as a card; an agent of its own
    // (`command`) prints only text, so it does not get that tool, nor
    // messages sent while it works (they go as the next message).
    let own = turn.own.filter(|_| kind != AgentKind::Command);
    if kind != AgentKind::Command {
        server_args.push("--writer-chat".to_owned());
    }
    let inbox_arg = |shared: bool| {
        own.map(|own| {
            if shared {
                format!("${{{INBOX_VAR}}}")
            } else {
                own.join(INBOX).display().to_string()
            }
        })
    };
    // Settings files in the shared agent folder must not name one turn's inbox.
    let with_inbox = |shared: bool| {
        let mut args = server_args.clone();
        if let Some(inbox) = inbox_arg(shared) {
            args.push("--inbox".to_owned());
            args.push(inbox);
        }
        args
    };
    // Where this turn's settings go when they name its inbox.
    let settings_dir = own.unwrap_or(turn.dir);
    let mut env = Vec::new();
    let args = match kind {
        AgentKind::ClaudeCode | AgentKind::Command => {
            let mcp = settings_dir.join("mcp.json");
            let server = json!({ "mcpServers": { SERVER: { "command": turn.cli, "args": with_inbox(false) } } });
            write_if_changed(&mcp, &server.to_string())?;
            let system = turn.dir.join("system-prompt.md");
            write_if_changed(&system, turn.system_prompt)?;
            if kind == AgentKind::ClaudeCode {
                claude_args(&mcp, &system, session)
            } else {
                Vec::new()
            }
        }
        AgentKind::Codex => {
            // Codex reads AGENTS.md in its working folder as instructions.
            write_if_changed(&turn.dir.join("AGENTS.md"), turn.system_prompt)?;
            codex_args(turn.cli, &with_inbox(false), session)
        }
        AgentKind::Gemini => {
            write_if_changed(&turn.dir.join("GEMINI.md"), turn.system_prompt)?;
            let settings = json!({
                "mcpServers": { SERVER: {
                    "command": turn.cli,
                    "args": with_inbox(true),
                    // Its tools run without asking; nothing else can.
                    "trust": true,
                }},
                "tools": { "exclude": GEMINI_BUILTIN_TOOLS },
            });
            let folder = turn.dir.join(".gemini");
            std::fs::create_dir_all(&folder)?;
            write_if_changed(
                &folder.join("settings.json"),
                &serde_json::to_string_pretty(&settings).unwrap_or_default(),
            )?;
            // Read this folder's settings; it is Studio's own folder.
            env.push(("GEMINI_CLI_TRUST_WORKSPACE", "true".to_owned()));
            if let Some(own) = own {
                env.push((INBOX_VAR, own.join(INBOX).display().to_string()));
            }
            gemini_args(session)
        }
        AgentKind::Copilot => {
            write_if_changed(&turn.dir.join("AGENTS.md"), turn.system_prompt)?;
            let mcp = settings_dir.join("copilot-mcp.json");
            let server = json!({ "mcpServers": { SERVER: {
                "type": "local",
                "command": turn.cli,
                "args": with_inbox(false),
                "tools": ["*"],
            }}});
            write_if_changed(&mcp, &server.to_string())?;
            copilot_args(&mcp, session)
        }
        AgentKind::Cursor => {
            // Cursor reads AGENTS.md and .cursor/ in its workspace (this folder).
            write_if_changed(&turn.dir.join("AGENTS.md"), turn.system_prompt)?;
            let folder = turn.dir.join(".cursor");
            std::fs::create_dir_all(&folder)?;
            // Shared by every turn: the inbox comes from a variable set for each.
            let mut args = server_args.clone();
            if own.is_some() {
                args.push("--inbox".to_owned());
                args.push(format!("${{env:{INBOX_VAR}}}"));
            }
            let mcp = json!({ "mcpServers": { SERVER: { "command": turn.cli, "args": args } } });
            write_if_changed(
                &folder.join("mcp.json"),
                &serde_json::to_string_pretty(&mcp).unwrap_or_default(),
            )?;
            // No shell, files or web: only SpellSheet's tools, which run without asking.
            let permissions = json!({ "permissions": {
                "allow": [format!("Mcp({SERVER}:*)")],
                "deny": CURSOR_DENIED,
            }});
            write_if_changed(
                &folder.join("cli.json"),
                &serde_json::to_string_pretty(&permissions).unwrap_or_default(),
            )?;
            if let Some(own) = own {
                env.push((INBOX_VAR, own.join(INBOX).display().to_string()));
            }
            // What its launcher sets when its Node.js runs it directly.
            env.push(("CURSOR_INVOKED_AS", "agent".to_owned()));
            cursor_args(turn.dir, session)
        }
    };
    Ok((args, env))
}

/// Several conversations run at once, each in its own agent process, and
/// all of them would otherwise rewrite these files on every message. On
/// Windows a write can fail while another agent is reading the file.
pub(crate) fn write_if_changed(path: &Path, contents: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(path).is_ok_and(|now| now == contents) {
        return Ok(());
    }
    std::fs::write(path, contents)
}

pub(crate) fn claude_args(mcp_config: &Path, system: &Path, session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        // Says when a tool call begins, long before its input is written.
        "--include-partial-messages",
        // Only SpellSheet: not the person's other MCP servers, nor files or shell.
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .map(str::to_owned)
    .into();
    args.push(mcp_config.display().to_string());
    args.extend(["--tools", "", "--allowedTools", "mcp__spellsheet"].map(str::to_owned));
    args.push("--append-system-prompt-file".to_owned());
    args.push(system.display().to_string());
    if let Some(session) = session.filter(|s| !s.is_empty()) {
        args.push("--resume".to_owned());
        args.push(session.to_owned());
    }
    args
}

/// A TOML string for a `-c key=value` override: a literal string (no
/// escapes, so Windows paths stay as they are) unless it holds a quote.
fn toml_str(s: &str) -> String {
    if s.contains('\'') {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("'{s}'")
    }
}

fn codex_args(cli: &Path, server_args: &[String], session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--json",
        // The agent folder is not a Git repository.
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        // No shell or web search: only SpellSheet's tools. Unknown settings
        // in an older Codex are ignored, unlike `--disable`.
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "web_search='disabled'",
    ]
    .map(str::to_owned)
    .into();
    let server = format!("mcp_servers.{SERVER}");
    args.push("-c".to_owned());
    args.push(format!(
        "{server}.command={}",
        toml_str(&cli.display().to_string())
    ));
    args.push("-c".to_owned());
    args.push(format!(
        "{server}.args=[{}]",
        server_args
            .iter()
            .map(|a| toml_str(a))
            .collect::<Vec<_>>()
            .join(",")
    ));
    // A headless run cannot ask; SpellSheet's tools are the ones it may use.
    args.push("-c".to_owned());
    args.push(format!("{server}.default_tools_approval_mode='approve'"));
    if let Some(session) = session {
        args.push("resume".to_owned());
        args.push(session.to_owned());
    }
    // The message comes on stdin.
    args.push("-".to_owned());
    args
}

fn gemini_args(session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--output-format",
        "stream-json",
        // Not the person's other MCP servers.
        "--allowed-mcp-server-names",
        SERVER,
    ]
    .map(str::to_owned)
    .into();
    if let Some(session) = session {
        args.push("--resume".to_owned());
        args.push(session.to_owned());
    }
    args
}

/// What Cursor's agent may not do in Studio's folder (deny wins over
/// `--force`, which lets SpellSheet's tools run without asking).
const CURSOR_DENIED: &[&str] = &["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)"];

/// `cursor-agent -p … <message>`: the message is added last by the caller
/// ([`AgentKind::prompt_as_argument`]).
fn cursor_args(dir: &Path, session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--workspace"]
        .map(str::to_owned)
        .into();
    args.push(dir.display().to_string());
    // Studio's own folder; its MCP server (SpellSheet) without asking.
    args.extend(["--trust", "--approve-mcps", "--force"].map(str::to_owned));
    if let Some(session) = session {
        args.push("--resume".to_owned());
        args.push(session.to_owned());
    }
    args
}

fn copilot_args(mcp_config: &Path, session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["--output-format", "json", "--additional-mcp-config"]
        .map(str::to_owned)
        .into();
    args.push(format!("@{}", mcp_config.display()));
    args.extend(
        [
            // Not GitHub's own MCP servers; only SpellSheet's tools, which run without asking.
            "--disable-builtin-mcps",
            "--available-tools",
            SERVER,
            "--allow-tool",
            SERVER,
        ]
        .map(str::to_owned),
    );
    if let Some(session) = session {
        args.push("--resume".to_owned());
        args.push(session.to_owned());
    }
    args
}

/// A tool's name without the prefix each agent gives MCP tools
/// (`mcp__spellsheet__get_flow`, `mcp_spellsheet_get_flow`, `spellsheet-get_flow`).
pub(crate) fn tool_name(name: &str) -> Option<String> {
    [
        format!("mcp__{SERVER}__"),
        format!("mcp_{SERVER}_"),
        format!("{SERVER}-"),
        format!("{SERVER}__"),
    ]
    .iter()
    .find_map(|p| name.strip_prefix(p.as_str()))
    .map(str::to_owned)
}

/// The flow a `create_flow` result names.
pub(crate) fn created(text: &str) -> Option<AgentEvent> {
    let out = serde_json::from_str::<Value>(text).ok()?;
    let flow = out.get("flow")?;
    Some(AgentEvent::Created {
        flow_id: flow.get("id")?.as_str()?.to_owned(),
        name: flow
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Text of an MCP result's `content` (a string or text parts).
pub(crate) fn content_text(content: Option<&Value>) -> String {
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

/// Reads `codex exec --json`.
#[derive(Default)]
pub(crate) struct CodexStream;

impl CodexStream {
    pub(crate) fn line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let item = v.get("item").cloned().unwrap_or(Value::Null);
        let item_type = item.get("type").and_then(Value::as_str);
        match v.get("type").and_then(Value::as_str) {
            Some("thread.started") => str_of(&v, "thread_id")
                .map(|session_id| vec![AgentEvent::Session { session_id }])
                .unwrap_or_default(),
            Some("item.started") if item_type == Some("mcp_tool_call") => {
                if str_of(&item, "server").as_deref() != Some(SERVER) {
                    return Vec::new();
                }
                str_of(&item, "tool")
                    .map(|name| vec![AgentEvent::tool(name, item.get("arguments"))])
                    .unwrap_or_default()
            }
            Some("item.completed") => match item_type {
                Some("agent_message") => str_of(&item, "text")
                    .filter(|t| !t.trim().is_empty())
                    .map(|text| vec![AgentEvent::Text { text }])
                    .unwrap_or_default(),
                Some("mcp_tool_call") => {
                    if let Some(message) = item.pointer("/error/message").and_then(Value::as_str) {
                        return vec![AgentEvent::ToolFailed {
                            message: truncate(message, TOOL_ERROR_LEN),
                        }];
                    }
                    let text = content_text(item.pointer("/result/content"));
                    if item.pointer("/result/is_error").and_then(Value::as_bool) == Some(true)
                        || str_of(&item, "status").as_deref() == Some("failed")
                    {
                        return vec![AgentEvent::ToolFailed {
                            message: truncate(&text, TOOL_ERROR_LEN),
                        }];
                    }
                    if str_of(&item, "tool").as_deref() == Some("create_flow") {
                        return created(&text).into_iter().collect();
                    }
                    Vec::new()
                }
                _ => Vec::new(),
            },
            Some("turn.completed") => vec![AgentEvent::done(true, None, None)],
            Some("turn.failed") => vec![AgentEvent::done(
                false,
                Some(
                    v.pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("AI が途中で終了しました")
                        .to_owned(),
                ),
                None,
            )],
            _ => Vec::new(),
        }
    }
}

/// Reads `gemini --output-format stream-json`. Its reply comes in pieces,
/// shown as one text once a tool call or the end follows.
#[derive(Default)]
pub(crate) struct GeminiStream {
    text: String,
    tools: HashMap<String, String>,
    error: Option<String>,
}

impl GeminiStream {
    fn flush(&mut self) -> Option<AgentEvent> {
        let text = std::mem::take(&mut self.text);
        (!text.trim().is_empty()).then_some(AgentEvent::Text { text })
    }

    pub(crate) fn line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match v.get("type").and_then(Value::as_str) {
            Some("init") => str_of(&v, "session_id")
                .map(|session_id| vec![AgentEvent::Session { session_id }])
                .unwrap_or_default(),
            Some("message") if str_of(&v, "role").as_deref() == Some("assistant") => {
                if let Some(text) = str_of(&v, "content") {
                    if v.get("delta").and_then(Value::as_bool) == Some(true) {
                        self.text.push_str(&text);
                    } else {
                        self.text = text;
                    }
                }
                Vec::new()
            }
            Some("tool_use") => {
                let mut out: Vec<AgentEvent> = self.flush().into_iter().collect();
                if let Some(name) = str_of(&v, "tool_name").and_then(|n| tool_name(&n)) {
                    if let Some(id) = str_of(&v, "tool_id") {
                        self.tools.insert(id, name.clone());
                    }
                    out.push(AgentEvent::tool(name, v.get("parameters")));
                }
                out
            }
            Some("tool_result") => {
                let tool = str_of(&v, "tool_id").and_then(|id| self.tools.remove(&id));
                if str_of(&v, "status").as_deref() == Some("error") {
                    let message = v
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| str_of(&v, "output"))
                        .unwrap_or_default();
                    return vec![AgentEvent::ToolFailed {
                        message: truncate(&message, TOOL_ERROR_LEN),
                    }];
                }
                if tool.as_deref() == Some("create_flow") {
                    return str_of(&v, "output")
                        .and_then(|o| created(&o))
                        .into_iter()
                        .collect();
                }
                Vec::new()
            }
            Some("error") => {
                self.error = str_of(&v, "message");
                Vec::new()
            }
            Some("result") => {
                let mut out: Vec<AgentEvent> = self.flush().into_iter().collect();
                let ok = str_of(&v, "status").as_deref() == Some("success");
                let message = (!ok).then(|| {
                    v.pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| self.error.take())
                        .unwrap_or_else(|| "AI が途中で終了しました".to_owned())
                });
                out.push(AgentEvent::done(ok, message, None));
                out
            }
            _ => Vec::new(),
        }
    }
}

/// Reads `copilot --output-format json`.
#[derive(Default)]
pub(crate) struct CopilotStream {
    tools: HashMap<String, String>,
    preparing: std::collections::HashSet<String>,
    error: Option<String>,
}

impl CopilotStream {
    pub(crate) fn line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let data = v.get("data").cloned().unwrap_or(Value::Null);
        match v.get("type").and_then(Value::as_str) {
            // Its input is still being written: say which tool is coming.
            Some("assistant.tool_call_delta") => {
                let Some(id) = str_of(&data, "toolCallId") else {
                    return Vec::new();
                };
                if !self.preparing.insert(id) {
                    return Vec::new();
                }
                str_of(&data, "toolName")
                    .and_then(|n| tool_name(&n))
                    .map(|name| vec![AgentEvent::Preparing { name }])
                    .unwrap_or_default()
            }
            Some("assistant.message") => {
                let mut out = Vec::new();
                if let Some(text) = str_of(&data, "content").filter(|t| !t.trim().is_empty()) {
                    out.push(AgentEvent::Text { text });
                }
                for request in data
                    .get("toolRequests")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(name) = str_of(request, "name").and_then(|n| tool_name(&n)) else {
                        continue;
                    };
                    if let Some(id) = str_of(request, "toolCallId") {
                        self.tools.insert(id, name.clone());
                    }
                    out.push(AgentEvent::tool(name, request.get("arguments")));
                }
                out
            }
            Some("tool.execution_complete") => {
                let tool = str_of(&data, "toolCallId").and_then(|id| self.tools.remove(&id));
                let text = data
                    .pointer("/result/content")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| content_text(data.pointer("/result/contents")));
                if data.get("success").and_then(Value::as_bool) == Some(false) {
                    let message = data
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or(text);
                    return vec![AgentEvent::ToolFailed {
                        message: truncate(&message, TOOL_ERROR_LEN),
                    }];
                }
                if tool.as_deref() == Some("create_flow") {
                    return created(&text).into_iter().collect();
                }
                Vec::new()
            }
            Some("session.error") => {
                self.error = str_of(&data, "message");
                Vec::new()
            }
            Some("result") => {
                let mut out = Vec::new();
                if let Some(session_id) = str_of(&v, "sessionId") {
                    out.push(AgentEvent::Session { session_id });
                }
                let ok = v.get("exitCode").and_then(Value::as_i64).unwrap_or(0) == 0
                    && self.error.is_none();
                let message = (!ok).then(|| {
                    self.error
                        .take()
                        .unwrap_or_else(|| "AI が途中で終了しました".to_owned())
                });
                out.push(AgentEvent::done(ok, message, None));
                out
            }
            _ => Vec::new(),
        }
    }
}

/// Reads `cursor-agent -p --output-format stream-json`: like Claude Code's,
/// with its tool calls as `tool_call` events (`mcpToolCall` for MCP tools).
#[derive(Default)]
pub(crate) struct CursorStream {
    session: bool,
}

impl CursorStream {
    pub(crate) fn line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match v.get("type").and_then(Value::as_str) {
            Some("system") if !self.session => {
                self.session = true;
                str_of(&v, "session_id")
                    .map(|session_id| vec![AgentEvent::Session { session_id }])
                    .unwrap_or_default()
            }
            Some("assistant") => {
                let text = content_text(v.pointer("/message/content"));
                if text.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![AgentEvent::Text { text }]
                }
            }
            Some("tool_call") => {
                let Some(call) = v.pointer("/tool_call/mcpToolCall") else {
                    return Vec::new();
                };
                let args = call.get("args").cloned().unwrap_or(Value::Null);
                let name = str_of(&args, "toolName")
                    .filter(|_| str_of(&args, "providerIdentifier").as_deref() == Some(SERVER))
                    .or_else(|| str_of(&args, "name").and_then(|n| tool_name(&n)));
                let Some(name) = name else {
                    return Vec::new();
                };
                match v.get("subtype").and_then(Value::as_str) {
                    Some("started") => vec![AgentEvent::tool(name, args.get("args"))],
                    Some("completed") => {
                        let result = call.get("result").cloned().unwrap_or(Value::Null);
                        if let Some(success) = result.get("success") {
                            let text = cursor_result_text(success);
                            if success.get("isError").and_then(Value::as_bool) == Some(true) {
                                return vec![AgentEvent::ToolFailed {
                                    message: truncate(&text, TOOL_ERROR_LEN),
                                }];
                            }
                            if name == "create_flow" {
                                return created(&text).into_iter().collect();
                            }
                            return Vec::new();
                        }
                        let message = ["rejected", "error", "failure"]
                            .iter()
                            .find_map(|k| result.get(*k))
                            .map(|r| {
                                ["reason", "message", "error"]
                                    .iter()
                                    .find_map(|k| str_of(r, k))
                                    .unwrap_or_else(|| r.to_string())
                            })
                            .unwrap_or_default();
                        if message.is_empty() {
                            Vec::new()
                        } else {
                            vec![AgentEvent::ToolFailed {
                                message: truncate(&message, TOOL_ERROR_LEN),
                            }]
                        }
                    }
                    _ => Vec::new(),
                }
            }
            Some("result") => {
                let mut out = Vec::new();
                if !self.session
                    && let Some(session_id) = str_of(&v, "session_id")
                {
                    self.session = true;
                    out.push(AgentEvent::Session { session_id });
                }
                let ok = v.get("is_error").and_then(Value::as_bool) != Some(true)
                    && str_of(&v, "subtype")
                        .as_deref()
                        .is_none_or(|s| s == "success");
                let message = (!ok).then(|| {
                    str_of(&v, "result")
                        .filter(|r| !r.trim().is_empty())
                        .unwrap_or_else(|| "AI が途中で終了しました".to_owned())
                });
                out.push(AgentEvent::done(ok, message, None));
                out
            }
            _ => Vec::new(),
        }
    }
}

/// The text of a Cursor MCP result: `content` as MCP gives it, where a text
/// part may hold its text directly or under `text.text`.
fn cursor_result_text(success: &Value) -> String {
    match success.get("content") {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| {
                p.get("text").and_then(|t| {
                    t.as_str()
                        .map(str::to_owned)
                        .or_else(|| t.get("text").and_then(Value::as_str).map(str::to_owned))
                })
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => content_text(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn<'a>(dir: &'a Path, session: Option<&'a str>) -> Turn<'a> {
        Turn {
            dir,
            cli: Path::new("C:\\Program Files\\SpellSheet\\spellsheet.exe"),
            workspace: Path::new("D:\\work"),
            system_prompt: "be brief",
            session,
            own: None,
        }
    }

    #[test]
    fn strips_each_agents_tool_prefix() {
        for n in [
            "mcp__spellsheet__get_flow",
            "mcp_spellsheet_get_flow",
            "spellsheet-get_flow",
        ] {
            assert_eq!(tool_name(n).as_deref(), Some("get_flow"), "{n}");
        }
        assert_eq!(tool_name("run_shell_command"), None);
    }

    #[test]
    fn codex_gets_only_spellsheet_and_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let (args, _) = prepare(AgentKind::Codex, &turn(dir.path(), Some("t1"))).unwrap();
        let joined = args.join(" ");
        assert!(joined.starts_with("exec --json --skip-git-repo-check --sandbox read-only"));
        assert!(joined.contains("features.shell_tool=false"));
        assert!(joined.contains(
            "mcp_servers.spellsheet.command='C:\\Program Files\\SpellSheet\\spellsheet.exe'"
        ));
        assert!(joined.contains(
            "mcp_servers.spellsheet.args=['--workspace','D:\\work','mcp','--writer-chat']"
        ));
        assert!(joined.contains("default_tools_approval_mode='approve'"));
        assert!(joined.ends_with("resume t1 -"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(),
            "be brief"
        );
        assert!(args.iter().all(|a| !a.contains('\n')));
        assert_eq!(toml_str("it's"), "\"it's\"");
    }

    #[test]
    fn gemini_trusts_only_spellsheet() {
        let dir = tempfile::tempdir().unwrap();
        let (args, env) = prepare(AgentKind::Gemini, &turn(dir.path(), None)).unwrap();
        assert_eq!(
            args,
            [
                "--output-format",
                "stream-json",
                "--allowed-mcp-server-names",
                "spellsheet"
            ]
        );
        assert_eq!(env, [("GEMINI_CLI_TRUST_WORKSPACE", "true".to_owned())]);
        let settings: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join(".gemini/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            settings.pointer("/mcpServers/spellsheet/trust"),
            Some(&json!(true))
        );
        assert!(
            settings
                .pointer("/tools/exclude")
                .unwrap()
                .as_array()
                .unwrap()
                .contains(&json!("run_shell_command"))
        );
        assert!(dir.path().join("GEMINI.md").is_file());
        let (args, _) = prepare(AgentKind::Gemini, &turn(dir.path(), Some("s"))).unwrap();
        assert!(args.ends_with(&["--resume".to_owned(), "s".to_owned()]));
    }

    #[test]
    fn copilot_gets_only_spellsheet() {
        let dir = tempfile::tempdir().unwrap();
        let (args, _) = prepare(AgentKind::Copilot, &turn(dir.path(), Some("s"))).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("--output-format json --additional-mcp-config @"));
        assert!(joined.contains(
            "--disable-builtin-mcps --available-tools spellsheet --allow-tool spellsheet"
        ));
        assert!(joined.ends_with("--resume s"));
        let mcp: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("copilot-mcp.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            mcp.pointer("/mcpServers/spellsheet/args/1"),
            Some(&json!("D:\\work"))
        );
    }

    #[test]
    fn every_agent_learns_where_this_turns_messages_wait() {
        let dir = tempfile::tempdir().unwrap();
        let own = dir.path().join("turns").join("turn_1");
        std::fs::create_dir_all(&own).unwrap();
        let inbox = own.join(INBOX).display().to_string();
        let with_own = |session| Turn {
            own: Some(&own),
            ..turn(dir.path(), session)
        };
        let server_args = |file: &Path| -> Vec<Value> {
            let config: Value =
                serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
            config
                .pointer("/mcpServers/spellsheet/args")
                .unwrap()
                .as_array()
                .unwrap()
                .clone()
        };

        // Claude Code and Copilot: settings of this turn's own, naming its inbox.
        let (args, _) = prepare(AgentKind::ClaudeCode, &with_own(None)).unwrap();
        let mcp = own.join("mcp.json");
        assert!(args.contains(&mcp.display().to_string()));
        assert_eq!(server_args(&mcp)[4..], [json!("--inbox"), json!(inbox)]);
        prepare(AgentKind::Copilot, &with_own(None)).unwrap();
        assert_eq!(
            server_args(&own.join("copilot-mcp.json"))[4..],
            [json!("--inbox"), json!(inbox)]
        );

        // Codex: on the command line.
        let (args, _) = prepare(AgentKind::Codex, &with_own(None)).unwrap();
        assert!(
            args.join(" ")
                .contains(&format!("'--writer-chat','--inbox',{}]", toml_str(&inbox)))
        );

        // Gemini: its shared settings name a variable set for this turn.
        let (_, env) = prepare(AgentKind::Gemini, &with_own(None)).unwrap();
        assert!(env.contains(&(INBOX_VAR, inbox.clone())));
        assert_eq!(
            server_args(&dir.path().join(".gemini/settings.json"))[4..],
            [json!("--inbox"), json!("${SPELLSHEET_CHAT_INBOX}")]
        );

        // An agent of its own gets messages as the next message instead.
        let command = Turn {
            own: Some(&own),
            ..turn(dir.path(), None)
        };
        prepare(AgentKind::Command, &command).unwrap();
        assert_eq!(
            server_args(&dir.path().join("mcp.json")),
            [json!("--workspace"), json!("D:\\work"), json!("mcp")]
        );
    }

    // The lines below are what each tool printed against a stand-in model
    // server, with SpellSheet's real MCP server behind it.

    #[test]
    fn reads_codex() {
        let mut s = CodexStream;
        let lines = [
            r#"{"type":"thread.started","thread_id":"01a1"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata not found"}}"#,
            r#"{"type":"error","message":"Reconnecting... 2/5"}"#,
            r#"{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"spellsheet","tool":"update_flow","arguments":{"summary":"送信を足しました"},"result":null,"error":null,"status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"spellsheet","tool":"create_flow","arguments":{},"result":{"content":[{"type":"text","text":"{\"flow\":{\"id\":\"scn_1\",\"name\":\"請求\"}}"}]},"error":null,"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"spellsheet","tool":"get_flow","arguments":{},"result":null,"error":{"message":"no such flow"},"status":"failed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"直しました。"}}"#,
            r#"{"type":"turn.completed","usage":{}}"#,
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|l| s.line(l)).collect();
        assert_eq!(
            events,
            [
                AgentEvent::Session {
                    session_id: "01a1".into()
                },
                AgentEvent::Tool {
                    name: "update_flow".into(),
                    detail: Some("送信を足しました".into())
                },
                AgentEvent::Created {
                    flow_id: "scn_1".into(),
                    name: "請求".into()
                },
                AgentEvent::ToolFailed {
                    message: "no such flow".into()
                },
                AgentEvent::Text {
                    text: "直しました。".into()
                },
                AgentEvent::done(true, None, None),
            ]
        );
        let failed = s.line(r#"{"type":"turn.failed","error":{"message":"401 Unauthorized: please run codex login"}}"#);
        assert!(matches!(
            &failed[0],
            AgentEvent::Done {
                ok: false,
                needs_login: true,
                ..
            }
        ));
    }

    #[test]
    fn reads_gemini() {
        let mut s = GeminiStream::default();
        let lines = [
            r#"{"type":"init","session_id":"g1","model":"gemini-2.5-flash"}"#,
            r#"{"type":"message","role":"user","content":"hello"}"#,
            r#"{"type":"message","role":"assistant","content":"見て","delta":true}"#,
            r#"{"type":"message","role":"assistant","content":"みます。","delta":true}"#,
            r#"{"type":"tool_use","tool_name":"mcp_spellsheet_create_flow","tool_id":"c1","parameters":{"summary":"新しいフロー"}}"#,
            r#"{"type":"tool_result","tool_id":"c1","status":"success","output":"{\"flow\":{\"id\":\"scn_2\",\"name\":\"在庫\"}}"}"#,
            r#"{"type":"tool_use","tool_name":"mcp_spellsheet_get_flow","tool_id":"c2","parameters":{}}"#,
            r#"{"type":"tool_result","tool_id":"c2","status":"error","error":{"type":"x","message":"bad id"}}"#,
            r#"{"type":"message","role":"assistant","content":"できました。","delta":true}"#,
            r#"{"type":"result","status":"success","stats":{}}"#,
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|l| s.line(l)).collect();
        assert_eq!(
            events,
            [
                AgentEvent::Session {
                    session_id: "g1".into()
                },
                AgentEvent::Text {
                    text: "見てみます。".into()
                },
                AgentEvent::Tool {
                    name: "create_flow".into(),
                    detail: Some("新しいフロー".into())
                },
                AgentEvent::Created {
                    flow_id: "scn_2".into(),
                    name: "在庫".into()
                },
                AgentEvent::Tool {
                    name: "get_flow".into(),
                    detail: None
                },
                AgentEvent::ToolFailed {
                    message: "bad id".into()
                },
                AgentEvent::Text {
                    text: "できました。".into()
                },
                AgentEvent::done(true, None, None),
            ]
        );
        let failed = s.line(r#"{"type":"result","status":"error","error":{"type":"unknown","message":"API key not valid"}}"#);
        assert!(matches!(
            &failed[0],
            AgentEvent::Done {
                ok: false,
                needs_login: true,
                ..
            }
        ));
    }

    #[test]
    fn reads_copilot() {
        let mut s = CopilotStream::default();
        let lines = [
            r#"{"type":"session.mcp_server_status_changed","data":{"serverName":"spellsheet","status":"connected"},"ephemeral":true}"#,
            r#"{"type":"assistant.tool_call_delta","data":{"toolCallId":"call_1","toolName":"spellsheet-update_flow","inputDelta":"{"},"ephemeral":true}"#,
            r#"{"type":"assistant.tool_call_delta","data":{"toolCallId":"call_1","toolName":"spellsheet-update_flow","inputDelta":"}"},"ephemeral":true}"#,
            r#"{"type":"assistant.message","data":{"content":"","toolRequests":[{"toolCallId":"call_1","name":"spellsheet-update_flow","arguments":{"summary":"確認を足しました"},"type":"function"}]}}"#,
            r#"{"type":"tool.execution_complete","data":{"toolCallId":"call_1","success":true,"result":{"content":"{}"}}}"#,
            r#"{"type":"assistant.message","data":{"content":"フローを確認しました。","toolRequests":[]}}"#,
            r#"{"type":"result","sessionId":"c-1","exitCode":0}"#,
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|l| s.line(l)).collect();
        assert_eq!(
            events,
            [
                AgentEvent::Preparing {
                    name: "update_flow".into()
                },
                AgentEvent::Tool {
                    name: "update_flow".into(),
                    detail: Some("確認を足しました".into())
                },
                AgentEvent::Text {
                    text: "フローを確認しました。".into()
                },
                AgentEvent::Session {
                    session_id: "c-1".into()
                },
                AgentEvent::done(true, None, None),
            ]
        );
        assert!(s.line(r#"{"type":"session.error","data":{"errorType":"query","message":"Could not connect"}}"#).is_empty());
        let failed = s.line(r#"{"type":"result","sessionId":"c-2","exitCode":1}"#);
        assert_eq!(
            failed[1],
            AgentEvent::done(false, Some("Could not connect".into()), None)
        );
    }

    #[test]
    fn cursor_gets_only_spellsheet() {
        let dir = tempfile::tempdir().unwrap();
        let own = dir.path().join("turns").join("turn_1");
        std::fs::create_dir_all(&own).unwrap();
        let with_own = Turn {
            own: Some(&own),
            ..turn(dir.path(), Some("chat-1"))
        };
        let (args, env) = prepare(AgentKind::Cursor, &with_own).unwrap();
        let joined = args.join(" ");
        assert!(joined.starts_with("-p --output-format stream-json --workspace "));
        assert!(joined.contains("--trust --approve-mcps --force"));
        assert!(joined.ends_with("--resume chat-1"));
        assert!(AgentKind::Cursor.prompt_as_argument());
        assert!(env.contains(&(INBOX_VAR, own.join(INBOX).display().to_string())));
        assert!(dir.path().join("AGENTS.md").is_file());
        let read = |name: &str| -> Value {
            serde_json::from_str(
                &std::fs::read_to_string(dir.path().join(".cursor").join(name)).unwrap(),
            )
            .unwrap()
        };
        let mcp = read("mcp.json");
        let servers = mcp.get("mcpServers").unwrap().as_object().unwrap();
        assert_eq!(servers.keys().collect::<Vec<_>>(), ["spellsheet"]);
        assert_eq!(
            mcp.pointer("/mcpServers/spellsheet/args")
                .unwrap()
                .as_array()
                .unwrap()[4..],
            [json!("--inbox"), json!("${env:SPELLSHEET_CHAT_INBOX}")]
        );
        let cli = read("cli.json");
        assert_eq!(
            cli.pointer("/permissions/allow"),
            Some(&json!(["Mcp(spellsheet:*)"]))
        );
        assert!(
            cli.pointer("/permissions/deny")
                .unwrap()
                .as_array()
                .unwrap()
                .contains(&json!("Shell(*)"))
        );
    }

    #[test]
    fn cursor_runs_its_own_node_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let versions = dir.path().join("versions");
        for (name, complete) in [
            ("2026.09.01-a", true),
            ("2026.10.15-b", true),
            ("2026.11.01-c", false),
        ] {
            let v = versions.join(name);
            std::fs::create_dir_all(&v).unwrap();
            std::fs::write(v.join("node.exe"), "").unwrap();
            if complete {
                std::fs::write(v.join("index.js"), "").unwrap();
            }
        }
        let newest = newest_cursor_version(&versions).unwrap();
        assert_eq!(newest, versions.join("2026.10.15-b"));
        assert_eq!(
            AgentKind::Cursor.leading_args(&newest.join("node.exe")),
            [newest.join("index.js").display().to_string()]
        );
        assert!(
            AgentKind::Cursor
                .leading_args(Path::new("/usr/local/bin/cursor-agent"))
                .is_empty()
        );
        assert!(
            AgentKind::Codex
                .leading_args(&newest.join("node.exe"))
                .is_empty()
        );
    }

    #[test]
    fn reads_cursor() {
        let mut s = CursorStream::default();
        let lines = [
            r#"{"type":"system","subtype":"init","apiKeySource":"login","cwd":"D:\\work","session_id":"chat-1","model":"Auto","permissionMode":"default"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"作って"}]},"session_id":"chat-1"}"#,
            r#"{"type":"tool_call","subtype":"started","call_id":"t1","tool_call":{"mcpToolCall":{"args":{"name":"spellsheet-create_flow","args":{"name":"請求書"},"toolCallId":"t1","providerIdentifier":"spellsheet","toolName":"create_flow"}}},"session_id":"chat-1"}"#,
            r#"{"type":"tool_call","subtype":"completed","call_id":"t1","tool_call":{"mcpToolCall":{"args":{"name":"spellsheet-create_flow","args":{"name":"請求書"},"toolCallId":"t1","providerIdentifier":"spellsheet","toolName":"create_flow"},"result":{"success":{"content":[{"text":{"text":"{\"flow\":{\"id\":\"f1\",\"name\":\"請求書\"}}"}}],"isError":false}}}},"session_id":"chat-1"}"#,
            r#"{"type":"tool_call","subtype":"started","call_id":"t2","tool_call":{"readToolCall":{"args":{"path":"a.txt"}}},"session_id":"chat-1"}"#,
            r#"{"type":"tool_call","subtype":"completed","call_id":"t3","tool_call":{"mcpToolCall":{"args":{"name":"spellsheet-run_flow","args":{},"providerIdentifier":"spellsheet","toolName":"run_flow"},"result":{"rejected":{"reason":"not allowed"}}}},"session_id":"chat-1"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"フローを作りました。"}]},"session_id":"chat-1"}"#,
            r#"{"type":"result","subtype":"success","duration_ms":1200,"is_error":false,"result":"フローを作りました。","session_id":"chat-1"}"#,
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|l| s.line(l)).collect();
        assert_eq!(
            events,
            [
                AgentEvent::Session {
                    session_id: "chat-1".into()
                },
                AgentEvent::tool("create_flow".into(), Some(&json!({"name":"請求書"}))),
                AgentEvent::Created {
                    flow_id: "f1".into(),
                    name: "請求書".into()
                },
                AgentEvent::ToolFailed {
                    message: "not allowed".into()
                },
                AgentEvent::Text {
                    text: "フローを作りました。".into()
                },
                AgentEvent::done(true, None, None),
            ]
        );
        let failed = CursorStream::default().line(
            r#"{"type":"result","subtype":"error","is_error":true,"result":"Rate limited","session_id":"chat-2"}"#,
        );
        assert_eq!(
            failed,
            [
                AgentEvent::Session {
                    session_id: "chat-2".into()
                },
                AgentEvent::done(false, Some("Rate limited".into()), None),
            ]
        );
    }
}
