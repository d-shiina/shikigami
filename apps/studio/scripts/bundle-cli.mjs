// Builds the spellsheet CLI (the MCP server) in release mode and places it
// where `tauri.release.conf.json` expects it (`bundle.externalBin`), so the
// installer ships it next to Studio and updates it together with Studio.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
if (!host) throw new Error("cannot read the Rust host triple from `rustc -vV`");
const ext = host.includes("windows") ? ".exe" : "";

execFileSync("cargo", ["build", "--release", "-p", "shikigami-cli"], { cwd: root, stdio: "inherit" });

// The same program under the product's name and its old one: MCP clients
// and scheduled tasks set up before the rename keep starting `shikigami.exe`.
const outDir = join(root, "apps/studio/src-tauri/binaries");
mkdirSync(outDir, { recursive: true });
for (const name of ["spellsheet", "shikigami"]) {
  const target = join(outDir, `${name}-${host}${ext}`);
  copyFileSync(join(root, "target/release", `shikigami${ext}`), target);
  console.log(`bundled CLI: ${target}`);
}
