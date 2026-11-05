import type { Step, StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { effects } from "./effects";

const def = (type: string, risk: StepTypeDef["risk"], pathParams?: string[]): StepTypeDef => ({
  type,
  category: "file",
  label: type,
  description: "",
  paramsSchema: {},
  risk,
  pathParams,
});
const defs = new Map(
  [
    def("file.readCsv", "safe", ["path"]),
    def("file.writeText", "interactive", ["path"]),
    def("file.delete", "dangerous", ["path"]),
    def("browser.open", "interactive"),
    def("browser.click", "interactive"),
    def("log.message", "safe"),
  ].map((d) => [d.type, d] as const),
);

describe("effects", () => {
  it("lists what the scenario touches outside, dangerous and new first", () => {
    const steps: Step[] = [
      { id: "a", type: "browser.open", params: { url: "https://orders.example.com" } },
      { id: "b", type: "browser.click", params: { target: "ログイン" } },
      { id: "c", type: "file.readCsv", params: { path: "input/a.csv" } },
      { id: "d", type: "file.writeText", params: { path: "output/b.txt" } },
      { id: "e", type: "log.message", params: { message: "hi" } },
    ];
    const removed: Step[] = [{ id: "z", type: "file.delete", params: { path: "work/old.txt" } }];
    const list = effects(steps, new Map([["d", "added"]]), removed, defs);
    expect(list.map((e) => [e.status, e.action, e.target])).toEqual([
      ["removed", "file.delete", "work/old.txt"],
      ["added", "file.writeText", "output/b.txt"],
      ["same", "browser.open", "https://orders.example.com"],
      ["same", "file.readCsv", "input/a.csv"],
    ]);
  });

  it("marks a changed step's effect as changed unless only its name or settings changed", () => {
    const now: Step = { id: "d", type: "file.writeText", name: "新しい名前", params: { path: "output/b.txt", text: "new" } };
    const renamed: Step = { ...now, name: "古い名前" };
    expect(effects([now], new Map([["d", "changed"]]), [], defs, () => renamed)[0]?.status).toBe("same");
    const before: Step = { ...now, params: { path: "output/b.txt", text: "old" } };
    expect(effects([now], new Map([["d", "changed"]]), [], defs, () => before)[0]?.status).toBe("changed");
    const moved: Step = { ...now, params: { path: "output/c.txt" } };
    expect(effects([moved], new Map([["d", "changed"]]), [], defs, () => before)[0]?.status).toBe("changed");
  });
});
