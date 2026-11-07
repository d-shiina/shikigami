<p align="center">
  <img src="docs/assets/mark.png" alt="Shikigami" width="160">
</p>

# Shikigami

English | [日本語](README.ja.md)

MCP-native desktop RPA where AI and humans build, edit, and run the same automation flows.

Shikigami is a local-first RPA platform where AI clients (Claude Code, Codex, Cursor and others) and people create, edit, run and maintain **the same flows**. AI builds them; finished flows run without AI and without a GUI. The target OS is **Windows 10/11 (x64)**.

![Shikigami Studio](docs/assets/studio-phase1.png)

## Getting started

1. Download `Shikigami.Studio_<version>_x64-setup.exe` from the [latest release](https://github.com/d-shiina/shikigami/releases/latest) and run it. It installs per user, so no administrator rights are needed. Studio updates itself from then on.
2. Start **Shikigami Studio** from the Start menu. Under the flows page, "Samples" opens finished flows so you can see what they look like and how they run.
3. To have AI build flows, open "Claude Code" at the top left of Studio (Ctrl+J) and press "Install Claude Code": [Claude Code](https://claude.com/claude-code) goes into your user folder and the sign-in follows, with no terminal. Ask something like "make a flow that collects unshipped orders from the order system" and the AI adds nodes to the flow chart as it goes.
4. Check the AI's changes under "To review" in the sidebar and press "Review and publish". Published flows run without AI from Studio, from the "Shikigami Run" window, or on a schedule.

To try one task from start to finish, see the [tutorials](docs/tutorials/README.md) (about 15 minutes each, with sample files). The rest of this page is for developers.

## Status

**Phase 1 (foundation) and Phase 2 (MCP server) are done.** Flow Core, Runtime, CLI, Studio (Tauri 2 + React) and the MCP server work. Browser automation (Phase 3) works too ([docs/browser.md](docs/browser.md); try `pnpm demo:browser`). Windows desktop apps (Phase 4) are automated through UI Automation ([docs/desktop.md](docs/desktop.md)). Excel workbooks are read and written directly, without Excel ([docs/office.md](docs/office.md)). Details: [architecture §13](docs/architecture.md#13-implementation-status-and-limits).

Studio's UI is available in English and Japanese (JA / EN switch in the status bar; it follows the OS language until you choose).

| Document | Contents |
|---|---|
| [docs/tutorials/](docs/tutorials/README.md) | Tutorials: one piece of office work from the request to the AI to a monthly run (sales CSVs into Excel, invoices from an order list, a web order system) |
| [docs/architecture.md](docs/architecture.md) | System layout, flow format, adapter / MCP / IPC / DB / error / security design, design decisions, MVP acceptance criteria |
| [docs/mcp.md](docs/mcp.md) | Connecting the MCP server (Claude Code / Codex / Cursor), tool list, audit log, limits |
| [docs/ai-chat.md](docs/ai-chat.md) | Building flows with an AI chat that has no MCP (Microsoft Copilot): the guide to give it, pasting its answer into Studio, what is left for a person |
| [docs/runner.md](docs/runner.md) | The run window for the people who only run flows: published flows, a form made from the inputs, results and files |
| [docs/policy.md](docs/policy.md) | Unattended runs use only an approved, published version; allowed sites and apps; approving AI operations (`policy.json`) |
| [docs/expressions.md](docs/expressions.md) | Functions available in flow expressions |
| [docs/browser.md](docs/browser.md), [docs/desktop.md](docs/desktop.md), [docs/office.md](docs/office.md), [docs/files.md](docs/files.md), [docs/system.md](docs/system.md), [docs/pdf.md](docs/pdf.md), [docs/database.md](docs/database.md) | Built-in nodes: browser, Windows apps, Excel / Word / mail, files, HTTP / programs / clipboard / dialogs, PDF, databases |
| [docs/schedules.md](docs/schedules.md) | Schedules and file triggers; the agent that runs them on each PC |
| [docs/audit.md](docs/audit.md) | One audit trail: who changed, published and ran which flow (`shikigami audit`), and how long it is kept |
| [docs/remote.md](docs/remote.md) | Management server: enroll PCs, hand jobs to whichever is free, protocol v1 and a reference server |
| [docs/secrets.md](docs/secrets.md) | Logins: secrets the AI refers to by name only |
| [docs/oauth.md](docs/oauth.md) | Web APIs that need an OAuth sign-in (Box and others), with any fixed redirect URL |
| [docs/adapters.md](docs/adapters.md) | Where each node type comes from, and node plugins |
| [docs/release.md](docs/release.md) | Installer, updates and release signing |
| [docs/design/plugins.md](docs/design/plugins.md) (Japanese) | Node plugins: add nodes for in-house systems without rebuilding Shikigami (manifest + separate process) |
| [docs/design/ui-principles.md](docs/design/ui-principles.md) (Japanese) | Studio's layout rules: where each button goes and how it looks, and why |
| [docs/compatibility.md](docs/compatibility.md) | Compatibility policy: the flow format (`schemaVersion`, migration, `requires`) and what MCP and the CLI never break |
| [docs/research.md](docs/research.md) (Japanese) | Versions, licenses and Windows support of the libraries used |

The design notes under `docs/design/` and `docs/research.md` are in Japanese. Japanese versions of the guides above are in [docs/ja/](docs/ja/).

## Layout

```text
crates/shikigami-core      Flow Core (the only source of truth for flow data)
crates/shikigami-runtime   RPA Runtime (runs without AI or GUI)
crates/shikigami-cli       CLI (the `shikigami` command; `shikigami mcp` is the MCP server)
crates/shikigami-mcp       MCP server (rmcp)
apps/studio                Shikigami Studio (Tauri 2 + React + React Flow)
packages/schema            TypeScript types generated from Rust
plugins/shikigami          Claude Code plugin (MCP settings + skill)
schemas/                   Generated JSON Schema
examples/                  Sample flows
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

# Full-feature demo on screen: browser, dialogs, Excel, Word, Notepad + OCR,
# Outlook and more in one flow (see examples/full-demo/README.md)
pnpm demo:full

# Start Studio
pnpm studio:dev

# Regenerate the JSON Schema and TS types after changing Rust types
pnpm schema:generate
```

The workspace (where flows, history and run records are stored) defaults to `%APPDATA%\Shikigami\workspace`. Change it with the `SHIKIGAMI_HOME` environment variable or the CLI's `--workspace`.

### CLI examples

```sh
shikigami flow import examples/invoice-summary.json
shikigami flow list
echo '[{"op":"addStep","step":{"type":"log.message","params":{"message":"hello"}}}]' \
  | shikigami flow edit scn_example_invoice_summary -
shikigami flow undo scn_example_invoice_summary
shikigami run scn_example_invoice_summary --draft --json   # try the work in progress
shikigami version publish scn_example_invoice_summary       # a person reviews and publishes
shikigami run scn_example_invoice_summary --json           # unattended runs use only the published version
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

## License

[Apache License 2.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) for contributing, [SECURITY.md](SECURITY.md) for reporting vulnerabilities, [docs/compatibility.md](docs/compatibility.md) for the file format, MCP and CLI compatibility policy, and [CHANGELOG.md](CHANGELOG.md) for changes.
