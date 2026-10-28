import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startDemoSite } from "../src/demo-site.ts";

// No browser needed, so this also runs on the Windows CI runner.
let server: Server;
let base: string;

beforeAll(async () => {
  ({ server, url: base } = await startDemoSite(0));
});

afterAll(() => {
  server.close();
});

describe("demo site", () => {
  it.each(["", "orders.html", "stock.html", "app.js", "style.css"])("serves /%s", async (path) => {
    const res = await fetch(new URL(path, base));
    expect(res.status).toBe(200);
  });

  it("serves index.html for the root", async () => {
    const html = await (await fetch(base)).text();
    expect(html).toContain("サンプル商事");
  });

  it("answers 404 for a missing file and refuses to leave the site", async () => {
    expect((await fetch(new URL("missing.html", base))).status).toBe(404);
    const res = await fetch(new URL("/%2e%2e/%2e%2e/package.json", base));
    expect([403, 404]).toContain(res.status);
  });
});
