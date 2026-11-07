import type { Flow, StepTypeDef, ValidationReport } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { authorIssues, flowForChat, handOffText, isUnset, personTodos, returnText, todosByStep } from "./todos";

const defs = new Map<string, StepTypeDef>([["excel.readRows", { type: "excel.readRows", pathParams: ["path"] } as unknown as StepTypeDef]]);

const flow: Flow = {
  schemaVersion: 5,
  id: "flw_1",
  name: "受注",
  revision: 3,
  metadata: {},
  parts: {
    login: { label: "ログインボタン", app: "browser" },
    search: { label: "検索欄", app: "browser", target: { label: "検索" } },
  },
  steps: [
    { id: "a", type: "browser.click", params: { target: { part: "login" } } },
    { id: "b", type: "browser.fill", params: { target: { part: "search" }, value: { secret: "受注システム", field: "password" } } },
    { id: "c", type: "excel.readRows", params: { path: "input/受注.xlsx" } },
    { id: "d", type: "excel.readRows", params: { path: "output/{{ day }}.xlsx" } },
    { id: "e", type: "control.if", params: { condition: "true" }, blocks: { then: [{ id: "f", type: "browser.click", params: { target: { part: "login" } } }] } },
  ],
} as Flow;

describe("personTodos", () => {
  it("lists the parts to pick, the logins to register and the files to put", () => {
    const todos = personTodos(flow, defs, new Set(["別のログイン"]), { flowId: "flw_1", dir: "", folders: [], files: [] });
    expect(todos).toEqual([
      { kind: "pick", part: "login", label: "ログインボタン", app: "browser", steps: ["a", "f"] },
      { kind: "secret", name: "受注システム", fields: ["password"], steps: ["b"] },
      { kind: "file", path: "input/受注.xlsx", steps: ["c"] },
    ]);
    expect(todosByStep(todos).get("a")).toHaveLength(1);
  });

  it("says nothing about what it does not know yet", () => {
    const todos = personTodos(flow, defs, null, null);
    expect(todos.map((t) => t.kind)).toEqual(["pick"]);
    const registered = personTodos(flow, defs, new Set(["受注システム"]), {
      flowId: "flw_1",
      dir: "",
      folders: [],
      files: [{ path: "input/受注.xlsx" } as never],
    });
    expect(registered.map((t) => t.kind)).toEqual(["pick"]);
  });
});

describe("text for the AI", () => {
  const validation: ValidationReport = {
    valid: false,
    issues: [
      { severity: "error", code: "PART_NOT_PICKED", message: "not picked", path: "/steps/0/params/target", stepId: "a" },
      { severity: "error", code: "INVALID_PARAMS", message: "'value' is required", path: "/steps/1/params", stepId: "b", hint: "Set value." },
      { severity: "warning", code: "X", message: "w", path: "" },
    ],
  };

  it("keeps what a person does out of what goes back to the AI", () => {
    const issues = authorIssues(validation);
    expect(issues.map((i) => i.code)).toEqual(["INVALID_PARAMS"]);
    const text = returnText(issues, flow);
    expect(text).toContain("1. /flow/steps/1/params");
    expect(text).toContain("'value' is required");
    expect(text).toContain("Set value.");
    expect(text).toContain('"format": "shikigami.answer"');
  });

  it("hands the flow over without what Studio owns", () => {
    const answer = JSON.parse(flowForChat(flow)) as { flow: Record<string, unknown> };
    expect(Object.keys(answer.flow)).toEqual(["name", "parts", "steps"]);
    expect(handOffText(flow)).toContain("```json");
  });

  it("never hands a secret's value to the AI", () => {
    const withSecret = { ...flow, variables: [{ name: "pw", type: "string", secret: true, default: "hunter2" }, { name: "n", type: "number", default: 3 }] } as Flow;
    const text = flowForChat(withSecret);
    expect(text).not.toContain("hunter2");
    expect(text).toContain('"default": 3');
  });
});

describe("isUnset", () => {
  const issue = (path: string) => ({ code: "INVALID_PARAMS", message: '"path" is a required property', path });
  it("takes a node's own empty setting as not set up yet", () => {
    expect(isUnset(issue("/steps/0/params"))).toBe(true);
  });
  it("keeps a required item inside a list as an error", () => {
    expect(isUnset(issue("/steps/0/params/by/0"))).toBe(false);
  });
});
