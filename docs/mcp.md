# MCP server

English | [日本語](ja/mcp.md)

`shikigami mcp` gives AI clients (Claude Code, Codex, Cursor and others) Shikigami's scenario editing, validation and execution as MCP tools. It uses the same Scenario Core as Studio, so AI edits show up in Studio immediately and can be undone there. It also runs on its own, without a GUI.

![An MCP edit showing up in Studio](assets/studio-mcp-edit.png)

## Connecting

The transport is **stdio**: the AI client starts `shikigami mcp` as a child process. No network port is opened. The `shikigami` command must be on PATH (the installer puts it there; during development it is `target/debug/shikigami` from `cargo build -p shikigami-cli`).

### Claude Code

The plugin is recommended: it bundles the MCP settings and a skill that teaches how to write scenarios.

```text
/plugin install shikigami --marketplace d-shiina/shikigami
```

(Before Claude Code 2.1.275: `/plugin marketplace add d-shiina/shikigami`, then `/plugin install shikigami@shikigami`.)

To register only the MCP server:

```sh
claude mcp add shikigami -- shikigami mcp
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.shikigami]
command = "shikigami"
args = ["mcp"]
```

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "shikigami": { "command": "shikigami", "args": ["mcp"] }
  }
}
```

### Options

| Option | Default | Description |
|---|---|---|
| `--workspace <DIR>` | `%APPDATA%\Shikigami\workspace` (change with `SHIKIGAMI_HOME`) | The workspace. Point it at the same place as Studio and changes show up in both |
| `--allow read,write,run` | All three | Which tool classes to expose. For read-only access: `--allow read` |

## Tools

| Class | Tool | What it does |
|---|---|---|
| read | `list_scenarios` | List scenarios |
|  | `get_scenario` | The scenario (with node IDs) and whether Undo/Redo is possible. While a person has sent it back, `feedback` (the reason and notes on nodes). Inputs and outputs of scenarios called with `scenario.call` (`subscenarios`), and the scenarios that call this one (`calledBy`) |
|  | `validate_scenario` | Validates a saved scenario (`scenarioId`) or an unsaved document (`scenario`). Returns every error with a JSON Pointer |
|  | `list_step_types` / `get_step_schema` | Available node types, the JSON Schema of their params, and examples to copy (`examples`) |
|  | `get_history` | Who (Studio / MCP client name / CLI) changed what and when, with the AI's explanation (`summary`) and the nodes touched (`stepIds`) |
|  | `get_review` | What the review desk shows: changes since the last approval, the AI's test runs, the screens it relied on, and reviews (reasons for sending back). [Design](design/review-evidence.md) |
|  | `get_run_status` / `get_run_logs` / `list_runs` | Status of a run, its final report, and its event log (`afterSeq` for what is new, `variable` for one variable's changes only) |
|  | `list_versions` / `get_version` | Named versions, and a version's snapshot |
|  | `diff_versions` | Differences between versions, or a version and now (by node ID; by default "latest version → now") |
|  | `export_scenario` | The scenario, its versions and the subscenarios it calls, as one bundle (without defaults of secret variables) |
|  | `list_project_files` / `read_project_file` | The files in the scenario's folder (input, config, templates, output, work, logs), and a text file's contents ([files.md](files.md#the-scenarios-folder)) |
|  | `list_secrets` | Names, sites and set fields of the secrets registered in Studio (never the values; see [secrets.md](secrets.md)) |
| write | `create_scenario` | Create a scenario (node IDs optional) |
|  | `update_scenario` | Apply several EditOps atomically as one revision |
|  | `add_step` / `update_step` / `remove_step` / `move_step` | Single edits |
|  | (common edit arguments) | `summary`: what the change does (shown in review and history). `observations`: the `observationId`s of the screens it is based on |
|  | `undo` / `redo` | The Undo stack shared with Studio and the CLI |
|  | `delete_scenario` | Move to the trash. `expectedRevision` required, marked `destructiveHint`. `SCENARIO_IN_USE` while another scenario calls it |
|  | `create_version` / `restore_version` | Save a version / go back to a version (one edit that can be undone) |
|  | `import_scenario` | Import a bundle or a scenario document. `IMPORT_CONFLICT` when the ID exists (choose with `onConflict: update / copy`). Subscenarios in the bundle come along |
|  | `extract_subscenario` | Move consecutive nodes of one block into a new scenario and replace them with a single `scenario.call`. Variables they read and write become inputs and outputs, so nothing changes in how it runs ([design](design/subscenarios.md)) |
|  | `write_project_file` / `delete_project_file` | Put a file in the scenario's folder (`text`, or `copyFrom` a file on this PC; `overwrite` to replace) / move one to the trash |
|  | `request_secret` | Ask the person for login details. Studio shows "Login needed" and opens the registration form with the name and sites filled in. Values are entered only in Studio and never returned to the AI. `waitMs` waits for the registration ([secrets.md](secrets.md)) |
| run | `run_scenario` | Run with the Runtime (the AI takes no part in running it). `waitMs` waits for it to finish. Input variables marked `secret: true` cannot be passed |
|  | `stop_scenario` | Cancel a run |
| browser | `inspect_page` | The page's accessibility tree (how to choose a `target`: [browser.md](browser.md)). Saves the tree and a screenshot as evidence and returns an `observationId` |
| desktop | `inspect_ui` | The open windows, or the elements of one window (how to choose a `target`: [desktop.md](desktop.md)). When it looks at a window it saves the element tree as evidence and returns an `observationId` |
| try | `test_step` | Run one node on the spot and return its output (for a browser node also the page after it, for a desktop node the window it worked on). Does not change the scenario. Saves the result as evidence and returns an `observationId` |

- Each validation issue carries a hint for fixing it (`hint`: close names, required and allowed params, when to use expressions vs. templates…), so the AI can fix it in one go.
- Input schemas are generated from the Rust types. Results come back as `structuredContent` (JSON).
- Failures are MCP tool errors (`isError: true`) with `{ code, message, details }`, so the AI can act on the code. For example: `REVISION_CONFLICT` (`details.actual` is the current revision), `VALIDATION_FAILED`, `SCENARIO_NOT_FOUND`.
- Write tools accept `expectedRevision`. Without it the edit applies to the latest revision; with it, a conflicting change by someone else gives `REVISION_CONFLICT` instead of overwriting.
- Every tool is annotated with `readOnlyHint` / `destructiveHint` / `openWorldHint` (clients use them in their approval UI).

## Audit log

Every tool call (successful or not) is written as one line to `<workspace>/audit/mcp.jsonl`.

```json
{"at":"2026-10-28T04:18:04Z","tool":"run_scenario","class":"run","client":"claude-code","ok":true,"scenarioId":"scn_example_invoice_summary","runId":"run_01a1…"}
```

The scenario changes themselves (EditOps and their inverses) are recorded with the client name in `history/<id>/journal.jsonl`, as before.

## Verified and limits

- **Verified**: automated E2E with the rmcp client (create → add → validate → run → read logs → read from another process → Undo/Redo, revision conflicts, stopping a run, tools limited by `--allow`, the schemas of every tool). Registered with `claude mcp add` from Claude Code CLI 2.1 and the connection (health check) succeeds. Editing over MCP with Studio open shows up in Studio, and Studio's Undo is recorded in the history as Studio.
- **Not yet verified**: a conversation where Claude Code actually builds a scenario with the tools, connecting from Codex / Cursor, and running on real Windows machines.
- Runs started from the MCP server stop when the server process (= the AI client's session) ends. Use `shikigami run` for long or unattended runs.
- Human approval in Studio for deletions, per-client tool permissions, and per-scenario "may run from MCP" are not implemented (only the server-wide `--allow`).
- The audit log is JSONL. Indexing it in SQLite is not implemented.
- The Streamable HTTP transport is not implemented (stdio only).
- Screens are inspected with `inspect_page` for browsers ([browser.md](browser.md)) and `inspect_ui` for Windows apps ([desktop.md](desktop.md)). Both can be tried step by node with `test_step`.
