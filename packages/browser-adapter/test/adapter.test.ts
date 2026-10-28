import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Adapter } from "../src/adapter.ts";
import { startDemoSite } from "../src/demo-site.ts";
import { AdapterError } from "../src/targets.ts";

// Uses Playwright's bundled Chromium (PLAYWRIGHT_BROWSERS_PATH) or
// SHIKIGAMI_BROWSER_PATH; CI installs it with `playwright-core install`.
let server: Server;
let base: string;
const adapter = new Adapter({ forceHeadless: true, timeoutMs: 3000, executablePath: process.env.SHIKIGAMI_BROWSER_PATH });
const run = { runId: "run_test" };

beforeAll(async () => {
  ({ server, url: base } = await startDemoSite(0));
});

afterAll(async () => {
  await adapter.shutdown();
  server.close();
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

describe("browser adapter", () => {
  it("logs in, reads the order table and ships an order", async () => {
    const opened = (await adapter.call("open", { ...run, url: base })) as { title: string };
    expect(opened.title).toContain("ログイン");

    await adapter.call("fill", { ...run, target: { label: "ユーザー名" }, value: "demo" });
    await adapter.call("fill", { ...run, target: { label: "パスワード" }, value: "shikigami" });
    await adapter.call("click", { ...run, target: { role: "button", name: "ログイン" } });
    await adapter.call("waitFor", { ...run, target: { role: "heading", name: "受注一覧" } });

    const rows = (await adapter.call("getTable", { ...run })) as Record<string, string>[];
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ 注文番号: "A-1001", 顧客: "青葉商店", "金額（円）": "12,000", 状態: "未処理" });

    await adapter.call("click", { ...run, target: { role: "button", name: "A-1001 を出荷" } });
    await adapter.call("waitFor", { ...run, target: { text: "A-1001 を出荷しました" } });
    const after = (await adapter.call("getTable", { ...run })) as Record<string, string>[];
    expect(after[0]?.状態).toBe("出荷済み");

    const texts = await adapter.call("getText", { ...run, target: { role: "cell", name: "未処理", exact: true }, all: true });
    expect(texts).toEqual(["未処理", "未処理"]);
  });

  it("keeps contexts of one run apart and waits for slow pages", async () => {
    await adapter.call("open", { ...run, context: "stock", url: `${base}stock.html` });
    const stock = (await adapter.call("getTable", { ...run, context: "stock" })) as Record<string, string>[];
    expect(stock.map((s) => s.在庫数)).toEqual(["42", "0", "7", "3", "120"]);
    // The default context is still on the order page.
    const { title } = (await adapter.call("snapshot", { ...run })) as { title: string };
    expect(title).toContain("受注一覧");
  });

  it("reports missing and ambiguous elements with repair hints", async () => {
    const missing = await failure(adapter.call("click", { ...run, target: { role: "button", name: "存在しない" } }));
    expect(missing.code).toBe("ELEMENT_NOT_FOUND");
    expect(missing.retryable).toBe(true);
    expect(String(missing.details?.page)).toContain("受注一覧");

    const ambiguous = await failure(adapter.call("click", { ...run, target: { role: "link" } }));
    expect(ambiguous.code).toBe("ELEMENT_AMBIGUOUS");
    expect(String(ambiguous.details?.hint)).toContain("nth");

    const closed = await failure(adapter.call("click", { runId: "other", target: { text: "x" } }));
    expect(closed.code).toBe("BROWSER_NOT_OPEN");
  });

  it("selects by label or value and stops at the step's time limit", async () => {
    const html = '<meta charset="utf-8"><label for="c">国</label><select id="c"><option value="jp">日本</option><option value="us">米国</option></select>';
    const page = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await adapter.call("open", { ...run, context: "form", url: page });
    expect(await adapter.call("select", { ...run, context: "form", target: { label: "国" }, value: "米国" })).toEqual(["us"]);
    const started = Date.now();
    expect(await adapter.call("select", { ...run, context: "form", target: { label: "国" }, value: "jp" })).toEqual(["jp"]);
    expect(Date.now() - started).toBeLessThan(1000);
    const missing = await failure(adapter.call("select", { ...run, context: "form", target: { label: "国" }, value: "英国" }));
    expect(missing.code).toBe("OPTION_NOT_FOUND");

    const t0 = Date.now();
    const slow = await failure(
      adapter.call("click", { ...run, context: "form", target: { role: "button", name: "ない" }, timeoutMs: 300 }),
    );
    expect(slow.code).toBe("ELEMENT_NOT_FOUND");
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("closes every context of a finished run", async () => {
    await adapter.call("closeRun", run);
    const err = await failure(adapter.call("getTable", { ...run, context: "stock" }));
    expect(err.code).toBe("BROWSER_NOT_OPEN");
  });

  it("types secrets only on their sites and masks them", async () => {
    const r = { runId: "run_secret" };
    await adapter.call("open", { ...r, url: base });
    const site = new URL(base).origin;
    await adapter.call("fill", {
      ...r,
      target: { label: "ユーザー名" },
      value: "demo",
      secret: { name: "demo", sites: [site], sensitive: false },
    });
    const elsewhere = await failure(
      adapter.call("fill", {
        ...r,
        target: { label: "パスワード" },
        value: "shikigami",
        secret: { name: "demo", sites: ["https://example.com"], sensitive: true },
      }),
    );
    expect(elsewhere.code).toBe("SECRET_SITE_MISMATCH");
    expect(String(elsewhere.details?.hint)).toContain("Studio");

    await adapter.call("fill", {
      ...r,
      target: { label: "パスワード" },
      value: "shikigami",
      secret: { name: "demo", sites: [site], sensitive: true },
    });
    const page = (await adapter.call("snapshot", r)) as { snapshot: string; login?: { hint: string } };
    expect(page.snapshot).not.toContain("shikigami");
    expect(page.snapshot).toContain("demo");
    expect(page.login?.hint).toContain("list_secrets");

    // Typed by hand (not through a secret): still hidden from AI clients.
    await adapter.call("fill", { ...r, target: { label: "パスワード" }, value: "typed-by-hand" });
    const again = (await adapter.call("snapshot", r)) as { snapshot: string };
    expect(again.snapshot).not.toContain("typed-by-hand");

    // Review evidence: a JPEG of the page next to the tree.
    const shot = join(mkdtempSync(join(tmpdir(), "shikigami-")), "shot.jpg");
    await adapter.call("snapshot", { ...r, screenshotPath: shot });
    expect([...readFileSync(shot).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await adapter.call("closeRun", r);
  });

  it("does not type a secret into a page reached while waiting for the field", async () => {
    // An allowed page without the field that moves to another origin with a
    // matching field while the fill is still waiting for it.
    const target = base.replace("127.0.0.1", "localhost");
    const hop = createServer((_, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<script>setTimeout(() => location.href = ${JSON.stringify(target)}, 300)</script>`);
    });
    await new Promise<void>((resolve) => hop.listen(0, "127.0.0.1", resolve));
    const hopUrl = `http://127.0.0.1:${(hop.address() as AddressInfo).port}/`;
    const r = { runId: "run_hop" };
    try {
      await adapter.call("open", { ...r, url: hopUrl });
      const err = await failure(
        adapter.call("fill", {
          ...r,
          target: { label: "パスワード" },
          value: "shikigami",
          secret: { name: "demo", sites: [new URL(hopUrl).origin], sensitive: true },
        }),
      );
      expect(err.code).toBe("SECRET_SITE_MISMATCH");
      const page = (await adapter.call("snapshot", r)) as { url: string; snapshot: string };
      expect(page.url).toContain("localhost");
      expect(page.snapshot).not.toContain("shikigami");
    } finally {
      await adapter.call("closeRun", r);
      hop.close();
    }
  });

  it("saves a login and reuses it in the next run", async () => {
    const first = { runId: "run_login_1" };
    await adapter.call("open", { ...first, url: `${base}orders.html`, session: "demo" });
    expect(await adapter.call("isVisible", { ...first, target: { role: "heading", name: "受注一覧" }, waitMs: 500 })).toBe(false);
    await adapter.call("fill", { ...first, target: { label: "ユーザー名" }, value: "demo" });
    await adapter.call("fill", { ...first, target: { label: "パスワード" }, value: "shikigami" });
    await adapter.call("click", { ...first, target: { role: "button", name: "ログイン" } });
    await adapter.call("waitFor", { ...first, target: { role: "heading", name: "受注一覧" } });
    const closed = (await adapter.call("closeRun", first)) as { sessions: { name: string; state: unknown }[] };
    expect(closed.sessions.map((s) => s.name)).toEqual(["demo"]);

    const second = { runId: "run_login_2" };
    await adapter.call("open", {
      ...second,
      url: `${base}orders.html`,
      session: "demo",
      storageState: closed.sessions[0]?.state,
    });
    expect(await adapter.call("isVisible", { ...second, target: { role: "heading", name: "受注一覧" } })).toBe(true);
    await adapter.call("closeRun", second);
  });

  it("refuses to wait for a person without a window", async () => {
    const r = { runId: "run_human" };
    await adapter.call("open", { ...r, url: base });
    const err = await failure(
      adapter.call("waitForHuman", { ...r, until: { role: "heading", name: "受注一覧" }, timeoutMs: 1000 }),
    );
    expect(err.code).toBe("HUMAN_REQUIRED");
    await adapter.call("closeRun", r);
  });

  it("finds the demo site files", () => {
    expect(existsSync(new URL("../../../examples/web/index.html", import.meta.url))).toBe(true);
  });
});
