import type { Step } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { CALL_BAR_H, knownVariables, NODE_HEAD_H, NODE_PAD_B, nodeHeight, nodeRows, ROW_H, splitRefs, unsetParams } from "./nodeRows";

const set: Step = { id: "s1", type: "variable.set", params: { name: "total", expression: "total + invoice.amount" } };
const loop: Step = { id: "s2", type: "control.forEach", params: { items: "invoices", itemVar: "invoice" }, blocks: { body: [set] } };

describe("nodeRows", () => {
  it("lists params as rows and the written variable as an output", () => {
    const rows = nodeRows(set, undefined, new Set(["total", "invoice"]));
    expect(rows).toEqual([
      { kind: "param", key: "expression", label: "式", value: "total + invoice.amount", raw: "total + invoice.amount", refs: ["total", "invoice"] },
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
      type: "flow.call",
      params: { flow: "scn_tax", inputs: { amount: "{{ price }}" }, outputs: { taxed: "total" } },
    };
    expect(nodeRows(call, undefined, new Set(["price"]))).toEqual([
      { kind: "param", key: "inputs.amount", label: "amount", value: "{{ price }}", raw: "{{ price }}", refs: ["price"] },
      { kind: "output", label: "taxed", variable: "total" },
    ]);
    expect(nodeHeight(call, undefined)).toBe(NODE_HEAD_H + CALL_BAR_H + 2 * ROW_H + NODE_PAD_B);
    expect(knownVariables([], [call]).has("total")).toBe(true);
  });

  it("keeps the whole text of a value cut short, and the setting as stored", () => {
    const long = "こんにちは、山田様。ご注文いただいた商品の発送が完了しましたのでお知らせします。お届けまでしばらくお待ちください。";
    const step: Step = { id: "m1", type: "mail.send", params: { body: long } };
    const [row] = nodeRows(step, undefined);
    expect(row).toMatchObject({ kind: "param", raw: long, full: long });
    expect(row?.kind === "param" && row.value.endsWith("…")).toBe(true);
    const short: Step = { id: "m2", type: "mail.send", params: { body: "短い" } };
    expect(nodeRows(short, undefined)[0]).not.toHaveProperty("full");
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

  it("cuts an expression around the variables it uses, with their fields", () => {
    expect(splitRefs("total > limit && response.rows.length > 0", ["total", "limit", "response"])).toEqual([
      "",
      "total",
      " > ",
      "limit",
      " && ",
      "response.rows.length",
      " > 0",
    ]);
    expect(splitRefs("subtotal + items[0].金額", ["total", "items"])).toEqual(["subtotal + ", "items[0].金額", ""]);
    expect(splitRefs("x.total", ["total"])).toEqual(["x.total"]);
  });

  it("finds the required settings still empty, and gives them a row", () => {
    const def = { type: "browser.fill", category: "browser", label: "", description: "", risk: "safe", paramsSchema: { required: ["target", "value"], properties: { target: {}, value: {} } } } as never;
    const fresh = { id: "s", type: "browser.fill", params: { target: { label: "" } } };
    expect(unsetParams(fresh, def)).toEqual(["target", "value"]);
    expect(nodeRows(fresh, def).filter((r) => r.kind === "param" && r.unset).map((r) => (r.kind === "param" ? r.key : ""))).toEqual(["target", "value"]);
    expect(unsetParams({ ...fresh, params: { target: { role: "textbox", name: "注文番号" }, value: "{{ no }}" } }, def)).toEqual([]);
    expect(unsetParams({ id: "o", type: "browser.open", params: { url: "https://" } }, { ...(def as object), paramsSchema: { required: ["url"] } } as never)).toEqual(["url"]);
  });
});
