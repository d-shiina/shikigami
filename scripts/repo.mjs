// The GitHub repository ("owner/name"), read from `repository` in the root
// Cargo.toml so a rename or a move to another owner is changed in one place.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cargo = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../Cargo.toml"), "utf8");
const url = cargo.match(/^repository\s*=\s*"https:\/\/github\.com\/([^"]+?)\/?"/m)?.[1];
if (!url) throw new Error("Cargo.toml has no GitHub `repository`");

export const REPO = url;
export const REPO_URL = `https://github.com/${url}`;
