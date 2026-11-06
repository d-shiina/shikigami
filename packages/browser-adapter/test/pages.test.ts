import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Adapter } from "../src/adapter.ts";
import { AdapterError } from "../src/targets.ts";

// Pages with what business sites do besides forms: popups, frames, JS
// dialogs, menus that open on hover, lists that load as they scroll.
const PAGES: Record<string, string> = {
  "/": `<title>一覧</title>
    <a href="/detail" target="_blank">詳細を別ウィンドウで</a>
    <button onclick="window.open('/detail', 'w', 'width=400,height=300')">ポップアップ</button>
    <button onclick="if (confirm('削除しますか？')) document.getElementById('r').textContent = '削除しました'; else document.getElementById('r').textContent = 'やめました'">削除</button>
    <button onclick="setTimeout(() => { const v = prompt('件名は？'); document.getElementById('r').textContent = '件名：' + v }, 300)">件名</button>
    <button onclick="setTimeout(() => alert('登録しました（受付番号 42）'), 200)">登録</button>
    <p id="r"></p>
    <div id="menu" onmouseenter="document.getElementById('sub').hidden = false">メニュー<div id="sub" hidden><a href="/detail">月次レポート</a></div></div>
    <a id="dl" href="/files/report.csv">CSV</a> <a id="slow" href="/files/slow.csv">遅い CSV</a>
    <iframe name="main" title="本文" src="/frame"></iframe>
    <div id="list" style="height:60px;overflow:auto" onscroll="document.getElementById('ly').textContent = this.scrollTop > 0 ? '下' : '上'"><div style="height:400px">上</div><div id="end">下の端</div></div>
    <p id="ly">上</p><p id="y" style="position:fixed;top:0">上</p>
    <script>onscroll = () => document.getElementById('y').textContent = scrollY > 4500 ? '下' : scrollY > 0 ? '途中' : '上'</script>
    <div style="height:3000px"></div><p id="foot">ページの下</p><div style="height:3000px"></div>`,
  "/detail": `<title>詳細</title><h1>受注の詳細</h1><button onclick="window.close()">閉じる</button>`,
  "/frame": `<title>枠</title><label>備考 <input></label><iframe name="inner" src="/inner"></iframe>`,
  "/upload": `<title>添付</title>
    <label>請求書 <input type="file" id="f" multiple onchange="document.getElementById('n').textContent = [...this.files].map(f => f.name).join(',')"></label>
    <input type="file" id="hidden" hidden onchange="document.getElementById('n').textContent = 'hidden:' + this.files[0].name">
    <button onclick="document.getElementById('hidden').click()">ファイルを選ぶ</button>
    <p id="n"></p>`,
  "/inner": `<button onclick="this.textContent = '押しました'">奥のボタン</button>`,
};

let server: Server;
let base: string;
const adapter = new Adapter({ forceHeadless: true, timeoutMs: 3000, executablePath: process.env.SHIKIGAMI_BROWSER_PATH });
const run = { runId: "run_pages" };

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname === "/files/slow.csv") {
      // Starts at once, never finishes.
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="slow.csv"' });
      return void res.write("a,b\n");
    }
    if (pathname === "/files/report.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report_20261106.csv"' });
      return void res.end("注文番号,金額\nA-1001,12000\n");
    }
    const body = PAGES[pathname];
    if (body === undefined) return void res.writeHead(404).end();
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="ja"><meta charset="utf-8">${body}</html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await adapter.call("open", { ...run, url: `${base}/` });
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

const text = (id: string) => adapter.call("getText", { ...run, target: { css: `#${id}` } });

describe("tabs and popups", () => {
  it("moves to a tab a click opened and back when it closes", async () => {
    await adapter.call("click", { ...run, target: { role: "link", name: "詳細を別ウィンドウで" } });
    const tab = (await adapter.call("switchTab", { ...run, title: "詳細" })) as { title: string; index: number };
    expect(tab).toMatchObject({ title: "詳細", index: 1 });
    expect(await adapter.call("getText", { ...run, target: { role: "heading" } })).toBe("受注の詳細");
    const back = (await adapter.call("closeTab", run)) as { title: string };
    expect(back.title).toBe("一覧");
    expect((await failure(adapter.call("closeTab", run))).code).toBe("LAST_TAB");
  });

  it("goes back by itself when a popup closes itself", async () => {
    await adapter.call("click", { ...run, target: { role: "button", name: "ポップアップ" } });
    await adapter.call("switchTab", { ...run, url: "/detail" });
    await adapter.call("click", { ...run, target: { role: "button", name: "閉じる" } });
    await adapter.call("waitFor", { ...run, target: { role: "button", name: "削除" } });
    const { title } = (await adapter.call("snapshot", run)) as { title: string };
    expect(title).toBe("一覧");
  });

  it("lists the tabs when none matches", async () => {
    const err = await failure(adapter.call("switchTab", { ...run, title: "ない", timeoutMs: 300 }));
    expect(err.code).toBe("TAB_NOT_FOUND");
    expect(err.details?.tabs).toEqual([expect.objectContaining({ title: "一覧", current: true })]);
  });
});

describe("JS dialogs", () => {
  it("accepts or dismisses a confirm and returns its message", async () => {
    expect(await adapter.call("click", { ...run, target: { role: "button", name: "削除" }, dialog: "accept" })).toBe("削除しますか？");
    expect(await text("r")).toBe("削除しました");
    expect(await adapter.call("click", { ...run, target: { role: "button", name: "削除" }, dialog: "dismiss" })).toBe("削除しますか？");
    expect(await text("r")).toBe("やめました");
  });

  it("waits for a dialog that comes after the click and types into a prompt", async () => {
    const message = await adapter.call("click", {
      ...run,
      target: { role: "button", name: "件名" },
      dialog: { action: "accept", promptText: "請求書" },
    });
    expect(message).toBe("件名は？");
    await adapter.call("waitFor", { ...run, target: { text: "件名：請求書" } });
    expect(await adapter.call("click", { ...run, target: { role: "button", name: "登録" }, dialog: "accept" })).toBe("登録しました（受付番号 42）");
  });

  it("dismisses dialogs nobody answers and says so in the next failure", async () => {
    expect(await adapter.call("click", { ...run, target: { role: "button", name: "削除" } })).toBeNull();
    await adapter.call("waitFor", { ...run, target: { text: "やめました" } });
    const err = await failure(adapter.call("click", { ...run, target: { text: "削除しました" }, timeoutMs: 300 }));
    expect(err.details?.dismissedDialog).toEqual({ type: "confirm", message: "削除しますか？" });
    expect(String(err.details?.hint)).toContain('dialog: "accept"');
  });

  it("masks secrets quoted in a dialog", async () => {
    const r = { runId: "run_dialog_secret" };
    const html = `<label>パスワード <input type="password" id="p"></label><button onclick="alert('入力：' + document.getElementById('p').value)">確認</button>`;
    await adapter.call("open", { ...r, url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    const site = "null";
    await adapter.call("fill", { ...r, target: { label: "パスワード" }, value: "s3cret", secret: { name: "x", sites: [site], sensitive: true } });
    expect(await adapter.call("click", { ...r, target: { role: "button", name: "確認" }, dialog: "accept" })).toBe("入力：***");
    await adapter.call("closeRun", r);
  });

  it("fails when the expected dialog never shows", async () => {
    const started = Date.now();
    const err = await failure(adapter.call("click", { ...run, target: { css: "#r" }, dialog: "accept", timeoutMs: 300 }));
    expect(err.code).toBe("DIALOG_NOT_SHOWN");
    // The click and the wait share the step's limit.
    expect(Date.now() - started).toBeLessThan(600);
  });
});

describe("frames", () => {
  it("reaches elements inside frames and frames inside frames", async () => {
    await adapter.call("fill", { ...run, target: { label: "備考", frame: { name: "main" } }, value: "至急" });
    const filled = await adapter.call("getAttribute", { ...run, target: { label: "備考", frame: { title: "本文" } }, name: "value" });
    expect(filled).toBeNull(); // the attribute, not the typed value
    const inner = { role: "button", name: "奥のボタン", frame: { name: "inner", frame: { name: "main" } } };
    await adapter.call("click", { ...run, target: inner });
    expect(await adapter.call("getText", { ...run, target: { ...inner, name: "押しました" } })).toBe("押しました");
  });

  it("lists the frames for AI clients and in failures", async () => {
    const page = (await adapter.call("snapshot", run)) as { frames: { name: string }[]; framesHint: string };
    expect(page.frames.map((f) => f.name)).toEqual(["main"]);
    expect(page.framesHint).toContain("frame");
    const inside = (await adapter.call("snapshot", { ...run, target: { css: "body", frame: { name: "main" } } })) as { snapshot: string };
    expect(inside.snapshot).toContain("備考");
    const err = await failure(adapter.call("click", { ...run, target: { label: "備考" }, timeoutMs: 300 }));
    expect(err.details?.frames).toEqual([expect.objectContaining({ name: "main", title: "本文" })]);
  });
});

describe("hover, scroll and attributes", () => {
  it("opens a menu by hovering", async () => {
    expect(await adapter.call("isVisible", { ...run, target: { role: "link", name: "月次レポート" }, waitMs: 100 })).toBe(false);
    await adapter.call("hover", { ...run, target: { text: "メニュー" } });
    expect(await adapter.call("isVisible", { ...run, target: { role: "link", name: "月次レポート" } })).toBe(true);
  });

  it("scrolls the page, an element into view and a list by itself", async () => {
    const at = async (id: string, want: string) => adapter.call("waitFor", { ...run, target: { css: `#${id}:text-is("${want}")` } });
    await adapter.call("scroll", { ...run, to: "bottom" });
    await at("y", "下");
    await adapter.call("scroll", { ...run, to: "top" });
    await at("y", "上");
    await adapter.call("scroll", { ...run, target: { css: "#foot" } });
    await at("y", "途中");
    await adapter.call("scroll", { ...run, target: { css: "#list" }, to: "bottom" });
    await at("ly", "下");
    expect((await failure(adapter.call("scroll", run))).code).toBe("INVALID_PARAMS");
  });

  it("reads attributes, links as full addresses", async () => {
    expect(await adapter.call("getAttribute", { ...run, target: { css: "#dl" }, name: "href" })).toBe(`${base}/files/report.csv`);
    expect(await adapter.call("getAttribute", { ...run, target: { css: "#dl" }, name: "title" })).toBeNull();
    const all = (await adapter.call("getAttribute", { ...run, target: { role: "link" }, name: "href", all: true })) as string[];
    expect(all).toContain(`${base}/files/report.csv`);
  });
});

describe("downloads and uploads", () => {
  const dir = mkdtempSync(join(tmpdir(), "shikigami-dl-"));

  it("saves a download to a path or under the site's name", async () => {
    const saved = (await adapter.call("download", { ...run, target: { css: "#dl" }, path: join(dir, "out", "受注.csv") })) as { path: string; fileName: string };
    expect(saved).toEqual({ path: join(dir, "out", "受注.csv"), fileName: "report_20261106.csv" });
    expect(readFileSync(saved.path, "utf8")).toContain("A-1001");
    const named = (await adapter.call("download", { ...run, target: { css: "#dl" }, folder: join(dir, "in") })) as { path: string };
    expect(named.path).toBe(join(dir, "in", "report_20261106.csv"));
    const none = await failure(adapter.call("download", { ...run, target: { role: "button", name: "削除" }, path: join(dir, "x"), timeoutMs: 400 }));
    expect(none.code).toBe("DOWNLOAD_NOT_STARTED");
    expect((await failure(adapter.call("download", { ...run, target: { css: "#dl" } }))).code).toBe("INVALID_PARAMS");
    const started = Date.now();
    const slow = await failure(adapter.call("download", { ...run, target: { css: "#slow" }, path: join(dir, "slow.csv"), timeoutMs: 800 }));
    expect(slow.code).toBe("DOWNLOAD_FAILED");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("uploads through a file input or a button that opens the picker", async () => {
    const a = join(dir, "a.pdf");
    const b = join(dir, "b.pdf");
    writeFileSync(a, "%PDF-1.4");
    writeFileSync(b, "%PDF-1.4");
    const r = { runId: "run_upload" };
    await adapter.call("open", { ...r, url: `${base}/upload` });
    await adapter.call("upload", { ...r, target: { label: "請求書" }, path: [a, b] });
    expect(await adapter.call("getText", { ...r, target: { css: "#n" } })).toBe("a.pdf,b.pdf");
    await adapter.call("upload", { ...r, target: { role: "button", name: "ファイルを選ぶ" }, path: a });
    expect(await adapter.call("getText", { ...r, target: { css: "#n" } })).toBe("hidden:a.pdf");
    const missing = await failure(adapter.call("upload", { ...r, target: { label: "請求書" }, path: join(dir, "ない.pdf") }));
    expect(missing.code).toBe("FILE_NOT_FOUND");
    await adapter.call("closeRun", r);
  });
});
