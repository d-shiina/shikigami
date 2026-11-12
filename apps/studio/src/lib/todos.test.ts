import type { Flow, StepTypeDef, ValidationReport } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { authorIssues, blocksRun, liveStepIds, fixText, isUnset, personTodos, todosByStep } from "./todos";

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

describe("an account picked each run", () => {
  it("asks to register each of the input's choices that is missing", () => {
    const picked = {
      ...flow,
      parts: {},
      variables: [{ name: "アカウント", type: "string", direction: "input", choices: ["受注（経理）", "受注（申請）"] }],
      steps: [{ id: "u", type: "browser.fill", params: { value: { secret: "{{ アカウント }}", field: "username" } } }],
    } as Flow;
    const todos = personTodos(picked, defs, new Set(["受注（経理）"]), null);
    expect(todos).toEqual([{ kind: "secret", name: "受注（申請）", fields: ["username"], steps: ["u"] }]);
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
    const text = fixText(issues, flow);
    expect(text).toContain("1. /steps/1/params");
    expect(text).toContain("'value' is required");
    expect(text).toContain("Set value.");
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

describe("what stops a run before it starts", () => {
  const steps = [
    { id: "a", type: "x", params: {} },
    { id: "b", type: "x", params: {}, disabled: true, blocks: { body: [{ id: "c", type: "x", params: {} }] } },
  ] as never;
  const live = liveStepIds(steps);
  it("is a login or a part that a step the run reaches needs", () => {
    expect([...live]).toEqual(["a"]);
    expect(blocksRun({ kind: "secret", name: "s", fields: ["password"], steps: ["a"] }, live)).toBe(true);
    expect(blocksRun({ kind: "secret", name: "s", fields: ["password"], steps: ["b", "c"] }, live)).toBe(false);
  });
  it("is never a missing file, which a step may write or check for", () => {
    expect(blocksRun({ kind: "file", path: "config/settings.json", steps: ["a"] }, live)).toBe(false);
  });
});
