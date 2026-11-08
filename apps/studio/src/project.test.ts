import type { ConfigItem, Flow } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import type { AskAnswer } from "./lib/ask";
import { CONFIG_FORMAT, formatConfig, itemUsers, latestLog, logStatus, parseConfig, roleOf, shelfFor, usersOf } from "./project";

const flow = {
  id: "s",
  name: "s",
  revision: 1,
  schemaVersion: 3,
  steps: [
    { id: "a", type: "config.read", params: { path: "config/settings.json" }, saveAs: "settings" },
    { id: "b", type: "excel.readRows", params: { path: "input/orders.xlsx" }, saveAs: "orders" },
    {
      id: "c",
      type: "control.forEach",
      params: { items: "orders" },
      blocks: { body: [{ id: "d", type: "control.if", params: { condition: "item.amount >= settings.threshold" } }] },
    },
  ],
} as unknown as Flow;

describe("project files", () => {
  it("sorts dropped files onto shelves by name", () => {
    expect(shelfFor("受注一覧.xlsx")).toBe("input");
    expect(shelfFor("settings.json")).toBe("config");
    expect(shelfFor("請求書テンプレート.xlsx")).toBe("templates");
    expect(shelfFor("letter.dotx")).toBe("templates");
  });

  it("tells a file's role by its folder", () => {
    expect(roleOf("input/2026/a.xlsx")).toBe("input");
    expect(roleOf("logs/x.log")).toBe("logs");
    expect(roleOf("notes.txt")).toBeNull();
  });

  it("reads settings files and leaves other JSON as text", () => {
    const text = formatConfig({ format: "shikigami.config", items: [{ name: "threshold", type: "number", value: 1 as never }] });
    expect(parseConfig(text)?.items?.[0]?.name).toBe("threshold");
    expect(parseConfig('{"a":1}')).toBeNull();
    expect(parseConfig("not json")).toBeNull();
  });

  it("finds the steps that use a file and each setting", () => {
    expect(usersOf(flow, "input/orders.xlsx").map((s) => s.id)).toEqual(["b"]);
    expect(usersOf(flow, "input\\orders.xlsx").map((s) => s.id)).toEqual(["b"]);
    const users = itemUsers(flow, "config/settings.json", [
      { name: "threshold", type: "number" },
      { name: "sendTo", type: "text" },
    ]);
    expect(users.get("threshold")?.map((s) => s.id)).toEqual(["d"]);
    expect(users.get("sendTo")).toEqual([]);
  });

  it("picks the newest run log", () => {
    const files = ["logs/20261029-090000_succeeded.log", "logs/20261029-100000_failed.log", "logs/memo.log"].map((path) => ({ path, size: 1 }));
    expect(latestLog(files)?.path).toBe("logs/20261029-100000_failed.log");
    expect(logStatus("logs/20261029-100000_failed.log")).toBe("failed");
  });
});

describe("the open sheet", () => {
  it("keeps unsaved edits when another file is opened and the person cancels", async () => {
    const { createProjectStore } = await import("./project");
    const api = {
      list: async () => ({ flowId: "s", dir: "", folders: [], files: [] }),
      readText: async (_: string, path: string) => `text of ${path}`,
    } as unknown as Parameters<typeof createProjectStore>[0];
    let answer: AskAnswer = "cancel";
    const asked: string[] = [];
    const store = createProjectStore(api, {
      added: () => "",
      unsaved: async (path) => {
        asked.push(path);
        return answer;
      },
    });
    await store.getState().load("s");
    await store.getState().openFile("input/a.csv");
    store.getState().editSheet("edited");
    await store.getState().openFile("input/b.csv");
    expect(asked).toEqual(["input/a.csv"]);
    expect(store.getState().sheet?.path).toBe("input/a.csv");
    expect(store.getState().sheet?.text).toBe("edited");
    answer = "other";
    await store.getState().openFile("input/b.csv");
    expect(store.getState().sheet?.text).toBe("text of input/b.csv");
  });
});

describe("settings autosave", () => {
  it("writes a setting typed just before another flow is opened", async () => {
    const { createProjectStore } = await import("./project");
    const writes: [string, string, string][] = [];
    const api = {
      list: async (id: string) => ({ flowId: id, dir: "", folders: [], files: [] }),
      readText: async () => JSON.stringify({ items: [{ name: "締め日", type: "text", value: "25" }] }),
      writeText: async (id: string, path: string, text: string) => {
        writes.push([id, path, text]);
        return { path, size: text.length };
      },
    } as unknown as Parameters<typeof createProjectStore>[0];
    const store = createProjectStore(api, { added: () => "", unsaved: async () => "cancel" });
    await store.getState().load("s");
    await store.getState().openFile("config/settings.json");
    store.getState().editConfig({ format: CONFIG_FORMAT, items: [{ name: "締め日", type: "text", value: "20" as unknown as ConfigItem["value"] }] });
    // Within the autosave pause, the person opens another flow.
    await store.getState().load("t");
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe("s");
    expect(writes[0]![2]).toContain('"20"');
    expect(store.getState().flowId).toBe("t");
    expect(store.getState().sheet).toBeNull();
  });
});
