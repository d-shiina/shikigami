// Checks every link inside the built manual (dist/) points at a page or file
// that exists, after `astro build`. Links that leave the manual (../../x.html)
// must be pages of the product site (site/), which the manual is published
// under. Anchors (#…) must be headings or ids on the page they point at.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const site = join(here, "..", "..", "..", "site");
const base = (process.env.MANUAL_BASE ?? "/manual").replace(/\/$/, "");

function pages(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? pages(path) : path.endsWith(".html") ? [path] : [];
  });
}

const ids = new Map();
function idsOf(file) {
  if (!ids.has(file)) {
    const html = readFileSync(file, "utf8");
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))));
  }
  return ids.get(file);
}

function resolve(from, href) {
  let path;
  if (href.startsWith(`${base}/`) || href === base) path = join(dist, href.slice(base.length));
  else if (href.startsWith("/")) return null;
  else path = normalize(join(dirname(from), href));
  // Out of the manual: a page of the product site next to it.
  if (relative(dist, path).startsWith("..")) {
    const up = relative(dist, path).split(sep);
    path = join(site, ...up.slice(1));
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  return path;
}

const problems = [];
for (const file of pages(dist)) {
  const html = readFileSync(file, "utf8");
  for (const [, raw] of html.matchAll(/\shref="([^"]*)"/g)) {
    if (/^(https?:|mailto:|data:)/.test(raw) || raw === "") continue;
    const [href, anchor] = raw.split("#");
    const target = href === "" ? file : resolve(file, decodeURI(href));
    const where = relative(dist, file);
    if (target === null) problems.push(`${where}: ${raw} (a path from the root, not under ${base})`);
    else if (!existsSync(target)) problems.push(`${where}: ${raw} (no such page)`);
    else if (anchor && target.endsWith(".html") && target.startsWith(dist) && !idsOf(target).has(decodeURIComponent(anchor)))
      problems.push(`${where}: ${raw} (no such heading)`);
  }
}

if (problems.length > 0) {
  console.error(`Broken links in the manual (${problems.length}):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("All links in the manual lead somewhere.");
