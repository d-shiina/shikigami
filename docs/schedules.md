# Schedules and the worker

English | [日本語](ja/schedules.md)

SpellSheet starts flows by itself: every morning at 8, on the 25th of each month, every 30 minutes during working hours, or when a file is put in a folder. Windows Task Scheduler is not needed.

## The worker

The **worker** is one process per PC (per Windows user and workspace) that fires the schedules and runs them. It needs neither Writer nor an AI.

In Writer, **Automation** in the sidebar shows whether the worker is running and what it is running, and **Turn on automation** starts it (registered to start at every sign-in, as `worker install` does). Schedules are added, edited and switched on and off on the same page. The flow inspector's **Schedules** section lists the flow's own.

```powershell
spellsheet worker install     # start it whenever you sign in to Windows (and now)
spellsheet worker status      # is it running, what is it running, what comes next
spellsheet worker stop
spellsheet worker run         # run it in this window instead (Ctrl+C stops)
spellsheet worker uninstall
```

`worker install` registers the Task Scheduler task `SpellSheet\Worker` for your user ("at log on" of your user only, with no time limit; no administrator rights needed), so the worker runs in your signed-in desktop session, where it can use the mouse and keyboard. Where Task Scheduler refuses the task (some PCs let only administrators add tasks), it is registered under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` as `SpellSheet Worker` instead; `worker uninstall` removes either. A second worker for the same workspace refuses to start.

- Runs the worker starts are **unattended runs**: they execute the published version (and `flows.<id>.unattended: false` in `policy.json` refuses them), exactly as `spellsheet run <id>`. A flow that is not published fails with `NOT_PUBLISHED`.
- They are recorded like any run, with `origin.trigger: "schedule"`, `origin.requestedBy` the schedule's name and `origin.jobId` its ID.
- The mouse and keyboard are shared with Writer, the CLI and the MCP server: nodes that use them take turns across processes. While the screen is locked they stop with `DESKTOP_UNAVAILABLE` (browser and file work still runs). While a flow with such nodes runs, the display is kept on and the PC awake, so it does not turn off or sleep. Locking is not prevented: a password-protected screen saver, an inactivity limit set by policy, or Win+L still stops them. Keep the PC signed in and unlocked when desktop flows are due. In Writer's 「自動実行」, a schedule whose flow uses the mouse and keyboard says so when this PC locks by itself after a while without input.
- Other processes talk to the worker over a local named pipe that only your user can write to (`\\.\pipe\spellsheet-agent-…`).

### Screen lock and Remote Desktop

Nodes that use the mouse and keyboard cannot run while the screen is locked (Windows does not let input reach a locked screen). On a PC that cannot be kept unlocked (see [design/locked-runs.md](design/locked-runs.md), in Japanese):

- `spellsheet session status`: whether the screen takes input now, whether this is a Remote Desktop session, and after how many minutes without input the PC locks.
- **A VM or PC you look at over Remote Desktop**: closing the window disconnects and locks the session. Disconnect with 「画面を残して切断」 in Writer's 「自動実行」, or `spellsheet session release`, instead: the session is not locked and desktop flows keep running (it uses `tscon`; Windows may ask for an administrator). A monitor plugged into the PC shows the screen to anyone in front of it.
- **Minimizing the Remote Desktop window stops drawing**: on the PC you connect from, run `reg add "HKCU\Software\Microsoft\Terminal Server Client" /v RemoteDesktop_SuppressWhenMinimized /t REG_DWORD /d 2 /f` once.

## Schedules

Schedules belong to the PC that runs them (`schedules.json` in the per-PC area of the workspace, next to the run records). When several PCs share a workspace folder, only the PC a schedule was made on runs it.

```powershell
spellsheet schedule add scn_01a1… --name "毎朝の受注取り込み" --daily 08:00 --days mon,tue,wed,thu,fri
spellsheet schedule add scn_01a1… --monthly 25@09:00          # -1@18:00 is the last day of the month
spellsheet schedule add scn_01a1… --monthly 25@09:00 --on-holiday before   # the business day before on holidays
spellsheet schedule add scn_01a1… --monthly 3@09:00 --business-day        # the third business day (-1: the last)
spellsheet schedule add scn_01a1… --daily 08:00 --days mon,tue,wed,thu,fri --skip-holidays
spellsheet schedule add scn_01a1… --every 30 --from 09:00 --to 18:00
spellsheet schedule add scn_01a1… --once 2026-11-07T08:00
spellsheet schedule add scn_01a1… --file-added input --pattern "*.xlsx" --file-input file
spellsheet schedule add scn_01a1… --mail-received Inbox --subject-contains Invoice --mail-input mail
spellsheet schedule list
spellsheet schedule disable sch_…   # enable / remove
```

`-i NAME=VALUE` sets input variables, as with `spellsheet run`.

| `when.kind` | Fields | Fires |
|---|---|---|
| `daily` | `at` ("08:00"), `days` (optional: "mon" … "sun", or 月 … 日), `skipHolidays` (optional) | Every day (or on those days) at that time |
| `monthly` | `day` (1–31, -1 = last day), `at`, `businessDay` (optional), `onHoliday` (optional) | Every month. A day the month lacks (31 in June) is its last day |
| `every` | `minutes`, `from` / `to` (optional), `days` (optional), `skipHolidays` (optional) | `from`, `from` + `minutes`, … up to `to` (the whole day without them) |
| `once` | `at` ("2026-11-07T08:00") | Once |
| `fileAdded` | `folder` (relative to the flow's folder, or a full path), `pattern` ("*.xlsx"), `input` (optional) | Once per new file whose name matches, after its size stops changing. Its full path goes into the input variable `input`. Files already there when the worker starts, Office lock files (`~$…`) and partial downloads do not count |
| `mailReceived` | `folder` (optional, default the Inbox), `subjectContains` / `fromContains` (optional), `minutes` (how often to look, default 5), `via` / `account` (optional, as for `mail.list`), `input` (optional) | Once per new mail that matches. The mail (`{ id, subject, from, fromAddress, receivedAt, attachments }`) goes into the input variable `input`. Mails already there when the worker starts do not count |

```json
{
  "formatVersion": 1,
  "schedules": [
    {
      "id": "sch_01a1…",
      "name": "毎朝の受注取り込み",
      "flowId": "scn_01a1…",
      "enabled": true,
      "when": { "kind": "daily", "at": "08:00", "days": ["mon", "tue", "wed", "thu", "fri"] },
      "inputs": {}
    }
  ]
}
```

### When a mail arrives

`mailReceived` looks at the folder with `mail.list` every `minutes` minutes and starts the flow for each mail that was not there at the last look. It uses this PC's Outlook (classic), so keep Outlook started and signed in. PCs without Outlook and shared work mailboxes are looked at with `via: "microsoft365"` and `account` ([office.md](office.md), "A Microsoft 365 mailbox without Outlook").

- With the mail's `id` from the input variable, the flow can save its attachments (`mail.saveAttachments`), move it (`mail.move`) or reply (`mail.reply`). Moving handled mail or marking it read keeps the inbox easy to read
- When it cannot look (Outlook not started, the sign-in expired), `worker status` shows why on that schedule, and it looks again next time
- Mail that arrives while the worker is off is there when it starts, and does not count

```json
{ "kind": "mailReceived", "folder": "Inbox", "subjectContains": "Invoice", "minutes": 5, "input": "mail" }
```

### Holidays and business days

- `skipHolidays: true` (`daily`, `every`): not on Japan's national holidays (with substitute holidays and days between two) or the company's days off. The company's working days run even on days not in `days` (a Saturday)
- `businessDay: true` (`monthly`): `day` counts business days. `3` is the third business day, `-1` the last (`-2` the one before). Business days are the days that are not weekends, holidays or company days off, and the company's working days
- `onHoliday` (`monthly`, calendar days): when the day is not a business day, `before` runs on the business day before, `after` on the one after, `skip` not that month. For example, payments on the 25th, or the business day before

The company's days off and working days go in the workspace's `holidays.json` (the same on every PC that shares the workspace folder).

```json
{
  "formatVersion": 1,
  "holidays": ["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-02", "2027-01-03"],
  "workdays": ["2026-11-28"]
}
```

Japan's national holidays are built in (the law since 2020; the equinoxes are calculated). A `holidays.json` that cannot be read is not guessed at: no schedule fires until it is fixed (`HOLIDAYS_INVALID`).

Times are the PC's local time. The worker reads the file again when it changes. A broken file is not guessed at: `worker status` shows the problem and no schedule fires until it is fixed (`SCHEDULE_INVALID`).

- **Missed times are not made up for.** A time that passes while the worker is off (the PC was off, nobody signed in) is skipped; the schedule fires at its next time.
- **One at a time.** When a timed schedule comes round while its previous run is still going, that time is skipped. A file trigger starts one run per file.
- A schedule that cannot start (not published, refused by the policy) counts as a failed run for notifications.

## Notifications

`notify` in `policy.json` tells people how unattended runs ended: runs the worker starts and `spellsheet run` (Task Scheduler, batch files). Runs in Writer and the AI's trial runs are watched by a person and are not reported. Flows do not need to send mail in a `catch` for this.

```json
"notify": [
  { "webhook": "https://….logic.azure.com/workflows/…", "format": "teams" },
  { "webhook": "https://hooks.slack.com/services/…", "format": "slack", "on": ["failed", "succeeded"], "flows": ["scn_01a1…"] }
]
```

| Field | Default | Meaning |
|---|---|---|
| `webhook` | (required) | Where to post. `https://` (`http://` only for `localhost`). Anyone with the URL can post there: treat it like a password |
| `on` | `["failed"]` | Which endings: `failed`, `succeeded`, `cancelled`. With `waiting`, also when a run **starts waiting for a person** (a sign-in in the browser, a dialog): once per wait; if nobody comes in time, it fails and `failed` reports it |
| `format` | `teams` | `teams`: a card for a Teams "Workflows" webhook (or Power Automate's "When a HTTP request is received", which can also send mail). `slack`: `{ "text": … }` for Slack and similar tools. `json`: the run's summary for your own systems |
| `flows` | all | Only these flow IDs |

The message says which flow, the error (code, message, node), what started it (the schedule's name), the PC, the times, the version and the run ID. Output values are never sent. A schedule that cannot start (not published, refused by the policy) is reported as failed. A notification that cannot be sent is logged and changes nothing about the run.
