// Packs the MCP server as an MCP Bundle (`spellsheet.mcpb`) and writes the
// `server.json` that lists it in the official MCP Registry
// (registry.modelcontextprotocol.io). Run by .github/workflows/release.yml
// after the installer build, which has already staged everything this needs:
//
//   node scripts/build-mcpb.mjs 0.2.0
//
// The bundle holds what the installer puts next to `spellsheet.exe` (Node.js,
// the browser adapter and the OCR models), so an AI client that installs only
// the bundle runs browser and OCR steps the same way as an installed Writer.
//
// Output (target/mcpb/): spellsheet.mcpb and server.json. The bundle's URL is
// the GitHub Release asset of the version's tag, which the registry requires
// to contain "mcp" (the .mcpb extension does).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, REPO_URL } from "./repo.mjs";

// Pinned; update deliberately (npm view @anthropic-ai/mcpb version).
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const REGISTRY_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const DESCRIPTION = "Windows RPA that AI builds over MCP and that runs without AI: browser, desktop apps, Excel.";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("usage: node scripts/build-mcpb.mjs <version>");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "apps/studio/src-tauri");
const outDir = join(root, "target/mcpb");
const stage = join(outDir, "stage");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// The CLI that bundle-cli.mjs staged for the installer (the same build).
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
const cli = join(tauri, "binaries", `spellsheet-${host}.exe`);
if (!existsSync(cli)) throw new Error(`${cli} is missing; run pnpm studio:bundle-cli first`);
copyFileSync(cli, join(stage, "spellsheet.exe"));

for (const dir of ["node", "browser-adapter", "ocr"]) {
  const from = join(tauri, "bundled", dir);
  if (!existsSync(from)) throw new Error(`${from} is missing; run pnpm studio:bundle-node and studio:bundle-ocr first`);
  cpSync(from, join(stage, dir), { recursive: true });
}
copyFileSync(join(root, "docs/assets/mark.png"), join(stage, "icon.png"));
copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));

const manifest = {
  manifest_version: "0.3",
  name: "spellsheet",
  display_name: "SpellSheet",
  version,
  description: DESCRIPTION,
  long_description: [
    "SpellSheet is a local-first RPA platform for Windows 10/11 (x64). AI clients create, edit, test and run automation flows through these tools; finished flows run without AI.",
    "",
    "Install SpellSheet Writer as well (" + REPO_URL + "/releases/latest) to see the flows the AI builds, review its changes and run them by hand. Writer and this server share the same workspace (%APPDATA%\\SpellSheet\\workspace).",
    "",
    "The releases are not code-signed yet, so Windows may warn on first start.",
  ].join("\n"),
  author: { name: "SpellSheet", url: REPO_URL },
  repository: { type: "git", url: REPO_URL },
  homepage: "https://spellsheet.github.io/",
  documentation: `${REPO_URL}/blob/main/docs/mcp.md`,
  support: `${REPO_URL}/issues`,
  icon: "icon.png",
  license: "Apache-2.0",
  keywords: ["rpa", "automation", "windows", "excel", "browser", "desktop"],
  server: {
    type: "binary",
    entry_point: "spellsheet.exe",
    mcp_config: { command: "${__dirname}/spellsheet.exe", args: ["mcp"] },
  },
  tools_generated: true,
  compatibility: { platforms: ["win32"] },
};
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const bundle = join(outDir, "spellsheet.mcpb");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(npx, ["--yes", MCPB_CLI, "pack", stage, bundle], { stdio: "inherit", shell: process.platform === "win32" });
const sha256 = createHash("sha256").update(readFileSync(bundle)).digest("hex");

// The registry name is tied to the GitHub owner (io.github.<owner>/...), and
// publishing with GitHub OIDC proves it from the release workflow.
const owner = REPO.split("/")[0];
const server = {
  $schema: REGISTRY_SCHEMA,
  name: `io.github.${owner}/spellsheet`,
  title: "SpellSheet",
  description: DESCRIPTION,
  repository: { url: REPO_URL, source: "github" },
  websiteUrl: "https://spellsheet.github.io/",
  version,
  packages: [
    {
      registryType: "mcpb",
      identifier: `${REPO_URL}/releases/download/v${version}/spellsheet.mcpb`,
      version,
      fileSha256: sha256,
      transport: { type: "stdio" },
    },
  ],
};
writeFileSync(join(outDir, "server.json"), `${JSON.stringify(server, null, 2)}\n`);
rmSync(stage, { recursive: true, force: true });
console.log(`${bundle} (sha256 ${sha256})`);
