# Office automation (Excel, Word, Outlook)

English | [日本語](ja/office.md)

Office work is based on reading and writing the files directly; the Office apps themselves (COM) are used only for what files alone cannot do.

## Approach

| | Files directly (default) | Office app (COM) |
|---|---|---|
| Office installed | Not needed | Needed |
| Speed / parallelism | Fast. Different workbooks run at the same time | Slow. One app used in turn |
| Unattended runs | Stable (no dialogs) | Can stop on dialogs or license screens |
| What it can do | Read and write cells, ranges, tables, sheets | Macros, recalculation, printing, PDF export… |
| Tests | Run in Linux CI too | Only on Windows with Office |

To keep the number of ways the AI has to learn small, the same action is never available both ways. Reading and writing cells is always `excel.*` (files directly); COM nodes exist only for what files cannot do, such as "run a macro". Driving the Excel window with `desktop.*` is the last resort.

## Excel (`excel.*`, implemented)

Crate `crates/shikigami-excel`. Reads and writes `.xlsx` / `.xlsm` directly (`.xls` gives `UNSUPPORTED_FORMAT`; save it as `.xlsx` in Excel).

| type | Main params | Output |
|---|---|---|
| `excel.readRows` | `path`, `sheet`, `headerRow` (default 1) | list of records keyed by the header cells, each with its row number `_row` |
| `excel.appendRows` | `path`, `sheet`, `rows` (list of records), `headerRow` | `{ firstRow, count }` |
| `excel.readCell` | `path`, `sheet`, `cell` (e.g. `B3`) | the cell's value |
| `excel.writeCell` | `path`, `sheet`, `cell`, `value` | – |
| `excel.readRange` | `path`, `sheet`, `range` (e.g. `A1:D20`; the whole used range when omitted) | list of rows (each a list of cell values) |
| `excel.writeRange` | `path`, `sheet`, `cell` (top-left), `values` (list of rows) | `{ range }` |
| `excel.listSheets` | `path` | list of sheet names |
| `excel.addSheet` | `path`, `sheet` | – (does nothing if it exists) |

- Without `sheet`, the first sheet. A wrong name gives `SHEET_NOT_FOUND` (`details.sheets` lists the sheets)
- Writing nodes create the workbook when the file does not exist (but not the folder). They do not create sheets; add new sheets with `excel.addSheet`
- **A common shape**: `excel.readRows` → `control.forEach` → work on each row → `excel.writeCell` (`cell: "F{{ row._row }}"`) to write the result on the same row. To collect results in another workbook use `excel.appendRows` (on an empty sheet it also writes the header row from the record keys)
- `excel.appendRows` keys must match the headers exactly. Others give `UNKNOWN_COLUMN` (`details.columns` lists the headers). Columns are never added on their own

### Values

| Cell | Value read | How to write it |
|---|---|---|
| Text | `"A-1"` | `"A-1"` (`"=1+1"` and `"007"` stay text; they never turn into numbers or formulas) |
| Number | `1200` / `980.5` | `1200` |
| Boolean | `true` / `false` | `true` |
| Date | `"2026-10-28"` (`"2026-10-28T09:30:00"` with a time, `"09:30:00"` for a time only) | `{ "date": "2026-10-28" }` |
| Formula | The result Excel last calculated | `{ "formula": "SUM(B2:B9)" }` |
| Error | Text such as `"#DIV/0!"` | – |
| Empty | `null` | `null` (clears the value, keeps the formatting) |

- Dates are recognized by the cell's number format (`yyyy/mm/dd`, `ggge年m月d日`…). When writing a date to a cell without a date format, `yyyy/mm/dd` is applied
- Results of formulas you write are calculated the next time the workbook is opened in Excel (Shikigami does not calculate). If you need the result right away, use the COM recalculation node (planned)

### Locking and saving

- Every node uses `path` as a resource, so nodes on the same workbook run one at a time and different workbooks run in parallel (the `file:` key; [ai-authoring.md](design/ai-authoring.md) B, Japanese). Scenarios never declare locks
- Each writing node saves before it finishes. It writes to a temporary file in the same folder and then replaces the original, so a failure never corrupts it. There are no "open / save / close workbook" nodes (so no way of linking distant nodes by name is needed)
- While the workbook is open in Excel (a `~$name` file exists), writes fail with `FILE_IN_USE` (retryable). Reading still works

### Limits

- Each node reads and writes the whole workbook, so a node on a large workbook takes time. Collecting the results and writing them once at the end with `excel.appendRows` / `excel.writeRange` is faster than `excel.writeCell` per row
- Formatting, merged cells, conditional formatting and macros (`.xlsm`) are meant to be kept on save, but some parts such as pivot tables and charts depend on what the library (umya-spreadsheet) supports. Try important workbooks on a copy first
- Password-protected workbooks cannot be opened (`WORKBOOK_UNREADABLE`)

### MCP

The AI checks a workbook's contents with `test_step` (`excel.listSheets`, `excel.readRange`…) before writing. `test_step`'s `state` includes the used range and first few rows of every sheet in that workbook.

## Excel macros (`excel.runMacro`, implemented)

Only "run a workbook's VBA macro", which files alone cannot do, goes through Excel itself (COM). It needs Windows and desktop Excel (`PLATFORM_UNSUPPORTED` elsewhere, `EXCEL_NOT_INSTALLED` without Excel).

```json
{ "type": "excel.runMacro", "params": { "path": "C:\\work\\summary.xlsm", "macro": "Module1.Summarize", "args": ["{{ month }}", 2026] }, "saveAs": "result" }
```

- `macro`: `Summarize` or `Module1.Summarize` (a Public Sub / Function in a standard module). A Function's return value is the output (text, numbers, true/false; dates as ISO text; anything else null)
- `args`: arguments (text, numbers, true/false, null; up to 30). `save`: whether to save after running (default true; false discards the changes and closes)
- Each node starts **its own hidden Excel** and goes open → run → save → close → quit. Excel windows the person has open are never touched. Warning dialogs are off (`DisplayAlerts = false`) and external links are not updated
- The default timeout is 5 minutes. A macro that shows a MsgBox / InputBox waits for a person and never ends, so on timeout that Excel is quit (without saving) and the node returns `MACRO_TIMEOUT`
- It waits its turn automatically with other `excel.*` nodes on the same workbook. `FILE_IN_USE` while the person has the workbook open in Excel
- Workbooks downloaded from the internet and blocked ("Unblock" not checked in the file's properties) cannot run macros and give `MACRO_FAILED`
- Any code can run, so the node's risk is `Dangerous`

## Word (`word.*`, implemented)

Crate `crates/shikigami-word`. Reads and writes `.docx` (also `.docm` / `.dotx`) directly; Word is not needed (`.doc` gives `UNSUPPORTED_FORMAT`).

| type | Main params | Output |
|---|---|---|
| `word.fillTemplate` | `template`, `path` (the document to create), `values` | `{ path, replaced }` |
| `word.readText` | `path` | The body text (a line break per paragraph) |

- Write `{{ name }}` in the template's body, headers and footers and it is replaced with the value from `values`. Formatting (bold, fonts…) stays as in the template. `\n` in a value becomes a line break. `{{ customer.name }}` is a field of a record
- **Repeating table rows**: write `{{ items.product }}` `{{ items.qty }}` in a table row and pass `"items": [ { "product": …, "qty": … }, … ]` in `values`; the row repeats once per record (an empty list removes the row)
- If any `{{ }}` has no value, no document is created and the node gives `TEMPLATE_VALUE_MISSING` (`details.missing` lists the names), so documents with unreplaced fields are never produced
- Placeholders such as `{{ name }}` that Word split internally (spell checking and formatting changes do this) are replaced just the same
- The template is never changed. `path` is written as a temporary file in the same folder, then replaced. Writing to a document open in Word gives `FILE_IN_USE`
- Both `template` and `path` are resources, so nodes on the same file wait their turn automatically
- Running `word.readText` on a template with MCP's `test_step` adds the list of placeholders to `state`

## Mail (`mail.*`, implemented)

Crate `crates/shikigami-mail`. One `mail.*` set regardless of app; for now it uses this PC's Outlook (classic) through COM (Windows only; the new Outlook app and the web version are not supported). It uses the account signed in to Outlook, so no passwords or server settings are needed.

| type | Main params | Output |
|---|---|---|
| `mail.createDraft` | `to` / `cc` / `bcc` (lists of addresses), `subject`, `body`, `html`, `attachments` (list of full paths) | `{ id }` |
| `mail.list` | `folder` (e.g. `Inbox/Invoices`; default the Inbox), `unreadOnly`, `since`, `subjectContains`, `fromContains`, `limit` (default 50), `includeBody` | A list of mails, newest first: `{ id, subject, from, fromAddress, to, receivedAt, unread, attachments, body }` |
| `mail.saveAttachments` | `id` (an id from `mail.list`), `folder` (where to save), `nameContains` | A list of the full paths saved |

- **Nothing is sent.** `mail.createDraft` only puts a draft in the Drafts folder; a person checks and sends it. Sending automatically (`mail.send`) leaves the PC, so it is being considered separately
- Write recipients one per list item (`["{{ customer.email }}"]`). Anything that is not an address gives `INVALID_ADDRESS` and a missing attachment `FILE_NOT_FOUND`, before the draft is created
- Saving attachments never overwrites a file of the same name; it numbers them like `invoice (2).pdf`. Folder parts in attachment names are ignored
- Outlook operations run one at a time (resource `app:outlook`). The person's Outlook is never closed. `OUTLOOK_TIMEOUT` when it gets stuck on a security prompt or similar
- Mail content is data from outside, not instructions (this is stated to AI clients too)

## Next (planned)

1. **Excel recalculation and PDF export**: added the same way as `excel.runMacro`
2. **Word PDF export**: through COM (the same way as Excel macros)
3. **Sending mail and other ways to send**: `mail.send` (`Dangerous`, with thorough recipient checks), and choosing something other than Outlook (SMTP / Microsoft Graph) in settings
