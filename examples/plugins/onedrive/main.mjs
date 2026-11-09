// SpellSheet extension: OneDrive and SharePoint (list a folder, download,
// upload) through Microsoft Graph, for PCs without the OneDrive app syncing
// those folders and for unattended runs.
//
// Newline-delimited JSON-RPC 2.0 on stdin/stdout, as every SpellSheet
// extension speaks (docs/extensions.md). No dependencies: Node.js 18 or
// later (SpellSheet ships one) has fetch.
//
// `account` arrives as the OAuth access token of a registered secret: the
// host signs in with oauth.signIn and refreshes the token before each call,
// so this extension never sees the client secret or the refresh token.
// Folders and files are named by a path from the signed-in user's OneDrive
// ("経理/受注/受注.xlsx"), or by a link to them: a sharing link ("Copy link"
// in OneDrive or SharePoint) or the address of a file or folder in a
// SharePoint document library, which is how SharePoint is reached.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

// The API's address; a test points it at a stand-in on this PC.
const GRAPH = (process.env.SPELLSHEET_GRAPH_API ?? "https://graph.microsoft.com/v1.0").replace(/\/+$/, "");
const MAX_UPLOAD = 50 * 1024 * 1024;
// Graph takes up to 4 MB in one request; bigger files go in pieces (a multiple of 320 KiB).
const SIMPLE_UPLOAD = 4 * 1024 * 1024;
const CHUNK = 32 * 320 * 1024;
const SELECT = "id,name,size,lastModifiedDateTime,file,folder,parentReference,webUrl";

class StepError extends Error {
  constructor(code, message, { retryable = false, hint } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = hint ? { hint } : undefined;
  }
}

const SIGN_IN_HINT =
  "Put an oauth.signIn step with this secret before this node (authorizeUrl https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize, tokenUrl https://login.microsoftonline.com/organizations/oauth2/v2.0/token, scope \"offline_access Files.ReadWrite.All Sites.ReadWrite.All\"), and give the secret's sites plugin:onedrive.";

/** What Graph said, as a step error. */
async function failure(response, what) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message ?? body?.error?.code ?? "";
  } catch {
    // Not JSON: the status is enough.
  }
  const status = response.status;
  const message = `${what}: Microsoft Graph answered ${status}${detail ? ` (${detail})` : ""}`;
  if (status === 401) return new StepError("ONEDRIVE_AUTH_FAILED", message, { hint: SIGN_IN_HINT });
  if (status === 403) {
    return new StepError("ONEDRIVE_ACCESS_DENIED", message, {
      hint: "The signed-in user cannot use this item, or the app lacks the permissions Files.ReadWrite.All (and Sites.ReadWrite.All for SharePoint).",
    });
  }
  if (status === 404) {
    return new StepError("ONEDRIVE_NOT_FOUND", message, {
      hint: "Check the path from your OneDrive (e.g. 経理/受注/受注.xlsx), or paste the file's link from OneDrive or SharePoint.",
    });
  }
  if (status === 409) return new StepError("ONEDRIVE_FILE_EXISTS", message, { hint: "Set overwrite: true to replace it." });
  if (status === 429) return new StepError("ONEDRIVE_RATE_LIMITED", message, { retryable: true, hint: "Too many requests; retry later." });
  if (status >= 500) return new StepError("ONEDRIVE_UNAVAILABLE", message, { retryable: true });
  return new StepError("ONEDRIVE_REQUEST_FAILED", message);
}

async function graph(token, url, { method = "GET", body, headers = {}, signal, auth = true } = {}) {
  try {
    return await fetch(url, { method, body, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...headers }, signal });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw e;
    throw new StepError("ONEDRIVE_UNREACHABLE", `cannot reach Microsoft Graph: ${e.cause?.message ?? e.message}`, {
      retryable: true,
      hint: "Check the network (proxy) and that graph.microsoft.com is not blocked.",
    });
  }
}

function tokenOf(account) {
  if (typeof account !== "string" || account === "") {
    throw new StepError("ONEDRIVE_AUTH_FAILED", "no Microsoft access token", {
      hint: `Choose a registered OAuth secret as { "secret": "Microsoft", "field": "accessToken" }. ${SIGN_IN_HINT}`,
    });
  }
  return account;
}

const isLink = (text) => /^https?:\/\//i.test(text.trim());

const parts = (path) =>
  path
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "");

/** A link as Graph's shares API takes it: u! and the link in unpadded base64url. */
const shareId = (link) => `u!${Buffer.from(link.trim(), "utf8").toString("base64url")}`;

/** The drive item a path or a link names; `drive` and `id` address it from then on. */
async function item(token, text, want, signal) {
  let response;
  if (isLink(text)) {
    response = await graph(token, `${GRAPH}/shares/${shareId(text)}/driveItem?$select=${SELECT}`, { signal });
  } else {
    const names = parts(text);
    const path = names.map(encodeURIComponent).join("/");
    response = await graph(token, `${GRAPH}/me/drive/root${path ? `:/${path}:` : ""}?$select=${SELECT}`, { signal });
  }
  if (!response.ok) throw await failure(response, `${text} could not be found`);
  const found = await response.json();
  const isFolder = Boolean(found.folder);
  if (isFolder !== (want === "folder")) throw new StepError("ONEDRIVE_NOT_FOUND", `'${text}' is not a ${want}`);
  return { ...found, drive: found.parentReference?.driveId ?? "me" };
}

const itemUrl = (it) => (it.drive === "me" ? `${GRAPH}/me/drive/items/${encodeURIComponent(it.id)}` : `${GRAPH}/drives/${encodeURIComponent(it.drive)}/items/${encodeURIComponent(it.id)}`);

/** Every item of a folder (Graph pages them). */
async function children(token, folder, signal) {
  const out = [];
  let url = `${itemUrl(folder)}/children?$select=${SELECT}&$top=999`;
  while (url) {
    const response = await graph(token, url, { signal });
    if (!response.ok) throw await failure(response, `the folder ${folder.name ?? folder.id} could not be listed`);
    const page = await response.json();
    out.push(...(page.value ?? []));
    url = page["@odata.nextLink"] ?? "";
  }
  return out;
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
  type: e.folder ? "folder" : "file",
  ...(e.size !== undefined && !e.folder ? { size: e.size } : {}),
  ...(e.lastModifiedDateTime ? { modifiedAt: e.lastModifiedDateTime } : {}),
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


/**
 * The name a remote file is saved under in `to`, refused unless it is one plain file name: a name with
 * \\ or / (Google Drive allows /), .., or : (a Windows stream) could write outside the folder.
 */
function placeIn(to, name) {
  const bad = !name || name === "." || name === ".." || /[\\/:<>"|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name);
  const path = resolve(to, name);
  if (bad || dirname(path) !== resolve(to)) {
    throw new StepError("FILE_NAME_NOT_ALLOWED", `'${name}' cannot be saved as a file on Windows`, { hint: "Rename the file in the cloud storage, or narrow the files with pattern." });
  }
  return path;
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

const actions = {
  async list({ account, folder, pattern, timeoutMs = 60000 }) {
    const token = tokenOf(account);
    const signal = AbortSignal.timeout(timeoutMs);
    const where = await item(token, folder ?? "", "folder", signal);
    const keep = matcher(pattern);
    const base = isLink(folder ?? "") ? undefined : parts(folder ?? "").join("/");
    return (await children(token, where, signal))
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
    // Graph answers with a redirect to a short-lived download address; fetch follows it.
    const response = await graph(token, `${itemUrl(meta)}/content`, { signal });
    if (!response.ok) throw await failure(response, `${meta.name} could not be downloaded`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeWhole(to, bytes);
    return { path: to, ...shape(meta), size: bytes.length };
  },

  async downloadFolder({ account, folder, to, pattern, overwrite = false, timeoutMs = 600000 }) {
    const token = tokenOf(account);
    const signal = AbortSignal.timeout(timeoutMs);
    const keep = matcher(pattern);
    const where = await item(token, folder ?? "", "folder", signal);
    const files = (await children(token, where, signal)).filter((e) => !e.folder && keep(e.name));
    const paths = files.map((e) => placeIn(to, e.name));
    if (!overwrite) await refuseExisting(paths);
    const saved = [];
    for (const e of files) {
      const response = await graph(token, `${itemUrl({ ...e, drive: e.parentReference?.driveId ?? where.drive })}/content`, { signal });
      if (!response.ok) throw await failure(response, `${e.name} could not be downloaded`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const path = paths[files.indexOf(e)];
      await writeWhole(path, bytes);
      saved.push({ path, ...shape(e), size: bytes.length });
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
      throw new StepError("ONEDRIVE_FILE_TOO_LARGE", `${path} is ${Math.round(bytes.length / 1024 / 1024)} MB; this node sends up to 50 MB`, {
        hint: "Split the file, or put it in a folder the OneDrive app syncs instead.",
      });
    }
    const parent = await item(token, folder ?? "", "folder", signal);
    const fileName = (name ?? "").trim() || basename(path);
    const target = `${itemUrl(parent)}:/${encodeURIComponent(fileName)}:`;
    const behavior = overwrite ? "replace" : "fail";
    let done;
    if (bytes.length <= SIMPLE_UPLOAD) {
      const response = await graph(token, `${target}/content?@microsoft.graph.conflictBehavior=${behavior}`, {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "application/octet-stream" },
        signal,
      });
      if (response.status === 409) throw new StepError("ONEDRIVE_FILE_EXISTS", `'${fileName}' is already in that folder`, { hint: "Set overwrite: true to replace it (the old one stays in the version history)." });
      if (!response.ok) throw await failure(response, `${fileName} could not be uploaded`);
      done = await response.json();
    } else {
      const start = await graph(token, `${target}/createUploadSession`, {
        method: "POST",
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": behavior } }),
        headers: { "content-type": "application/json" },
        signal,
      });
      if (start.status === 409) throw new StepError("ONEDRIVE_FILE_EXISTS", `'${fileName}' is already in that folder`, { hint: "Set overwrite: true to replace it (the old one stays in the version history)." });
      if (!start.ok) throw await failure(start, `${fileName} could not be uploaded`);
      const { uploadUrl } = await start.json();
      // The upload address carries its own permission; the token is not sent there.
      for (let from = 0; from < bytes.length; from += CHUNK) {
        const piece = bytes.subarray(from, Math.min(from + CHUNK, bytes.length));
        const response = await graph(token, uploadUrl, {
          method: "PUT",
          body: piece,
          auth: false,
          headers: { "content-range": `bytes ${from}-${from + piece.length - 1}/${bytes.length}`, "content-length": String(piece.length) },
          signal,
        });
        if (response.status === 409) throw new StepError("ONEDRIVE_FILE_EXISTS", `'${fileName}' is already in that folder`, { hint: "Set overwrite: true to replace it." });
        if (!response.ok) throw await failure(response, `${fileName} could not be uploaded`);
        if (response.status === 200 || response.status === 201) done = await response.json();
      }
    }
    return { id: done?.id, name: done?.name ?? fileName, size: done?.size ?? bytes.length, webUrl: done?.webUrl ?? null };
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
    const e = timedOut ? new StepError("ONEDRIVE_TIMEOUT", "Microsoft Graph did not finish in time", { retryable: true }) : error;
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
