import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Adapter } from "../src/adapter.ts";
import { highlight } from "../src/pick.ts";

// Pointing at elements inside iframes: frames inside frames, and a frame
// from another site (localhost vs 127.0.0.1, so Chromium runs it in its
// own process as it does for a real cross-origin iframe).
let server: Server;
let base: string;
let other: string;
const PAGES: Record<string, (other: string) => string> = {
  // Below the banner, which sits over the top of the page.
  "/": (o) => `<title>外</title><div style="height:120px"></div><button>外のボタン</button>
    <iframe name="main" title="本文" src="/frame"></iframe>
    <iframe title="別のサイト" src="${o}/remote"></iframe>
    <iframe src="/same"></iframe><iframe src="/same"></iframe>`,
  "/frame": () => `<label>備考 <input></label><iframe name="inner" src="/inner"></iframe>`,
  "/inner": () => `<button onclick="this.textContent = '押しました'">奥のボタン</button>`,
  "/remote": () => `<button onclick="this.textContent = '押しました'">別サイトのボタン</button>`,
  "/same": () => `<button onclick="this.textContent = '押しました'">同じボタン</button>`,
};

const person = new Adapter({ forceHeadless: true, scriptedHuman: true, timeoutMs: 3000, executablePath: process.env.SHIKIGAMI_BROWSER_PATH });
const r = { runId: "run_pick_frames" };

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = PAGES[new URL(req.url ?? "/", "http://x").pathname];
    if (!page) return void res.writeHead(404).end();
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="ja"><meta charset="utf-8">${page(other)}</html>`);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
  await person.call("open", { ...r, url: `${base}/` });
  await person.call("waitFor", { ...r, target: { role: "button", name: "奥のボタン", frame: { name: "inner", frame: { name: "main" } } } });
  await person.call("waitFor", { ...r, target: { role: "button", name: "別サイトのボタン", frame: { title: "別のサイト" } } });
});

afterAll(async () => {
  await person.shutdown();
  server.close();
});

/** Starts a pick, then plays the person clicking `target` once the banner is up. */
async function pointAt(target: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const asked = person.call("pick", { ...r, message: "押すボタンをクリックしてください", timeoutMs: 8000, ...extra });
  for (let i = 0; ; i++) {
    if (await person.call("isVisible", { ...r, target: { text: "クリックして教えてください" }, waitMs: 100 })) break;
    if (i > 50) throw new Error("banner never appeared");
  }
  await person.call("click", { ...r, target });
  return (await asked) as Record<string, unknown>;
}

describe("pointing inside frames", () => {
  it("returns an element in a frame inside a frame with the frames in its target", async () => {
    const inner = { name: "inner", frame: { name: "main" } };
    const picked = await pointAt({ role: "button", name: "奥のボタン", frame: inner });
    expect(picked).toMatchObject({
      status: "picked",
      target: { role: "button", name: "奥のボタン", exact: true, frame: inner },
      matches: 1,
    });
    // The page never saw the click, and the target works as is.
    expect(await person.call("getText", { ...r, target: picked.target })).toBe("奥のボタン");
  });

  it("names the frame by title, and gives alternatives in the same frame", async () => {
    const picked = await pointAt({ label: "備考", frame: { title: "本文" } });
    expect(picked.target).toEqual({ role: "textbox", name: "備考", exact: true, frame: { name: "main" } });
    expect(picked.alternatives).toContainEqual({ label: "備考", exact: true, frame: { name: "main" } });
  });

  it("reaches a frame from another site", async () => {
    const picked = await pointAt({ role: "button", name: "別サイトのボタン", frame: { title: "別のサイト" } });
    expect(picked.target).toEqual({ role: "button", name: "別サイトのボタン", exact: true, frame: { title: "別のサイト" } });
    expect(await person.call("getText", { ...r, target: picked.target })).toBe("別サイトのボタン");
  });

  it("tells apart frames that look the same with nth", async () => {
    const picked = await pointAt({ role: "button", name: "同じボタン", frame: { src: "/same", nth: 1 } });
    expect(picked.target).toEqual({ role: "button", name: "同じボタン", exact: true, frame: { src: "/same", nth: 1 } });
  });

  it("outlines candidates inside frames and can be cancelled with Esc there", async () => {
    const asked = person.call("pick", {
      ...r,
      timeoutMs: 8000,
      candidates: [{ role: "button", name: "奥のボタン", frame: { name: "inner", frame: { name: "main" } } }],
    });
    for (let i = 0; i < 50; i++) {
      if (await person.call("isVisible", { ...r, target: { text: "クリックして教えてください" }, waitMs: 100 })) break;
    }
    // The candidate is marked inside its frame.
    const marked = await person.call("getAttribute", {
      ...r,
      target: { role: "button", name: "奥のボタン", frame: { name: "inner", frame: { name: "main" } } },
      name: "data-shikigami-candidate",
    });
    expect(marked).toBe("1");
    await person.call("click", { ...r, target: { label: "備考", frame: { name: "main" } } });
    const plain = (await asked) as Record<string, unknown>;
    expect(plain).toMatchObject({ status: "picked", target: { role: "textbox", name: "備考", frame: { name: "main" } } });
    expect(plain.candidate).toBeUndefined();
    // Esc pressed while the focus is inside a frame.
    const again = person.call("pick", { ...r, timeoutMs: 8000 });
    for (let i = 0; i < 50; i++) {
      if (await person.call("isVisible", { ...r, target: { text: "クリックして教えてください" }, waitMs: 100 })) break;
    }
    await person.call("press", { ...r, target: { label: "備考", frame: { name: "main" } }, key: "Escape" });
    expect(await again).toMatchObject({ status: "cancelled" });
    // Nothing is left behind in the frames.
    expect(await person.call("click", { ...r, target: { role: "button", name: "奥のボタン", frame: { name: "inner", frame: { name: "main" } } } })).toBeNull();
    expect(await person.call("getText", { ...r, target: { role: "button", name: "押しました", frame: { name: "inner", frame: { name: "main" } } } })).toBe("押しました");
  });
});

describe("highlight inside frames", () => {
  let browser: Browser;
  afterAll(async () => {
    await browser?.close();
  });

  it("outlines the element inside its frame", async () => {
    browser = await chromium.launch({ executablePath: process.env.SHIKIGAMI_BROWSER_PATH });
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    const inner = page.frameLocator('iframe[name="main"]').frameLocator('iframe[name="inner"]');
    await inner.getByRole("button", { name: "奥のボタン" }).waitFor();
    await page.frameLocator('iframe[title="別のサイト"]').getByRole("button").waitFor();
    const shown = await highlight(
      page,
      [
        { role: "button", name: "奥のボタン", frame: { name: "inner", frame: { name: "main" } } },
        { role: "button", name: "別サイトのボタン", frame: { title: "別のサイト" } },
      ],
      { durationMs: 5000 },
    );
    expect(shown).toBe(2);
    const drawn = await Promise.all(
      page.frames().map((f) => f.evaluate(() => document.getElementById("__shikigami_highlight")?.shadowRoot?.querySelectorAll(".hl").length ?? 0)),
    );
    // One box in each of the two frames, none on the top page.
    expect(drawn.filter((n) => n === 1)).toHaveLength(2);
    expect(await page.evaluate(() => Boolean(document.getElementById("__shikigami_highlight")))).toBe(false);
  });
});
