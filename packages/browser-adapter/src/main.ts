// Entry point: newline-delimited JSON-RPC 2.0 over stdin/stdout.
//
// Requests are handled concurrently (parallel branches use different
// contexts); stdout carries only responses, diagnostics go to stderr.

import { createInterface } from "node:readline";

import { Adapter, optionsFromEnv } from "./adapter.ts";
import { AdapterError } from "./targets.ts";

interface Request {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const adapter = new Adapter(optionsFromEnv());

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(line: string): Promise<void> {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const id = request.id ?? null;
  if (request.method === "shutdown") {
    await adapter.shutdown();
    send({ jsonrpc: "2.0", id, result: null });
    process.exit(0);
  }
  try {
    const result = await adapter.call(String(request.method ?? ""), request.params ?? {});
    send({ jsonrpc: "2.0", id, result: result ?? null });
  } catch (error) {
    const e = error instanceof AdapterError ? error : new AdapterError("BROWSER_ERROR", String(error));
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
// The Runtime closed our stdin (or exited): close browsers and leave.
lines.on("close", () => {
  void adapter.shutdown().finally(() => process.exit(0));
});
process.stderr.write("shikigami browser adapter ready\n");
