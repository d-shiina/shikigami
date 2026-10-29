# Files and folders (`file.*`)

English | [日本語](ja/files.md)

Crate `shikigami-files`. Works without installing anything and is tested off Windows too. Value processing (building paths, filtering rows…) is written with expression functions, not nodes ([expressions.md](expressions.md)).

| Node | What it does | Output |
|---|---|---|
| `file.readText` | Reads a whole text file | text |
| `file.writeText` | Writes (`append: true` adds to the end). Creates missing folders | the path |
| `file.readCsv` | Reads CSV / TSV into records keyed by the first row (every cell is text) | list of records |
| `file.writeCsv` | Writes records (or lists of cells), with a header row and CRLF line breaks | rows written |
| `file.exists` | Whether the file or folder exists | true / false |
| `file.list` | Lists a folder (`pattern` like `*.csv`, case-insensitive) | list of `{ path, name, isFolder, size, modified }` |
| `file.copy` / `file.move` | Copy / move or rename. `to` is the new path itself (not a folder) | the new path |
| `file.delete` | Deletes (not to the Recycle Bin). Folders with contents need `recursive: true` | whether it deleted |
| `file.createFolder` | Creates a folder (and the ones above it; an existing folder is fine) | the path |
| `file.zip` / `file.unzip` | Compress into a zip / extract | the zip path / list of extracted files |
| `config.read` | Reads a settings file (see below) into `{ name: value }`. A plain JSON object comes back as it is | record |

## The scenario's folder

Each scenario is a folder in the workspace, and its files live next to it:

```text
scenarios/<id>/
  scenario.json   the scenario
  input/          files the scenario reads (Excel, CSV…)
  config/         settings files people change without touching the flow
  templates/      layouts the output is made from (Excel, Word)
  output/         what runs produce
  work/           scratch space, emptied at the start of every run
  logs/           a readable log per run: 20261029-140512_failed.log (the newest 100 are kept)
```

- Relative paths in a node's file params (`input/orders.xlsx`) resolve from the scenario's folder, so the scenario keeps working when the workspace moves or is shared. A subscenario resolves from its own folder. Paths that leave the folder (`..`) get the `PATH_OUTSIDE_PROJECT` warning; absolute paths work as before.
- `work/` is emptied when a run starts. Set `settings.keepWork: true` on the scenario to keep it. Trying one node (`test_step`) neither empties `work/` nor writes a log.
- Bundles (`export_scenario`) and duplicates take the files along, except `output/`, `work/` and `logs/`.
- Older workspaces with `scenarios/<id>.json` are moved into folders when the workspace is opened.
- Add files from Studio, from the AI (`write_project_file`), or with `shikigami scenario add-file <id> <file> --to input`.

### Settings files

A settings file in `config/` lists named values with a type and a description, so Studio can show it as a form:

```json
{
  "format": "shikigami.config",
  "items": [
    { "name": "threshold", "type": "number", "value": 10000, "description": "Orders at or above this need approval" },
    { "name": "sendTo", "type": "text", "value": "accounts@example.com" }
  ]
}
```

Types are `text`, `number`, `boolean`, `date` and `list`. `config.read` with `{ "path": "config/settings.json" }` saved as `settings` gives `settings.threshold`. A wrong format gives `CONFIG_INVALID`.

## Encodings

- Reading (`encoding`, default `auto`): BOM, then UTF-8, then Shift_JIS. With `utf-8` / `shift_jis` given, a mismatch gives `ENCODING_MISMATCH`.
- Writing (default `utf-8`): for CSVs opened in Excel use `utf-8-bom` or `shift_jis`. Characters Shift_JIS cannot represent (emoji…) give `UNENCODABLE_TEXT` (`details.characters` says which). Appending never adds a second BOM.
- Japanese file names (Shift_JIS) in zips made by Windows Explorer extract correctly.

## Behavior

- Overwriting is refused by default (`FILE_EXISTS`); `overwrite: true` replaces. `file.unzip` extracts nothing if even one file would be overwritten.
- Writes go to a temporary file that then replaces the target, so no half-written files are left (except when appending). Attempts that were stopped or timed out leave the file unchanged.
- `path` / `from` / `to` act as locks: actions on the same file run in turn, different files in parallel.
- Appending with `writeCsv` lines the columns up with the existing header and does not write the header again.
- Zip entries that would land outside the destination (`../`) are refused with `ZIP_INVALID`.
- Error codes: `FILE_NOT_FOUND`, `FILE_EXISTS`, `FILE_ACCESS_DENIED`, `FILE_IN_USE` (open in Excel or similar; a retry may succeed), `FOLDER_NOT_EMPTY`, `NOT_A_FOLDER`, `CSV_INVALID`, `ZIP_INVALID`.

## Example

Wait for a download, keep the CSV rows of 10,000 or more with tax added, and write them out:

```json
[
  { "type": "wait.until", "params": { "condition": "len(files) > 0" },
    "blocks": { "check": [ { "type": "file.list", "params": { "folder": "C:\\work\\dl", "pattern": "*.csv" }, "saveAs": "files" } ] } },
  { "type": "file.readCsv", "params": { "path": "{{ files[0].path }}" }, "saveAs": "orders" },
  { "type": "variable.set", "params": { "name": "big",
      "expression": "map(filter(orders, r => num(r.Amount) >= 10000), r => { no: r.OrderNo, withTax: round(num(r.Amount) * 1.1) })" } },
  { "type": "file.writeCsv", "params": { "path": "C:\\work\\out\\{{ formatDate(today(), 'yyyyMMdd') }}.csv", "rows": "{{ big }}", "encoding": "utf-8-bom" } },
  { "type": "file.move", "params": { "from": "{{ files[0].path }}", "to": "{{ pathJoin('C:\\\\work\\\\done', files[0].name) }}", "overwrite": true } }
]
```
