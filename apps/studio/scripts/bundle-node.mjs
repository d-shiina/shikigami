// Stages Node.js and the browser adapter where `tauri.release.conf.json`
// expects them (`bundle.resources`), so the installer puts them in `node\`
// and `browser-adapter\` next to Studio and `shikigami.exe`. Browser steps
// and Node plugins then work on PCs without Node.js (see docs/browser.md).
//
// Node.js comes from nodejs.org, pinned to a version and checked against the
// SHA-256 below; the download is cached in target/node-dist. The browser is
// not shipped: Playwright drives the Edge that Windows already has.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

// Update all three together (SHASUMS256.txt in the version's dist folder).
const NODE_VERSION = "24.22.1";
const NODE_SHA256 = {
  x64: "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
  arm64: "a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(root, "apps/studio/src-tauri/bundled");

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1] ?? "";
const arch = process.env.SHIKIGAMI_NODE_ARCH || (host.startsWith("aarch64") ? "arm64" : "x64");
if (!NODE_SHA256[arch]) throw new Error(`no pinned Node.js for arch '${arch}'`);

rmSync(outDir, { recursive: true, force: true });
await stageNode();
stageAdapter();
if (process.platform === "win32") checkAdapterStarts();

async function stageNode() {
  const name = `node-v${NODE_VERSION}-win-${arch}`;
  const cacheDir = join(root, "target/node-dist");
  const zipPath = join(cacheDir, `${name}.zip`);
  let zip = existsSync(zipPath) ? readFileSync(zipPath) : null;
  if (!zip || sha256(zip) !== NODE_SHA256[arch]) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.zip`;
    console.log(`downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    zip = Buffer.from(await response.arrayBuffer());
    const actual = sha256(zip);
    if (actual !== NODE_SHA256[arch]) throw new Error(`${url}: SHA-256 ${actual}, expected ${NODE_SHA256[arch]}`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(zipPath, zip);
  }

  // Only the runtime and its license; npm and corepack are not needed.
  const nodeDir = join(outDir, "node");
  mkdirSync(nodeDir, { recursive: true });
  const entries = readZip(zip);
  for (const file of ["node.exe", "LICENSE"]) {
    const entry = entries.get(`${name}/${file}`);
    if (!entry) throw new Error(`${name}.zip has no ${file}`);
    writeFileSync(join(nodeDir, file), entry());
  }
  console.log(`bundled Node.js ${NODE_VERSION} (${arch}): ${nodeDir}`);
}

function stageAdapter() {
  const pkgDir = join(root, "packages/browser-adapter");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const dest = join(outDir, "browser-adapter");

  // The adapter runs as TypeScript (Node strips the types); demos stay out.
  mkdirSync(join(dest, "src"), { recursive: true });
  for (const file of readdirSync(join(pkgDir, "src"))) {
    if (file.endsWith(".ts") && !file.startsWith("demo")) cpSync(join(pkgDir, "src", file), join(dest, "src", file));
  }
  const runtimePkg = { name: pkg.name, version: pkg.version, private: true, type: pkg.type, dependencies: pkg.dependencies };
  writeFileSync(join(dest, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);

  // pnpm links dependencies into its store; copy the real files. Each one
  // must be dependency-free itself (playwright-core is).
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const src = realpathSync(join(pkgDir, "node_modules", dep));
    const depPkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
    if (Object.keys(depPkg.dependencies ?? {}).length > 0) {
      throw new Error(`${dep} has dependencies of its own; bundle-node.mjs copies only direct ones`);
    }
    cpSync(src, join(dest, "node_modules", dep), { recursive: true, dereference: true });
  }
  console.log(`bundled browser adapter: ${dest}`);
}

/** Starts the staged adapter with the staged Node.js, as the installed app will. */
function checkAdapterStarts() {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })}\n`;
  const result = spawnSync(
    join(outDir, "node/node.exe"),
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(outDir, "browser-adapter/src/main.ts")],
    { input: request, encoding: "utf8", cwd: outDir, timeout: 30_000 },
  );
  if (!result.stdout.includes('"id":1')) {
    throw new Error(`the bundled adapter did not answer:\n${result.stdout}\n${result.stderr}${result.error ?? ""}`);
  }
  console.log("bundled adapter starts with the bundled Node.js");
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Reads a zip's central directory; returns name -> () => contents. */
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("broken zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, () => {
      const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${name}: unsupported zip method ${method}`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
