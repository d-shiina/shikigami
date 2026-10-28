# Releases and online updates

English | [日本語](ja/release.md)

The installed Studio checks for a new version at startup and updates with "Update and restart" from the version menu at the bottom right. It uses the official Tauri updater.

- Distribution: this repository's GitHub Releases (`latest.json` and the installers)
- Checked at: `https://github.com/d-shiina/shikigami/releases/latest/download/latest.json`
- Tamper protection: installers are signed with a dedicated signing key, and Studio verifies them with the public key embedded at release time before replacing itself
- Installer: NSIS (per user, no administrator rights). An MSI is also on Releases, but automatic updates use the NSIS one
- Development builds (`pnpm studio:dev`) do not check

## The CLI (MCP server) is updated too

The release installer puts `shikigami.exe` (CLI and MCP server) in the same folder as Studio. Register this `shikigami.exe` with Claude Code and the MCP server is updated with every Studio update, at the same path. Copy the registration command from the version menu at the bottom right of Studio.

```powershell
claude mcp add --scope user shikigami -- "<install folder>\shikigami.exe" mcp
```

Updating works even while Claude Code runs the MCP server. Windows cannot overwrite a running exe but can rename it, so right before starting the installer Studio renames `shikigami.exe` to `shikigami-<old version>.exe.old` (and the bundled `node\node.exe` to `node-<old version>.exe.old`). The running server keeps going on the old file, and the next start uses the new version (in Claude Code, reconnect from `/mcp`). Leftover `.old` files are removed the next time Studio starts. If the installation is cancelled, the file is put back.

When developing from the repository with `target\debug\shikigami.exe` registered, `cargo build -p shikigami-cli` keeps updating it as before.

## One-time setup

In the repository folder, run:

```powershell
pnpm release:setup
```

It creates a signing key (without a password) at `~\.tauri\shikigami.key` and registers it with GitHub:

- Private key → Actions secret `TAURI_SIGNING_PRIVATE_KEY`
- Public key → Actions variable `TAURI_UPDATER_PUBKEY` (the release workflow embeds it in the app)

If the GitHub CLI (`gh`) is signed in, this happens automatically. Without `gh`, the value is put on the clipboard and the registration page opens; paste and save (twice).

**If the private key is lost, installed copies of Studio can no longer receive updates.** Back up `shikigami.key`. To protect the key with a password, create it yourself and also register `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as a secret.

## Releasing

1. Turn "Unreleased" in [CHANGELOG.md](../CHANGELOG.md) into a heading with the version and date (breaking changes and deprecations: [compatibility.md](compatibility.md) §9)
1. Raise `version` under `[workspace.package]` in the root `Cargo.toml` (this one place sets the version of Studio, the CLI and the MCP server). Run `cargo check` to update `Cargo.lock`, and commit
2. Push a tag with the same version

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The `Release` workflow (`.github/workflows/release.yml`) builds on Windows and publishes the release. It stops if the tag and the `Cargo.toml` version differ

Once published, installed copies of Studio find the update the next time they start.

## Building a release locally

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $HOME\.tauri\shikigami.key
pnpm studio:release
```

The public key is read from `~\.tauri\shikigami.key.pub`.

`pnpm studio:build` is a trial build that neither bundles the CLI and Node.js nor signs.

## Bundling Node.js and the browser adapter

So that browser automation and Node plugins work on PCs without Node.js (including company PCs where it cannot be installed), the installer puts the following in Studio's folder.

| Folder | Contents |
|---|---|
| `node\` | `node.exe` and the Node.js license (no npm etc.) |
| `browser-adapter\` | The browser adapter (`src\*.ts`) and `playwright-core` |

- `pnpm studio:bundle-node` (`apps/studio/scripts/bundle-node.mjs`) downloads the official Windows zip from nodejs.org, checks it against the SHA-256 written in the script, and places it in `apps/studio/src-tauri/bundled/`. Downloads are cached in `target/node-dist/`. On Windows it also checks that the adapter starts with the placed Node.js
- The Node.js version is pinned to an LTS (currently 24.22.1). To raise it, change the script's `NODE_VERSION` and `NODE_SHA256` (the `win-x64.zip` / `win-arm64.zip` lines of that version's `SHASUMS256.txt`) together
- No browser is bundled. Playwright uses the Edge that comes with Windows
- Node.js is looked up in the order `SHIKIGAMI_NODE` → `node\node.exe` next to the executable → `node` on PATH. Development builds have no `node\` next to them, so they use Node.js on PATH as before
- The installer grows by a few tens of MB (`node.exe` is about 90 MB, about a third of that compressed)

## Notes

- Installers are not code-signed (Authenticode), so the first installation shows a SmartScreen warning. Updates happen inside Studio and show none
- The first version with the updater has to be installed by hand from Releases
