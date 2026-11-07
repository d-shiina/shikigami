// @vitest-environment jsdom
import type { Flow, StepTypeDef } from "@shikigami/schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioContext } from "../../context";
import type { Api } from "../../lib/api";
import { createStudioStore } from "../../store";
import { NodeEditor } from "../NodeEditor";
import { StepInspector } from "./StepInspector";

afterEach(cleanup);

const setDef = {
  type: "variable.set",
  category: "variable",
  label: "変数への代入",
  description: "",
  paramsSchema: { type: "object", properties: { name: { type: "string" }, expression: { type: "string" } }, required: ["name"] },
  blocks: [],
  hasOutput: true,
  expressionParams: ["expression"],
  bindsVariables: ["name"],
  risk: "safe",
} as unknown as StepTypeDef;

const flow: Flow = {
  schemaVersion: 6,
  id: "scn_a",
  name: "A",
  revision: 1,
  variables: [{ name: "price", type: "number", direction: "input" }],
  steps: [{ id: "s1", type: "variable.set", name: "二倍にする", params: { name: "total", expression: "price * 2" } }],
  metadata: {},
} as unknown as Flow;

async function studio(overrides: Partial<Api> = {}) {
  const api = {
    listFlows: vi.fn(async () => []),
    listStepTypes: vi.fn(async () => [setDef]),
    getFlow: vi.fn(async () => flow),
    validate: vi.fn(async () => ({ valid: true, issues: [] })),
    undoState: vi.fn(async () => ({ canUndo: false, canRedo: false })),
    history: vi.fn(async () => []),
    listSecrets: vi.fn(async () => ({ secrets: [], keyLocation: "test", keyMissing: false })),
    listSecretRequests: vi.fn(async () => []),
    dismissSecretRequest: vi.fn(async () => true),
    ...overrides,
  } as unknown as Api;
  const store = createStudioStore(api);
  store.setState({ stepTypes: [setDef] });
  await store.getState().open("scn_a");
  store.getState().select({ kind: "step", stepId: "s1" });
  return store;
}

describe("the right pane", () => {
  it("shows a node's settings read-only and opens the node to change them", async () => {
    const store = await studio();
    render(
      <StudioContext.Provider value={store}>
        <StepInspector />
      </StudioContext.Provider>,
    );
    expect(screen.getByText("price * 2")).toBeTruthy();
    // Nothing to type into: settings are edited in the node opened full size.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /設定を開く/ }));
    expect(store.getState().editing).toBe("s1");
  });
});

describe("the node opened full size", () => {
  it("runs the node alone only when the values it reads are known", async () => {
    const testStep = vi.fn(async () => ({ status: "succeeded", output: 42, logs: [] }));
    const run = vi.fn(async () => "run_1");
    const store = await studio({ testStep, run } as Partial<Api>);
    store.getState().openEditor("s1");
    render(
      <StudioContext.Provider value={store}>
        <NodeEditor />
      </StudioContext.Provider>,
    );
    const alone = screen.getByRole("button", { name: "ノードの単体実行" }) as HTMLButtonElement;
    // `price` is an input with no value from a run yet.
    expect(alone.disabled).toBe(true);
    expect(alone.title).toContain("price");
    // The form is here, not in the right pane.
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
    // 「ここまで実行」 runs the flow, the node alone does not.
    fireEvent.click(screen.getByRole("button", { name: "ここまで実行" }));
    expect(run).toHaveBeenCalled();
    expect(testStep).not.toHaveBeenCalled();
  });
});

describe("a list of records", () => {
  it("edits a form's fields one box at a time, never as JSON", async () => {
    const formDef = {
      type: "dialog.form",
      category: "system",
      label: "入力フォーム",
      description: "",
      paramsSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                label: { type: "string" },
                type: { enum: ["text", "date"] },
                options: { type: "array", items: { type: ["string", "number"] } },
              },
              required: ["name"],
            },
          },
        },
        required: ["fields"],
      },
      blocks: [],
      hasOutput: true,
      risk: "interactive",
    } as unknown as StepTypeDef;
    const formFlow = {
      ...flow,
      steps: [{ id: "s1", type: "dialog.form", params: { fields: [{ name: "month", label: "対象月" }] } }],
    } as unknown as Flow;
    const edit = vi.fn(async () => {
      throw new Error("not saved in this test");
    });
    const store = await studio({ listStepTypes: vi.fn(async () => [formDef]), getFlow: vi.fn(async () => formFlow), edit } as Partial<Api>);
    store.setState({ stepTypes: [formDef] });
    store.getState().openEditor("s1");
    render(
      <StudioContext.Provider value={store}>
        <NodeEditor />
      </StudioContext.Provider>,
    );
    expect(screen.getByText("結果のキー")).toBeTruthy();
    expect((screen.getByDisplayValue("対象月") as HTMLInputElement).value).toBe("対象月");
    expect(screen.queryByDisplayValue(/\[\{/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /項目を追加/ }));
    const sent = () => (edit.mock.calls.at(-1) as unknown as [string, number, { patch: { replaceParams: { fields: unknown[] } } }[]])[2][0]!.patch.replaceParams.fields;
    expect(sent()).toEqual([{ name: "month", label: "対象月" }, {}]);
    fireEvent.click(screen.getAllByTitle("この項目を外す")[0]!);
    // The only field gone: the setting is left unset, not an empty list.
    expect((edit.mock.calls.at(-1) as unknown as [string, number, { patch: { replaceParams: object } }[]])[2][0]!.patch.replaceParams).toEqual({});
  });
});
