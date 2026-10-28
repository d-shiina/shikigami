import type { Step } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { CALL_BAR_H, knownVariables, NODE_HEAD_H, NODE_PAD_B, nodeHeight, nodeRows, ROW_H } from "./nodeRows";

const set: Step = { id: "s1", type: "variable.set", params: { name: "total", expression: "total + invoice.amount" } };
const loop: Step = { id: "s2", type: "control.forEach", params: { items: "invoices", itemVar: "invoice" }, blocks: { body: [set] } };

describe("nodeRows", () => {
  it("lists params as rows and the written variable as an output", () => {
    const rows = nodeRows(set, undefined, new Set(["total", "invoice"]));
    expect(rows).toEqual([
      { kind: "param", key: "expression", label: "式", value: "total + invoice.amount", refs: ["total", "invoice"] },
      { kind: "output", label: "書き込む", variable: "total" },
    ]);
  });

  it("treats a loop's element as an output, not a param row", () => {
    const rows = nodeRows(loop, undefined);
    expect(rows.map((r) => r.kind)).toEqual(["param", "output"]);
  });

  it("shows a call's inputs as rows and its outputs as written variables", () => {
    const call: Step = {
      id: "c1",
      type: "scenario.call",
      params: { scenario: "scn_tax", inputs: { amount: "{{ price }}" }, outputs: { taxed: "total" } },
    };
    expect(nodeRows(call, undefined, new Set(["price"]))).toEqual([
      { kind: "param", key: "inputs.amount", label: "amount", value: "{{ price }}", refs: ["price"] },
      { kind: "output", label: "taxed", variable: "total" },
    ]);
    expect(nodeHeight(call, undefined)).toBe(NODE_HEAD_H + CALL_BAR_H + 2 * ROW_H + NODE_PAD_B);
    expect(knownVariables([], [call]).has("total")).toBe(true);
  });

  it("sizes nodes by their rows", () => {
    expect(nodeHeight(set, undefined)).toBe(NODE_HEAD_H + 2 * ROW_H + NODE_PAD_B);
  });

  it("knows declared variables and loop elements", () => {
    const vars = knownVariables([{ name: "invoices", type: "array" }], [loop]);
    expect([...vars]).toEqual([
      ["invoices", "array"],
      ["invoice", "any"],
      ["total", "any"],
    ]);
  });
});
