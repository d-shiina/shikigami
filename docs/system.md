# Web APIs, programs, clipboard and dialogs

English | [日本語](ja/system.md)

Crate `shikigami-system`. Built-in steps for things outside app windows. Value processing is written with expression functions ([expressions.md](expressions.md)).

| Step | What it does | Output | Risk |
|---|---|---|---|
| `http.request` | Calls a web API | `{ status, headers, body }` | dangerous |
| `process.run` | Runs a command-line program and waits for it | `{ exitCode, stdout, stderr }` | dangerous |
| `clipboard.get` / `clipboard.set` | Reads / sets the clipboard text (Windows) | text | safe / interactive |
| `dialog.message` | Shows a message and returns the button pressed (Windows) | `ok` `cancel` `yes` `no` | interactive |
| `dialog.input` | Asks for one line of text (Windows; empty on cancel) | text | interactive |
| `dialog.selectFile` | Lets the person pick a file, several files, a folder or where to save (Windows) | the path (a list for `files`), null on cancel | interactive |

## `http.request`

- Send one of `json` (a value), `form` (form fields) or `body` (text). URL parameters written in `query` are encoded.
- When the response is JSON, `body` is a value (use it as `res.body.items`). Otherwise it is text (decoded by charset, or detected as UTF-8 / Shift_JIS). With `saveTo` the body is saved to a file and `body` is the path.
- Status 400 and above gives `HTTP_ERROR` (`details.status` and `details.body`). 5xx, 429 and 408 are retried by `retry`. To treat 404 as "not there", wrap the step in `control.try`.
- Authentication: put a registered secret in `auth`, `{ "secret": "Orders API", "field": "password" }`. `authType` is `bearer` (default, `Authorization: Bearer …`), `basic` (the secret's username and password) or `header` (into the header named by `authHeader`; for API keys). It is sent only to the sites registered on the secret (in the form `https://api.example.com`); otherwise `SECRET_SITE_MISMATCH`.
- Requests with a secret do not follow redirects to another site (the 3xx response is returned as is), so the key never reaches another site.
- Proxies follow the OS settings. Certificates are checked against the Windows certificate store (in-house CAs work as they are).

## `process.run`

- Pass `args` as a list (no shell, so no quoting; paths with spaces are fine). For `cmd` built-ins: `program: "cmd"`, `args: ["/c", "…"]`.
- An exit code not in `okExitCodes` (default `[0]`) gives `PROCESS_FAILED` (`details` has the exit code and the end of the output). For programs like robocopy where 1–7 mean success, list them in `okExitCodes`.
- No console window is shown. Past the step's `timeoutMs` the program is ended.
- When the step ends (finished, stopped or timed out), child processes the program started are ended too (a job object on Windows). Leftovers of an earlier attempt never keep running during a retry.
- To leave an app with a window open, use `desktop.launch` (apps opened with `cmd /c start …` are closed when the step ends).

## Clipboard and dialogs

- Windows only. Elsewhere `PLATFORM_UNSUPPORTED` (definitions and validation work everywhere).
- Each dialog is shown by its own PowerShell process (Windows Forms). Stopping or a timeout closes the process.
- Use dialogs only in runs a person is watching. They wait 10 minutes by default (change with `timeoutMs`); unattended runs stop there until the timeout. While waiting, Studio asks the person to answer the dialog.
- Never ask for passwords with `dialog.input` (use secrets).
