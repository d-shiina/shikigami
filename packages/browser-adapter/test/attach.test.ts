import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Adapter } from "../src/adapter.ts";
import { AdapterError } from "../src/targets.ts";

// A browser the person started with a debugging port: browser.attach works
// in it and leaves it open when the run ends.
const executable = process.env.SHIKIGAMI_BROWSER_PATH || chromium.executablePath();
let person: ChildProcess;
let port: number;
const page = (title: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<title>${title}</title><h1>${title}</h1>`)}`;

beforeAll(async () => {
  const profile = mkdtempSync(join(tmpdir(), "shikigami-person-"));
  person = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", ...(process.platform === "linux" ? ["--no-sandbox"] : []), page("社内ポータル")], {
    stdio: "ignore",
  });
  const file = join(profile, "DevToolsActivePort");
  // The browser makes the file before it writes the port into it: wait for a real port.
  port = 0;
  for (let i = 0; i < 100 && !(port > 0); i++) {
    if (existsSync(file)) port = Number(readFileSync(file, "utf8").split("\n")[0]);
    if (!(port > 0)) await new Promise((r) => setTimeout(r, 100));
  }
  if (!(port > 0)) throw new Error("the browser did not open its debugging port");
  // As a person's browser would be: up, with its page shown.
  for (let i = 0; i < 100; i++) {
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json() as Promise<{ title: string }[]>).catch(() => []);
    if (tabs.some((t) => t.title === "社内ポータル")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(() => {
  person.kill();
});

async function failure(p: Promise<unknown>): Promise<AdapterError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AdapterError) return e;
    throw e;
  }
  throw new Error("expected a failure");
}

describe("browser.attach", () => {
  it("works in the person's open tab and leaves the browser open", async () => {
    const adapter = new Adapter({ timeoutMs: 5000 });
    const run = { runId: "run_attach", context: "mine" };
    const tab = (await adapter.call("attach", { ...run, port, title: "社内ポータル" })) as { title: string };
    expect(tab.title).toBe("社内ポータル");
    expect(await adapter.call("getText", { ...run, target: { role: "heading" } })).toBe("社内ポータル");
    await adapter.call("closeRun", { runId: run.runId });

    // Still there for the person (and the next run).
    const again = new Adapter({ timeoutMs: 5000 });
    expect(((await again.call("attach", { ...run, port })) as { title: string }).title).toBe("社内ポータル");
    await again.call("closeRun", { runId: run.runId });
    expect(person.exitCode).toBeNull();
  });

  it("says how to start the browser when nothing listens", async () => {
    const adapter = new Adapter({ timeoutMs: 1000 });
    const err = await failure(adapter.call("attach", { runId: "run_none", port: 1, timeoutMs: 1000 }));
    expect(err.code).toBe("BROWSER_NOT_RUNNING");
    expect(String(err.details?.hint)).toContain("--remote-debugging-port=1");
  });
});
