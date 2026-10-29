# Browser automation (Phase 3)

English | [日本語](ja/browser.md)

Shikigami scenarios drive web pages. The Rust Runtime starts the Node.js + Playwright browser adapter (`packages/browser-adapter`) as a child process and talks to it with newline-delimited JSON-RPC 2.0 over stdio. No AI is involved in running a scenario.

## Requirements

- **Nothing extra when installed with the installer.** Node.js and the adapter are bundled ([release.md](release.md#bundling-nodejs-and-the-browser-adapter))
- When running from source: Node.js 22.18 or later (runs the TypeScript directly) and `pnpm install` in the repository (installs `playwright-core`)
- A browser: on Windows **the installed Microsoft Edge is used**, so nothing else is downloaded. For Chrome set `SHIKIGAMI_BROWSER_CHANNEL=chrome`; for any other executable, `SHIKIGAMI_BROWSER_PATH`

| Environment variable | Meaning |
|---|---|
| `SHIKIGAMI_BROWSER_CHANNEL` | `msedge` (default on Windows) / `chrome` and so on |
| `SHIKIGAMI_BROWSER_PATH` | The browser executable |
| `SHIKIGAMI_BROWSER_HEADLESS` | `1` to always run without a window (unattended runs, CI) |
| `SHIKIGAMI_BROWSER_SLOWMO` | Delay per action (ms), to show the moves in a demo |
| `SHIKIGAMI_BROWSER_ADAPTER` | Location of the adapter's `main.ts` (normally found automatically) |
| `SHIKIGAMI_NODE` | The Node.js executable (default: the bundled `node\node.exe`, otherwise `node` on PATH) |

## Demo

```powershell
pnpm demo:browser
```

This starts a demo business site, an order management system for a sample trading company (`examples/web`), at `http://127.0.0.1:8787/` and runs `examples/browser-demo.json` with the CLI. The demo account is first registered as a secret, so the scenario contains no password (it also shows under 🔑 Secrets in Studio).

1. An order clerk and a stock clerk work **at the same time**: the order clerk logs in and reads the order list while the stock clerk reads the stock list in another window (`control.parallel` with separate `context`s)
2. For each open order, press "Ship" and wait for the confirmation (`control.forEach` + `control.if`)
3. Output the shipped order numbers, the total amount and the out-of-stock items
4. The login is kept with `session`, so **the second run skips the login page**

The CLI builds into `target/demo`, so it does not fail to overwrite `target\debug\shikigami.exe` while an MCP server uses it (the first build takes a little while). `pnpm demo:site` starts only the site. Studio can load and run the same scenario.

## Nodes

| type | Main params | Output |
|---|---|---|
| `browser.open` | `url`, `headless`, `session` (name under which the login state is saved and reused) | `{ url, title }` |
| `browser.click` | `target` | – |
| `browser.fill` | `target`, `value` (text, or a registered secret `{ "secret": "name", "field": "password" }`) | – |
| `browser.select` | `target`, `value` (visible label, or a list) | – |
| `browser.press` | `key` (`Enter` and so on), `target` (the page when omitted) | – |
| `browser.getText` | `target`, `all` (`true` for a list of every match) | text / list |
| `browser.getTable` | `target` (the first table when omitted) | list of objects keyed by the header cells |
| `browser.waitFor` | `target`, `state` (`visible` / `hidden` / `attached` / `detached`) | – |
| `browser.screenshot` | `path` (absolute), `fullPage` | the path |
| `browser.isVisible` | `target`, `waitMs` (default 2000) | `true` / `false` (never fails when missing) |
| `browser.waitForHuman` | `message`, `until` (an element that appears when the person is done) | – |
| `browser.close` | – | – |

Every node has a `context` (default `default`). Each `context` has its own cookies and tabs; **nodes on the same `context` run one at a time, different `context`s run at the same time** (the Runtime works out the locking from `context`, so scenarios never declare locks). Contexts opened by a run are closed when it ends.

For logins, passwords and MFA, see [secrets.md](secrets.md).

### Choosing elements (`target`)

By meaning; CSS is the last resort.

```jsonc
{ "role": "button", "name": "Log in" }        // buttons, links, headings, cells… (first choice)
{ "label": "Username" }                        // input fields
{ "text": "Shipped A-1001" }                   // visible text
{ "placeholder": "e.g. Aoba Store" } / { "testId": "submit" } / { "css": "#q" }
// common: exact (exact match), nth (0-based index when several match)
```

Waiting uses Playwright's auto-waiting, so no `flow.delay` is needed in between. The limit is the node's `timeoutMs` (default 30 s), and the adapter stops its action just before it, so a timed-out click never fires late after a retry.

### Errors

| Code | Meaning | Retried |
|---|---|---|
| `ELEMENT_NOT_FOUND` | No such element. `details.page` holds the page at that moment (accessibility tree) and hints for fixing it | yes |
| `OPTION_NOT_FOUND` | The `browser.select` value is neither a label nor a value of the options. `details.options` lists them | no |
| `ELEMENT_AMBIGUOUS` | Several elements match. Narrow it with `exact` / `nth` | no |
| `BROWSER_NOT_OPEN` | No `browser.open` for that `context` | no |
| `NAVIGATION_FAILED` | The page cannot be opened | yes |
| `BROWSER_LAUNCH_FAILED` | The browser cannot be started | no |
| `ADAPTER_UNAVAILABLE` | Node.js or the adapter was not found | no |
| `ADAPTER_CRASHED` | The adapter died. It restarts on the next request | yes |

## Building scenarios from AI (MCP)

The MCP server has two tools for this (class `run`):

- `inspect_page`: opens a page (or uses the open one) and returns its accessibility tree. A line `- button "Log in"` means `{ "role": "button", "name": "Log in" }` works as a `target` as is
- `test_step`: runs one node on the spot and returns its output and the page after it (works for nodes of any adapter). Use it to look ahead, such as logging in and then inspecting the next page. It does not change the scenario

With these the AI checks the site while it builds the nodes, then confirms an AI-free run with `validate_scenario` → `run_scenario`.

## How it works

```text
Runtime ──(JSON-RPC over stdio)──▶ node packages/browser-adapter/src/main.ts ──▶ Playwright ──▶ Edge / Chrome
  browser.* steps                       one BrowserContext per run × context
```

- Browser support is one "adapter". To add other apps, see [adapters.md](adapters.md).
- The adapter starts with the first browser node and is shared by every run. If it dies, the running node fails with `ADAPTER_CRASHED` and the adapter restarts on the next request.
- The adapter's stderr goes to Rust's tracing (`shikigami_browser::adapter`).
