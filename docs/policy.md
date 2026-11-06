# Published versions, permissions and approval

English | [日本語](ja/policy.md)

Two rules that make "AI builds it, it runs without AI" safe to use:

1. **Unattended runs execute only the version a person approved and published.** What the AI edited during the night never drives a production system in the next morning's scheduled run.
2. **The workspace's settings (`policy.json`) decide where flows may go and what the AI may do without a person's approval.** The Runtime and Core apply the checks the same way, so the result is the same whether a run starts from Studio, the CLI or the AI (MCP).

## 1. Published versions

### What runs

| How it is started | What runs |
|---|---|
| `shikigami run <id>` (unattended: Task Scheduler, batch files) | **The published version**. Called subflows run their published versions too |
| `shikigami run <id> --draft` | The work in progress (only when asked for) |
| `shikigami run <file>` | What the file holds (bundles included) |
| "Run" in Studio | The work in progress (tried in front of you) |
| MCP `run_flow` | The work in progress (the AI's trial run). `published: true` runs the published version |
| MCP `test_step` | That one node only |

`shikigami run <id>` on a flow with no published version stops with `NOT_PUBLISHED`, and with `SUBFLOW_NOT_PUBLISHED` when a called flow has none. It never falls back to the work in progress. The run report's `version` records which version ran.

### How to publish

- **Review desk in Studio**: look at the AI's changes and click "✓ Review and publish". Approving (the review record) and publishing are one action. When no version matches the current content, a version is made first.
- **"Versions" tab in Studio**: "Publish current content", or "Publish this version" on an earlier version (to go back, you can change only the published version and leave the work in progress as it is). "Unpublish" stops unattended runs.
- **CLI**: `shikigami version publish <id> [number] [--name NAME] [--note NOTE]`, `shikigami version unpublish <id>`. `shikigami version list <id>` marks the published version with `published`.

Only people can publish (Studio and the CLI). An AI client calling Core's publish gets `PUBLISH_NOT_ALLOWED`, and MCP has no tool to publish at all. The AI asks a person to review and publish on the review desk.

Before publishing, Shikigami checks that the version validates and that every flow it calls is published (publish the called ones first).

### Record

Publishing is appended to `versions/<flow-id>/publish.jsonl` (in the shared part of the workspace, so everyone using it sees the same published version). One line is one publish or unpublish; the last line is the current state.

```json
{"version":3,"uid":"019a…","at":"2026-10-28T09:12:00Z","by":{"kind":"studio"},"note":"first"}
{"version":null,"at":"2026-10-29T08:00:00Z","by":{"kind":"cli"},"note":"stop"}
```

Versions themselves stay immutable. Moving a flow to the trash unpublishes it too.

## 2. `policy.json`

It sits directly in the workspace folder (the shared part). Without the file the defaults below apply. Edit it in Studio under Settings › "Run permissions". On the CLI: `shikigami policy show` (what is in effect), `shikigami policy check` (find mistakes), `shikigami policy init` (write the defaults).

```json
{
  "formatVersion": 1,
  "sites": ["https://order.example.co.jp", "https://*.corp.example"],
  "apps": ["C:\\Program Files\\Billing\\billing.exe", "notepad.exe"],
  "ai": {
    "runFlow": { "safe": "allow", "interactive": "allow", "dangerous": "ask" },
    "testStep": { "safe": "allow", "interactive": "allow", "dangerous": "ask" },
    "deleteFlow": "ask"
  },
  "flows": {
    "scn_01a1…": { "aiRun": "deny", "unattended": false }
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `sites` | empty (anywhere) | Sites that `browser.open`, `oauth.signIn` (`authorizeUrl` and `tokenUrl`), `http.request` (and plugin nodes that declare `targets`) may open. An origin (`https://example.com`, a port allowed) or every subdomain with `https://*.example.com`. http and https are different. `about:blank` is always allowed, `file:` and the like never |
| `apps` | empty (any) | Programs that `desktop.launch` and `process.run` may start. With a folder only that path, with a file name alone any folder. Case, `/` vs `\` and a missing `.exe` do not matter |
| `ai.runFlow` | allow for safe/interactive, ask for dangerous | The AI's `run_flow`. Decided by the highest risk among the nodes that may run (called flows included) |
| `ai.testStep` | same | The AI's `test_step`. The highest risk including nodes inside blocks and flows called with `flow.call` |
| `ai.deleteFlow` | ask | The AI's `delete_flow` |
| `flows.<id>.aiRun` | none | Stricter rules for this flow only (and runs and tests that call it). Never looser than the global rule |
| `flows.<id>.unattended` | true | When false, `shikigami run` does not run it, nor any flow that calls it (`UNATTENDED_NOT_ALLOWED`). Studio still can |
| `records.keepDays` | none (keep) | Each PC deletes its run records (`runs/<run-id>/`) older than this many days. Applied when a run ends; runs still going are never deleted |
| `records.keepRuns` | none (keep) | Each PC keeps at most this many run records, the newest |
| `remote.enabled` | false | Take runs from a management server ([design/remote-runs.md](design/remote-runs.md), Japanese). Reserved: no management server connects yet |
| `remote.manager` | none | The management server's URL. `https://` (`http://` only for `localhost`) |
| `remote.flows` | empty (none) | Flow IDs the management server may start, or `"*"` for all. `flows.<id>.unattended: false` still refuses one |
| `remote.acceptBundles` | false | Also run flows the server sends as bundles, not only published versions in this workspace |
| `notify` | empty | Where unattended runs (the agent's schedules and `shikigami run`) are reported: a list of `{ "webhook", "on", "format", "flows" }`. See [schedules.md](schedules.md#notifications) |

`allow` = go ahead, `ask` = after a person approves in Studio, `deny` = never. The risk is the node type's `risk` (`safe`: variables, logs, control; `interactive`: operating screens; `dangerous`: deleting and moving files, HTTP to the outside, running programs and so on). Unregistered node types count as `dangerous`.

A broken `policy.json` (bad JSON, unknown fields, `sites` that are not origins) never means "allow everything": runs stop with `POLICY_INVALID`. The settings are read when a run starts, so a change applies from the next run.

### Checking sites and apps

Right before a node runs, the Runtime checks its params after templates are rendered. If the target is not allowed, the node does not run and fails with `SITE_NOT_ALLOWED` / `APP_NOT_ALLOWED` (`details.allowed` holds the allowlist). Building a URL from input variables or an earlier node's result cannot leave the allowlist. The `url` given to MCP's `inspect_page` is checked against the same list.

While `sites` is set, `http.request` follows redirects only within the origin it was sent to; a redirect elsewhere comes back as the 3xx response.

Limit: where a clicked link or a redirect leads inside the browser page is not checked (only the destination the node names).

## 3. Approving AI operations

When the AI calls an `ask` operation, the MCP server does not run it. It files a request for approval and returns `APPROVAL_REQUIRED` (`details.approvalId`).

1. Studio shows "✋ The AI asks for approval: try one node (file.delete, dangerous)" at the top. "Details" shows exactly what would run (nodes, inputs, revision; secret values masked) and the AI's reason (`approvalReason`). Click "Approve" or "Deny". On the CLI: `shikigami approval list` / `approve <id>` / `deny <id>`.
2. The AI calls the same tool again with `approvalId` (`approvalWaitMs` waits for the answer; it may also go on the first call).
3. Exactly the approved operation runs, **once**. Different content (also when a called flow changed afterwards) gives `APPROVAL_MISMATCH`, a used approval `APPROVAL_USED`, a refusal `APPROVAL_DENIED`, and a `deny` operation `POLICY_DENIED`.

Requests expire after 30 minutes, approvals after 10. Requests live in the per-PC area (`approvals/`, next to MCP's audit log); the AI client, the MCP server and the Studio that answers are expected to run on the same PC. The AI cannot answer its own request (`APPROVAL_NOT_ALLOWED`).

With MCP's `get_policy` the AI can read the current settings (no tool writes them).

## 4. Plugin nodes

Declare the params that name a site or a program in the manifest's `steps[].targets`, and they get the same checks as built-in nodes ([plugins.md](design/plugins.md), Japanese).

```json
"targets": [{ "kind": "site", "param": "baseUrl" }]
```

## 5. What this cannot protect against

- People's actions are trusted. Publishing, approving and editing `policy.json` are possible from Studio and the CLI. If an AI client is also allowed the PC's shell (writing files, running commands), nothing stops the AI from doing these directly. Allow the AI client only Shikigami's MCP tools ("Talk to AI" in Studio starts it that way).
- Navigation inside the browser (links, redirects, form targets) is outside `sites`.
