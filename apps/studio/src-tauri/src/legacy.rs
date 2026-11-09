//! Moving what the product's old name left on this PC to the new name, once,
//! when Writer starts after the update that renamed it.
//!
//! - Writer's window settings: the WebView data folder is named after the
//!   app identifier, which changed with the name. It moves before the first
//!   window opens ([`move_webview_data`]); the browser storage keys inside
//!   it move in the screens (`src/lib/legacyStorage.ts`).
//! - The AI clients' MCP setup (Claude Code, Claude Desktop, Codex, Cursor,
//!   Gemini CLI, Copilot CLI, VS Code, Windsurf): a server registered under
//!   the old name, or starting the old command, is renamed and pointed at
//!   `spellsheet.exe` ([`migrate_mcp_setups`]). The AI client picks it up
//!   when it next starts.
//! - The worker's scheduled task: `spellsheet worker migrate`.
//! - The old command left in the install folder, once nothing points at it.
//!
//! Every step is best-effort: what cannot be moved now is tried again at the
//! next start, and nothing here stops Writer from starting.
//!
//! The old name appears in this file (and in `spellsheet_core::paths`) only so
//! it can be found and replaced.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// The old name, in lower case, as in the MCP server name and the command.
fn legacy_name() -> String {
    spellsheet_core::paths::LEGACY_APP_DIR.to_ascii_lowercase()
}

/// The MCP server name and the command now.
const NAME: &str = "spellsheet";

/// The app identifier before the rename (its WebView data folder).
fn legacy_identifier() -> String {
    format!("dev.{}.studio", legacy_name())
}

/// The app identifier now (`identifier` in tauri.conf.json).
const IDENTIFIER: &str = "dev.spellsheet.writer";

/// Before the first window: `%LOCALAPPDATA%\<old identifier>` (the WebView's
/// storage) and its roaming twin become the new identifier's folders.
pub(crate) fn move_webview_data() {
    for base in [dirs::data_local_dir(), dirs::data_dir()]
        .into_iter()
        .flatten()
    {
        move_folder(&base.join(legacy_identifier()), &base.join(IDENTIFIER));
    }
}

fn move_folder(old: &Path, new: &Path) {
    if !old.is_dir() || new.exists() {
        return;
    }
    if let Err(e) = std::fs::rename(old, new) {
        tracing::warn!(error = %e, folder = %old.display(), "cannot move the folder to the new name yet");
    }
}

/// After start-up, in the background: the AI clients' MCP setup, the worker
/// task and the old command. Installed builds only: a development build
/// leaves the developer's own setup alone.
pub(crate) fn spawn_after_start() {
    if cfg!(debug_assertions) || !cfg!(windows) {
        return;
    }
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let cli = dir.join(format!("{NAME}.exe"));
    if !cli.is_file() {
        return;
    }
    std::thread::spawn(move || {
        let Some(home) = dirs::home_dir() else { return };
        let mut files = mcp_setups(&home, dirs::config_dir().as_deref());
        files.extend(project_setups(&home));
        files.extend(plugin_setups(&home.join(".claude").join("plugins")));
        let all_moved = migrate_mcp_setups(&files);
        migrate_worker_task(&cli);
        if all_moved {
            remove_old_command(&dir);
        }
    });
}

/// Where AI clients keep their MCP servers (user level).
fn mcp_setups(home: &Path, roaming: Option<&Path>) -> Vec<PathBuf> {
    let mut files = vec![
        home.join(".claude.json"),
        home.join(".claude").join("settings.json"),
        home.join(".cursor").join("mcp.json"),
        home.join(".gemini").join("settings.json"),
        home.join(".copilot").join("mcp-config.json"),
        home.join(".codeium")
            .join("windsurf")
            .join("mcp_config.json"),
        home.join(".codex").join("config.toml"),
    ];
    if let Some(roaming) = roaming {
        files.push(roaming.join("Claude").join("claude_desktop_config.json"));
        files.push(roaming.join("Code").join("User").join("mcp.json"));
    }
    files
}

/// The project-level setups of the folders Claude Code knows
/// (`projects` in `~/.claude.json`): `.mcp.json`, and Cursor's, VS Code's and
/// Gemini CLI's files in the same folders.
fn project_setups(home: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) else {
        return vec![];
    };
    let Ok(Value::Object(config)) = serde_json::from_str::<Value>(&text) else {
        return vec![];
    };
    let Some(Value::Object(projects)) = config.get("projects") else {
        return vec![];
    };
    projects
        .keys()
        .map(PathBuf::from)
        .flat_map(|dir| {
            [
                dir.join(".mcp.json"),
                dir.join(".cursor").join("mcp.json"),
                dir.join(".vscode").join("mcp.json"),
                dir.join(".gemini").join("settings.json"),
            ]
        })
        .collect()
}

/// The `.mcp.json` of the Claude Code plugins installed on this PC
/// (`~/.claude/plugins`), such as the one SpellSheet shipped under its old name.
fn plugin_setups(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth > 0 {
                    walk(&path, depth - 1, out);
                }
            } else if path.file_name().is_some_and(|n| n == ".mcp.json") {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 6, &mut out);
    out
}

/// Rewrites each file that mentions the old server or command. False when
/// one could not be read or written (the old command is then kept).
fn migrate_mcp_setups(files: &[PathBuf]) -> bool {
    let mut all = true;
    for file in files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        let updated = if file.extension().is_some_and(|e| e == "toml") {
            Some(migrate_toml(&text)).filter(|t| *t != text)
        } else {
            migrate_json(&text)
        };
        let Some(updated) = updated else { continue };
        match write_replacing(file, &updated) {
            Ok(()) => tracing::info!(file = %file.display(), "moved the MCP setup to the new name"),
            Err(e) => {
                all = false;
                tracing::warn!(error = %e, file = %file.display(), "cannot move the MCP setup to the new name");
            }
        }
    }
    all
}

/// Writes next to the file and swaps it in, so an AI client never reads half
/// a file. The first time, the file as it was is kept beside it.
fn write_replacing(file: &Path, text: &str) -> std::io::Result<()> {
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("mcp");
    let backup = file.with_file_name(format!("{name}.before-{NAME}"));
    if !backup.exists() {
        std::fs::copy(file, &backup)?;
    }
    let temp = file.with_file_name(format!("{name}.{NAME}-tmp"));
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, file)
}

/// The JSON setups: every `mcpServers` / `servers` object (also those of
/// Claude Code's projects), and tool names in permission lists
/// (`mcp__<old>__get_flow`). `None` when nothing changes.
fn migrate_json(text: &str) -> Option<String> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    if !migrate_value(&mut value, &legacy_name()) {
        return None;
    }
    let mut out = serde_json::to_string_pretty(&value).ok()?;
    out.push('\n');
    Some(out)
}

fn migrate_value(value: &mut Value, old: &str) -> bool {
    match value {
        Value::Object(map) => {
            let mut changed = false;
            for (key, child) in map.iter_mut() {
                if key == "mcpServers" || key == "servers" {
                    if let Value::Object(servers) = child {
                        changed |= migrate_servers(servers, old);
                    }
                } else {
                    changed |= migrate_value(child, old);
                }
            }
            changed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| migrate_value(item, old) | changed),
        Value::String(text) => match text.strip_prefix(&format!("mcp__{old}")) {
            Some(rest) => {
                *text = format!("mcp__{NAME}{rest}");
                true
            }
            None => false,
        },
        _ => false,
    }
}

fn migrate_servers(servers: &mut serde_json::Map<String, Value>, old: &str) -> bool {
    let mut changed = false;
    for server in servers.values_mut() {
        if let Some(Value::String(command)) = server.get_mut("command")
            && let Some(new) = new_command(command, old)
        {
            *command = new;
            changed = true;
        }
    }
    if !servers.contains_key(NAME)
        && let Some(server) = servers.remove(old)
    {
        servers.insert(NAME.to_owned(), server);
        changed = true;
    }
    changed
}

/// `C:\…\<old>.exe` -> `C:\…\spellsheet.exe`, `<old>` -> `spellsheet`; other
/// commands are not ours.
fn new_command(command: &str, old: &str) -> Option<String> {
    let start = command.rfind(['\\', '/']).map_or(0, |i| i + 1);
    let file = &command[start..];
    let lower = file.to_ascii_lowercase();
    let new_file = if lower == old {
        NAME.to_owned()
    } else if lower == format!("{old}.exe") {
        format!("{NAME}.exe")
    } else {
        return None;
    };
    Some(format!("{}{new_file}", &command[..start]))
}

/// Codex's `config.toml`: `[mcp_servers.<old>]` (and its sub-tables) and
/// `command = "…<old>.exe"`, line by line so the rest stays as written.
fn migrate_toml(text: &str) -> String {
    let old = legacy_name();
    let has_new = text.lines().any(|l| {
        let l = l.trim();
        l == format!("[mcp_servers.{NAME}]") || l == format!("[mcp_servers.\"{NAME}\"]")
    });
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        let mut replaced = None;
        if !has_new && trimmed.starts_with('[') {
            for (from, to) in [
                (
                    format!("[mcp_servers.{old}"),
                    format!("[mcp_servers.{NAME}"),
                ),
                (
                    format!("[mcp_servers.\"{old}\""),
                    format!("[mcp_servers.\"{NAME}\""),
                ),
            ] {
                let rest = trimmed
                    .strip_prefix(&from)
                    .filter(|r| r.starts_with(']') || r.starts_with('.'));
                if let Some(rest) = rest {
                    let indent = &line[..line.len() - line.trim_start().len()];
                    let end = &line[line.trim_end().len()..];
                    replaced = Some(format!("{indent}{to}{rest}{end}"));
                }
            }
        } else if let Some(value) = trimmed.strip_prefix("command").map(str::trim_start)
            && let Some(value) = value.strip_prefix('=').map(str::trim)
            && let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'')
            && let Some(inner) = toml_string(&value[1..], quote)
            && let Some(new) = new_command(inner, &old)
        {
            replaced = Some(line.replacen(inner, &new, 1));
        }
        out.push_str(replaced.as_deref().unwrap_or(line));
    }
    out
}

/// The text of a TOML string up to its closing `quote` (`rest` starts just
/// after the opening one), whatever follows it (a `# comment`). A basic
/// string ("…") skips escaped characters; a literal one ('…') has none.
fn toml_string(rest: &str, quote: char) -> Option<&str> {
    let mut escaped = false;
    for (i, c) in rest.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' && quote == '"' {
            escaped = true;
        } else if c == quote {
            return Some(&rest[..i]);
        }
    }
    None
}

/// A worker task made with the old command, or under an old task name,
/// starts `spellsheet.exe` from the next sign-in.
fn migrate_worker_task(cli: &Path) {
    let mut command = std::process::Command::new(cli);
    command.args(["worker", "migrate"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.output() {
        Ok(out) if out.status.success() => {}
        Ok(out) => tracing::warn!(
            stderr = %String::from_utf8_lossy(&out.stderr),
            "cannot move the worker task to the new command"
        ),
        Err(e) => tracing::warn!(error = %e, "cannot move the worker task to the new command"),
    }
}

/// The old command in the install folder, and copies of it set aside by
/// updates. One still running under an AI client stays until next time.
fn remove_old_command(dir: &Path) {
    let old = legacy_name();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let parked = name.starts_with(&format!("{old}-")) && name.ends_with(".exe.old");
        if name == format!("{old}.exe") || parked {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn old() -> String {
        legacy_name()
    }

    #[test]
    fn identifier_matches_the_app_config() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
        assert_ne!(legacy_identifier(), IDENTIFIER);
    }

    #[test]
    fn json_server_is_renamed_and_pointed_at_the_new_command() {
        let old = old();
        let text = json!({
            "mcpServers": {
                "other": { "command": "npx", "args": ["x"] },
                old.clone(): { "command": format!(r"C:\Users\a\AppData\Local\SpellSheet Writer\{old}.exe"), "args": ["mcp"] }
            },
            "projects": {
                r"D:\w": { "mcpServers": { "mine": { "command": old.clone() } } }
            },
            "permissions": { "allow": [format!("mcp__{old}__get_flow"), "Bash"] }
        })
        .to_string();
        let out: Value = serde_json::from_str(&migrate_json(&text).unwrap()).unwrap();
        assert_eq!(
            out["mcpServers"]["spellsheet"]["command"],
            r"C:\Users\a\AppData\Local\SpellSheet Writer\spellsheet.exe"
        );
        assert_eq!(out["mcpServers"]["spellsheet"]["args"], json!(["mcp"]));
        assert!(out["mcpServers"].get(&old).is_none());
        assert_eq!(out["mcpServers"]["other"]["command"], "npx");
        assert_eq!(
            out["projects"][r"D:\w"]["mcpServers"]["mine"]["command"],
            "spellsheet"
        );
        assert_eq!(
            out["permissions"]["allow"],
            json!(["mcp__spellsheet__get_flow", "Bash"])
        );
    }

    #[test]
    fn json_without_the_old_name_is_left_alone() {
        let text = r#"{"mcpServers":{"spellsheet":{"command":"spellsheet"}}}"#;
        assert_eq!(migrate_json(text), None);
        assert_eq!(migrate_json("not json"), None);
    }

    #[test]
    fn an_existing_new_server_is_kept_and_the_old_one_still_fixed() {
        let old = old();
        let text = json!({ "mcpServers": {
            "spellsheet": { "command": "spellsheet" },
            old.clone(): { "command": format!("{old}.EXE") }
        }})
        .to_string();
        let out: Value = serde_json::from_str(&migrate_json(&text).unwrap()).unwrap();
        assert_eq!(out["mcpServers"][&old]["command"], "spellsheet.exe");
        assert_eq!(out["mcpServers"]["spellsheet"]["command"], "spellsheet");
    }

    #[test]
    fn codex_toml_tables_and_command_move() {
        let old = old();
        let text = format!(
            "model = \"o3\"\n\n[mcp_servers.{old}]\ncommand = 'C:\\x\\{old}.exe'\nargs = [\"mcp\"]\n\n[mcp_servers.{old}.env]\nA = \"1\"\n\n[mcp_servers.other]\ncommand = \"npx\"\n"
        );
        assert_eq!(
            migrate_toml(&text),
            "model = \"o3\"\n\n[mcp_servers.spellsheet]\ncommand = 'C:\\x\\spellsheet.exe'\nargs = [\"mcp\"]\n\n[mcp_servers.spellsheet.env]\nA = \"1\"\n\n[mcp_servers.other]\ncommand = \"npx\"\n"
        );
        let done = "[mcp_servers.spellsheet]\ncommand = \"spellsheet\"\n";
        assert_eq!(migrate_toml(done), done);
    }

    #[test]
    fn toml_command_with_a_comment_moves_too() {
        let old = old();
        let text =
            format!("[mcp_servers.{old}]\ncommand = \"C:\\\\x\\\\{old}.exe\" # MCP server\n");
        assert_eq!(
            migrate_toml(&text),
            "[mcp_servers.spellsheet]\ncommand = \"C:\\\\x\\\\spellsheet.exe\" # MCP server\n"
        );
    }

    #[test]
    fn project_folders_and_plugins_are_looked_at() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join("work");
        std::fs::write(
            home.path().join(".claude.json"),
            json!({ "projects": { project.display().to_string(): {} } }).to_string(),
        )
        .unwrap();
        assert!(project_setups(home.path()).contains(&project.join(".mcp.json")));
        let plugin = home.path().join("plugins/cache/m/p/1.0.0");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join(".mcp.json"), "{}").unwrap();
        assert_eq!(
            plugin_setups(&home.path().join("plugins")),
            [plugin.join(".mcp.json")]
        );
    }

    #[test]
    fn files_are_rewritten_with_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let old = old();
        std::fs::write(
            &file,
            json!({ "mcpServers": { old: { "command": "x" } } }).to_string(),
        )
        .unwrap();
        assert!(migrate_mcp_setups(&[
            file.clone(),
            dir.path().join("missing.json")
        ]));
        let out: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(out["mcpServers"].get("spellsheet").is_some());
        assert!(dir.path().join("mcp.json.before-spellsheet").is_file());
    }

    #[test]
    fn old_commands_are_removed_from_the_install_folder() {
        let dir = tempfile::tempdir().unwrap();
        let old = old();
        for name in [
            format!("{old}.exe"),
            format!("{old}-0.1.19.exe.old"),
            "spellsheet.exe".into(),
        ] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }
        remove_old_command(dir.path());
        let left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["spellsheet.exe"]);
    }

    #[test]
    fn webview_folder_moves_once() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("a");
        let new = dir.path().join("b");
        std::fs::create_dir_all(old.join("EBWebView")).unwrap();
        move_folder(&old, &new);
        assert!(new.join("EBWebView").is_dir());
        std::fs::create_dir_all(&old).unwrap();
        move_folder(&old, &new);
        assert!(old.is_dir());
    }
}
