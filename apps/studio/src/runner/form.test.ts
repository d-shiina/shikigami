import type { Flow } from "@spellsheet/schema";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../lib/i18n";
import { collect, fieldsOf, formatValue, initialValues, topOf } from "./form";
import { progress } from "./progress";

afterEach(() => setLocale("ja", false));

const makeFlow = (over: Partial<Flow>): Flow => ({ id: "scn_a", name: "A", revision: 1, steps: [], variables: [], ...over }) as Flow;

const invoices = makeFlow({
  variables: [
    { name: "month", type: "string", direction: "input", description: "対象の月\n例：2026-10" },
    { name: "threshold", type: "number", direction: "input", default: 100000, description: "高額のしきい値（円）" },
    { name: "mail", type: "boolean", direction: "input", default: false },
    { name: "names", type: "array", direction: "input", default: ["a", "b"] },
    { name: "password", type: "string", direction: "input", secret: true },
    { name: "total", type: "number", direction: "output" },
    { name: "tmp", type: "any" },
  ],
});

describe("the run window's form", () => {
  it("is made from the input variables", () => {
    expect(fieldsOf(invoices).map((f) => [f.name, f.label, f.kind, f.required, f.initial])).toEqual([
      ["month", "対象の月", "text", true, ""],
      ["threshold", "高額のしきい値（円）", "number", false, "100000"],
      ["mail", "mail", "checkbox", false, false],
      ["names", "names", "lines", false, "a\nb"],
      ["password", "password", "password", true, ""],
    ]);
  });

  it("offers pickers, a calendar and a list where the variable says so", () => {
    const flow = makeFlow({
      variables: [
        { name: "book", type: "string", direction: "input", format: "file", description: "売上のブック" },
        { name: "dir", type: "string", direction: "input", format: "folder", default: "C:\\out" },
        { name: "month", type: "string", direction: "input", format: "month", default: "2026-11" },
        { name: "day", type: "string", direction: "input", format: "date" },
        { name: "branch", type: "string", direction: "input", choices: ["東京", "大阪"] },
        { name: "rank", type: "number", direction: "input", choices: [1, 2, 3], default: 2 },
      ],
    });
    const fields = fieldsOf(flow);
    expect(fields.map((f) => [f.name, f.kind, f.required, f.initial])).toEqual([
      ["book", "file", true, ""],
      ["dir", "folder", false, "C:\\out"],
      ["month", "month", false, "2026-11"],
      ["day", "date", true, ""],
      ["branch", "select", true, ""],
      ["rank", "select", false, "1"],
    ]);
    expect(collect(fields, initialValues(fields)).errors).toEqual({ book: "入力してください", day: "入力してください", branch: "入力してください" });
    const values = { ...initialValues(fields), book: "C:\\売上.xlsx", day: "2026-11-06", branch: "1", rank: "0" };
    expect(collect(fields, values)).toEqual({
      inputs: { book: "C:\\売上.xlsx", dir: "C:\\out", month: "2026-11", day: "2026-11-06", branch: "大阪", rank: 1 },
      errors: {},
    });
  });

  it("offers a file picker for a text input that a step opens as a file", () => {
    const flow = makeFlow({
      variables: [
        { name: "受注一覧", type: "string", direction: "input" },
        { name: "保存先", type: "string", direction: "input" },
        { name: "宛名", type: "string", direction: "input" },
      ],
      steps: [
        {
          id: "s1",
          type: "control.forEach",
          params: {},
          blocks: { body: [{ id: "s2", type: "excel.readRows", params: { path: "{{ 受注一覧 }}" } }] },
        },
        { id: "s3", type: "file.makeFolder", params: { folder: "{{保存先}}" } },
        { id: "s4", type: "excel.readRows", params: { path: "C:/{{ 宛名 }}.xlsx" } },
      ],
    } as Partial<Flow>);
    const defs = new Map([
      ["excel.readRows", { type: "excel.readRows", pathParams: ["path"] }],
      ["file.makeFolder", { type: "file.makeFolder", pathParams: ["folder"] }],
    ]) as never;
    expect(fieldsOf(flow, defs).map((f) => f.kind)).toEqual(["file", "folder", "text"]);
    expect(fieldsOf(flow).map((f) => f.kind)).toEqual(["text", "text", "text"]);
  });

  it("turns what was typed into the inputs, by type", () => {
    const fields = fieldsOf(invoices);
    const values = { ...initialValues(fields), month: "2026-10", threshold: "120,000", mail: true, names: "東京\n大阪\n", password: "x" };
    expect(collect(fields, values)).toEqual({
      inputs: { month: "2026-10", threshold: 120000, mail: true, names: ["東京", "大阪"], password: "x" },
      errors: {},
    });
  });

  it("asks for what has no default, and leaves empty ones to their default", () => {
    const fields = fieldsOf(invoices);
    const { inputs, errors } = collect(fields, { ...initialValues(fields), threshold: "", names: "" });
    expect(errors).toEqual({ month: "入力してください", password: "入力してください" });
    expect(inputs).toEqual({ mail: false });
    expect(collect(fields, { ...initialValues(fields), month: "x", password: "x", threshold: "たくさん" }).errors).toEqual({ threshold: "数値を入力してください" });
  });

  it("keeps defaults that one item per line would change", () => {
    const fields = fieldsOf(makeFlow({ variables: [{ name: "ids", type: "array", direction: "input", default: [1, 2, 3] }] }));
    expect(fields[0]?.initial).toBe("[\n  1,\n  2,\n  3\n]");
    expect(collect(fields, initialValues(fields)).inputs).toEqual({ ids: [1, 2, 3] });
  });

  it("shows results in the person's way", () => {
    expect(formatValue(3842500)).toBe("3,842,500");
    expect(formatValue(true)).toBe("はい");
    expect(formatValue([1, 2])).toBe("2 件");
    setLocale("en", false);
    expect(formatValue([1])).toBe("1 item");
  });
});

describe("the run window's progress", () => {
  const sample = makeFlow({
    steps: [
      { id: "read", type: "excel.readRows" },
      { id: "loop", type: "control.forEach", blocks: { body: [{ id: "make", type: "word.fillTemplate" }] } },
      { id: "off", type: "log.message", disabled: true },
      { id: "call", type: "flow.call" },
    ],
  });
  const base = { runId: "run_1", at: "2026-11-06T00:00:00Z" };

  it("knows which top-level step a nested one is in", () => {
    expect(topOf(sample).get("make")).toBe("loop");
  });

  it("ticks off the top-level steps as the run passes them", () => {
    const p = progress(sample, [
      { ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 },
      { ...base, seq: 1, type: "stepStarted", stepId: "read", stepType: "excel.readRows", attempt: 1 },
      { ...base, seq: 2, type: "stepFinished", stepId: "read", stepType: "excel.readRows", outcome: "succeeded", durationMs: 5 },
      { ...base, seq: 3, type: "stepStarted", stepId: "loop", stepType: "control.forEach", attempt: 1 },
      { ...base, seq: 4, type: "stepStarted", stepId: "make", stepType: "word.fillTemplate", attempt: 1 },
    ] as never);
    expect(p.tops.map((s) => [s.step.id, s.state])).toEqual([
      ["read", "done"],
      ["loop", "running"],
      ["call", "waiting"],
    ]);
    expect(p.now?.id).toBe("make");
    expect(p.finished).toBeNull();
  });

  it("moves the call step for what happens inside the called flow, and marks where it failed", () => {
    const error = { code: "FILE_NOT_FOUND", message: "x" };
    const p = progress(sample, [
      { ...base, seq: 0, type: "stepStarted", stepId: "call", stepType: "flow.call", attempt: 1 },
      { ...base, seq: 1, callPath: ["call"], type: "stepStarted", stepId: "inner", stepType: "file.read", attempt: 1 },
      { ...base, seq: 2, type: "runFinished", status: "failed", error, durationMs: 1200 },
    ] as never);
    expect(p.tops.map((s) => s.state)).toEqual(["done", "done", "failed"]);
    expect(p.finished).toEqual({ status: "failed", error, durationMs: 1200 });
  });

  it("shows what a step waits for until it finishes, inside a called flow too", () => {
    const events = [
      { ...base, seq: 0, type: "stepStarted", stepId: "call", stepType: "flow.call", attempt: 1 },
      { ...base, seq: 1, callPath: ["call"], type: "stepStarted", stepId: "login", stepType: "browser.waitForHuman", attempt: 1 },
      { ...base, seq: 2, callPath: ["call"], type: "humanActionRequired", stepId: "login", message: "ブラウザでサインインしてください" },
    ];
    expect(progress(sample, events as never).waiting).toEqual({ stepId: "login", message: "ブラウザでサインインしてください", dialog: false });
    // A step of the same id in the started flow is another step.
    const other = { ...base, seq: 3, type: "stepFinished", stepId: "login", stepType: "x", outcome: "succeeded", durationMs: 1 };
    expect(progress(sample, [...events, other] as never).waiting).not.toBeNull();
    const done = { ...other, callPath: ["call"] };
    expect(progress(sample, [...events, done] as never).waiting).toBeNull();
    const dialog = { ...base, seq: 4, type: "humanActionRequired", stepId: "read", message: "答えてください", dialog: true };
    expect(progress(sample, [dialog] as never).waiting?.dialog).toBe(true);
  });

  it("keeps a wait of one parallel branch when another branch's wait ends", () => {
    const login = { ...base, seq: 0, type: "humanActionRequired", stepId: "read", message: "サインインしてください" };
    const ask = { ...base, seq: 1, type: "humanActionRequired", stepId: "make", message: "答えてください", dialog: true };
    expect(progress(sample, [login, ask] as never).waiting?.stepId).toBe("make");
    const answered = { ...base, seq: 2, type: "stepFinished", stepId: "make", stepType: "dialog.input", outcome: "succeeded", durationMs: 1 };
    expect(progress(sample, [login, ask, answered] as never).waiting).toEqual({ stepId: "read", message: "サインインしてください", dialog: false });
  });
});
