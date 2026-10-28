<p align="center">
  <img src="docs/assets/mark.png" alt="Shikigami" width="160">
</p>

# Shikigami

English | [日本語](README.ja.md)

MCP-native desktop RPA where AI and humans build, edit, and run the same automation scenarios.

Shikigami is a local-first RPA platform where AI clients (Claude Code, Codex, Cursor and others) and people create, edit, run and maintain **the same scenarios**. AI builds them; finished scenarios run without AI and without a GUI. The target OS is **Windows 10/11 (x64)**.

![Shikigami Studio (Phase 1)](docs/assets/studio-phase1.png)

## Status

**Phase 1 (foundation) and Phase 2 (MCP server) are done.** Scenario Core, Runtime, CLI, Studio (Tauri 2 + React) and the MCP server work. Browser automation (Phase 3) works too ([docs/browser.md](docs/browser.md); try `pnpm demo:browser`). Windows desktop apps (Phase 4) are automated through UI Automation ([docs/desktop.md](docs/desktop.md)). Excel workbooks are read and written directly, without Excel ([docs/office.md](docs/office.md)). Details: [architecture §13](docs/architecture.md#13-implementation-status-and-limits).

Studio's UI is available in English and Japanese (JA / EN switch in the status bar; it follows the OS language until you choose).

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System layout, scenario format, adapter / MCP / IPC / DB / error / security design, design decisions, MVP acceptance criteria |
| [docs/mcp.md](docs/mcp.md) | Connecting the MCP server (Claude Code / Codex / Cursor), tool list, audit log, limits |
| [docs/expressions.md](docs/expressions.md) | Functions available in scenario expressions |
| [docs/browser.md](docs/browser.md), [docs/desktop.md](docs/desktop.md), [docs/office.md](docs/office.md), [docs/files.md](docs/files.md), [docs/system.md](docs/system.md) | Built-in steps: browser, Windows apps, Excel, files, HTTP / programs / clipboard / dialogs |
| [docs/secrets.md](docs/secrets.md) | Logins: secrets the AI refers to by name only |
| [docs/adapters.md](docs/adapters.md) | Where each step type comes from, and node plugins |
| [docs/release.md](docs/release.md) | Installer, updates and release signing |
| [docs/design/plugins.md](docs/design/plugins.md) (Japanese) | Node plugins: add steps for in-house systems without rebuilding Shikigami (manifest + separate process) |
| [docs/research.md](docs/research.md) (Japanese) | Versions, licenses and Windows support of the libraries used |

The design notes under `docs/design/` and `docs/research.md` are in Japanese. Japanese versions of the guides above are in [docs/ja/](docs/ja/).

## Layout

```text
crates/shikigami-core      Scenario Core (the only source of truth for scenario data)
crates/shikigami-runtime   RPA Runtime (runs without AI or GUI)
crates/shikigami-cli       CLI (the `shikigami` command; `shikigami mcp` is the MCP server)
crates/shikigami-mcp       MCP server (rmcp)
apps/studio                Shikigami Studio (Tauri 2 + React + React Flow)
packages/schema            TypeScript types generated from Rust
plugins/shikigami          Claude Code plugin (MCP settings + skill)
schemas/                   Generated JSON Schema
examples/                  Sample scenarios
```

## Development

| Requirement | Version |
|---|---|
| Rust | 1.90 or later (MSVC toolchain on Windows) |
| Node.js | 22 LTS |
| pnpm | 10 (`corepack enable` sets it up) |

**Windows**: Visual Studio itself is not needed, but you need the "Desktop development with C++" workload of [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (it includes the Windows SDK) and WebView2 (built into Windows 10 1803 and later). Build Tools 2022 and 2026 both work. Installing them requires administrator rights (ask your administrator on a company PC). With winget:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

If you installed Rust with rustup, run `rustup default stable-msvc`. The standalone (MSVC) installer works as is, clippy and rustfmt included, as long as it is 1.90 or later.

**Linux (for core development and CI only; not a product target)**: `libwebkit2gtk-4.1-dev build-essential file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

```sh
pnpm install

# Build Studio's frontend (Tauri's build script needs dist, so after a fresh
# clone this is needed once before cargo test / cargo build)
pnpm --filter @shikigami/studio build

# Tests
cargo test --workspace
pnpm -r test

# Run a sample with the CLI (no AI, no GUI)
cargo run -p shikigami-cli -- run examples/invoice-summary.json
cargo run -p shikigami-cli -- run examples/invoice-summary.json -i threshold=10000

# Start Studio
pnpm studio:dev

# Regenerate the JSON Schema and TS types after changing Rust types
pnpm schema:generate
```

The workspace (where scenarios, history and run records are stored) defaults to `%APPDATA%\Shikigami\workspace`. Change it with the `SHIKIGAMI_HOME` environment variable or the CLI's `--workspace`.

### CLI examples

```sh
shikigami scenario import examples/invoice-summary.json
shikigami scenario list
echo '[{"op":"addStep","step":{"type":"log.message","params":{"message":"hello"}}}]' \
  | shikigami scenario edit scn_example_invoice_summary -
shikigami scenario undo scn_example_invoice_summary
shikigami run scn_example_invoice_summary --json
```

Edits made with the CLI while Studio is open show up in Studio immediately.

## Using it from AI (MCP)

In Claude Code, install the plugin (the `shikigami` command must be on PATH):

```text
/plugin install shikigami --marketplace d-shiina/shikigami
```

If you installed Studio, register the `shikigami.exe` in Studio's folder so the MCP server is updated together with Studio (copy the command from the version menu at the bottom right of Studio; see [docs/release.md](docs/release.md)).

To register only the MCP server: `claude mcp add shikigami -- shikigami mcp`. When developing from the repository without `shikigami` on PATH, register the built executable by its absolute path (`cargo build -p shikigami-cli` updates it):

```powershell
claude mcp add --scope user shikigami -- C:\path\to\shikigami\target\debug\shikigami.exe mcp
```

With this registration and the plugin both in place, the plugin's own `shikigami` server (which starts `shikigami` from PATH) fails to connect, but its skill still works.

See [docs/mcp.md](docs/mcp.md) for Codex / Cursor settings and the tool list. AI edits show up in Studio immediately and can be undone from Studio.
