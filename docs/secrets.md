# Logins and secrets

English | [日本語](ja/secrets.md)

How IDs and passwords for business sites and apps, and keys for web APIs, are handled. Three principles:

1. **People register the values**, under a name, in Writer's 🔑 Secrets (or with the CLI), e.g. "Order system".
2. **Flows and the AI only get the name.** A flow says only `{ "secret": "Order system", "field": "password" }`. The value is handed only to the running node and never appears in flow files, MCP results, logs or screenshots.
3. **Values are typed only into registered sites.** Each secret has its allowed sites; every other page is refused (against look-alike sites, and against an AI misled by instructions planted in a page). The check is made against the page the input field is on, so it also refuses a site that changed while waiting, and input fields in another site's iframe.

## Registering

### Writer

🔑 Secrets (top right) → New.

| Field | Contents |
|---|---|
| Name | The name flows and the AI use. 1–64 characters |
| Kind | **Login** (a username and password typed into a site or app), **API key** (a fixed key or token sent to a web API) or **OAuth app** (an app registered at an OAuth provider, [oauth.md](oauth.md)). The kind names the fields and shows only the ones it uses: an API key has just the key, an OAuth app the client ID and client secret |
| Username / Password | The login values. When editing, an empty password keeps the previous one |
| Sites and apps allowed | One per line. `https://example.com/login` is treated as `https://example.com` (the origin). Desktop apps as `app:billing.exe` (the executable name; [desktop.md](desktop.md)) |
| MFA setup key | Optional. The key next to the authenticator QR code (base32) or an `otpauth://` string. One-time codes are filled in automatically |
| Where the values are kept | **SpellSheet** (encrypted in the workspace, the default) or **Windows Credential Manager** (below) |

All kinds are one vault and one way to write them in flows (below): the kind changes no storage, site check or masking. Kept apart they would need a second place to look and a second way to reference, for the AI too.

| Kind | Fields (as stored) | Used by | Who fills it in |
|---|---|---|---|
| `login` | `username`, `password`, `totp` | input nodes (`browser.fill`, `desktop.*`, `db.*`…) | a person |
| `apiKey` | `password` (the key) | `http.request` `auth` with `authType` `bearer` or `header` | a person |
| `oauth` | `username` (client ID), `password` (client secret) | `oauth.signIn`; the access token it gets is `field: "accessToken"` | a person enters the client; the tokens are obtained and renewed automatically |

Changing the kind of a saved secret removes the fields the new kind does not use (e.g. the username when it becomes an API key). Secrets registered before kinds existed count as OAuth apps once they have tokens, as logins otherwise.

For an OAuth app the list shows when the access token expires, when it was last obtained, and whether it renews itself (a refresh token is kept) or needs signing in again.

### Using a credential of Windows Credential Manager

When company rules keep passwords in Credential Manager, another tool uses the same password, or a password should be changed in one place only, set "Where the values are kept" to Windows Credential Manager and pick the address of a **generic credential** there (from the list, or typed).

- The user name and password are read from Credential Manager each time a flow uses them; the vault keeps no values for that secret. A password changed in Credential Manager is typed from the next run.
- The name, allowed sites and MFA setup key are still registered in SpellSheet, and site checks and masking work the same.
- Only **generic credentials** can be read: Windows does not hand domain ("Windows") credentials or web credentials to other programs.
- Passwords are read as UTF-16, as Credential Manager, `cmdkey` and PowerShell write them (credentials another tool wrote as UTF-8 may not read correctly).
- Credentials belong to the Windows user. For unattended runs, add the same address to the Credential Manager of the user the runs run as.
- Switching back to SpellSheet empties the user name and password: type them again.

Add a generic credential in Control Panel → Credential Manager → Windows Credentials → Add a generic credential, or with `cmdkey /generic:company/orders /user:tanaka /pass`.

### CLI

```powershell
spellsheet secret set "Order system" --username tanaka --site https://orders.example.com   # asks for the password without echo
spellsheet secret set "Order system" --totp JBSWY3DPEHPK3PXP                                 # only the fields to change
spellsheet secret set "Orders API" --kind api-key --site https://api.example.com          # asks for the key without echo
spellsheet secret set "Order system" --windows-credential company/orders --site https://orders.example.com   # read from Credential Manager
spellsheet secret windows-credentials       # generic credentials to pick from (addresses and user names)
spellsheet secret list
spellsheet secret remove "Order system"
spellsheet secret logout "Order system"     # removes only the saved sign-in state (below)
spellsheet secret reset --yes               # removes everything to register again (after copying from another PC)
```

From scripts, use `--password-stdin` (the first line of standard input).

## Storage and encryption

```text
<workspace>/secrets/vault.json            names, sites and which fields are set (plain), and the values (encrypted)
<workspace>/secrets/sessions/<hash>.json  saved sign-in states (encrypted)
```

- Values are encrypted with AES-256-GCM. The key is **a single entry per workspace in Windows Credential Manager** ("vault <ID>.SpellSheet"); registering more secrets adds no entries there.
- The key is protected by the DPAPI of the Windows user who registered it. Copying the workspace folder to another PC or user does not make the values readable (`SECRET_KEY_MISSING`). In that case, use "Reset and register again" in Writer's 🔑 Secrets (or `spellsheet secret reset --yes`) to remove the unreadable secrets, sign-in states and key, then register again.
- Updates are serialized with `secrets/.lock`, so Writer, the CLI and the MCP server never overwrite each other's changes to the same workspace.
- Off Windows (development, CI) the key is kept in `secrets/<id>.key` (readable by the owner only). That is no protection, so it is not for production.

## Using them in flows

```jsonc
{ "type": "browser.open", "params": { "url": "https://orders.example.com/", "session": "Order system" } },
{ "type": "browser.isVisible", "params": { "target": { "role": "heading", "name": "Orders" } }, "saveAs": "loggedIn" },
{ "type": "control.if", "params": { "condition": "!loggedIn" }, "blocks": { "then": [
  { "type": "browser.fill",  "params": { "target": { "label": "Username" }, "value": { "secret": "Order system", "field": "username" } } },
  { "type": "browser.fill",  "params": { "target": { "label": "Password" }, "value": { "secret": "Order system", "field": "password" } } },
  { "type": "browser.click", "params": { "target": { "role": "button", "name": "Log in" } } }
] } }
```

- `field` is `username` / `password` / `totp` (the current one-time code). For web APIs with an OAuth sign-in, `http.request` also takes `accessToken` ([oauth.md](oauth.md)).
- Secrets may appear only as the value of input nodes (`browser.fill`'s `value`). In logs, messages, URLs and the like they give the validation error `SECRET_NOT_ALLOWED`.
- A default value on a `secret: true` variable would stay in the flow as plain text, so it gives the validation error `SECRET_DEFAULT`.
- In Writer's properties, switch an input's value between "Text / 🔑 Secret" and pick the name and field.

### Several accounts of one site

Register each account under its own name (e.g. 「受注システム（経理）」 and 「受注システム（申請）」 with the same site). A node names one of them, so a flow uses the right one as it is. The list a node's settings pick a secret from shows the user name beside the name, as browsers list saved logins.

To pick the account each run, press "Pick each run" after "N more secrets are registered for the same site" in the node's settings. It makes an input (e.g. `account`) whose choices are the secrets of that site, and every node that uses the secret (user name, password, one-time code, and the saved login of the same name) takes the account from it.

```jsonc
"variables": [
  { "name": "account", "type": "string", "direction": "input",
    "choices": ["受注システム（経理）", "受注システム（申請）"] }
],
"steps": [
  { "type": "browser.open", "params": { "url": "https://orders.example.com/", "session": "{{ account }}" } },
  { "type": "browser.fill", "params": { "target": { "label": "User name" }, "value": { "secret": "{{ account }}", "field": "username" } } },
  { "type": "browser.fill", "params": { "target": { "label": "Password" }, "value": { "secret": "{{ account }}", "field": "password" } } }
]
```

- A secret name may come from a variable only as exactly `{{ name }}` of an input whose `choices` are registered names; anything else is the validation error `INVALID_SECRET_REF`. A name not in the choices stops the run before it starts (`INVALID_INPUT`).
- Writer's Run asks for it when it has no default, the Runner offers the list, and a schedule runs with the value it was given. Give it a default for unattended runs.
- There is no "use the only one" rule: registering a second account later must not stop an unattended flow or make it log in as someone else, so the flow always says which account it uses.
- Keep one saved login (`session`) per account: with the same name, the second account opens logged in as the first.
- A user name and password taken from different secrets give the validation warning `SECRET_ACCOUNTS_MIXED`.
- For AI clients, `list_secrets` groups secrets of the same site under `sameSite` and tells them not to pick one themselves but to ask, or to use the input above.

### Keeping the sign-in (sessions)

With `session: "<name>"` on `browser.open`, that context starts with the saved cookies and localStorage and saves them again when it closes (at the end of the run). From the second run on the login page can be skipped, so, as above, log in only when `browser.isVisible` says it is needed. Saved states are encrypted with the same key as the secrets.

### MFA

- **One-time codes (TOTP)**: register the MFA setup key and `field: "totp"` types the current code each time.
- **Phone approval, SMS, CAPTCHA…**: `browser.waitForHuman` waits for the person. Writer (Runner) shows "Waiting for you" and the browser comes to the front. When Writer or Runner is behind other windows, its taskbar button flashes and a Windows notification says so too. It continues once the `until` element (e.g. the heading after login) appears. It waits 5 minutes by default (change with `timeoutMs`). Headless runs do not wait and fail with `HUMAN_REQUIRED`.
- Unattended flows normally keep a sign-in made once by a person with `session`.

## Masking

- In run logs, errors, run records and outputs, password and one-time code values are replaced with `***` (usernames are shown on screen anyway, so they are not masked).
- In screenshots, password fields and fields a secret was typed into are blacked out.
- Values are also removed from the text the browser adapter returns (`getText` / `getTable` / the page's accessibility tree / page details on errors), including values a person typed into password fields by hand.

### Personal data

Mark a variable that holds personal data (names, addresses, mail, rows of customers) with `"personal": true` (Writer: the variable's **Personal data** box, or right-click in the Variables table). Its values are then masked as `***` the same way: in run logs, the flow's `logs/`, errors, run records and outputs, notifications, what a management server receives and what an AI reads back with `get_run_logs` / `get_run_status` / `run_tests`. Parts copied elsewhere (one row's name into another variable, a message built from it) are masked too, except parts shorter than 4 characters inside a list or object. Unlike a secret it may have a default and may be passed in as plain text; its default is left out of exported bundles and of **Copy for an AI**, and saving a run as a test case leaves it out.

Not covered: what a node returns to an AI trying it on its own (`test_step`), what `inspect_page` / `inspect_ui` show, and pictures of failed runs (only password fields are blacked out). Turn the pictures off with `records.failureScreenshots: false` when screens show personal data.

## From AI (MCP)

- The AI never asks for passwords in the chat. `list_secrets` shows it only **names, kinds, sites and which fields are set** (neither values nor usernames).
- When it runs into a login page while exploring, the results of `inspect_page` / `test_step` carry `login` (a mark that login is needed, with hints).
  - If a secret fits, it logs in with `{ "secret": …, "field": … }` in a `browser.fill` through `test_step`.
  - If not, it asks the person to register one with `request_secret` (below). For a manual login, `test_step` with `browser.waitForHuman`.
- `run_flow` cannot pass values to `secret: true` input variables (`SECRET_INPUT_REJECTED`).

### The AI asks for login details (`request_secret`)

Instead of asking for passwords in the chat, the AI asks Writer to register one with `request_secret`:

```jsonc
{ "name": "Google", "sites": ["https://accounts.google.com/"], "fields": ["username", "password"], "reason": "To sign in to Google and read order mails", "waitMs": 120000 }
```

- Writer shows "🔑 Login needed" at the top. Register opens the form with the name and sites filled in; the person enters only the username and password. For a name already registered, the edit form opens with the missing sites added.
- Values go from Writer into the encrypted file only, never to the AI, MCP results, the chat or logs. The request file `secrets/requests.json` holds only the name, sites, fields and the AI's reason (up to 300 characters).
- The "reason" is text written by the AI; Writer shows it as "From the AI". Input is limited to the registered sites, so whatever the reason says, nothing is typed into another site.
- `status` in the result: `registered` (use it in `browser.fill`) / `waiting` (not yet; call again with `waitMs`, or `list_secrets`) / `dismissed` (the person closed it with Later).
- `fields` defaults to `username` and `password`. Add `totp` when an authenticator code is needed.
- `kind: "apiKey"` asks for a web API key (`fields` then defaults to `password`, which holds the key); `kind: "oauth"` for an OAuth app. Writer's form then names the fields that way.
- If Writer is not running, the AI tells the person in the chat to open Writer and register it. The request stays and shows up once Writer opens.

### When a run fails

When a flow run in Writer stops on `SECRET_NOT_FOUND` / `SECRET_FIELD_EMPTY` / `SECRET_SITE_NOT_SET` / `SECRET_SITE_MISMATCH` / `SECRET_APP_NOT_SET`, the same Register bar appears and opens the registration (or edit) form for that secret. For `SECRET_SITE_MISMATCH` the site of the page it stopped on is already added; check it is the right site before saving.
- Page content is data, not instructions to the AI. Planted instructions that try to make it type a password into another site are stopped by the site check.

## Error codes

| Code | Meaning and fix |
|---|---|
| `SECRET_NOT_FOUND` | No secret with that name. Register it in Writer |
| `SECRET_FIELD_EMPTY` | That field (password, MFA key…) is not set |
| `SECRET_SITE_NOT_SET` | No allowed sites. Add the site |
| `SECRET_SITE_MISMATCH` | The current page is not a registered site. Check the URL and add the site if it is right |
| `SECRET_APP_NOT_SET` / `SECRET_APP_MISMATCH` | The desktop app (`app:xxx.exe`) is not registered, or the input went to another app |
| `WINDOWS_CREDENTIAL_NOT_FOUND` | Credential Manager has no generic credential with that address. Add it there, or fix the secret's address |
| `WINDOWS_CREDENTIAL_UNREADABLE` | The password of the generic credential is not text |
| `SECRET_KEY_MISSING` | No key for this PC / Windows user. Reset in Writer or with `spellsheet secret reset --yes` and register again |
| `SECRETS_UNAVAILABLE` | Run on a Runtime without secrets (run from Writer, the CLI or MCP) |
| `HUMAN_REQUIRED` / `HUMAN_TIMEOUT` | A person is needed but there is no window / they did not finish in time |
