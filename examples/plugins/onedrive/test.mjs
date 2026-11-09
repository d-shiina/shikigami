// Runs the extension against a stand-in for Microsoft Graph on this PC:
// node --test examples/plugins/onedrive/
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
const puts = [];
let sessionAuth = "unset";

// My OneDrive ─ 経理 (f10) ─ 受注 (f11) ─ 受注.xlsx (x100), メモ.txt (t101)
// A SharePoint library (drive "sp") ─ 共有 (f20) ─ 共有.csv (c200)
const ROOT = { id: "root", name: "root", folder: {}, parentReference: { driveId: "me1" } };
const ITEMS = {
  f10: { id: "f10", name: "経理", folder: {}, parentReference: { driveId: "me1", id: "root" } },
  f11: { id: "f11", name: "受注", folder: {}, parentReference: { driveId: "me1", id: "f10" } },
  x100: { id: "x100", name: "受注.xlsx", file: {}, size: 5, lastModifiedDateTime: "2026-11-09T00:00:00Z", parentReference: { driveId: "me1", id: "f11" }, body: "BOOK!" },
  t101: { id: "t101", name: "メモ.txt", file: {}, size: 3, parentReference: { driveId: "me1", id: "f11" }, body: "abc" },
  f20: { id: "f20", name: "共有", folder: {}, parentReference: { driveId: "sp", id: "sproot" } },
  c200: { id: "c200", name: "共有.csv", file: {}, size: 2, parentReference: { driveId: "sp", id: "f20" }, body: "a," },
};
const PATHS = { "経理": "f10", "経理/受注": "f11", "経理/受注/受注.xlsx": "x100", "経理/受注/メモ.txt": "t101" };
const SHARED_FILE = "https://contoso.sharepoint.com/:x:/s/keiri/EabcDEF?e=xyz";
const SHARED_FOLDER = "https://contoso.sharepoint.com/sites/keiri/Shared Documents/共有";
const SHARES = { [SHARED_FILE]: "c200", [SHARED_FOLDER]: "f20" };
const view = ({ body, ...rest }) => rest;

before(async () => {
  const serve = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    const path = decodeURIComponent(url.pathname);
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path.startsWith("/session/")) {
      sessionAuth = req.headers.authorization;
      puts.push({ path, range: req.headers["content-range"], size: body.length });
      const [, total] = req.headers["content-range"].match(/\/(\d+)$/);
      const end = Number(req.headers["content-range"].match(/-(\d+)\//)[1]);
      return end + 1 === Number(total) ? json(201, { id: "n300", name: "大きい.bin", size: Number(total) }) : json(202, { nextExpectedRanges: [`${end + 1}-`] });
    }
    if (req.headers.authorization !== "Bearer good-token") return json(401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });
    let m;
    if (path === "/api/me/drive/root") return json(200, ROOT);
    if ((m = path.match(/^\/api\/me\/drive\/root:\/(.+):$/))) {
      const id = PATHS[m[1]];
      return id ? json(200, view(ITEMS[id])) : json(404, { error: { code: "itemNotFound", message: "The resource could not be found." } });
    }
    if ((m = path.match(/^\/api\/shares\/u!([^/]+)\/driveItem$/))) {
      const link = Buffer.from(m[1], "base64url").toString("utf8");
      const id = SHARES[link];
      return id ? json(200, view(ITEMS[id])) : json(404, { error: { code: "itemNotFound" } });
    }
    if ((m = path.match(/^\/api\/(?:me\/drive|drives\/[^/]+)\/items\/([^/]+)\/children$/))) {
      const all = Object.values(ITEMS).filter((i) => i.parentReference.id === m[1]).map(view);
      // Pages of one item, so paging is exercised.
      const at = Number(url.searchParams.get("skip") || 0);
      const next = at + 1 < all.length ? `${base}${url.pathname}?skip=${at + 1}` : undefined;
      return json(200, { value: all.slice(at, at + 1), ...(next ? { "@odata.nextLink": next } : {}) });
    }
    if ((m = path.match(/^\/api\/(?:me\/drive|drives\/[^/]+)\/items\/([^/:]+)\/content$/))) {
      res.writeHead(302, { location: `${downloadBase}/download/${m[1]}` });
      return res.end();
    }
    if ((m = path.match(/^\/api\/(?:me\/drive|drives\/([^/]+))\/items\/([^/:]+):\/([^:]+):\/content$/)) && req.method === "PUT") {
      const exists = Object.values(ITEMS).some((i) => i.parentReference.id === m[2] && i.name === m[3]);
      const behavior = url.searchParams.get("@microsoft.graph.conflictBehavior");
      puts.push({ path, behavior, body: body.toString("utf8") });
      if (exists && behavior === "fail") return json(409, { error: { code: "nameAlreadyExists" } });
      return json(exists ? 200 : 201, { id: exists ? "t101" : "n200", name: m[3], size: body.length, webUrl: `https://example/${m[3]}` });
    }
    if ((m = path.match(/:\/([^:]+):\/createUploadSession$/)) && req.method === "POST") {
      return json(200, { uploadUrl: `${base}/session/${encodeURIComponent(m[1])}` });
    }
    json(404, { error: { code: "itemNotFound" } });
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
  // The pre-authenticated download address Graph redirects to is another site.
  downloads = createServer((req, res) => {
    downloadAuth = req.headers.authorization;
    const id = req.url.split("/").pop();
    res.writeHead(ITEMS[id] ? 200 : 404);
    res.end(ITEMS[id]?.body ?? "");
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
    env: { ...process.env, SPELLSHEET_GRAPH_API: `${base}/api` },
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

const work = mkdtempSync(join(tmpdir(), "onedrive-"));

test("lists a folder named by its path or by a SharePoint link", async () => {
  const p = plugin();
  const answer = await p.call("list", { account: "good-token", folder: "経理/受注", pattern: "*.XLSX" });
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual(answer.result, [{ id: "x100", name: "受注.xlsx", type: "file", size: 5, modifiedAt: "2026-11-09T00:00:00Z", path: "経理/受注/受注.xlsx" }]);
  const shared = await p.call("list", { account: "good-token", folder: SHARED_FOLDER });
  assert.deepEqual(shared.result, [{ id: "c200", name: "共有.csv", type: "file", size: 2 }]);
  p.close();
});

test("downloads by path or by a sharing link, without sending the token to the download address", async () => {
  const p = plugin();
  const to = join(work, "input", "受注.xlsx");
  const first = await p.call("download", { account: "good-token", file: "経理/受注/受注.xlsx", to });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  assert.equal(readFileSync(to, "utf8"), "BOOK!");
  assert.equal(downloadAuth, undefined);
  const again = await p.call("download", { account: "good-token", file: "経理/受注/受注.xlsx", to });
  assert.equal(again.error.data.code, "FILE_EXISTS");
  const shared = join(work, "共有.csv");
  const byLink = await p.call("download", { account: "good-token", file: SHARED_FILE, to: shared });
  assert.equal(byLink.error, undefined, JSON.stringify(byLink.error));
  assert.equal(readFileSync(shared, "utf8"), "a,");
  p.close();
});

test("downloads the files of a OneDrive folder or a SharePoint one", async () => {
  const p = plugin();
  const to = join(work, "folder-in");
  const mine = await p.call("downloadFolder", { account: "good-token", folder: "経理/受注", to, pattern: "*.xlsx" });
  assert.equal(mine.error, undefined, JSON.stringify(mine.error));
  assert.deepEqual(mine.result.files.map((f) => f.name), ["受注.xlsx"]);
  assert.equal(readFileSync(join(to, "受注.xlsx"), "utf8"), "BOOK!");
  const shared = await p.call("downloadFolder", { account: "good-token", folder: SHARED_FOLDER, to });
  assert.equal(shared.error, undefined, JSON.stringify(shared.error));
  assert.equal(readFileSync(join(to, "共有.csv"), "utf8"), "a,");
  const again = await p.call("downloadFolder", { account: "good-token", folder: SHARED_FOLDER, to });
  assert.equal(again.error.data.code, "FILE_EXISTS");
  p.close();
});

test("uploads into a OneDrive folder or a SharePoint one, replacing only with overwrite", async () => {
  const p = plugin();
  const path = join(work, "メモ.txt");
  writeFileSync(path, "new!");
  const refused = await p.call("upload", { account: "good-token", path, folder: "経理/受注" });
  assert.equal(refused.error.data.code, "ONEDRIVE_FILE_EXISTS");
  const replaced = await p.call("upload", { account: "good-token", path, folder: "経理/受注", overwrite: true });
  assert.equal(replaced.error, undefined, JSON.stringify(replaced.error));
  assert.equal(puts.at(-1).behavior, "replace");
  assert.equal(puts.at(-1).body, "new!");
  const toSharePoint = await p.call("upload", { account: "good-token", path, folder: SHARED_FOLDER });
  assert.equal(toSharePoint.error, undefined, JSON.stringify(toSharePoint.error));
  assert.equal(puts.at(-1).path, "/api/drives/sp/items/f20:/メモ.txt:/content");
  p.close();
});

test("sends a file over 4 MB in pieces to the upload address, without the token", async () => {
  const p = plugin();
  const path = join(work, "大きい.bin");
  writeFileSync(path, Buffer.alloc(12 * 1024 * 1024, 1));
  const before = puts.length;
  const answer = await p.call("upload", { account: "good-token", path, folder: "経理" });
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.equal(answer.result.id, "n300");
  const pieces = puts.slice(before);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].range, `bytes 0-${32 * 320 * 1024 - 1}/${12 * 1024 * 1024}`);
  assert.equal(sessionAuth, undefined);
  p.close();
});

test("explains a missing sign-in, a wrong path and a missing file", async () => {
  const p = plugin();
  const auth = await p.call("list", { account: "expired", folder: "経理" });
  assert.equal(auth.error.data.code, "ONEDRIVE_AUTH_FAILED");
  assert.match(auth.error.data.details.hint, /oauth\.signIn/);
  const none = await p.call("list", { folder: "経理" });
  assert.equal(none.error.data.code, "ONEDRIVE_AUTH_FAILED");
  const path = await p.call("download", { account: "good-token", file: "経理/売上/a.xlsx", to: join(work, "a.xlsx") });
  assert.equal(path.error.data.code, "ONEDRIVE_NOT_FOUND");
  const local = await p.call("upload", { account: "good-token", path: join(work, "ない.txt"), folder: "経理" });
  assert.equal(local.error.data.code, "FILE_NOT_FOUND");
  p.close();
});
