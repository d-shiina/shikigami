# Audit trail

Japanese: [ja/audit.md](ja/audit.md)

`spellsheet audit` shows, in one list, who changed, published and ran which flow on this PC, whether it was a person in Writer, the CLI, an AI over MCP, a schedule or a management server.

```powershell
spellsheet audit                              # everything, oldest first
spellsheet audit --since 2026-11-01           # from that day on (or an RFC 3339 time)
spellsheet audit --flow scn_01a1… --json      # one flow, one JSON object per line
```

```text
2026-11-06T08:00:01Z  schedule (毎朝)  run  scn_01a1… FAILED ELEMENT_NOT_FOUND  secrets: 受注システム
2026-11-06T09:12:40Z  mcp (claude-code)  update_step  scn_01a1…  Wait for the save dialog
2026-11-06T09:15:02Z  studio  publish  scn_01a1…  v4
```

Nothing is written twice. The trail is read from the records each part already keeps, so they cannot disagree:

| Source | What it holds | Where |
|---|---|---|
| `change` | Every change to a flow (create, edit, undo, redo, delete), with who made it and the AI's summary | `history/<flow-id>/journal.jsonl` (per PC) |
| `publish` | Every publish and unpublish, with who did it and the note | `versions/<flow-id>/publish.jsonl` (shared with the workspace) |
| `mcp` | Every MCP tool call, including reads and refused calls (`ok: false`, `errorCode`) | `audit/mcp.jsonl` (per PC) |
| `run` | Every run, with where it came from (`studio`, `cli`, `mcp`, `schedule`, `remote`), who asked and how it ended | `runs/<run-id>/report.json` (per PC) |

Fields of `--json`: `at`, `source`, `actor`, `who` (client, schedule name or the person on the management server), `action`, `flowId`, `revision`, `version`, `runId`, `ok`, `errorCode`, `detail`, `secrets` (runs only: the names of the secrets the run used, such as typed passwords, API keys, saved logins and OAuth tokens; never their values. Also `secretsUsed` in the run's `report.json`).

## How long it is kept

Run records, the run logs in each flow's `logs/` and MCP calls are kept for 90 days: older ones are deleted on each PC when a run ends. Change it with `records.keepDays` in `policy.json` ([policy.md](policy.md)); `0` keeps them for good. The change journal is kept: undo and the flow's history need it. Publish records live with the versions and are kept with them.

For a shared workspace, changes, MCP calls and runs are per PC; publishes are shared. A management server ([remote.md](remote.md)) keeps the jobs it handed out, with their events and reports, for all PCs.
