// Sample Shikigami plugin: newline-delimited JSON-RPC 2.0 on stdin/stdout.
//
// Each request's method is a step's `action`, and its params are the step's
// params (templates already filled in) plus `runId` and `timeoutMs`.
// Answer with `result`, or with `error.data = { code, retryable, details }`.
// stdout carries only responses; write logs to stderr.

import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

class StepError extends Error {
  constructor(code, message, { retryable = false, hint } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = hint ? { hint } : undefined;
  }
}

const actions = {
  greet({ name }) {
    return `こんにちは、${name}さん`;
  },

  appendLine({ path, text }) {
    if (!isAbsolute(path)) {
      throw new StepError("RELATIVE_PATH", `'${path}' is not an absolute path`, {
        hint: "Write the full path, e.g. C:\\data\\log.txt, or build it from a variable: {{ outDir }}\\log.txt",
      });
    }
    appendFileSync(path, `${text}\n`, "utf8");
    return readFileSync(path, "utf8").split("\n").length - 1;
  },

  // Called when a run ends; nothing to clean up here.
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
    const e = error instanceof StepError ? error : new StepError("HELLO_ERROR", String(error));
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: e.message, data: { code: e.code, retryable: e.retryable, details: e.details } },
    });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim()) void handle(line);
});
lines.on("close", () => process.exit(0));
process.stderr.write("hello plugin ready\n");
