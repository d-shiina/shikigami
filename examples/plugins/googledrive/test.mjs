// Runs the extension against a stand-in for the Drive API on this PC:
// node --test examples/plugins/googledrive/
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const dir = new URL(".", import.meta.url);
const FOLDER = "application/vnd.google-apps.folder";
let server;
let base;
const sessions = [];

// My Drive ─ 経理 (f10) ─ 受注 (f11) ─ 受注.xlsx (x100), 集計 (Sheets, s101), メモ.txt (t102)
const ITEMS = [
  { id: "f10", name: "経理", mimeType: FOLDER, parent: "root" },
  { id: "f11", name: "受注", mimeType: FOLDER, parent: "f10" },
  { id: "x100", name: "受注.xlsx", mimeType: "application/octet-stream", size: "5", modifiedTime: "2026-11-09T00:00:00Z", parent: "f11", body: "BOOK!" },
  { id: "s101", name: "集計", mimeType: "application/vnd.google-apps.spreadsheet", parent: "f11" },
  { id: "t102", name: "メモ.txt", mimeType: "text/plain", size: "3", parent: "f11", body: "abc" },
];
const LONG = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
ITEMS.push({ id: LONG, name: "共有.csv", mimeType: "text/csv", size: "2", parent: "shared", body: "a," });

const meta = ({ id, name, mimeType, size, modifiedTime }) => ({ id, name, mimeType, ...(size ? { size } : {}), ...(modifiedTime ? { modifiedTime } : {}) });

before(async () => {
  const serve = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== "Bearer good-token") return json(401, { error: { code: 401, message: "Invalid Credentials" } });
    let m;
    if (url.pathname === "/api/files" && req.method === "GET") {
      const query = url.searchParams.get("q");
      const parent = query.match(/^'([^']+)' in parents/)[1];
      const name = query.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1];
      // Pages of one item, so paging is exercised.
      const all = ITEMS.filter((i) => i.parent === parent && (name === undefined || i.name === name) && !(name && i.mimeType === FOLDER));
      const at = Number(url.searchParams.get("pageToken") || 0);
      return json(200, { files: all.slice(at, at + 1).map(meta), ...(at + 1 < all.length ? { nextPageToken: String(at + 1) } : {}) });
    }
    if ((m = url.pathname.match(/^\/api\/files\/([^/]+)\/export$/))) {
      res.writeHead(200);
      return res.end(`EXPORT ${url.searchParams.get("mimeType").split(".").pop()}`);
    }
    if ((m = url.pathname.match(/^\/api\/files\/([^/]+)$/))) {
      const found = ITEMS.find((i) => i.id === m[1]);
      if (!found) return json(404, { error: { code: 404, message: "File not found" } });
      if (url.searchParams.get("alt") === "media") {
        res.writeHead(200);
        return res.end(found.body);
      }
      return json(200, meta(found));
    }
    if (url.pathname === "/upload/files" && req.method === "POST") {
      const metadata = JSON.parse(body.toString("utf8"));
      sessions.push({ kind: "create", metadata });
      return json(200, {}, { location: `${base}/session/new/${encodeURIComponent(metadata.name)}` });
    }
    if ((m = url.pathname.match(/^\/upload\/files\/([^/]+)$/)) && req.method === "PATCH") {
      sessions.push({ kind: "update", id: m[1] });
      return json(200, {}, { location: `${base}/session/old/${m[1]}` });
    }
    if ((m = url.pathname.match(/^\/session\/(new|old)\/(.+)$/)) && req.method === "PUT") {
      sessions.at(-1).body = body.toString("utf8");
      return json(200, m[1] === "new" ? { id: "n200", name: decodeURIComponent(m[2]), size: String(body.length) } : { id: m[2], name: "メモ.txt", size: String(body.length) });
    }
    json(404, { error: { code: 404, message: "Not found" } });
  };
  server = createServer((req, res) =>
    serve(req, res).catch((e) => {
      console.error(e);
      res.writeHead(500);
      res.end(String(e));
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function plugin() {
  const child = spawn(process.execPath, ["main.mjs"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, SPELLSHEET_GDRIVE_API: `${base}/api`, SPELLSHEET_GDRIVE_UPLOAD: `${base}/upload` },
  });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  return {
    call(method, params) {
      id += 1;
      const at = id;
      return new Promise((resolve) => {
        waiting.set(at, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: at, method, params: { runId: "r1", timeoutMs: 10000, ...params } })}\n`);
      });
    },
    close: () => child.stdin.end(),
  };
}

const work = mkdtempSync(join(tmpdir(), "gdrive-"));

test("lists a folder named by its path, keeping the names that match", async () => {
  const p = plugin();
  const answer = await p.call("list", { account: "good-token", folder: "経理/受注", pattern: "*.XLSX" });
  p.close();
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual(answer.result, [{ id: "x100", name: "受注.xlsx", type: "file", size: 5, modifiedAt: "2026-11-09T00:00:00Z", path: "経理/受注/受注.xlsx" }]);
});

test("downloads by path or by address, saves Sheets as Excel, and refuses to replace without overwrite", async () => {
  const p = plugin();
  const to = join(work, "input", "受注.xlsx");
  const first = await p.call("download", { account: "good-token", file: "経理/受注/受注.xlsx", to });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  assert.equal(readFileSync(to, "utf8"), "BOOK!");
  const again = await p.call("download", { account: "good-token", file: "経理/受注/受注.xlsx", to });
  assert.equal(again.error.data.code, "FILE_EXISTS");
  const shared = join(work, "共有.csv");
  const byLink = await p.call("download", { account: "good-token", file: `https://drive.google.com/file/d/${LONG}/view?usp=sharing`, to: shared });
  assert.equal(byLink.error, undefined, JSON.stringify(byLink.error));
  assert.equal(readFileSync(shared, "utf8"), "a,");
  const sheet = join(work, "集計.xlsx");
  const exported = await p.call("download", { account: "good-token", file: "経理/受注/集計", to: sheet });
  assert.equal(exported.error, undefined, JSON.stringify(exported.error));
  assert.equal(readFileSync(sheet, "utf8"), "EXPORT sheet");
  p.close();
});

test("downloads the files of a folder, saving Sheets as Excel", async () => {
  const p = plugin();
  const to = join(work, "folder-in");
  const answer = await p.call("downloadFolder", { account: "good-token", folder: "経理/受注", to });
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual(answer.result.files.map((f) => f.name), ["受注.xlsx", "集計.xlsx", "メモ.txt"]);
  assert.equal(readFileSync(join(to, "集計.xlsx"), "utf8"), "EXPORT sheet");
  const named = await p.call("downloadFolder", { account: "good-token", folder: "経理/受注", to, names: ["集計.xlsx"], overwrite: true });
  assert.deepEqual(named.result.files.map((f) => f.name), ["集計.xlsx"]);
  const again = await p.call("downloadFolder", { account: "good-token", folder: "経理/受注", to, pattern: "*.txt" });
  assert.equal(again.error.data.code, "FILE_EXISTS");
  p.close();
});

test("refuses a file whose name would be saved outside the folder", async () => {
  ITEMS.push({ id: "x104", name: "../escaped.txt", mimeType: "text/plain", size: "1", parent: "f11", body: "E" });
  const p = plugin();
  const to = join(work, "escape", "input");
  const answer = await p.call("downloadFolder", { account: "good-token", folder: "経理/受注", to, overwrite: true });
  ITEMS.pop();
  p.close();
  assert.equal(answer.error.data.code, "FILE_NAME_NOT_ALLOWED");
  assert.throws(() => readFileSync(join(work, "escape", "escaped.txt")));
  assert.throws(() => readFileSync(join(to, "受注.xlsx")));
});

test("refuses a folder where two files would be saved under one name", async () => {
  ITEMS.push({ id: "x103", name: "集計.XLSX", mimeType: "application/octet-stream", size: "1", parent: "f11", body: "B" });
  const p = plugin();
  const to = join(work, "clash");
  const answer = await p.call("downloadFolder", { account: "good-token", folder: "経理/受注", to });
  ITEMS.pop();
  p.close();
  assert.equal(answer.error.data.code, "GDRIVE_NAME_CLASH");
  assert.throws(() => readFileSync(join(to, "受注.xlsx")));
});

test("uploads a new file, and replaces an existing one only with overwrite", async () => {
  const p = plugin();
  const path = join(work, "メモ.txt");
  writeFileSync(path, "new!");
  const refused = await p.call("upload", { account: "good-token", path, folder: "経理/受注" });
  assert.equal(refused.error.data.code, "GDRIVE_FILE_EXISTS");
  const replaced = await p.call("upload", { account: "good-token", path, folder: "経理/受注", overwrite: true });
  assert.equal(replaced.error, undefined, JSON.stringify(replaced.error));
  assert.deepEqual(replaced.result, { id: "t102", name: "メモ.txt", size: 4, replaced: true });
  assert.deepEqual(sessions.at(-1), { kind: "update", id: "t102", body: "new!" });
  const created = await p.call("upload", { account: "good-token", path, folder: "経理/受注", name: "メモ2.txt" });
  assert.deepEqual(created.result, { id: "n200", name: "メモ2.txt", size: 4, replaced: false });
  assert.deepEqual(sessions.at(-1).metadata, { name: "メモ2.txt", parents: ["f11"] });
  p.close();
});

test("explains a missing sign-in, a wrong path and a missing file", async () => {
  const p = plugin();
  const auth = await p.call("list", { account: "expired", folder: "経理" });
  assert.equal(auth.error.data.code, "GDRIVE_AUTH_FAILED");
  assert.match(auth.error.data.details.hint, /oauth\.signIn/);
  const none = await p.call("list", { folder: "経理" });
  assert.equal(none.error.data.code, "GDRIVE_AUTH_FAILED");
  const path = await p.call("download", { account: "good-token", file: "経理/売上/a.xlsx", to: join(work, "a.xlsx") });
  assert.equal(path.error.data.code, "GDRIVE_NOT_FOUND");
  assert.match(path.error.data.details.hint, /受注/);
  const local = await p.call("upload", { account: "good-token", path: join(work, "ない.txt"), folder: "経理" });
  assert.equal(local.error.data.code, "FILE_NOT_FOUND");
  p.close();
});
