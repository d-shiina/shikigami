import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { record, stopRecording, targetFromFacts } from "../src/record.ts";

// Recording a person's work on a page: Playwright plays the person (its
// clicks and keys are real input events, as a person's are).
let server: Server;
let base: string;
let browser: Browser;
let page: Page;
const PAGES: Record<string, string> = {
  "/": `<title>受注</title><div style="height:80px"></div>
    <label>氏名 <input name="who"></label>
    <label>パスワード <input type="password"></label>
    <label>都道府県 <select><option>大阪</option><option>東京</option></select></label>
    <label><input type="checkbox"> 同意する</label>
    <input placeholder="検索語">
    <button onclick="this.textContent = '検索しました'">検索</button>
    <iframe name="side" src="/side"></iframe>
    <a href="/next">次のページ</a>`,
  "/side": `<button onclick="this.textContent = '押しました'">枠のボタン</button><a href="/side2">枠の次</a>`,
  "/side2": `<button>枠の次のボタン</button>`,
  "/next": `<title>次</title><div style="height:80px"></div><button>戻る</button>`,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? "/", "http://x").pathname];
    if (!body) return void res.writeHead(404).end();
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="ja"><meta charset="utf-8">${body}</html>`);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: process.env.SHIKIGAMI_BROWSER_PATH });
  page = await browser.newPage();
  await page.goto(`${base}/`);
  await page.frameLocator("iframe").getByRole("button").waitFor();
});

afterAll(async () => {
  await browser?.close();
  server.close();
});

async function bannerUp(p: Page, text: RegExp) {
  for (let i = 0; i < 100; i++) {
    const shown = await p
      .evaluate(() => document.getElementById("__shikigami_record")?.shadowRoot?.querySelector(".bar b")?.textContent ?? "")
      .catch(() => "");
    if (text.test(shown)) return;
    await p.waitForTimeout(30);
  }
  const shown = await p.evaluate(() => document.getElementById("__shikigami_record")?.shadowRoot?.querySelector(".bar b")?.textContent ?? "").catch(() => "?");
  throw new Error(`banner never showed ${text}: ${shown}`);
}

describe("recording", () => {
  it("turns clicks, typing, choices and Enter into actions with targets", async () => {
    const recording = record(page, { timeoutMs: 20_000 });
    await bannerUp(page, /記録中（0 件）/);
    await page.getByLabel("氏名").fill("山田太郎");
    await page.getByRole("button", { name: "検索" }).click();
    await page.getByLabel("パスワード").fill("secret-123");
    // A person's choice (selectOption's events are not a person's).
    await page.getByLabel("都道府県").focus();
    await page.keyboard.press("ArrowDown");
    await page.getByLabel("同意する").check();
    await page.getByPlaceholder("検索語").fill("請求書");
    await page.getByPlaceholder("検索語").press("Enter");
    await page.frameLocator("iframe").getByRole("button", { name: "枠のボタン" }).click();
    await bannerUp(page, /（8 件）/);
    await page.getByRole("link", { name: "次のページ" }).click();
    await page.waitForURL(/\/next$/);
    await bannerUp(page, /記録中/);
    await page.getByRole("button", { name: "戻る" }).click();
    await bannerUp(page, /（10 件）/);
    await stopRecording(page);
    const { status, actions } = await recording;
    expect(status).toBe("stopped");
    const plain = actions.map(({ app: _app, label: _label, ...a }) => a);
    expect(plain).toEqual([
      { kind: "open", url: `${base}/` },
      { kind: "fill", target: { role: "textbox", name: "氏名", exact: true }, value: "山田太郎" },
      { kind: "click", target: { role: "button", name: "検索", exact: true } },
      // A password field has no role: its label names it.
      { kind: "fill", target: { label: "パスワード", exact: true }, value: "", password: true },
      { kind: "select", target: { role: "combobox", name: "都道府県", exact: true }, value: "東京" },
      { kind: "check", target: { role: "checkbox", name: "同意する", exact: true }, checked: true },
      { kind: "fill", target: { role: "textbox", name: "検索語", exact: true }, value: "請求書" },
      { kind: "press", target: { role: "textbox", name: "検索語", exact: true }, key: "Enter" },
      { kind: "click", target: { role: "button", name: "枠のボタン", exact: true, frame: { name: "side" } } },
      { kind: "click", target: { role: "link", name: "次のページ", exact: true } },
      { kind: "click", target: { role: "button", name: "戻る", exact: true } },
    ]);
    // The password never left the page, and nothing is left behind.
    expect(JSON.stringify(actions)).not.toContain("secret-123");
    expect(await page.evaluate(() => Boolean(document.getElementById("__shikigami_record")))).toBe(false);
  });

  it("keeps recording in a frame that went to another page", async () => {
    await page.goto(`${base}/`);
    await page.frameLocator("iframe").getByRole("button").waitFor();
    const recording = record(page, { timeoutMs: 20_000 });
    await bannerUp(page, /記録中/);
    const side = page.frameLocator("iframe");
    await side.getByRole("link", { name: "枠の次" }).click();
    await side.getByRole("button", { name: "枠の次のボタン" }).waitFor();
    await bannerUp(page, /（1 件）/);
    // The frame's new page is armed once it is ready.
    await page.waitForTimeout(300);
    await side.getByRole("button", { name: "枠の次のボタン" }).click();
    await bannerUp(page, /（2 件）/);
    await stopRecording(page);
    const { actions } = await recording;
    expect(actions.map((a) => [a.kind, a.target])).toEqual([
      ["open", undefined],
      ["click", { role: "link", name: "枠の次", exact: true, frame: { name: "side" } }],
      ["click", { role: "button", name: "枠の次のボタン", exact: true, frame: { name: "side" } }],
    ]);
  });

  it("records an address typed by hand as opening it", async () => {
    await page.goto(`${base}/`);
    const recording = record(page, { timeoutMs: 20_000 });
    await bannerUp(page, /記録中/);
    await page.goto(`${base}/next`);
    await bannerUp(page, /記録中/);
    await stopRecording(page);
    const { actions } = await recording;
    expect(actions.map((a) => [a.kind, a.url])).toEqual([
      ["open", `${base}/`],
      ["open", `${base}/next`],
    ]);
  });

  it("names an element that is gone by what the page said", () => {
    const facts = { role: "button", name: "出荷", label: "", placeholder: "", testId: "", text: "出荷", id: "", tag: "button" };
    expect(targetFromFacts(facts)).toEqual({ role: "button", name: "出荷", exact: true });
    expect(targetFromFacts({ ...facts, role: "", name: "", text: "", id: "ship" })).toEqual({ css: "#ship" });
    expect(targetFromFacts({ ...facts, role: "", name: "", text: "" })).toBeUndefined();
  });
});
