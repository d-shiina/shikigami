# Desktop app automation (Phase 4)

English | [日本語](ja/desktop.md)

Scenarios drive Windows apps (business systems, Notepad, the Excel window, SAP GUI…). Nodes are not split by app technology (Win32 / WinForms / WPF / UWP / SAP / Java): there is **only one set, `desktop.*`**. Shikigami looks at the target window and decides which technology to look inside it with. No AI is involved in running a scenario.

## Writing a target

```json
{ "window": { "title": "Billing", "process": "billing.exe" },
  "element": { "id": "btnSave" } }
```

- `window`: a top-level window. Either `title` (partial, case-insensitive by default; `exact: true` for an exact match) or `process` (the executable name; `.exe` optional) is required. When several match, `nth` (0-based)
- `element`: a part inside the window. `id` (the UI Automation AutomationId, exact match) is the first choice, otherwise `role` + `name`. Omit it for the window itself
- `role` uses the same words as the browser (`button` `textbox` `checkbox` `combobox` `list` `listitem` `menuitem` `tab` `tree` `treeitem` `table` `row` `text` …). `{ "role": "button", "name": "Save" }` means the same in a browser and on the desktop
- `point` (coordinates from the window's top-left) is a last resort, for `desktop.mouseClick` only

When several elements match, Shikigami does not pick "one of them": it fails with `ELEMENT_AMBIGUOUS` and the candidates, so a run never presses a different element each time.

## Nodes

| type | Main params | Output | Mouse / keyboard |
|---|---|---|---|
| `desktop.launch` | `path`, `args`, `workingDir` | `{ pid }` | – |
| `desktop.click` | `target` | – | not used |
| `desktop.setValue` | `target`, `value` (text or a secret) | – | not used |
| `desktop.getValue` | `target` | text (true / false for checkboxes) | not used |
| `desktop.select` | `target`, `value` (name of the option) | – | not used |
| `desktop.waitFor` | `target`, `state` (visible / hidden / enabled) | – | not used |
| `desktop.isVisible` | `target`, `waitMs` | true / false | not used |
| `desktop.closeWindow` | `target` | – | not used |
| `desktop.mouseClick` | `target`, `button`, `double` | – | **used** |
| `desktop.type` | `target`, `text` (text or a secret) | – | **used** |
| `desktop.press` | `target`, `key` (`Enter` `Control+S` `Alt+F4`…, written as for the browser) | – | **used** |

- **No waits to write**: every node keeps looking until the window or element appears (and is enabled). The limit is the node's `timeoutMs` (default 30 s). Use `desktop.waitFor` with `state: "hidden"` only to wait for something to go away
- **Mouse-free first**: `desktop.click` presses buttons, toggles checkboxes, selects items and expands trees without moving the mouse. It works on windows in the background and alongside other work. Only for apps that do not respond, use `desktop.mouseClick` / `desktop.type`
- **One mouse and keyboard**: nodes marked "used" take the screen (`desktop.input`) automatically before acting, so they never run at the same time, even in parallel branches. Nodes on the same app (same `process`) also run one at a time. Scenarios never declare locks

## How the AI inspects screens (MCP)

- `inspect_ui` (no arguments): the open windows (title, process, kind of app)
- `inspect_ui` (with `window`): that window's elements as an indented list. Copy a line into a target as is

```text
- window "Billing"
  - pane
    - textbox "Customer code" id=txtCustomer value="C-001"
    - textbox "Password" id=txtPassword [password]
    - checkbox "Send invoice" [checked]
    - button "Save" id=btnSave
```

- `test_step`: runs a single node on the spot and returns its output and the windows after it, so the AI can walk through the screens before writing the scenario
- The contents of password fields appear neither in the list nor in `desktop.getValue`

## Logins (secrets)

Register passwords under 🔑 Secrets in Studio and write only the name in the scenario ([secrets.md](secrets.md)). To type into a desktop app, add **`app:<executable>`** (e.g. `app:billing.exe`) to the secret's allowed sites and apps. Apps that are not listed never receive it.

```json
{ "type": "desktop.setValue",
  "params": { "target": { "window": { "process": "billing.exe" }, "element": { "id": "txtPassword" } },
              "value": { "secret": "Billing", "field": "password" } } }
```

## Kinds of apps and what is visible

| App | Visible today | Planned |
|---|---|---|
| Win32 / WinForms / WPF / UWP, Office windows | Elements are visible through UI Automation | – |
| SAP GUI for Windows | UI Automation often shows only part of it (`inspect_ui` notes this) | SAP GUI Scripting as another way in. Nodes stay `desktop.*`; only SAP-specific actions (transaction codes…) get their own types. Scripting must be enabled with `sapgui/user_scripting` on the SAP server and in the SAP GUI options |
| Java (Swing…) | Often only the frame (noted) | Java Access Bridge (enable with `jabswitch -enable`) |
| Inside Citrix / Remote Desktop | No elements visible | Image recognition and coordinates (`point`) |
| Excel data | – | `excel.*`, reading and writing xlsx directly ([adapters.md](adapters.md)) |

## How it works

- UI Automation is called from a **dedicated thread without windows** that joins the multithreaded apartment (MTA), as Microsoft recommends (so it does not freeze even when Studio's own window is the target). Nodes only send requests to that thread and element references never leave it; each node finds its `target` again
- UI Automation timeouts are set to 2 s for connecting and 10 s for calls, so an unresponsive app does not hang the run (`APP_NOT_RESPONDING`). A timeout during an action such as a click means "it may have happened", so it is not retried, to avoid pressing twice
- Classic Win32 buttons are clicked by posting the click, so a dialog opened by the button does not block
- Apps running as administrator cannot be driven from Shikigami running with normal rights (a Windows restriction). This is reported as `ELEVATION_REQUIRED`
- Requests whose node timed out or was stopped while waiting in the queue are dropped without running (no double clicks or typing after a stop or retry)
- Before using the mouse or keyboard the window is brought to the front. When Windows refuses (e.g. the screen is locked) the node stops with `FOREGROUND_DENIED` / `INPUT_BLOCKED`
- The thread is Per-Monitor DPI aware so coordinates stay right on high-DPI screens

## Main errors

| code | Meaning and fix |
|---|---|
| `WINDOW_NOT_FOUND` | No such window (with the list of open windows). Check title / process with `inspect_ui` |
| `WINDOW_AMBIGUOUS` / `ELEMENT_AMBIGUOUS` | Several match (with candidates). Add conditions or `nth` |
| `ELEMENT_NOT_FOUND` | No such element. Copy id / role / name from `inspect_ui` |
| `NOT_CLICKABLE` / `NOT_SUPPORTED` | The element cannot be operated without the mouse. Use `desktop.mouseClick` / `desktop.type` |
| `OPTION_NOT_FOUND` | No such option (with the list of options) |
| `SECRET_APP_NOT_SET` / `SECRET_APP_MISMATCH` | This app (`app:xxx.exe`) is not registered on the secret |
| `FOCUS_FAILED` | Could not focus the element before typing (stops so it never types into another field). Target the input field itself |
| `ELEVATION_REQUIRED` | The app runs as administrator |
| `PLATFORM_UNSUPPORTED` | Run on something other than Windows |

## Verified and limits

- **Verified**: node definitions, validation, automatic waiting, locking and secret checks are tested automatically against a fake backend (Linux / Windows CI). Windows CI starts Notepad and types and reads text through UI Automation
- **Not yet verified**: real business apps, SAP GUI and Java apps; mouse and keyboard actions (CI does not test screen input); high DPI and multiple monitors
- Mouse and keyboard exclusion **across processes** (Studio, CLI, MCP server) is not implemented (within one process only)
- Screenshots, reading a whole grid at once, and walking through menus are not implemented
