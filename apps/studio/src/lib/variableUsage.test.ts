import type { Step } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { variableUsage } from "./variableUsage";

describe("variableUsage", () => {
  it("lists declared and step-made variables with the steps that write and read them", () => {
    const steps: Step[] = [
      { id: "loop", type: "control.forEach", params: { items: "invoices", itemVar: "invoice" }, blocks: { body: [
        { id: "add", type: "variable.set", params: { name: "total", expression: "total + invoice.amount" } },
      ] } },
      { id: "log", type: "log.message", params: { message: "合計 {{ total }}" } },
    ];
    const variables = [
      { name: "total", type: "number" as const, direction: "output" as const, default: 0 },
      { name: "invoices", type: "array" as const, direction: "input" as const },
      { name: "unused", type: "string" as const },
    ];
    const rows = variableUsage(steps, variables).map(({ def: _, ...rest }) => rest);
    expect(rows).toEqual([
      { name: "invoices", type: "array", direction: "input", writers: [], readers: ["loop"] },
      { name: "total", type: "number", direction: "output", writers: ["add"], readers: ["add", "log"] },
      { name: "unused", type: "string", direction: "local", writers: [], readers: [] },
      { name: "invoice", type: "any", direction: "made", writers: ["loop"], readers: ["add"] },
    ]);
  });
});
