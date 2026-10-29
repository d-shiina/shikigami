// Stages the OCR engine where `tauri.release.conf.json` expects it
// (`bundle.resources`), so the installer puts it in `ocr\` next to Studio
// and `shikigami.exe`: PaddleOCR's PP-OCRv6 small models (det.onnx,
// rec.onnx) and ONNX Runtime. A copy goes to target/ocr, where development
// builds and `cargo test` find it (see crates/shikigami-desktop/src/paddle.rs).
//
// Everything comes from PyPI wheels, pinned to a version and checked against
// the SHA-256 below; downloads are cached in target/ocr-dist. The models are
// Apache-2.0 (PaddleOCR, converted by RapidOCR); ONNX Runtime is MIT.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

// Update the version, file and SHA-256 together (pypi.org/pypi/<name>/<version>/json).
const PYPI = "https://files.pythonhosted.org/packages";
const MODELS = {
  url: `${PYPI}/59/07/203065283bba0c5e9c10af3602dc25ab3e59ee54dc2d1d22c8faeabf5ed8/rapidocr-3.10.0-py3-none-any.whl`,
  sha256: "2fc34e26cd0f48514804a94f8832283039c7334076bff60768b1fed9ad068050",
  files: {
    "rapidocr/models/PP-OCRv6_det_small.onnx": "det.onnx",
    "rapidocr/models/PP-OCRv6_rec_small.onnx": "rec.onnx",
    "rapidocr-3.10.0.dist-info/licenses/LICENSE": "LICENSE-models.txt",
    "rapidocr-3.10.0.dist-info/licenses/MODEL_LICENSES.md": "MODEL_LICENSES.md",
  },
};
const RUNTIME = {
  "win32-x64": {
    url: `${PYPI}/59/bf/a1d282b4c753ba3e9b31f4c11abd2bc2390513dc5e3792ca3b78e42401c3/onnxruntime-1.31.1-cp313-cp313-win_amd64.whl`,
    sha256: "0558f29d5f6ac09957390c9c5495931485ee8ae7f0ce781ccee86a0ae5c2348b",
    library: "onnxruntime/capi/onnxruntime.dll",
  },
  "win32-arm64": {
    url: `${PYPI}/7e/fd/529135287474dbaf19d9362ccda61998128ab18507f78bc82931e1bbaf22/onnxruntime-1.31.1-cp313-cp313-win_arm64.whl`,
    sha256: "075147c2e2430b4b29c436bffa78537b902a6ed58ed66f99ae3c6795e2081cb5",
    library: "onnxruntime/capi/onnxruntime.dll",
  },
  // For development and CI on Linux (the OCR tests).
  "linux-x64": {
    url: `${PYPI}/fc/0a/c887bcb84a9455b2723825381a77af38611a80f996f804e20fde5f671b63/onnxruntime-1.31.1-cp313-cp313-manylinux_2_28_x86_64.whl`,
    sha256: "74a6a52994616c4d18b33db1e13c226333a70a6ba07480a5cab9c2a50dff1430",
    library: "onnxruntime/capi/libonnxruntime.so.1.31.1",
  },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(root, "apps/studio/src-tauri/bundled/ocr");
const devDir = join(root, "target/ocr");
const cacheDir = join(root, "target/ocr-dist");

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1] ?? "";
const arch = process.env.SHIKIGAMI_OCR_ARCH || (host.startsWith("aarch64") ? "arm64" : "x64");
const platform = `${process.platform}-${arch}`;
const runtime = RUNTIME[platform];
if (!runtime) throw new Error(`no pinned ONNX Runtime for ${platform}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const models = readZip(await download(MODELS));
for (const [from, to] of Object.entries(MODELS.files)) writeFileSync(join(outDir, to), entry(models, from)());

const ort = readZip(await download(runtime));
const library = runtime.library.split("/").pop();
writeFileSync(join(outDir, library), entry(ort, runtime.library)());
writeFileSync(join(outDir, "LICENSE-onnxruntime.txt"), entry(ort, "onnxruntime/LICENSE")());
writeFileSync(join(outDir, "ThirdPartyNotices-onnxruntime.txt"), entry(ort, "onnxruntime/ThirdPartyNotices.txt")());
if (process.platform === "win32") copyVcRuntime();

// The development copy: the same files.
rmSync(devDir, { recursive: true, force: true });
mkdirSync(devDir, { recursive: true });
for (const file of readdirSync(outDir)) copyFileSync(join(outDir, file), join(devDir, file));
console.log(`bundled PaddleOCR (PP-OCRv6 small) and ONNX Runtime: ${outDir} (and ${devDir})`);

/** The wheel's bytes, from the cache or PyPI, checked against its SHA-256. */
async function download({ url, sha256: expected }) {
  const path = join(cacheDir, url.split("/").pop());
  let data = existsSync(path) ? readFileSync(path) : null;
  if (!data || sha256(data) !== expected) {
    console.log(`downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    const actual = sha256(data);
    if (actual !== expected) throw new Error(`${url}: SHA-256 ${actual}, expected ${expected}`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, data);
  }
  return data;
}

/**
 * ONNX Runtime needs the Visual C++ runtime (msvcp140.dll and friends),
 * which not every PC has. Microsoft allows shipping these files next to the
 * program; they come from the build machine's Visual Studio
 * (VC\Redist\MSVC\<version>\<arch>\Microsoft.VC*.CRT).
 */
function copyVcRuntime() {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe");
  if (!existsSync(vswhere)) {
    console.warn("vswhere.exe not found: the Visual C++ runtime is not bundled (PCs without it fall back to Windows OCR)");
    return;
  }
  const vs = execFileSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], { encoding: "utf8" }).trim();
  const redist = join(vs, "VC/Redist/MSVC");
  const versions = existsSync(redist) ? readdirSync(redist).filter((v) => /^\d/.test(v)).sort() : [];
  const archDir = join(redist, versions.at(-1) ?? "", arch);
  const crt = existsSync(archDir) ? readdirSync(archDir).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d)) : undefined;
  if (!crt) {
    console.warn(`no Visual C++ redistributable under ${redist}: the runtime is not bundled`);
    return;
  }
  for (const dll of ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) {
    const from = join(archDir, crt, dll);
    if (existsSync(from)) copyFileSync(from, join(outDir, dll));
  }
  console.log(`bundled the Visual C++ runtime from ${join(archDir, crt)}`);
}

function entry(entries, name) {
  const found = entries.get(name);
  if (!found) throw new Error(`the wheel has no ${name}`);
  return found;
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
