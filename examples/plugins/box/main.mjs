// SpellSheet extension: Box (list a folder, download, upload) through the
// Box API, for PCs without Box Drive and for unattended runs on a server.
//
// Newline-delimited JSON-RPC 2.0 on stdin/stdout, as every SpellSheet
// extension speaks (docs/extensions.md). No dependencies: Node.js 18 or
// later (SpellSheet ships one) has fetch, FormData and Blob.
//
// `account` arrives as the OAuth access token of a registered secret: the
// host signs in with oauth.signIn and refreshes the token before each call,
// so this extension never sees the client secret or the refresh token.
// Folders and files are named by ID or by a path from All Files
// ("経理/受注/受注.xlsx"), which is looked up one name at a time.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

// The API's addresses; a test points them at a stand-in on this PC.
const API = (process.env.SPELLSHEET_BOX_API ?? "https://api.box.com/2.0").replace(/\/+$/, "");
const UPLOAD = (process.env.SPELLSHEET_BOX_UPLOAD ?? "https://upload.box.com/api/2.0").replace(/\/+$/, "");
const MAX_UPLOAD = 50 * 1024 * 1024;
const ITEM_FIELDS = "id,type,name,size,modified_at";

class StepError extends Error {
  constructor(code, message, { retryable = false, hint } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = hint ? { hint } : undefined;
  }
}

const SIGN_IN_HINT =
  "Put an oauth.signIn step with this secret (authorizeUrl https://account.box.com/api/oauth2/authorize, tokenUrl https://api.box.com/oauth2/token) before this node, and give the secret's sites plugin:box.";

/** What Box said, as a step error. */
async function failure(response, what) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.message ?? body?.code ?? "";
  } catch {
    // Not JSON: the status is enough.
  }
  const status = response.status;
  const message = `${what}: Box answered ${status}${detail ? ` (${detail})` : ""}`;
  if (status === 401) return new StepError("BOX_AUTH_FAILED", message, { hint: SIGN_IN_HINT });
  if (status === 403) {
    return new StepError("BOX_ACCESS_DENIED", message, {
      hint: "The signed-in Box user cannot use this item, or the app lacks the scope (Read / Write all files and folders).",
    });
  }
  if (status === 404) return new StepError("BOX_NOT_FOUND", message, { hint: "Check the ID or the path from All Files (e.g. 経理/受注/受注.xlsx)." });
  if (status === 429) return new StepError("BOX_RATE_LIMITED", message, { retryable: true, hint: "Too many requests; retry later." });
  if (status >= 500) return new StepError("BOX_UNAVAILABLE", message, { retryable: true });
  return new StepError("BOX_REQUEST_FAILED", message);
}

/** One call to the Box API; JSON in and out. */
async function box(token, url, { method = "GET", body, headers = {}, signal }) {
  let response;
  try {
    response = await fetch(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers }, signal });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw e;
    throw new StepError("BOX_UNREACHABLE", `cannot reach Box: ${e.cause?.message ?? e.message}`, {
      retryable: true,
      hint: "Check the network (proxy) and that api.box.com / upload.box.com are not blocked.",
    });
  }
  return response;
}

function tokenOf(account) {
  if (typeof account !== "string" || account === "") {
    throw new StepError("BOX_AUTH_FAILED", "no Box access token", {
      hint: `Choose a registered OAuth secret as { "secret": "Box", "field": "accessToken" }. ${SIGN_IN_HINT}`,
    });
  }
  return account;
}

const isId = (text) => /^\d+$/.test(text.trim());
const parts = (path) =>
  path
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== "すべてのファイル" && p !== "All Files");

/** Every item of a folder (Box pages them). */
async function items(token, folderId, signal) {
  const out = [];
  for (let offset = 0; ; ) {
    const query = new URLSearchParams({ fields: ITEM_FIELDS, limit: "1000", offset: String(offset) });
    const response = await box(token, `${API}/folders/${folderId}/items?${query}`, { signal });
    if (!response.ok) throw await failure(response, `the folder ${folderId} could not be listed`);
    const page = await response.json();
    out.push(...(page.entries ?? []));
    offset += page.entries?.length ?? 0;
    if (!page.entries?.length || offset >= (page.total_count ?? 0)) return out;
  }
}

/** The item a path from All Files names: exact name first, then ignoring case (Box keeps names unique that way). */
async function walk(token, path, want, signal) {
  const names = parts(path);
  let current = { id: "0", type: "folder", name: "" };
  for (const [i, name] of names.entries()) {
    const list = await items(token, current.id, signal);
    const last = i === names.length - 1;
    const fits = (e) => (last ? e.type === want : e.type === "folder");
    const found = list.find((e) => fits(e) && e.name === name) ?? list.find((e) => fits(e) && e.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      const where = names.slice(0, i).join("/") || "All Files";
      throw new StepError("BOX_NOT_FOUND", `there is no ${last && want === "file" ? "file" : "folder"} '${name}' in ${where}`, {
        hint: `Names in ${where}: ${list.slice(0, 20).map((e) => e.name).join(", ") || "(empty)"}`,
      });
    }
    current = found;
  }
  if (current.type !== want) throw new StepError("BOX_NOT_FOUND", `'${path}' is not a ${want}`);
  return current;
}

const folderId = async (token, folder, signal) => (isId(folder) ? folder.trim() : (await walk(token, folder, "folder", signal)).id);
const fileId = async (token, file, signal) => (isId(file) ? file.trim() : (await walk(token, file, "file", signal)).id);

/** `*.xlsx`, `受注_?.csv` as a test on names (case ignored, as Explorer does). */
function matcher(pattern) {
  if (!pattern) return () => true;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  const re = new RegExp(`^${source}$`, "i");
  return (name) => re.test(name);
}

const shape = (e, path) => ({
  id: e.id,
  name: e.name,
  type: e.type,
  ...(e.size !== undefined ? { size: e.size } : {}),
  ...(e.modified_at ? { modifiedAt: e.modified_at } : {}),
  ...(path !== undefined ? { path } : {}),
});

/** Writes the whole file next to its place first, so a stopped run leaves no half file. */
async function writeWhole(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.part`);
  try {
    await writeFile(temp, bytes);
    await rename(temp, path);
  } catch (e) {
    await rm(temp, { force: true });
    throw new StepError("FILE_ACCESS_DENIED", `cannot write ${path}: ${e.message}`, { hint: "The file may be open in Excel; close it and run again." });
  }
}

const actions = {
  async list({ account, folder, pattern, timeoutMs = 60000 }) {
    const token = tokenOf(account);
    const signal = AbortSignal.timeout(timeoutMs);
    const id = await folderId(token, folder, signal);
    const keep = matcher(pattern);
    const base = isId(folder) ? undefined : parts(folder).join("/");
    return (await items(token, id, signal))
      .filter((e) => (e.type === "file" || e.type === "folder") && keep(e.name))
      .map((e) => shape(e, base === undefined ? undefined : base ? `${base}/${e.name}` : e.name));
  },

  async download({ account, file, to, overwrite = false, timeoutMs = 120000 }) {
    const token = tokenOf(account);
    const signal = AbortSignal.timeout(timeoutMs);
    if (!overwrite) {
      const there = await stat(to).then(
        () => true,
        () => false,
      );
      if (there) throw new StepError("FILE_EXISTS", `${to} is already there`, { hint: "Set overwrite: true to replace it." });
    }
    const id = await fileId(token, file, signal);
    const info = await box(token, `${API}/files/${id}?fields=${ITEM_FIELDS}`, { signal });
    if (!info.ok) throw await failure(info, `the file ${id} could not be read`);
    const meta = await info.json();
    // Box answers with a redirect to a short-lived download address; fetch follows it.
    const response = await box(token, `${API}/files/${id}/content`, { signal });
    if (!response.ok) throw await failure(response, `the file ${meta.name} could not be downloaded`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeWhole(to, bytes);
    return { path: to, ...shape(meta), size: bytes.length };
  },

  async upload({ account, path, folder, name, overwrite = false, timeoutMs = 120000 }) {
    const token = tokenOf(account);
    const signal = AbortSignal.timeout(timeoutMs);
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (e) {
      throw new StepError("FILE_NOT_FOUND", `cannot read ${path}: ${e.message}`, { hint: "Check the file's path; a relative path is read from the flow's folder." });
    }
    if (bytes.length > MAX_UPLOAD) {
      throw new StepError("BOX_FILE_TOO_LARGE", `${path} is ${Math.round(bytes.length / 1024 / 1024)} MB; this node sends up to 50 MB`, {
        hint: "Split the file, or put it in a Box Drive folder instead.",
      });
    }
    const parent = await folderId(token, folder, signal);
    const fileName = (name ?? "").trim() || basename(path);
    const send = async (url, attributes) => {
      const form = new FormData();
      form.append("attributes", JSON.stringify(attributes));
      form.append("file", new Blob([bytes]), fileName);
      return box(token, url, { method: "POST", body: form, signal });
    };
    let response = await send(`${UPLOAD}/files/content`, { name: fileName, parent: { id: parent } });
    if (response.status === 409) {
      const conflict = await response.json().catch(() => ({}));
      const existing = conflict?.context_info?.conflicts?.id;
      if (!overwrite || !existing) {
        throw new StepError("BOX_FILE_EXISTS", `'${fileName}' is already in that Box folder`, { hint: "Set overwrite: true to add a new version of it." });
      }
      response = await send(`${UPLOAD}/files/${existing}/content`, { name: fileName });
    }
    if (!response.ok) throw await failure(response, `${fileName} could not be uploaded`);
    const body = await response.json();
    const entry = body?.entries?.[0] ?? body;
    return { id: entry.id, name: entry.name, size: entry.size ?? bytes.length, version: entry.file_version?.id ?? null };
  },

  closeRun() {
    return null;
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const id = request.id ?? null;
  const action = Object.hasOwn(actions, request.method) ? actions[request.method] : undefined;
  try {
    if (!action) throw new StepError("UNKNOWN_ACTION", `unknown method '${request.method}'`);
    const result = await action(request.params ?? {});
    send({ jsonrpc: "2.0", id, result: result ?? null });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    const e = timedOut ? new StepError("BOX_TIMEOUT", "Box did not finish in time", { retryable: true }) : error;
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: e?.message ?? String(e),
        data: { code: e?.code ?? "PLUGIN_ERROR", retryable: Boolean(e?.retryable), details: e?.details },
      },
    });
  }
}

// Several calls can be in flight at once (parallel branches): answer each when it is done.
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim()) handle(line);
});
lines.on("close", () => process.exit(0));
