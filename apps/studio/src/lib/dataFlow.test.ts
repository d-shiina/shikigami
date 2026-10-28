import type { Step } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { dataLinks, INPUT_NODE, OUTPUT_NODE } from "./dataFlow";

describe("dataLinks", () => {
  it("links each read to the latest write before it, and outputs to their last writer", () => {
    const steps: Step[] = [
      { id: "loop", type: "control.forEach", params: { items: "invoices", itemVar: "invoice" }, blocks: { body: [
        { id: "add", type: "variable.set", params: { name: "total", expression: "total + invoice.amount" } },
      ] } },
      { id: "log", type: "log.message", params: { message: "合計 {{ total }}" } },
    ];
    const variables = [
      { name: "invoices", type: "array" as const, direction: "input" as const },
      { name: "total", type: "number" as const, direction: "output" as const },
    ];
    const links = dataLinks(steps, variables, new Map(), new Set(["invoices", "total", "invoice"]));
    expect(links).toEqual([
      { variable: "invoices", from: INPUT_NODE, to: "loop", toHandle: "in:items" },
      { variable: "total", from: INPUT_NODE, to: "add", toHandle: "in:expression" },
      { variable: "invoice", from: "loop", to: "add", toHandle: "in:expression" },
      { variable: "total", from: "add", to: "log", toHandle: "in:message" },
      { variable: "total", from: "add", to: OUTPUT_NODE, toHandle: "in:total" },
    ]);
  });
});

import { hubColumns, HUB_COL_W, hubLinks } from "./varHub";

describe("variable box", () => {
  it("links writers into the box and the box into readers", () => {
    const steps: Step[] = [
      { id: "set", type: "variable.set", params: { name: "total", expression: "1" } },
      { id: "log", type: "log.message", params: { message: "{{ total }}" } },
    ];
    const links = dataLinks(steps, [{ name: "total", type: "number" }], new Map(), new Set(["total"]));
    expect(hubLinks(steps, links)).toEqual([
      { kind: "write", step: "set", variable: "total" },
      { kind: "read", step: "log", variable: "total", handle: "in:message" },
    ]);
  });

  it("places columns above their users without overlapping", () => {
    const x = { a: 0, b: 10, c: 500 } as Record<string, number>;
    const cols = hubColumns(["c", "a", "b", "unused"], ["a", "b", "c"].map((v) => ({ kind: "write" as const, step: v, variable: v })), (l) => x[l.step]);
    expect(cols.get("a")).toBe(-HUB_COL_W / 2);
    expect(cols.get("b")).toBe(cols.get("a")! + HUB_COL_W);
    expect(cols.get("c")).toBe(500 - HUB_COL_W / 2);
    expect(cols.get("unused")).toBe(cols.get("c")! + HUB_COL_W);
  });
});
