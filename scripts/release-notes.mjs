// Prints the CHANGELOG.md section for a version, used as the GitHub Release
// body by .github/workflows/release.yml (docs/release.md).
//
//   node scripts/release-notes.mjs 0.2.0
//
// The section is the one whose `## ` heading contains the version (for
// example `## [0.2.0] - 2026-11-06` or `## 0.2.0（2026-11-06）`), up to the
// next `## ` heading. When there is none, it prints a short fallback and a
// warning, so a forgotten CHANGELOG never blocks a release.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "./repo.mjs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = new RegExp(`^##\\s.*(?<![\\d.])v?${escaped}(?![\\d.\\w-])`);
const start = lines.findIndex((line) => heading.test(line));

const footer = [
  "",
  "---",
  "",
  "Install: download `SpellSheet Writer_" + version + "_x64-setup.exe` below (per user, no administrator rights).",
  "Installed copies of Writer update themselves on their next launch.",
];

if (start < 0) {
  console.error(`::warning::CHANGELOG.md has no section for ${version}; the release notes link to it instead`);
  console.log(
    [`See [CHANGELOG.md](${REPO_URL}/blob/v${version}/CHANGELOG.md).`, ...footer].join("\n"),
  );
} else {
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  console.log([body, ...footer].join("\n"));
}
