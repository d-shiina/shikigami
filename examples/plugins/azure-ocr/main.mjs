// SpellSheet extension: Azure AI Document Intelligence (cloud AI-OCR).
//
// Newline-delimited JSON-RPC 2.0 on stdin/stdout, as every SpellSheet
// extension speaks (docs/extensions.md). No dependencies: Node.js 18 or
// later (SpellSheet ships one) has fetch.
//
// readDocument sends the file to the Azure resource at `endpoint`, waits
// for the analysis and returns { text, pages, tables, fields, model }.

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createInterface } from "node:readline";

const API_VERSION = "2024-11-30";
const MODELS = new Set(["prebuilt-read", "prebuilt-layout", "prebuilt-invoice", "prebuilt-receipt"]);
const TYPES = { ".pdf": "PDF", ".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".tif": "TIFF", ".tiff": "TIFF", ".bmp": "BMP", ".heif": "HEIF" };

class StepError extends Error {
  constructor(code, message, { retryable = false, hint } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = hint ? { hint } : undefined;
  }
}

/** `https://<name>.cognitiveservices.azure.com` without a trailing slash. Plain http only on this PC (tests). */
function baseUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new StepError("AZURE_ENDPOINT_INVALID", `'${endpoint}' is not a URL`, {
      hint: "Copy the endpoint from the resource's 「キーとエンドポイント」 page in the Azure portal, e.g. https://<name>.cognitiveservices.azure.com",
    });
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new StepError("AZURE_ENDPOINT_INVALID", `'${endpoint}' is not an https URL`, { hint: "Write the endpoint starting with https://" });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** What Azure said, as a step error. */
async function failure(response, what) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message ?? "";
  } catch {
    // Not JSON: the status is enough.
  }
  const status = response.status;
  const message = `${what}: Azure answered ${status}${detail ? ` (${detail})` : ""}`;
  if (status === 401 || status === 403) {
    return new StepError("AZURE_AUTH_FAILED", message, {
      hint: "Check that the secret holds key 1 or key 2 of this resource (API キー) and that the endpoint belongs to the same resource.",
    });
  }
  if (status === 404) {
    return new StepError("AZURE_NOT_FOUND", message, {
      hint: "Check the endpoint (https://<name>.cognitiveservices.azure.com) and that the resource is Document Intelligence (Form Recognizer).",
    });
  }
  if (status === 429) return new StepError("AZURE_RATE_LIMITED", message, { retryable: true, hint: "Too many requests for the pricing tier; retry later." });
  if (status >= 500) return new StepError("AZURE_UNAVAILABLE", message, { retryable: true });
  return new StepError("AZURE_REQUEST_FAILED", message);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

/** A field of a prebuilt model as a plain value: text, number, date, amount, list or object. */
function fieldValue(field) {
  if (!field || typeof field !== "object") return null;
  if (Array.isArray(field.valueArray)) return field.valueArray.map(fieldValue);
  if (field.valueObject) return Object.fromEntries(Object.entries(field.valueObject).map(([k, v]) => [k, fieldValue(v)]));
  if (field.valueCurrency) return field.valueCurrency.amount ?? null;
  for (const key of ["valueString", "valueNumber", "valueInteger", "valueDate", "valueTime", "valuePhoneNumber", "valueCountryRegion", "valueBoolean"]) {
    if (field[key] !== undefined) return field[key];
  }
  if (field.valueAddress) return field.content ?? null;
  return field.content ?? null;
}

function tableRows(table) {
  const rows = Array.from({ length: table.rowCount ?? 0 }, () => Array.from({ length: table.columnCount ?? 0 }, () => ""));
  for (const cell of table.cells ?? []) {
    if (rows[cell.rowIndex]) rows[cell.rowIndex][cell.columnIndex] = cell.content ?? "";
  }
  return { rows };
}

/** The analysis in the shape the step returns. */
function shape(result, model) {
  return {
    model,
    text: result.content ?? "",
    pages: (result.pages ?? []).map((p) => ({ page: p.pageNumber, lines: (p.lines ?? []).map((l) => l.content) })),
    tables: (result.tables ?? []).map(tableRows),
    fields: Object.fromEntries(Object.entries(result.documents?.[0]?.fields ?? {}).map(([k, v]) => [k, fieldValue(v)])),
  };
}

const actions = {
  async readDocument({ endpoint, key, path, model = "prebuilt-read", locale, timeoutMs = 120000 }) {
    if (!MODELS.has(model)) {
      throw new StepError("AZURE_MODEL_UNKNOWN", `'${model}' is not a model this extension reads`, { hint: `Use one of ${[...MODELS].join(", ")}.` });
    }
    if (!key) throw new StepError("AZURE_KEY_MISSING", "no key was given", { hint: "Pick the registered secret (API キー) in the node's settings." });
    if (!TYPES[extname(path).toLowerCase()]) {
      throw new StepError("AZURE_FILE_TYPE", `'${path}' is not an image or PDF`, { hint: "Use a PDF, PNG, JPEG, TIFF, BMP or HEIF file." });
    }
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (e) {
      throw new StepError("FILE_NOT_FOUND", `cannot read ${path}: ${e.message}`, { hint: "Check the file's path; a relative path is read from the flow's folder." });
    }
    const signal = AbortSignal.timeout(timeoutMs);
    const base = baseUrl(endpoint);
    const query = new URLSearchParams({ "api-version": API_VERSION });
    if (locale) query.set("locale", locale);
    const headers = { "Ocp-Apim-Subscription-Key": key };
    let response;
    try {
      response = await fetch(`${base}/documentintelligence/documentModels/${model}:analyze?${query}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ base64Source: bytes.toString("base64") }),
        signal,
      });
    } catch (e) {
      throw new StepError("AZURE_UNREACHABLE", `cannot reach ${base}: ${e.cause?.message ?? e.message}`, { retryable: true, hint: "Check the endpoint and the network (proxy)." });
    }
    if (response.status !== 202) throw await failure(response, "the analysis was not accepted");
    const operation = response.headers.get("operation-location");
    if (!operation) throw new StepError("AZURE_REQUEST_FAILED", "Azure did not say where to get the result");
    for (;;) {
      const wait = Math.min(Math.max(Number(response.headers.get("retry-after")) || 1, 1), 5) * 1000;
      await sleep(wait, signal);
      response = await fetch(operation, { headers, signal });
      if (!response.ok) throw await failure(response, "the result could not be read");
      const body = await response.json();
      if (body.status === "succeeded") return shape(body.analyzeResult ?? {}, model);
      if (body.status === "failed") {
        throw new StepError("AZURE_ANALYZE_FAILED", `Azure could not read the file: ${body.error?.message ?? "failed"}`, {
          hint: "Check that the file opens and is not password protected.",
        });
      }
    }
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
    const e = timedOut ? new StepError("AZURE_TIMEOUT", "Azure did not finish in time", { retryable: true }) : error;
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
