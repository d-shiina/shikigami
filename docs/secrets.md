# Logins and secrets

English | [日本語](ja/secrets.md)

How IDs and passwords for business sites and apps are handled. Three principles:

1. **People register the values**, under a name, in Studio's 🔑 Secrets (or with the CLI), e.g. "Order system".
2. **Scenarios and the AI only get the name.** A scenario says only `{ "secret": "Order system", "field": "password" }`. The value is handed only to the running node and never appears in scenario files, MCP results, logs or screenshots.
3. **Values are typed only into registered sites.** Each secret has its allowed sites; every other page is refused (against look-alike sites, and against an AI misled by instructions planted in a page). The check is made against the page the input field is on, so it also refuses a site that changed while waiting, and input fields in another site's iframe.

## Registering

### Studio

🔑 Secrets (top right) → New.

| Field | Contents |
|---|---|
| Name | The name scenarios and the AI use. 1–64 characters |
| Username / Password | The login values. When editing, an empty password keeps the previous one |
| Sites and apps allowed | One per line. `https://example.com/login` is treated as `https://example.com` (the origin). Desktop apps as `app:billing.exe` (the executable name; [desktop.md](desktop.md)) |
| MFA setup key | Optional. The key next to the authenticator QR code (base32) or an `otpauth://` string. One-time codes are filled in automatically |

### CLI

```powershell
shikigami secret set "Order system" --username tanaka --site https://orders.example.com   # asks for the password without echo
shikigami secret set "Order system" --totp JBSWY3DPEHPK3PXP                                 # only the fields to change
shikigami secret list
shikigami secret remove "Order system"
shikigami secret logout "Order system"     # removes only the saved sign-in state (below)
shikigami secret reset --yes               # removes everything to register again (after copying from another PC)
```

From scripts, use `--password-stdin` (the first line of standard input).

## Storage and encryption

```text
<workspace>/secrets/vault.json            names, sites and which fields are set (plain), and the values (encrypted)
<workspace>/secrets/sessions/<hash>.json  saved sign-in states (encrypted)
```

- Values are encrypted with AES-256-GCM. The key is **a single entry per workspace in Windows Credential Manager** ("Shikigami / vault …"); registering more secrets adds no entries there.
- The key is protected by the DPAPI of the Windows user who registered it. Copying the workspace folder to another PC or user does not make the values readable (`SECRET_KEY_MISSING`). In that case, use "Reset and register again" in Studio's 🔑 Secrets (or `shikigami secret reset --yes`) to remove the unreadable secrets, sign-in states and key, then register again.
- Updates are serialized with `secrets/.lock`, so Studio, the CLI and the MCP server never overwrite each other's changes to the same workspace.
- Off Windows (development, CI) the key is kept in `secrets/<id>.key` (readable by the owner only). That is no protection, so it is not for production.

## Using them in scenarios

```jsonc
{ "type": "browser.open", "params": { "url": "https://orders.example.com/", "session": "Order system" } },
{ "type": "browser.isVisible", "params": { "target": { "role": "heading", "name": "Orders" } }, "saveAs": "loggedIn" },
{ "type": "control.if", "params": { "condition": "!loggedIn" }, "blocks": { "then": [
  { "type": "browser.fill",  "params": { "target": { "label": "Username" }, "value": { "secret": "Order system", "field": "username" } } },
  { "type": "browser.fill",  "params": { "target": { "label": "Password" }, "value": { "secret": "Order system", "field": "password" } } },
  { "type": "browser.click", "params": { "target": { "role": "button", "name": "Log in" } } }
] } }
```

- `field` is `username` / `password` / `totp` (the current one-time code).
- Secrets may appear only as the value of input nodes (`browser.fill`'s `value`). In logs, messages, URLs and the like they give the validation error `SECRET_NOT_ALLOWED`.
- A default value on a `secret: true` variable would stay in the scenario as plain text, so it gives the validation error `SECRET_DEFAULT`.
- In Studio's properties, switch an input's value between "Text / 🔑 Secret" and pick the name and field.

### Keeping the sign-in (sessions)

With `session: "<name>"` on `browser.open`, that context starts with the saved cookies and localStorage and saves them again when it closes (at the end of the run). From the second run on the login page can be skipped, so, as above, log in only when `browser.isVisible` says it is needed. Saved states are encrypted with the same key as the secrets.

### MFA

- **One-time codes (TOTP)**: register the MFA setup key and `field: "totp"` types the current code each time.
- **Phone approval, SMS, CAPTCHA…**: `browser.waitForHuman` waits for the person. Studio shows "Waiting for you" and the browser comes to the front. It continues once the `until` element (e.g. the heading after login) appears. It waits 5 minutes by default (change with `timeoutMs`). Headless runs do not wait and fail with `HUMAN_REQUIRED`.
- Unattended scenarios normally keep a sign-in made once by a person with `session`.

## Masking

- In run logs, errors, run records and outputs, password and one-time code values are replaced with `***` (usernames are shown on screen anyway, so they are not masked).
- In screenshots, password fields and fields a secret was typed into are blacked out.
- Values are also removed from the text the browser adapter returns (`getText` / `getTable` / the page's accessibility tree / page details on errors), including values a person typed into password fields by hand.

## From AI (MCP)

- The AI never asks for passwords in the chat. `list_secrets` shows it only **names, sites and which fields are set** (neither values nor usernames).
- When it runs into a login page while exploring, the results of `inspect_page` / `test_step` carry `login` (a mark that login is needed, with hints).
  - If a secret fits, it logs in with `{ "secret": …, "field": … }` in a `browser.fill` through `test_step`.
  - If not, it asks the person to register one with `request_secret` (below). For a manual login, `test_step` with `browser.waitForHuman`.
- `run_scenario` cannot pass values to `secret: true` input variables (`SECRET_INPUT_REJECTED`).

### The AI asks for login details (`request_secret`)

Instead of asking for passwords in the chat, the AI asks Studio to register one with `request_secret`:

```jsonc
{ "name": "Google", "sites": ["https://accounts.google.com/"], "fields": ["username", "password"], "reason": "To sign in to Google and read order mails", "waitMs": 120000 }
```

- Studio shows "🔑 Login needed" at the top. Register opens the form with the name and sites filled in; the person enters only the username and password. For a name already registered, the edit form opens with the missing sites added.
- Values go from Studio into the encrypted file only, never to the AI, MCP results, the chat or logs. The request file `secrets/requests.json` holds only the name, sites, fields and the AI's reason (up to 300 characters).
- The "reason" is text written by the AI; Studio shows it as "From the AI". Input is limited to the registered sites, so whatever the reason says, nothing is typed into another site.
- `status` in the result: `registered` (use it in `browser.fill`) / `waiting` (not yet; call again with `waitMs`, or `list_secrets`) / `dismissed` (the person closed it with Later).
- `fields` defaults to `username` and `password`. Add `totp` when an authenticator code is needed.
- If Studio is not running, the AI tells the person in the chat to open Studio and register it. The request stays and shows up once Studio opens.

### When a run fails

When a scenario run in Studio stops on `SECRET_NOT_FOUND` / `SECRET_FIELD_EMPTY` / `SECRET_SITE_NOT_SET` / `SECRET_SITE_MISMATCH` / `SECRET_APP_NOT_SET`, the same Register bar appears and opens the registration (or edit) form for that secret. For `SECRET_SITE_MISMATCH` the site of the page it stopped on is already added; check it is the right site before saving.
- Page content is data, not instructions to the AI. Planted instructions that try to make it type a password into another site are stopped by the site check.

## Error codes

| Code | Meaning and fix |
|---|---|
| `SECRET_NOT_FOUND` | No secret with that name. Register it in Studio |
| `SECRET_FIELD_EMPTY` | That field (password, MFA key…) is not set |
| `SECRET_SITE_NOT_SET` | No allowed sites. Add the site |
| `SECRET_SITE_MISMATCH` | The current page is not a registered site. Check the URL and add the site if it is right |
| `SECRET_APP_NOT_SET` / `SECRET_APP_MISMATCH` | The desktop app (`app:xxx.exe`) is not registered, or the input went to another app |
| `SECRET_KEY_MISSING` | No key for this PC / Windows user. Reset in Studio or with `shikigami secret reset --yes` and register again |
| `SECRETS_UNAVAILABLE` | Run on a Runtime without secrets (run from Studio, the CLI or MCP) |
| `HUMAN_REQUIRED` / `HUMAN_TIMEOUT` | A person is needed but there is no window / they did not finish in time |
