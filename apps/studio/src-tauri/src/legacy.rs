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
        let setups_moved = migrate_mcp_setups(&files);
        let task_moved = migrate_worker_task(&cli);
        if setups_moved && task_moved {
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
/// (`projects` in `~/.claude.json`): `.mcp.json` and the permissions in
/// `.claude/settings*.json`, and Cursor's, VS Code's and
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
                dir.join(".claude").join("settings.json"),
                dir.join(".claude").join("settings.local.json"),
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
    // Tool permissions (`mcp__<old>__…`) are Claude Code's. When one of its
    // setups has both names, the old server keeps its name, and its
    // permissions stay with it.
    let old = legacy_name();
    let old_kept = files
        .iter()
        .filter(|file| is_claude_setup(file))
        .any(|file| {
            std::fs::read_to_string(file).is_ok_and(|text| {
                serde_json::from_str::<Value>(&text).is_ok_and(|v| json_has_both(&v, &old))
            })
        });
    let mut all = true;
    for file in files {
        let text = match std::fs::read_to_string(file) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                // Held by another program, say: it may still start the old
                // command, so that stays until a later start moves it.
                all = false;
                tracing::warn!(error = %e, file = %file.display(), "cannot read the MCP setup");
                continue;
            }
        };
        let toml = file.extension().is_some_and(|e| e == "toml");
        if !toml
            && serde_json::from_str::<Value>(&text).is_err()
            && text.to_ascii_lowercase().contains(&old)
        {
            // Comments or trailing commas (VS Code allows them): left as
            // written, so the old command stays for it.
            all = false;
            tracing::warn!(file = %file.display(), "cannot read the MCP setup as JSON to move it");
            continue;
        }
        let updated = if toml {
            Some(migrate_toml(&text)).filter(|t| *t != text)
        } else {
            migrate_json(&text, !old_kept)
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
fn migrate_json(text: &str, permissions: bool) -> Option<String> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    if !migrate_value(&mut value, &legacy_name(), permissions) {
        return None;
    }
    let mut out = serde_json::to_string_pretty(&value).ok()?;
    out.push('\n');
    Some(out)
}

/// A `mcpServers` / `servers` object somewhere in `value` with both the old
/// and the new server.
fn json_has_both(value: &Value, old: &str) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, child)| {
            ((key == "mcpServers" || key == "servers")
                && child.get(old).is_some()
                && child.get(NAME).is_some())
                || json_has_both(child, old)
        }),
        Value::Array(items) => items.iter().any(|item| json_has_both(item, old)),
        _ => false,
    }
}

/// Where Claude Code registers MCP servers: `~/.claude.json` (also its
/// projects) and the `.mcp.json` of projects and plugins.
fn is_claude_setup(file: &Path) -> bool {
    file.file_name()
        .is_some_and(|n| n == ".claude.json" || n == ".mcp.json")
}

fn migrate_value(value: &mut Value, old: &str, permissions: bool) -> bool {
    match value {
        Value::Object(map) => {
            let mut changed = false;
            for (key, child) in map.iter_mut() {
                if key == "mcpServers" || key == "servers" {
                    if let Value::Object(servers) = child {
                        changed |= migrate_servers(servers, old);
                    }
                } else {
                    changed |= migrate_value(child, old, permissions);
                }
            }
            changed
        }
        Value::Array(items) => items.iter_mut().fold(false, |changed, item| {
            migrate_value(item, old, permissions) | changed
        }),
        Value::String(text) if permissions => match text
            .strip_prefix(&format!("mcp__{old}"))
            .filter(|rest| rest.is_empty() || rest.starts_with("__"))
        {
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
/// When the new table is already there, the old one keeps its name (two
/// tables of one name would make the whole file unreadable to Codex).
fn migrate_toml(text: &str) -> String {
    let old = legacy_name();
    let has_new = text.lines().any(|l| {
        toml_table(l)
            .is_some_and(|(path, _)| path.len() >= 2 && path[0] == "mcp_servers" && path[1] == NAME)
    });
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        let mut replaced = None;
        if trimmed.starts_with('[') {
            if !has_new
                && let Some((mut path, after)) = toml_table(line)
                && path.len() >= 2
                && path[0] == "mcp_servers"
                && path[1] == old
            {
                path[1] = NAME.to_owned();
                let indent = &line[..line.len() - line.trim_start().len()];
                let (open, close) = if trimmed.starts_with("[[") {
                    ("[[", "]]")
                } else {
                    ("[", "]")
                };
                let keys: Vec<String> = path.iter().map(|k| toml_key(k)).collect();
                replaced = Some(format!("{indent}{open}{}{close}{after}", keys.join(".")));
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

/// A TOML table header (`[a.b]`, `[[a.b]]`, `[ a . "b" ]  # note`): its
/// keys, and what follows the closing bracket (spaces, a comment, the line
/// end) as written.
fn toml_table(line: &str) -> Option<(Vec<String>, &str)> {
    let trimmed = line.trim_start();
    let array = trimmed.starts_with("[[");
    let mut rest = trimmed.strip_prefix(if array { "[[" } else { "[" })?;
    let mut keys = Vec::new();
    loop {
        rest = rest.trim_start_matches([' ', '\t']);
        let quote = rest.chars().next()?;
        if quote == '"' || quote == '\'' {
            let inner = toml_string(&rest[1..], quote)?;
            keys.push(inner.to_owned());
            rest = &rest[1 + inner.len() + 1..];
        } else {
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .unwrap_or(rest.len());
            if end == 0 {
                return None;
            }
            keys.push(rest[..end].to_owned());
            rest = &rest[end..];
        }
        rest = rest.trim_start_matches([' ', '\t']);
        if let Some(r) = rest.strip_prefix('.') {
            rest = r;
        } else {
            let after = rest.strip_prefix(if array { "]]" } else { "]" })?;
            let comment = after.trim_start_matches([' ', '\t']);
            if comment.is_empty() || comment.starts_with('#') || comment.starts_with(['\r', '\n']) {
                return Some((keys, after));
            }
            return None;
        }
    }
}

/// `key` as a TOML key: bare when it can be, quoted otherwise.
fn toml_key(key: &str) -> String {
    if !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        key.to_owned()
    } else {
        format!("\"{}\"", key.replace('\\', "\\\\").replace('"', "\\\""))
    }
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
/// False when the task could not be moved (the old command is then kept,
/// since the task may still start it).
fn migrate_worker_task(cli: &Path) -> bool {
    let mut command = std::process::Command::new(cli);
    command.args(["worker", "migrate"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.output() {
        Ok(out) if out.status.success() => true,
        Ok(out) => {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&out.stderr),
                "cannot move the worker task to the new command"
            );
            false
        }
        Err(e) => {
            tracing::warn!(error = %e, "cannot move the worker task to the new command");
            false
        }
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
        let out: Value = serde_json::from_str(&migrate_json(&text, true).unwrap()).unwrap();
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
        assert_eq!(migrate_json(text, true), None);
        assert_eq!(migrate_json("not json", true), None);
    }

    #[test]
    fn an_existing_new_server_is_kept_and_the_old_one_still_fixed() {
        let old = old();
        let text = json!({ "mcpServers": {
            "spellsheet": { "command": "spellsheet" },
            old.clone(): { "command": format!("{old}.EXE") }
        }})
        .to_string();
        let out: Value = serde_json::from_str(&migrate_json(&text, true).unwrap()).unwrap();
        assert_eq!(out["mcpServers"][&old]["command"], "spellsheet.exe");
        assert_eq!(out["mcpServers"]["spellsheet"]["command"], "spellsheet");
    }

    #[test]
    fn permissions_stay_with_an_old_server_that_keeps_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let old = old();
        let servers = dir.path().join(".claude.json");
        let settings = dir.path().join("settings.json");
        std::fs::write(
            &servers,
            json!({ "mcpServers": {
                "spellsheet": { "command": "spellsheet" },
                old.clone(): { "command": format!("{old}.exe") }
            }})
            .to_string(),
        )
        .unwrap();
        let rule = format!("mcp__{old}__get_flow");
        std::fs::write(
            &settings,
            json!({ "permissions": { "allow": [rule.clone()] } }).to_string(),
        )
        .unwrap();
        assert!(migrate_mcp_setups(&[servers, settings.clone()]));
        let out: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(out["permissions"]["allow"][0], rule.as_str());
    }

    #[test]
    fn only_the_whole_server_name_moves_in_permissions() {
        let old = old();
        let text = json!({ "permissions": { "deny": [
            format!("mcp__{old}"),
            format!("mcp__{old}__run_flow"),
            format!("mcp__{old}-other__run_flow"),
        ] } })
        .to_string();
        let out: Value = serde_json::from_str(&migrate_json(&text, true).unwrap()).unwrap();
        assert_eq!(
            out["permissions"]["deny"],
            json!([
                "mcp__spellsheet",
                "mcp__spellsheet__run_flow",
                format!("mcp__{old}-other__run_flow")
            ])
        );
    }

    #[test]
    fn both_names_in_another_client_do_not_stop_claude_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let old = old();
        let codex = dir.path().join("config.toml");
        std::fs::write(
            &codex,
            format!("[mcp_servers.spellsheet]\ncommand = \"spellsheet\"\n\n[mcp_servers.{old}]\ncommand = \"{old}\"\n"),
        )
        .unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(
            &settings,
            json!({ "permissions": { "allow": [format!("mcp__{old}__get_flow")] } }).to_string(),
        )
        .unwrap();
        assert!(migrate_mcp_setups(&[codex, settings.clone()]));
        let out: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(out["permissions"]["allow"][0], "mcp__spellsheet__get_flow");
    }

    #[test]
    #[cfg(unix)]
    fn an_unreadable_setup_keeps_the_old_command() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        std::fs::write(&file, "{}").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_to_string(&file).is_ok() {
            return; // running as root: every file can be read
        }
        assert!(!migrate_mcp_setups(std::slice::from_ref(&file)));
        assert!(migrate_mcp_setups(&[dir.path().join("missing.json")]));
    }

    #[test]
    fn a_setup_with_comments_keeps_the_old_command() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let old = old();
        std::fs::write(
            &file,
            format!("{{ // mine\n \"servers\": {{ \"{old}\": {{ \"command\": \"{old}\" }}, }} }}"),
        )
        .unwrap();
        assert!(!migrate_mcp_setups(std::slice::from_ref(&file)));
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
    fn toml_headers_are_read_with_spaces_quotes_and_comments() {
        let old = old();
        let text = format!("[ mcp_servers . \"{old}\" ] # mine\ncommand = \"{old}\"\n");
        assert_eq!(
            migrate_toml(&text),
            "[mcp_servers.spellsheet] # mine\ncommand = \"spellsheet\"\n"
        );
        // The new table is already there (written with a comment): the old
        // one keeps its name, so the file has no table twice.
        let text = format!(
            "[mcp_servers.spellsheet] # existing\ncommand = \"spellsheet\"\n\n[mcp_servers.{old}]\ncommand = \"{old}\"\n"
        );
        assert_eq!(
            migrate_toml(&text),
            format!(
                "[mcp_servers.spellsheet] # existing\ncommand = \"spellsheet\"\n\n[mcp_servers.{old}]\ncommand = \"spellsheet\"\n"
            )
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
        assert!(
            project_setups(home.path())
                .contains(&project.join(".claude").join("settings.local.json"))
        );
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
