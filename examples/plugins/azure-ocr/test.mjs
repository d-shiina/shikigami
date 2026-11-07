// Runs the extension against a stand-in for Azure on this PC:
// node --test examples/plugins/azure-ocr/
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const dir = new URL(".", import.meta.url);
let server;
let endpoint;
const seen = [];

before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, key: req.headers["ocp-apim-subscription-key"], body });
    if (req.headers["ocp-apim-subscription-key"] !== "good-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "401", message: "Access denied due to invalid subscription key." } }));
      return;
    }
    if (req.method === "POST") {
      res.writeHead(202, { "operation-location": `${endpoint}/operations/1`, "retry-after": "0" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "succeeded",
        analyzeResult: {
          content: "請求書\n合計 12,000円",
          pages: [{ pageNumber: 1, lines: [{ content: "請求書" }, { content: "合計 12,000円" }] }],
          tables: [{ rowCount: 2, columnCount: 2, cells: [
            { rowIndex: 0, columnIndex: 0, content: "品名" }, { rowIndex: 0, columnIndex: 1, content: "金額" },
            { rowIndex: 1, columnIndex: 0, content: "保守" }, { rowIndex: 1, columnIndex: 1, content: "12,000" },
          ] }],
          documents: [{ fields: {
            VendorName: { type: "string", valueString: "株式会社見本", content: "株式会社見本" },
            InvoiceTotal: { type: "currency", valueCurrency: { amount: 12000, currencyCode: "JPY" }, content: "12,000円" },
            Items: { type: "array", valueArray: [{ type: "object", valueObject: { Description: { type: "string", valueString: "保守" } } }] },
          } }],
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function plugin() {
  const child = spawn(process.execPath, ["main.mjs"], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
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
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: at, method, params })}\n`);
      });
    },
    close: () => child.stdin.end(),
  };
}

const file = join(mkdtempSync(join(tmpdir(), "azureocr-")), "invoice.png");
writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

test("reads text, tables and fields", async () => {
  const p = plugin();
  const answer = await p.call("readDocument", { endpoint: `${endpoint}/`, key: "good-key", path: file, model: "prebuilt-invoice", locale: "ja-JP", runId: "r1", timeoutMs: 10000 });
  p.close();
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual(answer.result.pages, [{ page: 1, lines: ["請求書", "合計 12,000円"] }]);
  assert.deepEqual(answer.result.tables[0].rows, [["品名", "金額"], ["保守", "12,000"]]);
  assert.deepEqual(answer.result.fields, { VendorName: "株式会社見本", InvoiceTotal: 12000, Items: [{ Description: "保守" }] });
  const post = seen.find((s) => s.method === "POST");
  assert.match(post.url, /^\/documentintelligence\/documentModels\/prebuilt-invoice:analyze\?api-version=2024-11-30&locale=ja-JP$/);
  assert.equal(JSON.parse(post.body).base64Source, "iVBORw==");
});

test("explains a wrong key, endpoint or file", async () => {
  const p = plugin();
  const auth = await p.call("readDocument", { endpoint, key: "bad", path: file, timeoutMs: 10000 });
  assert.equal(auth.error.data.code, "AZURE_AUTH_FAILED");
  assert.match(auth.error.data.details.hint, /API キー/);
  const http = await p.call("readDocument", { endpoint: "http://example.com", key: "good-key", path: file });
  assert.equal(http.error.data.code, "AZURE_ENDPOINT_INVALID");
  const type = await p.call("readDocument", { endpoint, key: "good-key", path: "a.docx" });
  assert.equal(type.error.data.code, "AZURE_FILE_TYPE");
  const model = await p.call("readDocument", { endpoint, key: "good-key", path: file, model: "custom" });
  assert.equal(model.error.data.code, "AZURE_MODEL_UNKNOWN");
  p.close();
});
