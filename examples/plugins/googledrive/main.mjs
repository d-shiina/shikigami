// SpellSheet extension: Google Drive (list a folder, download, upload)
// through the Drive API, for PCs without Google Drive for desktop and for
// unattended runs.
//
// Newline-delimited JSON-RPC 2.0 on stdin/stdout, as every SpellSheet
// extension speaks (docs/extensions.md). No dependencies: Node.js 18 or
// later (SpellSheet ships one) has fetch.
//
// `account` arrives as the OAuth access token of a registered secret: the
// host signs in with oauth.signIn and refreshes the token before each call,
// so this extension never sees the client secret or the refresh token.
// Folders and files are named by a path from My Drive ("経理/受注/受注.xlsx"),
// by their ID, or by the address Drive shows for them
// (https://drive.google.com/file/d/<ID>/view, …/drive/folders/<ID>).

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

// The API's addresses; a test points them at a stand-in on this PC.
const API = (process.env.SPELLSHEET_GDRIVE_API ?? "https://www.googleapis.com/drive/v3").replace(/\/+$/, "");
const UPLOAD = (process.env.SPELLSHEET_GDRIVE_UPLOAD ?? "https://www.googleapis.com/upload/drive/v3").replace(/\/+$/, "");
const MAX_UPLOAD = 50 * 1024 * 1024;
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,size,modifiedTime";
// Google's own documents have no file to download; they are exported as Office files.
const EXPORTS = {
  "application/vnd.google-apps.spreadsheet": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  "application/vnd.google-apps.document": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  "application/vnd.google-apps.presentation": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
};

class StepError extends Error {
  constructor(code, message, { retryable = false, hint } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = hint ? { hint } : undefined;
  }
}

const SIGN_IN_HINT =
  'Put an oauth.signIn step with this secret before this node (authorizeUrl https://accounts.google.com/o/oauth2/v2/auth, tokenUrl https://oauth2.googleapis.com/token, scope https://www.googleapis.com/auth/drive, authorizeParams { "access_type": "offline", "prompt": "consent" }), and give the secret\'s sites plugin:googledrive.';

/** What Drive said, as a step error. */
async function failure(response, what) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message ?? "";
  } catch {
    // Not JSON: the status is enough.
  }
  const status = response.status;
  const message = `${what}: Google Drive answered ${status}${detail ? ` (${detail})` : ""}`;
  if (status === 401) return new StepError("GDRIVE_AUTH_FAILED", message, { hint: SIGN_IN_HINT });
  if (status === 403 && /rate|quota/i.test(detail)) return new StepError("GDRIVE_RATE_LIMITED", message, { retryable: true });
  if (status === 403) {
    return new StepError("GDRIVE_ACCESS_DENIED", message, {
      hint: "The signed-in Google user cannot use this item, or the app lacks the Drive scope (https://www.googleapis.com/auth/drive).",
    });
  }
  if (status === 404) return new StepError("GDRIVE_NOT_FOUND", message, { hint: "Check the ID, the address or the path from My Drive (e.g. 経理/受注/受注.xlsx)." });
  if (status === 429) return new StepError("GDRIVE_RATE_LIMITED", message, { retryable: true, hint: "Too many requests; retry later." });
  if (status >= 500) return new StepError("GDRIVE_UNAVAILABLE", message, { retryable: true });
  return new StepError("GDRIVE_REQUEST_FAILED", message);
}

async function drive(token, url, { method = "GET", body, headers = {}, signal } = {}) {
  try {
    return await fetch(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers }, signal });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw e;
    throw new StepError("GDRIVE_UNREACHABLE", `cannot reach Google Drive: ${e.cause?.message ?? e.message}`, {
      retryable: true,
      hint: "Check the network (proxy) and that www.googleapis.com is not blocked.",
    });
  }
}

function tokenOf(account) {
  if (typeof account !== "string" || account === "") {
    throw new StepError("GDRIVE_AUTH_FAILED", "no Google access token", {
      hint: `Choose a registered OAuth secret as { "secret": "Google", "field": "accessToken" }. ${SIGN_IN_HINT}`,
    });
  }
  return account;
}

/** The ID in a Drive address, or the text itself when it looks like an ID. */
function idOf(text) {
  const t = text.trim();
  const link = t.match(/^https?:\/\/(?:drive|docs)\.google\.com\/.*?(?:\/d\/|\/folders\/|[?&]id=)([A-Za-z0-9_-]{10,})/);
  if (link) return link[1];
  return /^[A-Za-z0-9_-]{25,}$/.test(t) ? t : null;
}

const parts = (path) =>
  path
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== "マイドライブ" && p !== "My Drive");

const q = (text) => text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Every item of a folder (Drive pages them). */
async function children(token, folderId, signal, extra = "") {
  const out = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({
      q: `'${q(folderId)}' in parents and trashed = false${extra}`,
      fields: `nextPageToken,files(${FIELDS})`,
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await drive(token, `${API}/files?${query}`, { signal });
    if (!response.ok) throw await failure(response, `the folder ${folderId} could not be listed`);
    const page = await response.json();
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/** The item a path from My Drive names: exact name first, then ignoring case. */
async function walk(token, path, want, signal) {
  const names = parts(path);
  let current = { id: "root", mimeType: FOLDER, name: "" };
  for (const [i, name] of names.entries()) {
    const list = await children(token, current.id, signal);
    const last = i === names.length - 1;
    const fits = (e) => (last && want === "file" ? e.mimeType !== FOLDER : e.mimeType === FOLDER);
    const found = list.find((e) => fits(e) && e.name === name) ?? list.find((e) => fits(e) && e.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      const where = names.slice(0, i).join("/") || "My Drive";
      throw new StepError("GDRIVE_NOT_FOUND", `there is no ${last && want === "file" ? "file" : "folder"} '${name}' in ${where}`, {
        hint: `Names in ${where}: ${list.slice(0, 20).map((e) => e.name).join(", ") || "(empty)"}`,
      });
    }
    current = found;
  }
  return current;
}

async function item(token, text, want, signal) {
  const id = idOf(text);
  if (id) {
    const response = await drive(token, `${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}&supportsAllDrives=true`, { signal });
    if (!response.ok) throw await failure(response, `${text} could not be read`);
    const found = await response.json();
    if ((found.mimeType === FOLDER) !== (want === "folder")) throw new StepError("GDRIVE_NOT_FOUND", `'${text}' is not a ${want}`);
    return found;
  }
  if (want === "folder" && parts(text).length === 0) return { id: "root", name: "My Drive", mimeType: FOLDER };
  return walk(token, text, want, signal);
}

function matcher(pattern) {
  if (!pattern) return () => true;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  const re = new RegExp(`^${source}$`, "i");
  return (name) => re.test(name);
}

const shape = (e, path) => ({
  id: e.id,
  name: e.name,
  type: e.mimeType === FOLDER ? "folder" : "file",
  ...(e.size !== undefined ? { size: Number(e.size) } : {}),
  ...(e.modifiedTime ? { modifiedAt: e.modifiedTime } : {}),
  ...(path !== undefined ? { path } : {}),
});

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


/** Refuses before anything is fetched when a file to be saved is already there. */
async function refuseExisting(paths) {
  for (const path of paths) {
    const there = await stat(path).then(
      () => true,
      () => false,
    );
    if (there) throw new StepError("FILE_EXISTS", `${path} is already there`, { hint: "Set overwrite: true to replace it." });
  }
}

/** Where a file's contents are fetched from: Google's own documents are exported as Office files. */
function contentUrl(meta) {
  const exported = EXPORTS[meta.mimeType];
  return exported
    ? `${API}/files/${encodeURIComponent(meta.id)}/export?mimeType=${encodeURIComponent(exported[0])}`
    : `${API}/files/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`;
}

/** The name a file is saved under on this PC: an exported document gets its Office extension. */
function localName(meta) {
  const ext = EXPORTS[meta.mimeType]?.[1];
  return ext && !meta.name.toLowerCase().endsWith(ext) ? `${meta.name}${ext}` : meta.name;
}

/** Files with something to download: not folders, and of Google's own kinds only those exported. */
const downloadable = (e) => e.mimeType !== FOLDER && (!e.mimeType?.startsWith("application/vnd.google-apps.") || Boolean(EXPORTS[e.mimeType]));

const actions = {
  async list({ account, folder, pattern, timeoutMs = 60000 }) {
    const token = tokenOf(account);
    const signal = AbortSignal.timeout(timeoutMs);
    const where = await item(token, folder, "folder", signal);
    const keep = matcher(pattern);
    const base = idOf(folder) ? undefined : parts(folder).join("/");
    return (await children(token, where.id, signal))
      .filter((e) => keep(e.name))
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
    const meta = await item(token, file, "file", signal);
    const exported = EXPORTS[meta.mimeType];
    if (!exported && meta.mimeType?.startsWith("application/vnd.google-apps.")) {
      throw new StepError("GDRIVE_NOT_DOWNLOADABLE", `'${meta.name}' is a Google ${meta.mimeType.split(".").pop()} and has no file to download`, {
        hint: "Google Sheets, Docs and Slides are saved as Excel, Word and PowerPoint files; other kinds cannot be downloaded.",
      });
    }
    const response = await drive(token, contentUrl(meta), { signal });
    if (!response.ok) throw await failure(response, `${meta.name} could not be downloaded`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeWhole(to, bytes);
    return { path: to, ...shape(meta), size: bytes.length };
  },

  async downloadFolder({ account, folder, to, pattern, overwrite = false, timeoutMs = 600000 }) {
    const token = tokenOf(account);
    const signal = AbortSignal.timeout(timeoutMs);
    const keep = matcher(pattern);
    const where = await item(token, folder, "folder", signal);
    const files = (await children(token, where.id, signal)).filter((e) => downloadable(e) && keep(e.name));
    // Google Drive lets two files share a name, and a spreadsheet "Report" is saved as Report.xlsx:
    // two files that would land on one name (Windows ignores case) stop the download before anything is saved.
    const seen = new Map();
    for (const e of files) {
      const key = localName(e).toLowerCase();
      if (seen.has(key)) {
        throw new StepError("GDRIVE_NAME_CLASH", `'${seen.get(key)}' and '${e.name}' would both be saved as ${localName(e)}`, {
          hint: "Rename one of them in Google Drive, or narrow the files with pattern.",
        });
      }
      seen.set(key, e.name);
    }
    if (!overwrite) await refuseExisting(files.map((e) => join(to, localName(e))));
    const saved = [];
    for (const e of files) {
      const response = await drive(token, contentUrl(e), { signal });
      if (!response.ok) throw await failure(response, `${e.name} could not be downloaded`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const path = join(to, localName(e));
      await writeWhole(path, bytes);
      saved.push({ path, ...shape(e), name: localName(e), size: bytes.length });
    }
    return { folder: to, files: saved };
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
      throw new StepError("GDRIVE_FILE_TOO_LARGE", `${path} is ${Math.round(bytes.length / 1024 / 1024)} MB; this node sends up to 50 MB`, {
        hint: "Split the file, or put it in a Google Drive for desktop folder instead.",
      });
    }
    const parent = await item(token, folder, "folder", signal);
    const fileName = (name ?? "").trim() || basename(path);
    const [existing] = await children(token, parent.id, signal, ` and name = '${q(fileName)}' and mimeType != '${FOLDER}'`);
    if (existing && !overwrite) {
      throw new StepError("GDRIVE_FILE_EXISTS", `'${fileName}' is already in that Google Drive folder`, { hint: "Set overwrite: true to replace its content (Drive keeps the old one as a revision)." });
    }
    // A resumable upload in one piece: the same call for a new file and for a new revision.
    const start = existing
      ? await drive(token, `${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&supportsAllDrives=true&fields=${FIELDS}`, {
          method: "PATCH",
          body: "{}",
          headers: { "content-type": "application/json; charset=UTF-8" },
          signal,
        })
      : await drive(token, `${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${FIELDS}`, {
          method: "POST",
          body: JSON.stringify({ name: fileName, parents: [parent.id] }),
          headers: { "content-type": "application/json; charset=UTF-8" },
          signal,
        });
    if (!start.ok) throw await failure(start, `${fileName} could not be uploaded`);
    const session = start.headers.get("location");
    if (!session) throw new StepError("GDRIVE_REQUEST_FAILED", "Google Drive gave no upload address");
    const response = await drive(token, session, { method: "PUT", body: bytes, headers: { "content-length": String(bytes.length) }, signal });
    if (!response.ok) throw await failure(response, `${fileName} could not be uploaded`);
    const done = await response.json();
    return { id: done.id, name: done.name ?? fileName, size: Number(done.size ?? bytes.length), replaced: Boolean(existing) };
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
    const e = timedOut ? new StepError("GDRIVE_TIMEOUT", "Google Drive did not finish in time", { retryable: true }) : error;
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
