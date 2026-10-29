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
- In apps that show no elements (Citrix, remote desktops, custom-drawn screens), `image` (a picture) or `ocr` (a text) point at a place on the screen (see "Screens without elements" below)
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
| `desktop.readText` | `target` (window, `element` or `region`) or `file` (an image file) | `{ text, lines }` (OCR) | not used |
| `desktop.screenshot` | `target` (window, `element` or `region`), `path` | the saved path | not used |

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

## Screens without elements: images and text (OCR)

Inside Citrix or a remote desktop, and on custom-drawn screens, `inspect_ui` lists no elements. Targets then find their place on the picture of the window.

```json
{ "window": { "title": "Citrix" }, "ocr": { "text": "Search" } }
{ "window": { "title": "Citrix" }, "image": { "path": "C:\\RPA\\images\\save-button.png" } }
{ "window": { "title": "Citrix" }, "ocr": { "text": "Customer code" }, "offset": { "x": 150, "y": 0 } }
```

- `ocr`: a text shown on the screen, read with OCR. Spaces, case and full / half width are ignored; `exact: true` asks for a whole line
- `image`: a PNG picture found on the screen (normalised cross-correlation, so brightness changes do not matter). `threshold` (0.5–1, default 0.9) is how alike it must be. Cut the picture from the same app with `desktop.screenshot` and `region`. **A different display scaling (DPI) or theme stops it from matching**
- `offset`: moves the place from the centre of what was found (e.g. the field to the right of a label)
- `region`: looks only in part of the window (pixels from its top-left). A visible `element` narrows the search too
- When several places match, none is picked: `IMAGE_AMBIGUOUS` / `TEXT_AMBIGUOUS` (with the places). Choose with `nth` (0-based, top to bottom, then left to right) or `region`
- Nodes that take them: `desktop.mouseClick`, `desktop.type` (clicks the place, then types), `desktop.waitFor`, `desktop.isVisible`. All wait until the place appears
- The window draws its own picture, so it can be read even when other windows cover it; only apps that cannot are brought to the front and copied from the screen

### OCR engines

- The default is **PaddleOCR** (PP-OCRv6 small on ONNX Runtime): offline, Japanese, Chinese and English in one model, and good with small screen text (around 12 px). The models and ONNX Runtime come with the installer (`ocr\`, about 60 MB; the models are Apache-2.0, ONNX Runtime is MIT)
- Without PaddleOCR, **Windows OCR** (Windows.Media.Ocr) is used. It is weak on small text and Japanese, so pictures are enlarged twice first. `engine: "windows"` asks for it; `language` (`ja`, `en-US`…) is for it
- In a development checkout, run `pnpm studio:bundle-ocr` once: it fills `target\ocr`, which development builds of Studio, the MCP server and the tests use

### How the AI sees such screens (MCP)

- `inspect_ui` with `ocr: true` adds the window's text, line by line with places (pixels from the window's top-left), ready for `target.ocr` or `region`
- `image: true` returns the window's picture to the AI as an image (to see icons and layout, and choose what to cut out)
- The picture is kept with the observation for the human reviewer

## Kinds of apps and what is visible

| App | Visible today | Planned |
|---|---|---|
| Win32 / WinForms / WPF / UWP, Office windows | Elements are visible through UI Automation | – |
| SAP GUI for Windows | UI Automation often shows only part of it (`inspect_ui` notes this) | SAP GUI Scripting as another way in. Nodes stay `desktop.*`; only SAP-specific actions (transaction codes…) get their own types. Scripting must be enabled with `sapgui/user_scripting` on the SAP server and in the SAP GUI options |
| Java (Swing…) | Often only the frame (noted) | Java Access Bridge (enable with `jabswitch -enable`) |
| Inside Citrix / Remote Desktop | No elements visible; places are found by picture (`image`) and text (`ocr`) | – |
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
| `IMAGE_NOT_FOUND` / `TEXT_NOT_FOUND` | Not on the screen (after waiting until the timeout). With `bestScore` for a near miss of an image, `textRead` (what OCR read) for a text |
| `IMAGE_AMBIGUOUS` / `TEXT_AMBIGUOUS` | Found several times (with the places). Choose with `nth` or `region` |
| `IMAGE_FILE_NOT_FOUND` / `IMAGE_FLAT` | No such image file / an image of one flat colour (it would match anywhere) |
| `OCR_ENGINE_MISSING` / `OCR_LANGUAGE_MISSING` | `engine: "paddle"` but PaddleOCR is not installed / Windows OCR lacks that language |
| `PLATFORM_UNSUPPORTED` | Run on something other than Windows |

## Verified and limits

- **Verified**: node definitions, validation, automatic waiting, locking and secret checks are tested automatically against a fake backend (Linux / Windows CI). Windows CI starts Notepad and types and reads text through UI Automation. Image search, and PaddleOCR reading a picture of a Japanese business screen (12 px text), are tested on Linux and Windows CI. Windows CI also pictures Notepad, reads it with OCR and finds a cut-out part again
- **Not yet verified**: real business apps, SAP GUI, Java apps and Citrix; mouse and keyboard actions (CI does not test screen input); high DPI and multiple monitors
- Image search takes 0.2–0.5 s per look on a Full HD window, PaddleOCR about 0.3 s on a small screen (4 CPU cores). OCR of a whole large window can take over a second: `region` makes it faster
- Mouse and keyboard exclusion **across processes** (Studio, CLI, MCP server) is not implemented (within one process only)
- Reading a whole grid at once and walking through menus are not implemented. Rotated or scaled images are not found
