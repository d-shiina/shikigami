// Runs the extension against a stand-in for the Box API on this PC:
// node --test examples/plugins/box/
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const dir = new URL(".", import.meta.url);
let server;
let base;
let downloads;
let downloadBase;
let downloadAuth = "unset";
const uploads = [];

// All Files ─ 経理 (10) ─ 受注 (11) ─ 受注.xlsx (100), メモ.txt (101)
const FOLDERS = {
  0: [{ type: "folder", id: "10", name: "経理" }],
  10: [{ type: "folder", id: "11", name: "受注" }],
  11: [
    { type: "file", id: "100", name: "受注.xlsx", size: 5, modified_at: "2026-11-09T09:00:00+09:00" },
    { type: "file", id: "101", name: "メモ.txt", size: 3, modified_at: "2026-11-08T09:00:00+09:00" },
  ],
};
const FILES = { 100: { name: "受注.xlsx", body: "BOOK!" }, 101: { name: "メモ.txt", body: "abc" } };

before(async () => {
  server = createServer((req, res) =>
    serve(req, res).catch((e) => {
      console.error(e);
      res.writeHead(500);
      res.end(String(e));
    }),
  );
  const serve = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, base);
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== "Bearer good-token") return json(401, { code: "unauthorized", message: "Unauthorized" });
    let m;
    if ((m = url.pathname.match(/^\/api\/folders\/(\d+)\/items$/))) {
      const all = FOLDERS[m[1]];
      if (!all) return json(404, { code: "not_found" });
      const offset = Number(url.searchParams.get("offset"));
      // Pages of one item, so paging is exercised.
      return json(200, { total_count: all.length, entries: all.slice(offset, offset + 1) });
    }
    if ((m = url.pathname.match(/^\/api\/files\/(\d+)$/))) {
      const f = FOLDERS[11].find((e) => e.id === m[1]);
      return f ? json(200, f) : json(404, { code: "not_found" });
    }
    if ((m = url.pathname.match(/^\/api\/files\/(\d+)\/content$/))) {
      res.writeHead(302, { location: `${downloadBase}/download/${m[1]}` });
      res.end();
      return;
    }
    if (url.pathname === "/upload/files/content" || /^\/upload\/files\/\d+\/content$/.test(url.pathname)) {
      const attributes = JSON.parse(body.match(/name="attributes"\r\n\r\n(.*?)\r\n/s)[1]);
      uploads.push({ path: url.pathname, attributes, body });
      if (url.pathname === "/upload/files/content" && FOLDERS[attributes.parent.id]?.some((e) => e.name === attributes.name)) {
        const existing = FOLDERS[attributes.parent.id].find((e) => e.name === attributes.name);
        return json(409, { code: "item_name_in_use", context_info: { conflicts: { id: existing.id, type: "file" } } });
      }
      return json(201, { total_count: 1, entries: [{ id: "200", name: attributes.name, size: 4, file_version: { id: "v2" } }] });
    }
    json(404, { code: "not_found" });
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // The short-lived download address Box redirects to is another site.
  downloads = createServer((req, res) => {
    downloadAuth = req.headers.authorization;
    const id = req.url.split("/").pop();
    res.writeHead(FILES[id] ? 200 : 404);
    res.end(FILES[id]?.body ?? "");
  });
  await new Promise((resolve) => downloads.listen(0, "127.0.0.1", resolve));
  downloadBase = `http://localhost:${downloads.address().port}`;
});

after(() => {
  server.close();
  downloads.close();
});

function plugin() {
  const child = spawn(process.execPath, ["main.mjs"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, SPELLSHEET_BOX_API: `${base}/api`, SPELLSHEET_BOX_UPLOAD: `${base}/upload` },
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

const work = mkdtempSync(join(tmpdir(), "box-"));

test("lists a folder named by its path, keeping the names that match", async () => {
  const p = plugin();
  const answer = await p.call("list", { account: "good-token", folder: "経理/受注", pattern: "*.XLSX" });
  p.close();
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual(answer.result, [
    { id: "100", name: "受注.xlsx", type: "file", size: 5, modifiedAt: "2026-11-09T09:00:00+09:00", path: "経理/受注/受注.xlsx" },
  ]);
});

test("downloads by path into a new folder, and refuses to replace without overwrite", async () => {
  const p = plugin();
  const to = join(work, "input", "受注.xlsx");
  const first = await p.call("download", { account: "good-token", file: "経理/受注/受注.xlsx", to });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  assert.equal(readFileSync(to, "utf8"), "BOOK!");
  // The token goes to Box only, not to the download address.
  assert.equal(downloadAuth, undefined);
  assert.deepEqual({ id: first.result.id, name: first.result.name, size: first.result.size }, { id: "100", name: "受注.xlsx", size: 5 });
  const again = await p.call("download", { account: "good-token", file: "100", to });
  assert.equal(again.error.data.code, "FILE_EXISTS");
  const replaced = await p.call("download", { account: "good-token", file: "100", to, overwrite: true });
  assert.equal(replaced.error, undefined);
  p.close();
});

test("downloads the files of a folder that match, checking for files already there first", async () => {
  const p = plugin();
  const to = join(work, "folder-in");
  const first = await p.call("downloadFolder", { account: "good-token", folder: "経理/受注", to, pattern: "*.xlsx" });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  assert.deepEqual(first.result.files.map((f) => f.name), ["受注.xlsx"]);
  assert.equal(readFileSync(join(to, "受注.xlsx"), "utf8"), "BOOK!");
  const all = await p.call("downloadFolder", { account: "good-token", folder: "11", to });
  assert.equal(all.error.data.code, "FILE_EXISTS");
  assert.throws(() => readFileSync(join(to, "メモ.txt")));
  const named = await p.call("downloadFolder", { account: "good-token", folder: "11", to, names: ["メモ.txt"], overwrite: true });
  assert.deepEqual(named.result.files.map((f) => f.name), ["メモ.txt"]);
  const replaced = await p.call("downloadFolder", { account: "good-token", folder: "11", to, overwrite: true });
  assert.deepEqual(replaced.result.files.map((f) => f.name), ["受注.xlsx", "メモ.txt"]);
  p.close();
});

test("uploads, and adds a new version only with overwrite", async () => {
  const p = plugin();
  const path = join(work, "メモ.txt");
  writeFileSync(path, "new!");
  const refused = await p.call("upload", { account: "good-token", path, folder: "経理/受注" });
  assert.equal(refused.error.data.code, "BOX_FILE_EXISTS");
  const added = await p.call("upload", { account: "good-token", path, folder: "11", overwrite: true });
  assert.equal(added.error, undefined, JSON.stringify(added.error));
  assert.deepEqual(added.result, { id: "200", name: "メモ.txt", size: 4, version: "v2" });
  assert.equal(uploads.at(-1).path, "/upload/files/101/content");
  const renamed = await p.call("upload", { account: "good-token", path, folder: "11", name: "メモ2.txt" });
  assert.equal(renamed.result.name, "メモ2.txt");
  assert.deepEqual(uploads.at(-1).attributes, { name: "メモ2.txt", parent: { id: "11" } });
  p.close();
});

test("explains a missing sign-in, a wrong path and a missing file", async () => {
  const p = plugin();
  const auth = await p.call("list", { account: "expired", folder: "0" });
  assert.equal(auth.error.data.code, "BOX_AUTH_FAILED");
  assert.match(auth.error.data.details.hint, /oauth\.signIn/);
  const none = await p.call("list", { folder: "0" });
  assert.equal(none.error.data.code, "BOX_AUTH_FAILED");
  const path = await p.call("download", { account: "good-token", file: "経理/売上/a.xlsx", to: join(work, "a.xlsx") });
  assert.equal(path.error.data.code, "BOX_NOT_FOUND");
  assert.match(path.error.data.details.hint, /受注/);
  const local = await p.call("upload", { account: "good-token", path: join(work, "ない.txt"), folder: "0" });
  assert.equal(local.error.data.code, "FILE_NOT_FOUND");
  p.close();
});
