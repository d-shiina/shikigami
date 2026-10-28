import { existsSync } from "node:fs";
import type { Server } from "node:http";

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

  it("closes every context of a finished run", async () => {
    await adapter.call("closeRun", run);
    const err = await failure(adapter.call("getTable", { ...run, context: "stock" }));
    expect(err.code).toBe("BROWSER_NOT_OPEN");
  });

  it("finds the demo site files", () => {
    expect(existsSync(new URL("../../../examples/web/index.html", import.meta.url))).toBe(true);
  });
});
