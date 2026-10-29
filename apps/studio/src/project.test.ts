import type { Scenario } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { formatConfig, itemUsers, latestLog, logStatus, parseConfig, roleOf, shelfFor, usersOf } from "./project";

const scenario = {
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
} as unknown as Scenario;

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
    expect(usersOf(scenario, "input/orders.xlsx").map((s) => s.id)).toEqual(["b"]);
    expect(usersOf(scenario, "input\\orders.xlsx").map((s) => s.id)).toEqual(["b"]);
    const users = itemUsers(scenario, "config/settings.json", [
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
