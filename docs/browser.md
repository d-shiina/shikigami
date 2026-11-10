# Browser automation (Phase 3)

English | [日本語](ja/browser.md)

SpellSheet flows drive web pages. The Rust Runtime starts the Node.js + Playwright browser adapter (`packages/browser-adapter`) as a child process and talks to it with newline-delimited JSON-RPC 2.0 over stdio. No AI is involved in running a flow.

## Requirements

- **Nothing extra when installed with the installer.** Node.js and the adapter are bundled ([release.md](release.md#bundling-nodejs-and-the-browser-adapter))
- When running from source: Node.js 22.18 or later (runs the TypeScript directly) and `pnpm install` in the repository (installs `playwright-core`)
- A browser: on Windows **the installed Microsoft Edge is used**, so nothing else is downloaded. For Chrome set `SPELLSHEET_BROWSER_CHANNEL=chrome`; for any other executable, `SPELLSHEET_BROWSER_PATH`

| Environment variable | Meaning |
|---|---|
| `SPELLSHEET_BROWSER_CHANNEL` | `msedge` (default on Windows) / `chrome` and so on |
| `SPELLSHEET_BROWSER_PATH` | The browser executable |
| `SPELLSHEET_BROWSER_HEADLESS` | `1` to always run without a window (unattended runs, CI) |
| `SPELLSHEET_BROWSER_SLOWMO` | Delay per action (ms), to show the moves in a demo |
| `SPELLSHEET_BROWSER_ADAPTER` | Location of the adapter's `main.ts` (normally found automatically) |
| `SPELLSHEET_NODE` | The Node.js executable (default: the bundled `node\node.exe`, otherwise `node` on PATH) |

## Demo

```powershell
pnpm demo:browser
```

This starts a demo business site, an order management system for a sample trading company (`examples/web`), at `http://127.0.0.1:8787/` and runs `examples/browser-demo.json` with the CLI. The demo account is first registered as a secret, so the flow contains no password (it also shows under 🔑 Secrets in Writer).

1. An order clerk and a stock clerk work **at the same time**: the order clerk logs in and reads the order list while the stock clerk reads the stock list in another window (`control.parallel` with separate `context`s)
2. For each open order, press "Ship" and wait for the confirmation (`control.forEach` + `control.if`)
3. Output the shipped order numbers, the total amount and the out-of-stock items
4. The login is kept with `session`, so **the second run skips the login page**

The CLI builds into `target/demo`, so it does not fail to overwrite `target\debug\spellsheet.exe` while an MCP server uses it (the first build takes a little while). `pnpm demo:site` starts only the site. Writer can load and run the same flow.

## Nodes

| type | Main params | Output |
|---|---|---|
| `browser.open` | `url`, `headless`, `session` (name under which the login state is saved and reused), `dialog` | `{ url, title }` |
| `browser.attach` | `port` (default 9222), `title` / `url` (which tab) | `{ url, title }` |
| `browser.click` | `target`, `button` (`right` for a right-click), `double` (double-click), `modifiers` (keys held down, e.g. `["Control"]`), `dialog` (answer to the JS dialog the click shows) | the dialog's message / `null` |
| `browser.download` | `target` (what to click), `path` (the file) or `folder` (keep the site's name) | `{ path, fileName }` |
| `browser.upload` | `target` (the file input, or the button that opens the file picker), `path` (a file or a list) | – |
| `browser.hover` | `target` | – |
| `browser.scroll` | `target` (bring into view) and/or `to` (`top` / `bottom`) | – |
| `browser.fill` | `target`, `value` (text, or a registered secret `{ "secret": "name", "field": "password" }`), `typing` (one key at a time, for pages that react to each key; a secret is always filled at once) | – |
| `browser.check` | `target`, `checked` (default `true`; `false` unchecks) | – (nothing happens when it already is) |
| `browser.navigate` | `action` (`back` / `forward` / `reload`) | `{ url, title }` |
| `browser.select` | `target`, `value` (visible label, or a list) | – |
| `browser.press` | `key` (`Enter` and so on), `target` (the page when omitted), `dialog` | the dialog's message / `null` |
| `browser.getText` | `target`, `all` (`true` for a list of every match) | text / list |
| `browser.getTable` | `target` (the first table when omitted) | list of objects keyed by the header cells |
| `browser.getAttribute` | `target`, `name` (`href`, `src`, `value`, `data-id`…), `all` | text / `null` / list (`href` / `src` as full addresses) |
| `browser.runScript` | `script` (the body of an async function), `args`, `target`, `frame` | what the script `return`s |
| `browser.switchTab` | `title` / `url` (part of it) or `index` (0 = first tab) | `{ url, title, index }` |
| `browser.closeTab` | – | `{ url, title }` of the tab it goes back to |
| `browser.waitFor` | `target`, `state` (`visible` / `hidden` / `attached` / `detached`) | – |
| `browser.screenshot` | `path` (absolute), `fullPage` | the path |
| `browser.isVisible` | `target`, `waitMs` (default 2000) | `true` / `false` (never fails when missing) |
| `browser.waitForHuman` | `message`, `until` (an element that appears when the person is done) | – |
| `browser.close` | – | – |

Every node has a `context` (default `default`). Each `context` has its own cookies and tabs, and its steps work on its **current tab**; **nodes on the same `context` run one at a time, different `context`s run at the same time** (the Runtime works out the locking from `context`, so flows never declare locks). Contexts opened by a run are closed when it ends.

### Tabs and popups

A link with `target="_blank"` or a button that opens a window adds a tab to the context, but steps stay on the current tab until `browser.switchTab` moves them. Put it right after the click: it waits for the tab to open, and picks the newest tab whose title contains `title` (or address contains `url`). `browser.closeTab` closes the current tab and goes back to the one before it; a popup that closes itself (`window.close()`) goes back on its own.

```jsonc
{ "type": "browser.click", "params": { "target": { "role": "button", "name": "Details" } } },
{ "type": "browser.switchTab", "params": { "title": "Order details" } },
{ "type": "browser.getText", "params": { "target": { "role": "heading" } }, "saveAs": "title" },
{ "type": "browser.closeTab" }
```

### Using a browser the person opened (`browser.attach`)

Some sites only open in the person's own browser: SSO with the PC's sign-in, client certificates, a required extension. `browser.attach` takes over an Edge or Chrome that is already open instead of starting a new one, and later steps on the same `context` work in it. It reaches only `127.0.0.1`, and when the run ends it lets go of the browser without closing it.

The browser has to be started with a debugging port. Chrome 136 and later ignore the port on the everyday profile ([Chrome's announcement](https://developer.chrome.com/blog/remote-debugging-port)), and Edge is expected to do the same, so give it a profile folder of its own and sign in there once (a shortcut with these arguments is the easiest):

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\SpellSheet\edge-profile"
```

```jsonc
{ "type": "browser.attach", "params": { "title": "Attendance" } }
```

Notes:

- While the browser waits on the port, any program on this PC can drive it. Open it this way only for the work that needs it
- The workspace's allowed sites (policy) are checked by `browser.open`; tabs the person already opened are not checked
- Not for unattended runs (nobody starts the browser): use `browser.open` with `session` there
- JS dialogs in that browser are answered by the run while it is attached
- **Not yet tried on a Windows PC with Edge** (tested with Chromium)

### Edge IE mode

Pages that Edge shows in IE mode run on the old Internet Explorer engine, which Playwright (and so `browser.*`) cannot reach. Use the desktop nodes there: the IE mode page is part of the Edge window, so target it with `{ "window": { "process": "msedge.exe", "title": "<part of the page title>" }, "element": { … } }` and look at it with `inspect_ui`. On the Windows CI runner (Windows Server, IE Enhanced Security Configuration turned off) UI Automation lists the page's headings, labels, text boxes and buttons with their HTML `id`, and `desktop.setValue` into a text box and `desktop.click` on a button both work (`crates/spellsheet-desktop/tests/ie_mode.rs`). Name the element with its `role` too: a label and its text box share the name. **Not yet tried on a real PC's Edge** ([desktop.md](desktop.md)). On Windows Server, IE Enhanced Security Configuration keeps the page blank; a desktop PC has it off.

### Downloads and uploads

`browser.download` clicks the link or button and saves the file it downloads. Paths are relative to the flow folder, so `"path": "input/orders.csv"` puts it where `file.readCsv` / `excel.readRows` read it next. With `folder` instead of `path`, the file keeps the name the site gives it (`fileName` in the output). `browser.upload` attaches files to a form; it works on the file input itself and on a button that opens the file picker (the picker never shows). It only fills the form: click the send button next.

Both are `dangerous` (a download writes a file, an upload sends one out), so they show under "effects outside" in the review panel.

### JS dialogs (alert / confirm / prompt)

The step that causes the dialog answers it with `dialog`: `"accept"` (OK), `"dismiss"` (Cancel), or `{ "action": "accept", "promptText": "…" }` for a prompt. The step waits for the dialog (also one that shows a little after the click, such as "Saved" after the server answers) and outputs its message, so `saveAs` keeps a receipt number in an alert. If no dialog shows within the step's time limit it fails with `DIALOG_NOT_SHOWN`.

Without `dialog`, a dialog is closed the way a browser without a person would (alert: OK, confirm / prompt: Cancel), and the next failing step says so in `details.dismissedDialog`. Dialogs drawn by the page itself are ordinary elements: click their buttons.

### Tables across pages

A list split over pages ("Next" under the table) is read with a loop of the nodes above; there is no separate node. Read the page, add it to the rows, and click "Next" while it is there:

```jsonc
{ "type": "variable.set", "params": { "name": "rows", "expression": "[]" } },
{ "type": "variable.set", "params": { "name": "more", "expression": "true" } },
{ "type": "variable.set", "params": { "name": "pageNo", "expression": "1" } },
{ "type": "control.while", "params": { "condition": "more", "maxIterations": 200 }, "blocks": { "body": [
  { "type": "browser.getTable", "params": { "target": { "css": "#orders" } }, "saveAs": "page" },
  { "type": "variable.set", "params": { "name": "rows", "expression": "rows + page" } },
  { "type": "browser.isVisible", "params": { "target": { "role": "link", "name": "Next" } }, "saveAs": "more" },
  { "type": "control.if", "params": { "condition": "more" }, "blocks": { "then": [
    { "type": "browser.click", "params": { "target": { "role": "link", "name": "Next" } } },
    { "type": "variable.set", "params": { "name": "pageNo", "expression": "pageNo + 1" } },
    { "type": "browser.waitFor", "params": { "target": { "text": "Page {{ pageNo }}" } } }
  ] } }
] } }
```

After the click, wait for something that only the next page shows (here its page number), or `getTable` may read the old table again. When the last page still shows a greyed-out "Next", give `target` something only the working link has, such as `css: "a.next:not(.disabled)"`.

### Frames

Elements inside an iframe, or inside a `<frame>` of an old frameset page, need `frame` in their `target`: the frame by its `name` (or `id`) attribute, part of its `title` or `src`, or `css`. A frame inside a frame gives the outer one as `frame.frame` (up to four deep). Picking an element inside an iframe (Pick on screen, `ask_user_to_pick`) returns this `frame` with it: by `name`, else `title`, else `src`, else the tag, whichever tells the frame apart, with `nth` when identical frames repeat.

```jsonc
{ "label": "Remarks", "frame": { "name": "main" } }
{ "role": "button", "name": "Search", "frame": { "name": "body", "frame": { "name": "main" } } }
```

`inspect_page` lists the page's frames (`frames`), and shows the inside of one when called with `target: { "css": "body", "frame": { "name": "main" } }`. A failing step lists them in `details.frames` as well.

For logins, passwords and MFA, see [secrets.md](secrets.md). For web APIs that need an OAuth sign-in in the browser (`oauth.signIn`), see [oauth.md](oauth.md).

### Running JavaScript (`browser.runScript`)

Use it only for what no other node can read (a value kept in the page's JavaScript, state not shown on screen, a calculation over many elements). Reading text, attributes and tables, clicking and typing have their own nodes, which read better and survive page changes.

`script` is the body of an async function: `return` the result (`await` works). Inside it, `args` holds the value of `args` and `element` the element of `target` (`null` without `target`). Put flow values **in `args` with `{{ }}`, never inside `script`** (a value with a quote would break the code).

```jsonc
{ "type": "browser.runScript", "params": { "script": "return window.app.orders.length;" }, "saveAs": "orderCount" }
{ "type": "browser.runScript", "params": {
  "script": "const res = await fetch('/api/orders?code=' + encodeURIComponent(args.code)); return await res.json();",
  "args": { "code": "{{ order.code }}" }
}, "saveAs": "detail" }
```

- The output is text, numbers, true/false, `null` and arrays and objects of them. Elements and functions become `null`, dates ISO text
- It runs in the frame of `target`, otherwise in `frame` (the page when omitted)
- It runs even on pages whose CSP forbids eval
- A returned promise is awaited up to the node's `timeoutMs`, then `SCRIPT_TIMEOUT`. An exception or a syntax error is `SCRIPT_ERROR` with its message
- It runs **only inside the open page**, never touching the PC's files or programs. It can still do anything the page can (send, delete), so it is `dangerous` and shows under "What this flow changes" (このフローが変えるもの) in the review panel
- Registered secrets cannot be passed in. Secret values and what is typed in password fields come back as `***`

### Recording

**Record** in the dock under the flow diagram asks where to record. Choose **Browser** and a URL (filled from the flow's first `browser.open`): a browser opens with a red bar at the top, and Writer writes down what you do until you press the bar. While a run's browser is open, recording happens in that browser instead.

- Clicks (right and double clicks too) become `browser.click`, text you type becomes one `browser.fill` per field, choices become `browser.select`, checkboxes `browser.check`, Enter/Tab/Escape `browser.press`, and a URL typed in the address bar `browser.open`.
- The `target` is made the same way as **Pick on screen** (role and name first). A password field's text is never recorded: the node asks you to choose a secret.
- Not recorded: drags, file uploads (add `browser.upload` yourself), and pages a click opened in a new tab.

When you stop, the same **Recorded actions** list as desktop recording appears, with **Add as nodes** and **Have the AI tidy up**. The adapter's inspect takes `action: "record"` / `"stopRecording"`.

### Choosing elements (`target`)

By meaning; CSS is the last resort.

```jsonc
{ "role": "button", "name": "Log in" }        // buttons, links, headings, cells… (first choice)
{ "label": "Username" }                        // input fields
{ "text": "Shipped A-1001" }                   // visible text
{ "placeholder": "e.g. Aoba Store" } / { "testId": "submit" } / { "css": "#q" }
// common: exact (exact match), nth (0-based index when several match), frame (the iframe it is in)
```

In Writer, a browser node's target has **Pick on screen** and **Highlight** while the flow runs (or is paused at a node): Writer steps aside and the person clicks the element in the run's browser (Esc to cancel, the page never gets the click). With no run going, Writer opens the page of the nearest **Open page** node above (its `url` must be written out, not an expression) in a browser of its own and picks there; that browser stays open for the next pick, on whatever page the person has moved to. Without an Open page node above, the buttons are off and say so. Elements inside iframes can be picked and highlighted too (iframes from other sites and frames inside frames as well).

Waiting uses Playwright's auto-waiting, so no `flow.delay` is needed in between. The limit is the node's `timeoutMs` (default 30 s), and the adapter stops its action just before it, so a timed-out click never fires late after a retry.

### Errors

| Code | Meaning | Retried |
|---|---|---|
| `ELEMENT_NOT_FOUND` | No such element. `details.page` holds the page at that moment (accessibility tree) and hints for fixing it | yes |
| `OPTION_NOT_FOUND` | The `browser.select` value is neither a label nor a value of the options. `details.options` lists them | no |
| `ELEMENT_AMBIGUOUS` | Several elements match. Narrow it with `exact` / `nth` | no |
| `TAB_NOT_FOUND` | No tab matches `browser.switchTab`. `details.tabs` lists them | yes |
| `LAST_TAB` | `browser.closeTab` on the only tab (use `browser.close`) | no |
| `DIALOG_NOT_SHOWN` | The step has `dialog` but no JS dialog showed | no |
| `BROWSER_NOT_RUNNING` | `browser.attach` finds no browser on `port`. `details.hint` says how to start one | yes |
| `CONTEXT_IN_USE` | `browser.attach` on a `context` that `browser.open` already uses | no |
| `DOWNLOAD_NOT_STARTED` | `browser.download` clicked but nothing downloaded | no |
| `DOWNLOAD_FAILED` | The download broke off | yes |
| `FILE_NOT_FOUND` | A file for `browser.upload` is missing | no |
| `FILE_CHOOSER_NOT_SHOWN` | The `browser.upload` target is neither a file input nor opens the file picker | no |
| `SCRIPT_ERROR` | the `browser.runScript` script threw or has a syntax error | no |
| `SCRIPT_TIMEOUT` | the `browser.runScript` script did not finish within the node's time limit | no |
| `BROWSER_NOT_OPEN` | No `browser.open` for that `context` | no |
| `NAVIGATION_FAILED` | The page cannot be opened | yes |
| `BROWSER_LAUNCH_FAILED` | The browser cannot be started | no |
| `ADAPTER_UNAVAILABLE` | Node.js or the adapter was not found | no |
| `ADAPTER_CRASHED` | The adapter died. It restarts on the next request | yes |

## Building flows from AI (MCP)

The MCP server has three tools for this (class `run`):

- `inspect_page`: opens a page (or uses the open one) and returns its accessibility tree. A line `- button "Log in"` means `{ "role": "button", "name": "Log in" }` works as a `target` as is. `image: true` also hands the screenshot to the AI, for pages whose tree does not tell elements apart (icons without names)
- `test_step`: runs one node on the spot and returns its output and the page after it (works for nodes of any adapter). Use it to look ahead, such as logging in and then inspecting the next page. It does not change the flow. Before a browser node runs, its target is outlined in the browser for a moment (「ここを押します」), so the person watching sees what the AI is about to touch
- `ask_user_to_pick`: when the AI cannot tell which element is meant (two 「編集」 buttons, an icon without a name), it asks the person instead of guessing. The browser window comes to the front with the AI's `message` in a banner, the `candidates` it is torn between are outlined with numbers, and the person's click is caught before the page sees it (nothing is pressed). The element comes back as a `target` (with `nth` and the text of its table row `row` when it repeats, and `frame` when it is inside an iframe). Writer shows 「AI がブラウザの画面で指してほしいと言っています」 at the same time and can decline it; 「わからない」 or Esc in the browser declines too (`status: "cancelled"`). It needs a visible browser

With these the AI checks the site while it builds the nodes, then confirms an AI-free run with `validate_flow` → `run_flow`.

## How it works

```text
Runtime ──(JSON-RPC over stdio)──▶ node packages/browser-adapter/src/main.ts ──▶ Playwright ──▶ Edge / Chrome
  browser.* steps                       one BrowserContext per run × context
```

- Browser support is one "adapter". To add other apps, see [adapters.md](adapters.md).
- The adapter starts with the first browser node and is shared by every run. If it dies, the running node fails with `ADAPTER_CRASHED` and the adapter restarts on the next request.
- The adapter's stderr goes to Rust's tracing (`spellsheet_browser::adapter`).
