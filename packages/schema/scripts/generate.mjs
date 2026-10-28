// Generates src/generated.ts from schemas/api.schema.json (exported by Rust).
// Usage: node scripts/generate.mjs [--check]
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = fileURLToPath(new URL("../src/generated.ts", import.meta.url));

const banner =
  "/* eslint-disable */\n/**\n * GENERATED FILE - DO NOT EDIT.\n * Source: schemas/*.schema.json (generated from the Rust crates).\n * Regenerate with `pnpm schema:generate`.\n */";

async function compileFile(file, name, withBanner) {
  const schema = JSON.parse(await readFile(`${root}schemas/${file}`, "utf8"));
  return compile(schema, name, {
    bannerComment: withBanner ? banner : "",
    additionalProperties: false,
    unreachableDefinitions: true,
    style: { singleQuote: false, semi: true, printWidth: 100 },
  });
}

export async function generate() {
  const core = await compileFile("api.schema.json", "ShikigamiApi", true);
  // Run types reference core types (ids, errors); json-schema-to-typescript
  // inlines them, so drop exact duplicates of already-declared names.
  const run = await compileFile("run-api.schema.json", "ShikigamiRunApi", false);
  const declared = new Set([...core.matchAll(/^export (?:type|interface) (\w+)/gm)].map((m) => m[1]));
  const blocks = run.split(/\n(?=\/\*\*|export )/);
  const kept = [];
  for (let i = 0; i < blocks.length; i++) {
    const name = blocks[i].match(/^export (?:type|interface) (\w+)/m)?.[1];
    if (name && declared.has(name)) {
      // remove a preceding doc comment that belonged to this declaration
      if (kept.length && kept[kept.length - 1].startsWith("/**")) kept.pop();
      continue;
    }
    kept.push(blocks[i]);
  }
  return `${core}\n${kept.join("\n").trim()}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ts = await generate();
  if (process.argv.includes("--check")) {
    const current = await readFile(out, "utf8").catch(() => "");
    if (current !== ts) {
      console.error("src/generated.ts is out of date; run `pnpm schema:generate`");
      process.exit(1);
    }
  } else {
    await writeFile(out, ts);
    console.log(`wrote ${out}`);
  }
}
