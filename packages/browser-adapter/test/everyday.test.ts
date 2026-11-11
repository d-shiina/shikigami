import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Adapter } from "../src/adapter.ts";
import { EXTENSION_IDS } from "../src/extension.ts";
import { AdapterError } from "../src/targets.ts";

// The person's everyday browser with the SpellSheet extension: browser.attach
// (edge: "everyday") works in it through the extension, not a debugging port.
const extension = fileURLToPath(new URL("../../edge-extension", import.meta.url));
let everyday: BrowserContext;
// An extension may not send a tab to a data: address, so the pages come from a local site.
let site: Server;
let origin: string;
const page = (title: string) => `${origin}/?title=${encodeURIComponent(title)}`;

beforeAll(async () => {
  site = createServer((req, res) => {
    const title = new URL(req.url ?? "/", "http://x").searchParams.get("title") ?? "";
    const safe = title.replace(/[<>&]/g, "");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<title>${safe}</title><h1>${safe}</h1>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  everyday = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "spellsheet-everyday-")), {
    channel: "chromium",
    headless: true,
    executablePath: process.env.SPELLSHEET_BROWSER_PATH || undefined,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // The extension's worker has to be up before the connect page talks to it.
  if (everyday.serviceWorkers().length === 0) await everyday.waitForEvent("serviceworker");
});

afterAll(async () => {
  await everyday?.close();
  site?.close();
});

/** Plays Edge opening the connect page, and the person choosing Allow the first time. */
function person(allow: boolean) {
  return async (url: string) => {
    const tab = await everyday.newPage();
    await tab.goto(url);
    const ask = tab.locator("#ask");
    // Approved before: the page closes itself.
    await Promise.race([ask.waitFor({ state: "visible" }), tab.waitForEvent("close")]).catch(() => {});
    if (!tab.isClosed() && (await ask.isVisible())) await tab.locator(allow ? "#allow" : "#deny").click();
  };
}

describe("browser.attach in the everyday Edge", () => {
  it("has the extension at the ID SpellSheet opens", () => {
    const id = new URL(everyday.serviceWorkers()[0]!.url()).host;
    expect(EXTENSION_IDS).toContain(id);
  });

  it("opens its own tab after the person allows it once, and lets go when the run ends", async () => {
    const token = join(mkdtempSync(join(tmpdir(), "spellsheet-token-")), "edge-extension-token");
    const adapter = new Adapter({ timeoutMs: 15000, extensionTokenFile: token, openInEveryday: person(true) });
    const run = { runId: "run_everyday", context: "edge" };
    await adapter.call("attach", run);
    await adapter.call("open", { ...run, url: page("勤怠システム") });
    expect(await adapter.call("getText", { ...run, target: { role: "heading" } })).toBe("勤怠システム");
    await adapter.call("closeRun", { runId: run.runId });
    // The tab stays for the person.
    await expect.poll(() => everyday.pages().some((p) => p.url() === page("勤怠システム"))).toBe(true);

    // Approved once: the next run connects without asking (person(false) would refuse).
    const again = new Adapter({ timeoutMs: 15000, extensionTokenFile: token, openInEveryday: person(false) });
    await again.call("attach", { ...run, runId: "run_again" });
    await again.call("closeRun", { runId: "run_again" });
  });

  it("uses the open tab the flow names", async () => {
    const portal = await everyday.newPage();
    await portal.goto(page("社内ポータル"));
    const token = join(mkdtempSync(join(tmpdir(), "spellsheet-token-")), "edge-extension-token");
    const adapter = new Adapter({ timeoutMs: 15000, extensionTokenFile: token, openInEveryday: person(true) });
    const run = { runId: "run_named", context: "edge" };
    const tab = (await adapter.call("attach", { ...run, title: "社内ポータル" })) as { title: string };
    expect(tab.title).toBe("社内ポータル");
    expect(await adapter.call("getText", { ...run, target: { role: "heading" } })).toBe("社内ポータル");
    await adapter.call("closeRun", { runId: run.runId });
    expect(portal.isClosed()).toBe(false);
  });

  it("says how to add the extension when it does not answer", async () => {
    const token = join(mkdtempSync(join(tmpdir(), "spellsheet-token-")), "edge-extension-token");
    const adapter = new Adapter({ timeoutMs: 1500, extensionTokenFile: token, openInEveryday: person(false) });
    let error: unknown;
    try {
      await adapter.call("attach", { runId: "run_denied", timeoutMs: 1500 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("EXTENSION_NOT_CONNECTED");
  });
});
