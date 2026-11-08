# Desktop app automation (Phase 4)

English | [日本語](ja/desktop.md)

Flows drive Windows apps (business systems, Notepad, the Excel window, SAP GUI…). Nodes are not split by app technology (Win32 / WinForms / WPF / UWP / SAP / Java): there is **only one set, `desktop.*`**. SpellSheet looks at the target window and decides which technology to look inside it with. No AI is involved in running a flow.

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

When several elements match, SpellSheet does not pick "one of them": it fails with `ELEMENT_AMBIGUOUS` and the candidates, so a run never presses a different element each time.

When the same name repeats on a screen (a "Search" button for both the billing and the shipping address) or a text box has no name, two fields point at it without counting (`nth`), which survives controls being added or moved:

- `within`: look only inside this element. `{ "role": "button", "name": "Search", "within": { "id": "grpShip" } }` is the Search in the shipping group
- `after`: the first match after this element (in `inspect_ui` order). `{ "role": "textbox", "after": { "role": "text", "name": "Name" } }` is the box right after the label "Name"; `nth` counts from there

Both are written like `element` and nest up to two levels (a `within` inside a `within`).

### Picking on screen and named parts

- In Studio, a desktop node's target has **Pick on screen** (Studio steps aside; the element under the mouse is framed; click it, Esc or right-click to cancel; the click never reaches the app) and **Highlight** (frames the target on the screen now). The target is built the sturdy way: an `id` unique in the window, else `role` + `name` (exact), inside the group or row around it when the name repeats (`within`), after the label before it when it has no name (`after`), else `nth`, else a `point` in the window. The same is `inspect_ui`-free for AI clients: the adapter's inspect takes `action: "pick"` / `"highlight"`.
- **Named parts**: a flow can keep targets under `parts` (`"parts": { "saveButton": { "label": "保存ボタン", "app": "desktop", "target": { … } } }`) and a node writes `"target": { "part": "saveButton" }` (nothing else beside it). When the screen changes, fix the part once. Studio lists them in the project panel (Parts) and turns a node's target into a part with **Make a part**; AI clients use the `setPart` / `removePart` edit ops. Browser nodes use parts the same way (`"app": "browser"`).
- **Image parts** (screens with nothing to pick: Citrix, remote desktops, drawn screens): nodes that find their place by a picture (`desktop.mouseClick`, `desktop.waitFor`, `desktop.isVisible`, `desktop.hover`, `desktop.type`, `desktop.drag`…) have **Cut out of screen** beside **Pick on screen**. Studio steps aside, the screen dims, and you drag over the picture to look for (Esc or right-click cancels). You name it, and it becomes a part of the kind *Image*: the picture is saved as `templates/<key>.png` and the part is an ordinary desktop part, `{ "window": { … }, "image": { "path": "templates/image1.png", "threshold": 0.9 }, "offset": { "x": 0, "y": 0 } }`, with the window under the picture (the search stays inside it; `region` narrows it further). The part's screen shows the picture; clicking on it sets where the node acts (`offset` from the centre), the **Match** slider sets `threshold` (default 90%), and **Retake** cuts the picture again under the same name for every node that uses it. **Delete unused parts** under the Parts list removes the parts no node uses, and their pictures nothing else names (to the workspace's trash). Relative `image.path` values are resolved from the flow's folder, like any path. The adapter's inspect takes `action: "snip"` for the same (it answers the window and the PNG as base64). Cutting out works only on Windows and has not been tried on a real PC yet.

### Recording

**Record** on the canvas dock hides Studio and writes down what you do in desktop apps until you click the banner at the top of the screen:

- **Clicks**, with the target of what was clicked, built as **Pick on screen** builds it. Each click is held back for a moment while the screen is read (so the target is the button, not the menu it opens), then passed on to the app. A double click stays a double click.
- **Typing**: the field's final text when you leave it, as one `desktop.setValue` (Japanese input through the IME works the same: its conversion keys F6–F10, Escape and the Enter that confirms a conversion count as typing). A password field's text is never recorded: the node asks you to choose a secret.
- **Keys**: Enter, Tab, Escape, F1–F24 and shortcuts with Ctrl / Alt / Windows (`Control+S`) become `desktop.press`. Copy, paste, undo and select-all inside a field are part of the typing.
- Not recorded: drags, the mouse wheel, and Studio itself. To record in a browser, choose **Browser** when you press **Record** (see [browser.md](browser.md#recording)).

When you stop, **Recorded actions** lists the nodes. **Add as nodes** adds one node per action where a new node would go (a target used twice or more becomes a named part). **Have the AI tidy up** hands the recording to the AI pane (or the clipboard) with what to do: waits where the screen changes, loops for repeated work, input variables for values that differ each time. The raw recording stays in the flow's `logs/recordings/`. The adapter's inspect takes `action: "record"` for the same.

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
| `desktop.setWindow` | `target` (a window), `state` (`maximized` / `minimized` / `normal`), `front` (bring to the front), `x` `y` `width` `height` (pixels from the screen's top left; only the ones given change) | `{ state, x, y, width, height }` | not used |
| `desktop.check` | `target` (a checkbox), `checked` (default true) | – | not used |
| `desktop.mouseClick` | `target`, `button`, `double` | – | **used** |
| `desktop.type` | `target`, `text` (text or a secret) | – | **used** |
| `desktop.press` | `target`, `key` (`Enter` `Control+S` `Alt+F4`…, written as for the browser) | – | **used** |
| `desktop.readText` | `target` (window, `element` or `region`) or `file` (an image file) | `{ text, lines }` (OCR) | not used |
| `desktop.screenshot` | `target` (window, `element` or `region`), `path` | the saved path | not used |
| `desktop.getTable` | `target` (a grid, table or list; the window for its first one), `maxRows` | list of objects keyed by the column headers (as `browser.getTable`) | not used |
| `desktop.selectMenu` | `target` (window: its menu bar or the open menu; element: its right-click menu), `path` (names from the top, e.g. `["File", "Save As"]`) | – | not used |
| `desktop.scroll` | `target`; without `direction` the element is brought into view, with `direction` (`up` `down` `left` `right` `top` `bottom`), `amount`, `unit` (`page` / `line`) its list or pane scrolls | `{ verticalPercent, horizontalPercent, atEnd }` | not used |
| `desktop.mouseScroll` | `target`, `direction` (`up` `down` `left` `right`), `amount` (wheel notches, default 3) | – | **used** |
| `desktop.drag` | `target` (from), `to` (a target, may be another window) | – | **used** |
| `desktop.hover` | `target` | – | **used** |

- **No waits to write**: every node keeps looking until the window or element appears (and is enabled). The limit is the node's `timeoutMs` (default 30 s). Use `desktop.waitFor` with `state: "hidden"` only to wait for something to go away
- **Mouse-free first**: `desktop.click` presses buttons, toggles checkboxes, selects items and expands trees without moving the mouse. It works on windows in the background and alongside other work. Only for apps that do not respond, use `desktop.mouseClick` / `desktop.type`
- **Menus by their names**: `desktop.selectMenu` matches each name as shown, without access keys (`(F)`, `&`), a trailing `...` or the shortcut, and waits for each submenu to open. When an element's right-click menu does not open without the mouse (`NOT_SUPPORTED`), open it with `desktop.mouseClick` (`button: "right"`) and give `desktop.selectMenu` only the window
- **Tables at once**: `desktop.getTable` reads grids that support it (WPF, many WinForms and Win32 grids) whole, including rows scrolled out of view; other lists give the rows the app has created. Empty cells are `""` (WinForms' `(null)` too), rows with no text are left out, and over 10000 rows it stops with `TABLE_TOO_LARGE` unless `maxRows` is set
- **Reading a long list page by page**: `desktop.scroll` with `direction: "down"` returns `atEnd`, so a `control.while` loop can read, scroll and stop at the end
- **One mouse and keyboard**: nodes marked "used" take the screen (`desktop.input`) automatically before acting, so they never run at the same time, even in parallel branches. Nodes on the same app (same `process`) also run one at a time. Flows never declare locks

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

- `test_step`: runs a single node on the spot and returns its output and the windows after it, so the AI can walk through the screens before writing the flow
- The contents of password fields appear neither in the list nor in `desktop.getValue`

## Logins (secrets)

Register passwords under 🔑 Secrets in Studio and write only the name in the flow ([secrets.md](secrets.md)). To type into a desktop app, add **`app:<executable>`** (e.g. `app:billing.exe`) to the secret's allowed sites and apps. Apps that are not listed never receive it.

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
- Nodes that take them: `desktop.mouseClick`, `desktop.mouseScroll`, `desktop.drag` (both ends), `desktop.hover`, `desktop.type` (clicks the place, then types), `desktop.waitFor`, `desktop.isVisible`. All wait until the place appears
- The window draws its own picture, so it can be read even when other windows cover it; only apps that cannot are brought to the front and copied from the screen

### OCR engines

- The default is **PaddleOCR** (PP-OCRv6 small on ONNX Runtime): offline, Japanese, Chinese and English in one model, and good with small screen text (around 12 px). It never reads letters that only look like Latin ones (Turkish `ı`, Greek and Cyrillic capitals), so "AI" is not read as "Aı". Vertical lines (taller than 1.5 × their width) are turned a quarter left and read top to bottom. The models and ONNX Runtime come with the installer (`ocr\`, about 60 MB; the models are Apache-2.0, ONNX Runtime is MIT)
- Without PaddleOCR, **Windows OCR** (Windows.Media.Ocr) is used. It is weak on small text and Japanese, so pictures are enlarged twice first. `engine: "windows"` asks for it; `language` (`ja`, `en-US`…) is for it
- `accurate: true` (Studio: "Accurate") reads with PaddleOCR's larger models (PP-OCRv6 medium, in `ocr\medium\`): much better on handwriting, but several times slower (about 5 s for a 1000 × 560 picture instead of 0.4 s). It works on `desktop.readText` and on `ocr` targets. The installer includes them; in a development checkout `pnpm studio:bundle-ocr` fetches them from ModelScope when it can (`SHIKIGAMI_OCR_ACCURATE=required` makes that an error, `skip` leaves them out)
- `desktop.readText` says which engine read the text (`engine`), and adds a `warning` when the default fell back to Windows OCR
- PaddleOCR reads as Japanese: kanji Japanese does not use (simplified Chinese "纳", traditional "錄": outside Shift_JIS) are never chosen, so the model's next guess, the Japanese form of the same shape ("納", "録"), wins. Look-alike kana and kanji are chosen by their neighbours: "ー" after katakana ("コピ一用紙" → "コピー用紙", but "データ一覧" stays), "力" among kanji ("入カ" → "入力"), "タ" among katakana ("デー夕" → "データ"). Pictures are read 1.5 times larger (small text is found and read better)
- Each line of `desktop.readText` has `confidence` (0–1, its least sure word) and `unsure` (positions in `text` of the characters of words below 0.8) where the engine says how sure it is (PaddleOCR; Windows OCR does not). Studio's node result shows the lines with those characters highlighted, the confidence of each line and which engine read them
- `table: true` reads the table on the picture as rows and columns: the cells between its ruled lines (borders, spreadsheet grid lines; a merged cell such as "小計" goes to the column under its text), or, without lines, the rows of text split at the gaps that run down all of them. The output adds `cells` (every row as a list of texts) and `rows` (the rows after `headerRow`, default 1, as records named by its cells; empty names become 列1, 列2…, `headerRow: 0` gives none), e.g. `{{ invoice.rows[0].金額 }}`. On the benchmark's invoices and spreadsheets (including remote screens) 22 of 24 split right
- Other engines (a cloud AI-OCR from an extension) plug in through the `OcrProvider` trait (`shikigami_desktop::backend::register_ocr_engine`); flows choose them with `engine: "<name>"`

### How well OCR reads (benchmark)

`crates/shikigami-desktop/src/ocr_bench.rs` measures OCR on pictures of Japanese business screens (`tests/fixtures/ocr-bench`, made by `tests/ocr-bench/make.mjs`): a spreadsheet, a browser form, an invoice and message boxes with several lines, at 9, 10.5, 12 and 14 pt, light and dark, as drawn, with ClearType's colour fringes and through a remote desktop (JPEG). "Characters" is 1 − edit distance ÷ characters; "texts" is the share of texts read exactly (full and half width alike).

| PaddleOCR small | characters | texts |
| --- | --- | --- |
| before (v0.1.9) | 99.1 % | 94.7 % |
| now | 99.6 % | 98.0 % |

The pictures are drawn by Chromium on Linux with Noto Sans JP / IPA fonts, not by Windows, so real screens may read somewhat worse. `cargo test -p shikigami-desktop --lib ocr_bench -- --ignored --nocapture` prints the table and every miss; the 9 pt part runs on every test run and fails below 99 % / 95 %. On Windows CI the same benchmark also runs with Windows OCR (an experiment on main and on pull requests whose title names OCR; results are notices on the run).
- In a development checkout, `pnpm studio:dev` fills `target\ocr` when it is missing or out of date (or run `pnpm studio:bundle-ocr`); development builds of Studio, the MCP server and the tests use it

### How the AI sees such screens (MCP)

- `inspect_ui` with `ocr: true` adds the window's text, line by line with places (pixels from the window's top-left), ready for `target.ocr` or `region`
- `image: true` returns the window's picture to the AI as an image (to see icons and layout, and choose what to cut out)
- The picture is kept with the observation for the human reviewer

## Kinds of apps and what is visible

| App | Visible today | Planned |
|---|---|---|
| Win32 / WinForms / WPF / UWP, Office windows | Elements are visible through UI Automation | – |
| SAP GUI for Windows | Through SAP GUI Scripting when it is enabled (see "SAP GUI" below); otherwise only part of it through UI Automation (`inspect_ui` notes this) | – |
| Java (Swing, AWT…) | Through the Java Access Bridge when it is on (see "Java apps" below); otherwise only the frame (noted) | – |
| Inside Citrix / Remote Desktop | No elements visible; places are found by picture (`image`) and text (`ocr`) | – |
| Excel data | – | `excel.*`, reading and writing xlsx directly ([adapters.md](adapters.md)) |

## SAP GUI

When the target window belongs to SAP GUI for Windows and SAP GUI Scripting is enabled, the same `desktop.*` nodes act through scripting instead of UI Automation, which misses many SAP fields and tables.

- **Enable scripting** (once, by the SAP administrator and on each PC): on the SAP server, transaction RZ11 sets `sapgui/user_scripting` to `TRUE`; in SAP GUI, Options > Accessibility & Scripting > Scripting: "Enable scripting" on, and the two "Notify when a script…" boxes off (otherwise SAP GUI asks at every step)
- `inspect_ui` lists SAP components with their ids (`wnd[0]/usr/txtRSYST-BNAME`) and the same roles as other apps (`textbox`, `button`, `checkbox`, `combobox`, `tab`, `table`, `grid` for ALV grids…). Copy them as `element.id`. Ids from a recorded SAP GUI script (`/app/con[0]/ses[0]/wnd[0]/…`) and ids inside the target window (`usr/…`) work too
- What each node does there: `desktop.click` presses buttons, toggles checkboxes, selects radio buttons, tabs and menus (on labels and fields: F2, as a double click); `desktop.setValue` / `desktop.getValue` set and read fields; `desktop.select` picks a combo box entry by its text or key; `desktop.press` sends SAP's function keys (Enter, F1–F12 with Shift / Ctrl, Ctrl+S, Esc, PageUp / PageDown) without the real keyboard; `desktop.selectMenu` walks the menu bar; `desktop.getTable` reads table controls and ALV grids whole, scrolling through them; `desktop.type`, `desktop.mouseClick` and the other mouse nodes focus the component or use its place on the screen
- `sap.runTransaction` starts a transaction (`code`: `VA03`) and returns the status bar `{ type, text }` (`S` success, `W` warning, `E` error…), so a flow can check it with `control.if`
- When scripting is off, targets with a SAP component id stop with `SAP_SCRIPTING_OFF` (with the steps to enable it); the window itself, OCR and images still work through UI Automation
- **Not yet verified on a real SAP system**: this was written against SAP's scripting API documentation; CI has no SAP GUI

## Java apps

Java apps (Swing, AWT, and apps built on them, such as many in-house systems) show only their frame to UI Automation. When the Java Access Bridge is on, the same `desktop.*` nodes act through it instead.

- **Switch the bridge on** (once per PC and user): run `jabswitch -enable` from the `bin` folder of the Java the app uses, then restart the app. SpellSheet loads `WindowsAccessBridge-64.dll` from Windows, from the folder of the app's `java.exe`, or from `JAVA_HOME\bin`
- `inspect_ui` lists Java components with the same roles as other apps (`textbox`, `button`, `checkbox`, `combobox`, `table`, `menuitem`…). Java components have no id: target them with `role` + `name` (and `nth` when names repeat)
- What each node does there: `desktop.click` runs the component's action (press, toggle, select); `desktop.setValue` / `desktop.getValue` write and read text fields (password fields can only be written); `desktop.select` picks a list or combo box entry; `desktop.selectMenu` walks the menu bar; `desktop.getTable` reads a `JTable` whole with its column headers; `desktop.type`, `desktop.press` and the mouse nodes focus the component or use its place on the screen
- When the bridge is off, targets with an element stop with `JAVA_BRIDGE_OFF` (with the steps to switch it on); the window itself, OCR and images still work through UI Automation
- CI runs a small Swing window through the bridge; real business Java apps (Oracle Forms, Java Web Start…) are not yet verified

## How it works

- UI Automation is called from a **dedicated thread without windows** that joins the multithreaded apartment (MTA), as Microsoft recommends (so it does not freeze even when Studio's own window is the target). Nodes only send requests to that thread and element references never leave it; each node finds its `target` again
- UI Automation timeouts are set to 2 s for connecting and 10 s for calls, so an unresponsive app does not hang the run (`APP_NOT_RESPONDING`). A timeout during an action such as a click means "it may have happened", so it is not retried, to avoid pressing twice
- Classic Win32 buttons are clicked by posting the click, so a dialog opened by the button does not block
- Apps running as administrator cannot be driven from SpellSheet running with normal rights (a Windows restriction). This is reported as `ELEVATION_REQUIRED`
- Requests whose node timed out or was stopped while waiting in the queue are dropped without running (no double clicks or typing after a stop or retry)
- Before using the mouse or keyboard the window is brought to the front. While the screen is locked, the sign-in screen or an elevation prompt has the input, or a remote session is disconnected or minimized, such nodes stop with `DESKTOP_UNAVAILABLE` before they start (nodes without the mouse and keyboard still run). When Windows refuses for another reason the node stops with `FOREGROUND_DENIED` / `INPUT_BLOCKED`. The mouse and keyboard go to one node at a time across Studio, the CLI and the MCP server
- The thread is Per-Monitor DPI aware so coordinates stay right on high-DPI screens

## Main errors

| code | Meaning and fix |
|---|---|
| `WINDOW_NOT_FOUND` | No such window (with the list of open windows). Check title / process with `inspect_ui` |
| `WINDOW_AMBIGUOUS` / `ELEMENT_AMBIGUOUS` | Several match (with candidates). Add conditions, `within` / `after` for elements, or `nth` |
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
| `SAP_SCRIPTING_OFF` | A SAP component id, but SAP GUI Scripting cannot reach the window. Enable it (see "SAP GUI") |
| `JAVA_BRIDGE_OFF` | A Java window, but the Java Access Bridge is off or missing. Switch it on (see "Java apps") |
| `JAVA_NOT_READY` | The Java app is still starting; retried until the step's wait runs out |
| `NOT_SAP_WINDOW` | `sap.runTransaction` on a window that is not SAP GUI |
| `TABLE_TOO_LARGE` | More than 10000 rows. Set `maxRows`, or narrow the list in the app first |
| `MENU_ITEM_NOT_FOUND` / `MENU_ITEM_AMBIGUOUS` | No shown menu item has that name (with the items shown) / several do. Write the names from the first menu down |
| `PLATFORM_UNSUPPORTED` | Run on something other than Windows |

## Verified and limits

- **Verified**: node definitions, validation, automatic waiting, locking and secret checks are tested automatically against a fake backend (Linux / Windows CI). Windows CI opens a WinForms window (drawn by PowerShell) and, through UI Automation, picks an item from its menu bar, writes and reads text, scrolls it to the end, and reads its DataGridView and list view with `desktop.getTable`. (The Notepad test is skipped where Notepad has no classic Edit control, as on the CI runners.) Image search, and PaddleOCR reading a picture of a Japanese business screen (12 px text), are tested on Linux and Windows CI. Windows CI also pictures Notepad, reads it with OCR and finds a cut-out part again
- **Not yet verified**: real business apps, SAP GUI, business Java apps and Citrix; mouse and keyboard actions (CI does not test screen input); high DPI and multiple monitors
- Image search takes 0.2–0.5 s per look on a Full HD window, PaddleOCR about 0.3 s on a small screen (4 CPU cores). OCR of a whole large window can take over a second: `region` makes it faster
- Mouse and keyboard exclusion **across processes** (Studio, CLI, MCP server) is not implemented (within one process only)
- Rotated or scaled images are not found
