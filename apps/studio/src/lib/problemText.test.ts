import type { Flow, ValidationIssue } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { shortJson, stepAt, valueAt, writtenAt } from "./problemText";
import { fixText } from "./todos";

const flow = {
  schemaVersion: 5,
  id: "flw_1",
  name: "請求",
  revision: 1,
  metadata: {},
  variables: [{ name: "password", type: "string", secret: true, default: "hunter2" }],
  steps: [
    {
      id: "a",
      type: "control.if",
      name: "金額の確認",
      params: { condition: "total === 3" },
      blocks: { then: [{ id: "b", type: "log.message", name: "記録", params: { message: "{{ toUpperCase(name) }}" } }] },
    },
  ],
} as unknown as Flow;

describe("what was written where a problem is", () => {
  it("finds the value and the node by the pointer", () => {
    expect(valueAt(flow, "/steps/0/params/condition")).toBe("total === 3");
    expect(stepAt(flow, "/steps/0/blocks/then/0/params/message")?.name).toBe("記録");
    expect(writtenAt(flow, { path: "/steps/0/params/condition" })).toBe('"total === 3"');
    // A whole node says nothing new.
    expect(writtenAt(flow, { path: "/steps/0" })).toBeNull();
    // A secret's value never goes to the AI.
    expect(writtenAt(flow, { path: "/variables/0/default" })).toBeNull();
    expect(writtenAt(flow, { path: "/variables/0" })).toBeNull();
    expect(shortJson("x".repeat(400)).endsWith("…")).toBe(true);
  });

  it("gives the AI what was written, how to fix it and the rules", () => {
    const issues = [
      {
        severity: "error",
        code: "EXPR_SYNTAX",
        message: "syntax error at 8: unexpected character '='",
        path: "/steps/0/params/condition",
        stepId: "a",
        hint: "Compare with == and != (there is no === or !==).",
      },
    ] as ValidationIssue[];
    const text = fixText(issues, flow);
    expect(text).toContain("/steps/0/params/condition （ノード「金額の確認」）");
    expect(text).toContain('書かれていた内容: "total === 3"');
    expect(text).toContain("直し方: Compare with ==");
    expect(text).toContain("式の決まり（抜粋）");
  });
});
