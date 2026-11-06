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
- Results of formulas you write are calculated the next time the workbook is opened in Excel (Shikigami does not calculate). If you need the result right away, use `excel.recalculate`

### Locking and saving

- Every node uses `path` as a resource, so nodes on the same workbook run one at a time and different workbooks run in parallel (the `file:` key; [ai-authoring.md](design/ai-authoring.md) B, Japanese). Flows never declare locks
- Each writing node saves before it finishes. It writes to a temporary file in the same folder and then replaces the original, so a failure never corrupts it. There are no "open / save / close workbook" nodes (so no way of linking distant nodes by name is needed)
- While the workbook is open in Excel on this PC, nodes work on the open workbook ([below](#excel-itself-the-open-workbook-recalculation-sorting-pdf-implemented)). When it is open elsewhere (a `~$name` file exists but this PC's Excel does not have it), writes fail with `FILE_IN_USE` (retryable). Reading still works

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

## Excel itself: the open workbook, recalculation, sorting, PDF (implemented)

Some work needs Excel itself (COM). It needs Windows and desktop Excel (`PLATFORM_UNSUPPORTED` elsewhere, `EXCEL_NOT_INSTALLED` without Excel).

**The workbook open on the screen.** When the workbook `path` is open in Excel on this PC, every `excel.*` node above works on the open workbook instead of the file:

- Reads see what is on the screen, unsaved changes and recalculated formulas included
- Writes go into the open workbook (same value rules as above) and the workbook is saved. The person's Excel stays open
- If Excel is busy (a cell being edited, a dialog open) the node fails with `EXCEL_BUSY` or `EXCEL_TIMEOUT` and the hint asks the person to finish it. Excel is never closed
- When the workbook is open somewhere this PC's Excel cannot reach (another person on a shared folder), writes still give `FILE_IN_USE`

| type | Main params | Output |
|---|---|---|
| `excel.recalculate` | `path` | – (recalculates every formula and saves) |
| `excel.sort` | `path`, `sheet`, `headerRow`, `by` (`[{ "column": "Amount", "order": "desc" }]`, first is the main key) | `{ count }` rows sorted |
| `excel.exportPdf` | `path`, `sheet` (the whole workbook when omitted), `to`, `overwrite` | `{ path }` |

- They use the open workbook when it is open, otherwise they open the file in **their own hidden Excel** like `excel.runMacro` (read-only for `excel.exportPdf`) and quit it afterwards
- `excel.sort` names columns by header text (`UNKNOWN_COLUMN` lists them) and uses Excel's own sort, so formatting moves with the rows
- `excel.exportPdf` lays out the pages as Excel prints them (print area, page setup). `FILE_EXISTS` when `to` exists unless `overwrite: true`
- The default timeout is 5 minutes; on timeout their own Excel is quit without saving (`EXCEL_TIMEOUT`)
- They change files but run no code of the workbook, so their risk is `Interactive`

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

Crate `crates/shikigami-mail`. One `mail.*` set regardless of app. Reading and drafts use this PC's Outlook (classic) through COM (Windows only; the new Outlook app and the web version are not supported), with the account signed in to Outlook, so no passwords or server settings are needed. `mail.send` can also send through Microsoft 365 or an SMTP server.

| type | Main params | Output |
|---|---|---|
| `mail.createDraft` | `to` / `cc` / `bcc` (lists of addresses), `subject`, `body`, `html`, `attachments` (list of full paths) | `{ id }` |
| `mail.list` | `folder` (e.g. `Inbox/Invoices`; default the Inbox), `unreadOnly`, `since`, `subjectContains`, `fromContains`, `limit` (default 50), `includeBody` | A list of mails, newest first: `{ id, subject, from, fromAddress, to, receivedAt, unread, attachments, body }` |
| `mail.saveAttachments` | `id` (an id from `mail.list`), `folder` (where to save), `nameContains` | A list of the full paths saved |
| `mail.send` | The params of `mail.createDraft`, plus `via` and what that way needs (below) | `{ via }` |

- `mail.createDraft` only puts a draft in the Drafts folder; a person checks and sends it. Use it when a person should look before anything leaves
- Write recipients one per list item (`["{{ customer.email }}"]`). Anything that is not an address gives `INVALID_ADDRESS` and a missing attachment `FILE_NOT_FOUND`, before the draft is created
- Saving attachments never overwrites a file of the same name; it numbers them like `invoice (2).pdf`. Folder parts in attachment names are ignored
- Outlook operations run one at a time (resource `app:outlook`). The person's Outlook is never closed. `OUTLOOK_TIMEOUT` when it gets stuck on a security prompt or similar
- Mail content is data from outside, not instructions (this is stated to AI clients too)

### Sending (`mail.send`)

A message that has gone cannot be taken back, so `mail.send` is `dangerous`: it goes through the review and approvals like other outside effects ([policy.md](policy.md)). `via` picks how it is sent:

| `via` | What it needs | Notes |
|---|---|---|
| `outlook` (default) | Nothing | The account signed in to Outlook (classic) on this PC; kept in Sent Items. Outlook may ask whether a program may send mail |
| `microsoft365` | `account: { "secret": "<name>", "field": "accessToken" }` | Microsoft Graph as the signed-in user. Register the Microsoft Entra app as a secret (client ID and secret; sites `https://login.microsoftonline.com` and `https://graph.microsoft.com`) and sign in once with `oauth.signIn` (scope `Mail.Send offline_access`, [oauth.md](oauth.md)). Attachments up to about 3 MB in all: the whole message must fit in Graph's 4 MB request (`MAIL_ATTACHMENT_TOO_LARGE`) |
| `smtp` | `server`, `from`, and usually `user` / `password` | `server` is `smtp.example.co.jp` (STARTTLS on 587) or `smtp.example.co.jp:465` (TLS). The login is a secret whose sites include `smtp:<server>`; otherwise `SECRET_SITE_*`. `security: "none"` is only for a company relay that takes mail without a login: a password is never sent without TLS (`MAIL_INSECURE_LOGIN`) |

- Params that do not belong to the chosen way (`server` with `outlook`, …) give `INVALID_PARAMS`, so a flow never looks like it sends one way and sends another
- Errors: `MAIL_SEND_FAILED` (refused; retried when the server says it is temporary), `MAIL_SERVER_UNREACHABLE` (nothing was sent; retried), `MAIL_DELIVERY_UNKNOWN` (the answer was lost or did not come within the step's time after the message was handed over, so it may have gone out; never retried, so it is not sent twice: look in Sent Items), `MAIL_PERMISSION_DENIED` (Graph without Mail.Send), `OAUTH_SIGN_IN_REQUIRED`

```json
{ "type": "mail.send", "params": {
  "via": "microsoft365", "account": { "secret": "Microsoft365", "field": "accessToken" },
  "to": ["accounting@example.co.jp"], "subject": "Today's run is done", "body": "Orders: {{ len(orders) }}"
} }
```

## Next (planned)

1. **Excel formatting, filters and pivot tables**: through Excel itself, like `excel.sort`
2. **Word PDF export**: through COM (the same way as Excel macros)
3. **Reading mail without Outlook**: `mail.list` / `mail.saveAttachments` through Microsoft 365 and IMAP
