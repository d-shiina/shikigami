# Files and folders (`file.*`)

English | [日本語](ja/files.md)

Crate `spellsheet-files`. Works without installing anything and is tested off Windows too. Value processing (building paths, filtering rows…) is written with expression functions, not nodes ([expressions.md](expressions.md)).

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

## The flow's folder

Each flow is a folder in the workspace, and its files live next to it:

```text
flows/<id>/
  flow.json   the flow
  input/          files the flow reads (Excel, CSV…)
  config/         settings files people change without touching the flow
  templates/      layouts the output is made from (Excel, Word)
  output/         what runs produce
  work/           scratch space, emptied at the start of every run
  logs/           a readable log per run: 20261029-140512_failed.log (the newest 100, at most 90 days old by default: `records.keepDays`)
```

- Relative paths in a node's file params (`input/orders.xlsx`) resolve from the flow's folder, so the flow keeps working when the workspace moves or is shared. A subflow resolves from its own folder. Paths that leave the folder (`..`) get the `PATH_OUTSIDE_PROJECT` warning; absolute paths work as before.
- `work/` is emptied when a run starts. Set `settings.keepWork: true` on the flow to keep it. Trying one node (`test_step`) neither empties `work/` nor writes a log.
- Bundles (`export_flow`) and duplicates take the files along, except `output/`, `work/` and `logs/`.
- `spellsheet run orders.spellsheet.json` (a bundle file) unpacks its files into `orders.files/<id>/` next to it and runs there, so `output/` and `logs/` stay after the run.
- Older workspaces with `flows/<id>.json` are moved into folders when the workspace is opened.
- Add files from Writer, from the AI (`write_project_file`), or with `spellsheet flow add-file <id> <file> --to input`.

### Settings files

A settings file in `config/` lists named values with a type and a description, so Writer can show it as a form:

```json
{
  "format": "spellsheet.config",
  "items": [
    { "name": "threshold", "type": "number", "value": 10000, "description": "Orders at or above this need approval" },
    { "name": "sendTo", "type": "text", "value": "accounts@example.com" }
  ]
}
```

Types are `text`, `number`, `boolean`, `date`, `list` and `folder`. `config.read` with `{ "path": "config/settings.json" }` saved as `settings` gives `settings.threshold`. A wrong format gives `CONFIG_INVALID`.

A `folder` is a folder's full path. `%USERPROFILE%` and other `%NAME%` parts are replaced with the PC's environment variables when read: Box Drive and OneDrive folders sit in each user's profile, so `%USERPROFILE%\Box\Accounts` works on everyone's PC.

### Files on a file server or in cloud storage

File params take full paths too: a file server (`\\fs01\accounts\orders.xlsx`) and folders synced with cloud storage (Box Drive, OneDrive, Google Drive, Dropbox) are read and written where they are. Unattended runs (the worker) run as the signed-in user, so whatever that person can open works. For Box Drive, sign in to Box Drive on that PC.

Keep the place as a `folder` setting rather than in the nodes, so whoever receives the flow changes one setting:

```json
{ "name": "ordersFolder", "type": "folder", "value": "\\\\fs01\\accounts\\orders" }
```

and write `{{ settings.ordersFolder }}/orders.xlsx` in the node.

In Writer:

- When the flow reads a file from `input/` that is not there, the input part of the files panel says so and offers **Put it in the folder** (pick a file; it is copied under that name), **Read from a file server** (pick a folder: a `folder` setting is added and the nodes reading that file read `{{ settings.<name> }}/…`) and **Read from cloud storage** (below). Folders inside the user's profile are kept as `%USERPROFILE%\…`
- **Change where files are written** in the output part of the files panel points every node writing into `output/` at the file server folder you pick; cloud storage sends the files at the end of each run (below)
- **Browse…** in a node's settings asks, for a file outside the flow's folder, whether to read it where it is or copy it in
- A `.spx` lists the full paths and the settings' folders under what the receiving PC needs; on import, Writer checks whether this PC opens them
- The AI's `list_project_files` returns the missing input files as `needed`, and the cloud storage setting as `cloud` (with an input place, `needed` is empty)

### Cloud storage (API)

On PCs without the sync app (Box Drive and the like), and for unattended runs, the flow's folder reaches the storage through its API: Box, Google Drive, and OneDrive / SharePoint. It is a setting of the folder, not nodes: the nodes keep reading `input/orders.xlsx` and writing `output/invoice.pdf`, so the same flow also runs with the files put in its folder by hand.

- **Input**: each time a whole run starts, the files directly in a cloud storage folder are fetched into `input/` (replacing files of the same name), before the first node.
- **Output**: each time a run ends without an error, the files it wrote directly in `output/` (new or changed during the run) are sent to a cloud storage folder (replacing files of the same name). They stay in `output/` too.

In the files panel, **Read from cloud storage** (for a missing input file) and **Change where files are written → Write to cloud storage** ask for:

| Field | What |
|---|---|
| Service | Box, Google Drive or OneDrive / SharePoint |
| Secret to sign in with | An OAuth app secret. A new one takes the client ID and client secret of the app made in the service's developer console; the API's sites and `plugin:<name>` are added to its sites |
| Redirect URL | The one registered with the app ([oauth.md](oauth.md)) |
| Folder | A path from the top of the storage (`Accounting/Orders`), or the address of the folder (Box, Google Drive) or its link (OneDrive / SharePoint) |
| Names to fetch (input only) | `*.xlsx` and the like. Empty: every file in the folder (not the folders in it) |

The setting is `config/cloud.json`:

```jsonc
{
  "format": "spellsheet.cloud",
  "input": {
    "service": "box", "label": "Box", "secret": "Box",
    "signIn": { "authorizeUrl": "…", "tokenUrl": "…", "redirectUrl": "…" },
    "folder": "Accounting/Orders", "pattern": "*.xlsx"
  },
  "output": { "service": "onedrive", "label": "OneDrive / SharePoint", "secret": "Microsoft", "signIn": { … }, "folder": "Accounting/Out" }
}
```

Input and output may use different services or accounts (secrets). The run signs in with `oauth.signIn` first: the first run opens the sign-in page, later runs stay signed in ([oauth.md](oauth.md)). The run's log says what was moved (`Fetched 2 files from Accounting/Orders in Box into input/ (orders.xlsx, prices.xlsx)`); when a transfer fails the run fails, named as the transfer. 「ここから実行」 (run from a node) keeps `input/` as it is. The token is never in the setting, so the flow can be handed over: the receiver signs in with their own account and changes the folder if needed.

The work is done by the plugin of the service (`box`, `googledrive`, `onedrive`): `<name>.downloadFolder` and `<name>.upload`. These plugins do not come with Writer and are offered separately: add the one you received on the **Plugins** page and restart Writer. Their nodes (`googledrive.list`, `googledrive.download`, `googledrive.downloadFolder`, `googledrive.upload`, …) can also be used in a flow.

Keep `work/` in the flow's folder: it is emptied at every run, and in a synced folder the sync lags behind (locked files) and others see half-made files.

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
