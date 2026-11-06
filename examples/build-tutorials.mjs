// Builds one importable bundle per tutorial: examples/tutorials/<name>.shikigami.json
// from the project folder examples/tutorials/<name>/.
//
//   node examples/build-tutorials.mjs
//
// The folder (flow.json and the files under input/ config/ templates/) is
// the source of truth. In Studio, "Import from file" on the Flows page
// opens a bundle as a flow with its folder; the CLI runs it directly
// (`shikigami run examples/tutorials/<name>.shikigami.json`). Re-run this
// after editing a tutorial's folder.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./tutorials/", import.meta.url));
// A fixed timestamp keeps the generated bundles stable across rebuilds.
const EXPORTED_AT = "2026-11-06T00:00:00Z";
// What a flow's folder carries; runs make output/ work/ logs/.
const CARRIED = ["input", "config", "templates"];

/** Files under `dir`, as `/`-separated paths relative to `base`, sorted. */
function walk(base, dir) {
  const full = join(base, dir);
  let names;
  try {
    names = readdirSync(full).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(base, rel)).isDirectory() ? walk(base, rel) : [rel];
  });
}

for (const name of readdirSync(root).sort()) {
  const folder = join(root, name);
  if (!statSync(folder).isDirectory() || name.endsWith(".files")) continue;
  const flow = JSON.parse(readFileSync(join(folder, "flow.json"), "utf8"));
  delete flow.$schema;
  const files = CARRIED.flatMap((dir) => walk(folder, dir)).map((path) => ({
    flowId: flow.id,
    path,
    data: readFileSync(join(folder, path)).toString("base64"),
  }));
  const bundle = {
    format: "shikigami.flowBundle",
    formatVersion: 2,
    exportedAt: EXPORTED_AT,
    flow,
    versions: [],
    subflows: [],
    files,
  };
  const out = join(root, `${name}.shikigami.json`);
  writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n");
  console.log(`wrote ${out} (${files.length} file(s))`);
}
