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
  it("takes a picture for the 手順書 with the marked element and the fields to blur", async () => {
    const r = { runId: "run_manual_shot" };
    await adapter.call("open", { ...r, url: `${base}orders.html` });
    await adapter.call("fill", { ...r, target: { label: "ユーザー名" }, value: "demo" });
    await adapter.call("fill", { ...r, target: { label: "パスワード" }, value: "shikigami" });
    const path = join(mkdtempSync(join(tmpdir(), "shikigami-manual-")), "001.jpg");
    const shot = (await adapter.call("screenshot", {
      ...r,
      path,
      report: true,
      mark: { role: "button", name: "ログイン" },
    })) as { path: string; width: number; height: number; mark: { x: number; width: number } | null; regions: unknown[]; title: string };
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.mark?.width).toBeGreaterThan(0);
    // The two input fields.
    expect(shot.regions.length).toBeGreaterThanOrEqual(2);
    expect(shot.title).toContain("ログイン");

    const missing = (await adapter.call("screenshot", { ...r, path, report: true, mark: { role: "button", name: "ない" } })) as {
      mark: unknown;
    };
    expect(missing.mark).toBeNull();
    await adapter.call("close", r);
  });

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
    expect(String(elsewhere.details?.hint)).toContain("Writer");

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

describe("pointing at the page", () => {
  const person = new Adapter({ forceHeadless: true, scriptedHuman: true, timeoutMs: 3000, executablePath: process.env.SHIKIGAMI_BROWSER_PATH });
  const r = { runId: "run_pick" };

  beforeAll(async () => {
    await person.call("open", { ...r, url: base });
    await person.call("fill", { ...r, target: { label: "ユーザー名" }, value: "demo" });
    await person.call("fill", { ...r, target: { label: "パスワード" }, value: "shikigami" });
    await person.call("click", { ...r, target: { role: "button", name: "ログイン" } });
    await person.call("waitFor", { ...r, target: { role: "heading", name: "受注一覧" } });
  });

  afterAll(async () => {
    await person.shutdown();
  });

  /** Starts a pick, then plays the person clicking `target` once the banner is up. */
  async function pointAt(target: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const asked = person.call("pick", { ...r, message: "出荷するボタンを押してください", timeoutMs: 5000, ...extra });
    for (let i = 0; ; i++) {
      const up = await person.call("isVisible", { ...r, target: { text: "クリックして教えてください" }, waitMs: 100 });
      if (up) break;
      if (i > 50) throw new Error("banner never appeared");
    }
    await person.call("click", { ...r, target });
    return (await asked) as Record<string, unknown>;
  }

  it("returns the clicked button as a target without clicking it", async () => {
    const picked = await pointAt({ role: "button", name: "A-1001 を出荷" });
    expect(picked).toMatchObject({
      status: "picked",
      target: { role: "button", name: "A-1001 を出荷", exact: true },
      matches: 1,
    });
    expect(String(picked.row)).toContain("青葉商店");
    // The page never saw the click.
    const rows = (await person.call("getTable", r)) as Record<string, string>[];
    expect(rows[0]?.状態).toBe("未処理");
    // And the banner is gone.
    expect(await person.call("isVisible", { ...r, target: { text: "クリックして教えてください" }, waitMs: 0 })).toBe(false);
  });

  it("adds nth when the same target repeats, and tells which candidate was picked", async () => {
    const cells = { role: "cell", name: "未処理", exact: true };
    const picked = await pointAt({ ...cells, nth: 1 }, { candidates: [{ role: "button", name: "A-1001 を出荷" }, cells] });
    expect(picked.alternatives).toContainEqual({ text: "未処理", exact: true });
    expect(picked.target).toEqual({ ...cells, nth: 1 });
    expect(picked.matches).toBeGreaterThan(1);
    expect(picked.candidate).toBe(2);
  });

  it("can be cancelled with Esc", async () => {
    const asked = person.call("pick", { ...r, timeoutMs: 5000 });
    for (let i = 0; i < 50; i++) {
      if (await person.call("isVisible", { ...r, target: { text: "クリックして教えてください" }, waitMs: 100 })) break;
    }
    await person.call("press", { ...r, key: "Escape" });
    expect(await asked).toMatchObject({ status: "cancelled" });
  });

  it("ends when Writer cancels it", async () => {
    const asked = person.call("pick", { ...r, timeoutMs: 5000 });
    for (let i = 0; i < 50; i++) {
      if (await person.call("isVisible", { ...r, target: { text: "クリックして教えてください" }, waitMs: 100 })) break;
    }
    expect(await person.call("cancelPick", r)).toBe(true);
    expect(await asked).toMatchObject({ status: "cancelled" });
  });

  it("leaves nothing behind after a timeout", async () => {
    await failure(person.call("pick", { ...r, timeoutMs: 300 }));
    // The next click reaches the page again.
    await person.call("fill", { ...r, target: { label: "顧客名で絞り込み" }, value: "青葉" });
    await person.call("fill", { ...r, target: { label: "顧客名で絞り込み" }, value: "" });
    const picked = await pointAt({ role: "button", name: "A-1001 を出荷" });
    expect(picked.status).toBe("picked");
  });

  it("picks inside a frame without letting the click through", async () => {
    const f = { runId: "run_pick_frame" };
    const frame = `<button onclick="parent.document.title='pressed'">中のボタン</button>`;
    await person.call("open", { ...f, url: `data:text/html;charset=utf-8,${encodeURIComponent(`<title>frames</title><button>外のボタン</button><iframe srcdoc="${frame.replace(/"/g, "&quot;")}"></iframe>`)}` });
    const asked = person.call("pick", { ...f, timeoutMs: 5000 });
    for (let i = 0; i < 50; i++) {
      if (await person.call("isVisible", { ...f, target: { text: "クリックして教えてください" }, waitMs: 100 })) break;
    }
    // A frame without a name, title or address is named by its tag.
    await person.call("click", { ...f, target: { role: "button", name: "中のボタン", frame: { css: "iframe" } } });
    expect(await asked).toMatchObject({ status: "picked", target: { role: "button", name: "中のボタン", frame: { css: "iframe" } } });
    expect(((await person.call("snapshot", f)) as { title: string }).title).toBe("frames");
    await person.call("closeRun", f);
  });

  it("opens the page itself when no browser is open and a url is given (Writer with no run)", async () => {
    const s = { runId: "studio-pick" };
    const err = await failure(person.call("pick", { ...s, timeoutMs: 500 }));
    expect(err.code).toBe("BROWSER_NOT_OPEN");
    const asked = person.call("pick", { ...s, url: base, timeoutMs: 5000 });
    // The browser is opening: looking at it meanwhile would get in the way.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (let i = 0; i < 50; i++) {
      if (await person.call("isVisible", { ...s, target: { text: "クリックして教えてください" }, waitMs: 100 })) break;
    }
    await person.call("click", { ...s, target: { role: "button", name: "ログイン" } });
    expect(await asked).toMatchObject({ status: "picked", target: { role: "button", name: "ログイン" } });
    // The browser stays open for the next pick, on the page the person is at: the url is not opened again.
    await person.call("fill", { ...s, target: { label: "ユーザー名" }, value: "demo" });
    await person.call("fill", { ...s, target: { label: "パスワード" }, value: "shikigami" });
    await person.call("click", { ...s, target: { role: "button", name: "ログイン" } });
    await person.call("waitFor", { ...s, target: { role: "heading", name: "受注一覧" } });
    const again = person.call("pick", { ...s, url: base, timeoutMs: 5000 });
    for (let i = 0; i < 50; i++) {
      if (await person.call("isVisible", { ...s, target: { text: "クリックして教えてください" }, waitMs: 100 })) break;
    }
    await person.call("click", { ...s, target: { role: "button", name: "A-1001 を出荷" } });
    expect(await again).toMatchObject({ status: "picked", target: { role: "button", name: "A-1001 を出荷" } });
    await person.call("closeRun", s);
  });

  it("needs a visible browser", async () => {
    const unseen = { runId: "run_pick_headless" };
    await adapter.call("open", { ...unseen, url: base });
    const err = await failure(adapter.call("pick", { ...unseen, timeoutMs: 500 }));
    expect(err.code).toBe("HUMAN_REQUIRED");
    await adapter.call("closeRun", unseen);
  });

  it("outlines targets for a moment", async () => {
    const { shown } = (await person.call("highlight", { ...r, target: { role: "cell", name: "未処理", exact: true }, durationMs: 300 })) as { shown: number };
    // Headless sessions skip it (nobody would see it).
    expect(shown).toBe(0);
  });
});

describe("OAuth sign-in", () => {
  // The provider shows a consent page whose button redirects (302) to the
  // fixed redirect URL on another site, as Box and others do.
  let provider: Server;
  let company: Server;
  let providerBase: string;
  let redirectUrl: string;
  const companyHits: string[] = [];
  const person = new Adapter({ forceHeadless: true, scriptedHuman: true, timeoutMs: 3000, executablePath: process.env.SHIKIGAMI_BROWSER_PATH });

  const listen = async (server: Server): Promise<string> => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    company = createServer((req, res) => {
      companyHits.push(req.url ?? "");
      res.end("company site");
    });
    redirectUrl = `${await listen(company)}/callback`;
    provider = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const back = `${redirectUrl}?code=c-123&state=${url.searchParams.get("state") ?? ""}`;
      if (url.pathname === "/auto") {
        res.writeHead(302, { location: back }).end();
      } else if (url.pathname === "/authorize") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<form method="post" action="/allow?state=${url.searchParams.get("state")}"><button>Allow</button></form>`);
      } else if (url.pathname === "/allow") {
        res.writeHead(302, { location: back }).end();
      } else {
        res.writeHead(404).end();
      }
    });
    providerBase = await listen(provider);
  });

  afterAll(async () => {
    await person.shutdown();
    provider.close();
    company.close();
  });

  it("catches the redirect to a fixed URL without loading it", async () => {
    const r = { runId: "run_oauth" };
    const signIn = person.call("authorize", { ...r, url: `${providerBase}/authorize?state=s1`, redirectUrl, timeoutMs: 5000 });
    // The person clicks Allow once the window is there.
    for (let i = 0; ; i++) {
      try {
        await person.call("click", { ...r, target: { role: "button", name: "Allow" } });
        break;
      } catch (e) {
        if (i > 50 || !(e instanceof AdapterError) || e.code !== "BROWSER_NOT_OPEN") throw e;
        await new Promise((ok) => setTimeout(ok, 100));
      }
    }
    const { url } = (await signIn) as { url: string };
    expect(url).toBe(`${redirectUrl}?code=c-123&state=s1`);
    expect(companyHits).toEqual([]);
    const page = (await person.call("snapshot", r)) as { url: string; snapshot: string };
    expect(page.snapshot).toContain("サインインが終わりました");
    expect(page.url).not.toContain("c-123");
    await person.call("closeRun", r);
  });

  it("handles a provider that sends the browser straight back", async () => {
    const r = { runId: "run_oauth_auto" };
    const { url } = (await person.call("authorize", { ...r, url: `${providerBase}/auto?state=s2`, redirectUrl, timeoutMs: 5000 })) as { url: string };
    expect(url).toContain("state=s2");
    expect(companyHits).toEqual([]);
    await person.call("closeRun", r);
  });

  it("gives up when nobody signs in in time", async () => {
    const r = { runId: "run_oauth_timeout" };
    const err = await failure(person.call("authorize", { ...r, url: `${providerBase}/authorize?state=s3`, redirectUrl, timeoutMs: 800 }));
    expect(err.code).toBe("HUMAN_TIMEOUT");
    await person.call("closeRun", r);
  });

  it("needs a person when the browser has no window", async () => {
    const r = { runId: "run_oauth_headless" };
    const err = await failure(adapter.call("authorize", { ...r, url: `${providerBase}/authorize`, redirectUrl }));
    expect(err.code).toBe("HUMAN_REQUIRED");
    await adapter.call("closeRun", r);
  });
});
