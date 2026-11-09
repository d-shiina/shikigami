# Management server

English | [日本語](ja/remote.md)

A management server hands jobs to the workers of many PCs: "run this flow on whichever PC is free", and see how it went. The PCs only ever connect **out** (HTTPS); no port is opened on them, so they work behind proxies and firewalls. The design notes are in [design/remote-runs.md](design/remote-runs.md) (Japanese).

SpellSheet comes with a small **reference server** (`spellsheet manager serve`) that speaks the protocol below. It keeps its state in one JSON file and has an admin API but no web pages: it is for trying things out, tests and small teams on a LAN. A full management tool can be built on the same protocol.

## How it works

1. On the server you make a **one-time enrollment code**.
2. On the PC, `spellsheet worker enroll <server URL> <code>`. The worker makes its own Ed25519 key pair, sends only the public key, and keeps the private key in Windows Credential Manager. From then on every request it makes is signed.
3. In the workspace's `policy.json`, the PC says what the server may do:

   ```json
   "remote": {
     "enabled": true,
     "manager": "https://manager.example.co.jp",
     "flows": ["scn_01a1…"]
   }
   ```

4. The worker (`spellsheet worker install`, or **Turn on automation** in Writer's Automation) asks the server for work **only while it has nothing running**, offering the flows `remote.flows` allows that have a published version here. The server hands it a job that fits, if there is one.
5. The worker runs the job like any unattended run: the **published version**, `policy.json`'s sites, apps and `unattended` rules, secrets from this PC's vault. The record's `origin` says `trigger: "remote"`, `requestedBy` (who asked on the server) and `jobId`. Events go to the server every 2 seconds and the report at the end; a run started while the server is unreachable still finishes and is reported when it is back.
6. A job cancelled on the server is cancelled on the PC at its next check-in (`finally` still runs).

The PC has the last word. Whatever the server asks, it cannot run a flow `policy.json` does not allow (`REMOTE_NOT_ALLOWED`), an unpublished one (`NOT_PUBLISHED`), or another version than the one the job names (`VERSION_MISMATCH`); those jobs come back to the server as **rejected**. Secrets never leave the PC: a job carries input values, not passwords.

```powershell
spellsheet worker enroll https://manager.example.co.jp 3f9a1c0d2b7e4a55
spellsheet worker status        # shows the server, the worker ID and any problem
spellsheet worker unenroll
```

## The reference server

```powershell
spellsheet manager serve --listen 127.0.0.1:8740 --data C:\shikigami-manager
```

`--data` holds `state.json` (workers, jobs and their logs) and `admin-token`, made on first start. It listens on plain HTTP: anything beyond the PC itself goes through a reverse proxy with HTTPS (the worker refuses `http://` except for `localhost`).

Admin API (`Authorization: Bearer <admin-token>`):

| Request | What it does |
|---|---|
| `POST /admin/enrollment-codes` | A one-time code, valid for an hour: `{ "code", "expiresAt" }` |
| `GET /admin/workers` | Enrolled PCs: machine, user, workspace, last seen |
| `DELETE /admin/workers/{id}` | Remove a PC; its signed requests are refused from then on |
| `POST /admin/jobs` | Queue a job: `{ "flowId", "inputs"?, "versionUid"?, "worker"?, "requestedBy"? }`. `worker` pins it to one PC; otherwise the first free PC that can run it takes it |
| `GET /admin/jobs` | Jobs, newest first (without logs) |
| `GET /admin/jobs/{id}` | One job with its events and report |
| `POST /admin/jobs/{id}/cancel` | Cancel: a queued job at once, a running one at the PC's next check-in |

```powershell
$h = @{ Authorization = "Bearer $(Get-Content C:\shikigami-manager\admin-token)" }
Invoke-RestMethod -Method Post -Headers $h http://127.0.0.1:8740/admin/enrollment-codes
Invoke-RestMethod -Method Post -Headers $h -ContentType application/json `
  -Body '{"flowId":"scn_01a1…","inputs":{"month":"2026-11"},"requestedBy":"dana"}' `
  http://127.0.0.1:8740/admin/jobs
```

Job states: `queued` → `leased` (handed to a PC) → `running` → `succeeded` / `failed` / `cancelled`, or `rejected` (the PC refused it) or `lost` (the PC stopped answering while it ran; it is not started again, since part of it may have run). A leased job the PC does not start within 60 seconds goes back to the queue; a PC that cannot get its start through to the server in that time cancels the run, so a job never runs on two PCs at once. Cancelling a leased job tells the PC holding it to stop at its next check-in.

## Protocol v1

All requests are `POST` with a JSON body, under `/v1`. After enrollment each carries three headers:

| Header | Value |
|---|---|
| `X-Shikigami-Worker` | The worker ID from enrollment |
| `X-Shikigami-Time` | Unix time in seconds; the server refuses more than 5 minutes off its clock |
| `X-Shikigami-Signature` | Base64 Ed25519 signature of `shikigami-v1\n{METHOD}\n{path}\n{time}\n{hex SHA-256 of the body}` |

| Path | Body → answer |
|---|---|
| `/v1/enroll` (not signed) | `{ code, publicKey, machine, user, workspace }` → `{ workerId }` |
| `/v1/jobs/claim` | `{ flows: [{ flowId, name, versionUid }], desktop?, waitSecs }` → a job `{ id, flowId, versionUid?, inputs, requestedBy?, leaseSecs }`, or `204` when nothing came within `waitSecs` (long polling) |
| `/v1/jobs/{id}/started` | `{ runId }` → `204` |
| `/v1/jobs/{id}/rejected` | `{ error: { code, message } }` → `204` |
| `/v1/jobs/{id}/events` | `{ events: [RunEventEnvelope…] }` (from the last `seq` the server has; repeats are ignored) → `{ cancel }` |
| `/v1/jobs/{id}/heartbeat` | `{}` → `{ cancel }`. Events and heartbeats keep a running job's lease |
| `/v1/jobs/{id}/finished` | `{ report: RunReport }` → `204` |

Errors are `{ code, message }` with an HTTP status. Events and reports are the same as in `runs/<run-id>/` (secrets masked); screenshots are not sent.

## Limits

- Bundles (`remote.acceptBundles`) are not sent yet: jobs run the published versions in the PC's workspace.
- One job at a time per PC, and only while nothing else runs there.
- The reference server keeps everything in memory and one file, with no accounts beyond the admin token.
