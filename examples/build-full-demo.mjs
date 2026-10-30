// Builds the runnable bundle examples/full-demo.shikigami.json from the
// human-readable project folder examples/full-demo/.
//
//   node examples/build-full-demo.mjs
//
// The folder (scenario.json, subscenarios/shipping.json and the files under
// input/ config/ templates/) is the source of truth; the bundle is a single
// self-contained file that `shikigami run examples/full-demo.shikigami.json`
// unpacks and runs. Re-run this after editing anything in the folder.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./full-demo/", import.meta.url));
const out = fileURLToPath(new URL("./full-demo.shikigami.json", import.meta.url));

// A fixed timestamp keeps the generated bundle stable across rebuilds.
const EXPORTED_AT = "2026-10-30T00:00:00Z";

/** Reads a scenario JSON file and drops the editor-only `$schema` key. */
function scenario(path) {
  const s = JSON.parse(readFileSync(path, "utf8"));
  delete s.$schema;
  return s;
}

const main = scenario(new URL("full-demo/scenario.json", import.meta.url));
const shipping = scenario(new URL("full-demo/subscenarios/shipping.json", import.meta.url));

// The main scenario's folder files the bundle carries (input/ config/
// templates/; never output/ work/ logs/, which runs make). Paths are
// `/`-separated and relative to the scenario's folder.
const bundledPaths = [
  "input/受注.csv",
  "config/設定.json",
  "templates/請求書.docx",
];
const files = bundledPaths.map((rel) => ({
  scenarioId: main.id,
  path: rel,
  data: readFileSync(new URL(`full-demo/${rel}`, import.meta.url)).toString("base64"),
}));

const bundle = {
  format: "shikigami.scenarioBundle",
  formatVersion: 2,
  exportedAt: EXPORTED_AT,
  scenario: main,
  versions: [],
  subscenarios: [shipping],
  files,
};

writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n");
console.log(`wrote ${out} (${files.length} file(s), ${readdirSync(dir).length} folder entries)`);
