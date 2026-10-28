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

To keep the number of ways the AI has to learn small, the same action is never available both ways. Reading and writing cells is always `excel.*` (files directly); COM steps exist only for what files cannot do, such as "run a macro". Driving the Excel window with `desktop.*` is the last resort.

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
- Writing steps create the workbook when the file does not exist (but not the folder). They do not create sheets; add new sheets with `excel.addSheet`
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
- Results of formulas you write are calculated the next time the workbook is opened in Excel (Shikigami does not calculate). If you need the result right away, use the COM recalculation step (planned)

### Locking and saving

- Every step uses `path` as a resource, so steps on the same workbook run one at a time and different workbooks run in parallel (the `file:` key; [ai-authoring.md](design/ai-authoring.md) B, Japanese). Scenarios never declare locks
- Each writing step saves before it finishes. It writes to a temporary file in the same folder and then replaces the original, so a failure never corrupts it. There are no "open / save / close workbook" steps (so no way of linking distant steps by name is needed)
- While the workbook is open in Excel (a `~$name` file exists), writes fail with `FILE_IN_USE` (retryable). Reading still works

### Limits

- Each step reads and writes the whole workbook, so a step on a large workbook takes time. Collecting the results and writing them once at the end with `excel.appendRows` / `excel.writeRange` is faster than `excel.writeCell` per row
- Formatting, merged cells, conditional formatting and macros (`.xlsm`) are meant to be kept on save, but some parts such as pivot tables and charts depend on what the library (umya-spreadsheet) supports. Try important workbooks on a copy first
- Password-protected workbooks cannot be opened (`WORKBOOK_UNREADABLE`)

### MCP

The AI checks a workbook's contents with `test_step` (`excel.listSheets`, `excel.readRange`…) before writing. `test_step`'s `state` includes the used range and first few rows of every sheet in that workbook.

## Next (planned)

1. **`excel.runMacro` (COM)**: opens the `path` workbook in Excel, runs the macro `macro` with `args`, saves and quits. Windows only (`PLATFORM_UNSUPPORTED` elsewhere). Like desktop automation (`crates/shikigami-desktop/src/uia.rs`), COM is called on a dedicated thread with `unsafe` confined to that one module. Locked by workbook path; uses its own Excel instance and never touches the one the person has open. `DisplayAlerts = false` so macro warnings and dialogs do not stop it. "Recalculate and save" and "Export to PDF" come the same way
2. **Word (`word.*`, files directly)**: `.docx` templates (`word.fillTemplate`: replace `{{ name }}`, add rows to tables) and reading the text (`word.readText`). PDF export through COM
3. **Mail (`mail.*`)**: one set regardless of app, with the sending method (Outlook COM, later SMTP / Microsoft Graph) chosen in settings. Messages leave the PC, so `mail.send` is `Dangerous`; it starts with creating drafts (`mail.createDraft`) and reading received mail and saving attachments (`mail.list` / `mail.saveAttachments`), with thorough validation hints for recipients and bodies
