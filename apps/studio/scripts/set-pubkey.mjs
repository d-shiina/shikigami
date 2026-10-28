// Writes tauri.release.gen.json (tauri.release.conf.json plus the updater
// public key) for a release build. CI passes it in TAURI_UPDATER_PUBKEY (a repository variable); a
// local build falls back to ~/.tauri/shikigami.key.pub.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pubFile = join(homedir(), ".tauri", "shikigami.key.pub");
const pubkey =
  process.env.TAURI_UPDATER_PUBKEY?.trim() ||
  (existsSync(pubFile) ? readFileSync(pubFile, "utf8").trim() : "");
if (!pubkey) {
  console.error("updater public key not found: run `pnpm release:setup` first (see docs/release.md)");
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri");
const config = JSON.parse(readFileSync(join(dir, "tauri.release.conf.json"), "utf8"));
config.plugins = { ...config.plugins, updater: { ...config.plugins?.updater, pubkey } };
writeFileSync(join(dir, "tauri.release.gen.json"), `${JSON.stringify(config, null, 2)}\n`);
