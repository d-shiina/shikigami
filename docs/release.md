# Releases and online updates

English | [日本語](ja/release.md)

The installed Writer updates itself the way VS Code does. It checks for a new version at startup (or with "Check again" in Settings), downloads it in the background, and installs it silently with no installer window: either when you press "Restart to update" in Settings (Writer opens again as the new version a few seconds later) or when you close Writer (the next launch is the new version). The version at the bottom right turns blue while an update waits. It uses the official Tauri updater (`installMode: quiet`).

- Distribution: this repository's GitHub Releases (`latest.json` and the installers)
- Checked at: `https://github.com/spellsheet/spellsheet/releases/latest/download/latest.json`
- Versions up to 0.1.20 check the old address `https://github.com/d-shiina/spellsheet/...` and reach the new one through GitHub's redirect for moved repositories. Never create a repository named `spellsheet` under `d-shiina`: the redirect would stop and those versions could no longer update
- Tamper protection: installers are signed with a dedicated signing key, and Writer verifies them with the public key embedded at release time before replacing itself
- Installer: NSIS (per user, no administrator rights).
- Development builds (`pnpm studio:dev`) do not check

## The CLI (MCP server) is updated too

The release installer puts `spellsheet.exe` (CLI and MCP server) in the same folder as Writer. Register this `spellsheet.exe` with Claude Code and the MCP server is updated with every Writer update, at the same path. Copy the registration command from the version menu at the bottom right of Writer.

```powershell
claude mcp add --scope user spellsheet -- "<install folder>\spellsheet.exe" mcp
```

Updating works even while Claude Code runs the MCP server. Windows cannot overwrite a running exe but can rename it, so right before starting the installer Writer renames `spellsheet.exe` to `spellsheet-<old version>.exe.old` (and the bundled `node\node.exe` to `node-<old version>.exe.old`). The running server keeps going on the old file, and the next start uses the new version (in Claude Code, reconnect from `/mcp`). Leftover `.old` files are removed the next time Writer starts. If the installation is cancelled, the file is put back.

When developing from the repository with `target\debug\spellsheet.exe` registered, `cargo build -p spellsheet-cli` keeps updating it as before.

## One-time setup

In the repository folder, run:

```powershell
pnpm release:setup
```

It creates a signing key (without a password) at `~\.tauri\spellsheet.key` and registers it with GitHub:

- Private key → Actions secret `TAURI_SIGNING_PRIVATE_KEY`
- Public key → Actions variable `TAURI_UPDATER_PUBKEY` (the release workflow embeds it in the app)

If the GitHub CLI (`gh`) is signed in, this happens automatically. Without `gh`, the value is put on the clipboard and the registration page opens; paste and save (twice).

**If the private key is lost, installed copies of Writer can no longer receive updates.** Back up `spellsheet.key`. To protect the key with a password, create it yourself and also register `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as a secret.

## Releasing

1. Turn "Unreleased" in [CHANGELOG.md](../CHANGELOG.md) into a heading with the version and date (breaking changes and deprecations: [compatibility.md](compatibility.md) §9)
1. Raise `version` under `[workspace.package]` in the root `Cargo.toml` (this one place sets the version of Writer, the CLI and the MCP server). Run `cargo check` to update `Cargo.lock`, and commit
2. Push a tag with the same version

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

   Or, without a terminal: on GitHub, open **Actions → Release → Run workflow** (branch `main`). It tags the current `main` with the `Cargo.toml` version and releases it; it stops if that tag is already on another commit
3. The `Release` workflow (`.github/workflows/release.yml`) builds on Windows and publishes the release. It stops if the tag and the `Cargo.toml` version differ, or if the signing key is not registered (one-time setup above)
   - Release notes are the `CHANGELOG.md` section whose heading has the version (for example `## [0.2.0] - 2026-11-06`); without one they link to `CHANGELOG.md`
   - A version with a hyphen (`0.2.0-beta.1`) becomes a pre-release, which installed copies of SpellSheet Writer do not update to
   - The installers are also kept on the run page as the `installers-<version>` artifact for 14 days

A pull request that changes the release build (the workflow, `apps/studio/scripts/`, the Tauri configuration) runs the same build as a trial: it publishes nothing and leaves the installers on the run page, so they can be installed by hand before tagging. Without the signing key it signs with a throwaway key.

Once published, installed copies of Writer find the update the next time they start.

## Product site (GitHub Pages)

`site/` is the product page and the download page (Japanese, plain HTML with no build step), published at https://spellsheet.github.io/ by the [spellsheet/spellsheet.github.io](https://github.com/spellsheet/spellsheet.github.io) repository. Its workflow checks this repository every 15 minutes and publishes again when `site/`, the manual or the latest release has changed (run its Deploy workflow by hand to publish at once). It writes `release.json` with the newest installer so the download button points at that `SpellSheet.Writer_<version>_x64-setup.exe`; the page also asks the GitHub API for the latest release and falls back to the release page. This repository's own page, the old address https://spellsheet.github.io/spellsheet/, only redirects there (`.github/workflows/pages.yml`, `site-moved/`).

## Building a release locally

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $HOME\.tauri\spellsheet.key
pnpm studio:release
```

The public key is read from `~\.tauri\spellsheet.key.pub`.

`pnpm studio:build` is a trial build that neither bundles the CLI and Node.js nor signs.

## Bundling Node.js and the browser adapter

So that browser automation and Node plugins work on PCs without Node.js (including company PCs where it cannot be installed), the installer puts the following in Writer's folder.

| Folder | Contents |
|---|---|
| `node\` | `node.exe` and the Node.js license (no npm etc.) |
| `browser-adapter\` | The browser adapter (`src\*.ts`) and `playwright-core` |

- `pnpm studio:bundle-node` (`apps/studio/scripts/bundle-node.mjs`) downloads the official Windows zip from nodejs.org, checks it against the SHA-256 written in the script, and places it in `apps/studio/src-tauri/bundled/`. Downloads are cached in `target/node-dist/`. On Windows it also checks that the adapter starts with the placed Node.js
- The Node.js version is pinned to an LTS (currently 24.22.1). To raise it, change the script's `NODE_VERSION` and `NODE_SHA256` (the `win-x64.zip` / `win-arm64.zip` lines of that version's `SHASUMS256.txt`) together
- No browser is bundled. Playwright uses the Edge that comes with Windows
- Node.js is looked up in the order `SPELLSHEET_NODE` → `node\node.exe` next to the executable → `node` on PATH. Development builds have no `node\` next to them, so they use Node.js on PATH as before
- The installer grows by a few tens of MB (`node.exe` is about 90 MB, about a third of that compressed)

## Notes

- Installers are not code-signed (Authenticode), so the first installation shows a SmartScreen warning. Updates happen inside Writer and show none
- The first version with the updater has to be installed by hand from Releases
