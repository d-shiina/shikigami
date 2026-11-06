import type { Scenario } from "@shikigami/schema";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../lib/i18n";
import { collect, fieldsOf, formatValue, initialValues, topOf } from "./form";
import { progress } from "./progress";

afterEach(() => setLocale("ja", false));

const scenario = (over: Partial<Scenario>): Scenario => ({ id: "scn_a", name: "A", revision: 1, steps: [], variables: [], ...over }) as Scenario;

const invoices = scenario({
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
    expect(collect(fields, { ...initialValues(fields), month: "x", password: "x", threshold: "たくさん" }).errors).toEqual({ threshold: "数を入れてください" });
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
  const flow = scenario({
    steps: [
      { id: "read", type: "excel.readRows" },
      { id: "loop", type: "control.forEach", blocks: { body: [{ id: "make", type: "word.fillTemplate" }] } },
      { id: "off", type: "log.message", disabled: true },
      { id: "call", type: "scenario.call" },
    ],
  });
  const base = { runId: "run_1", at: "2026-11-06T00:00:00Z" };

  it("knows which top-level step a nested one is in", () => {
    expect(topOf(flow).get("make")).toBe("loop");
  });

  it("ticks off the top-level steps as the run passes them", () => {
    const p = progress(flow, [
      { ...base, seq: 0, type: "runStarted", scenarioId: "scn_a", scenarioName: "A", revision: 1 },
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

  it("moves the call step for what happens inside the called scenario, and marks where it failed", () => {
    const error = { code: "FILE_NOT_FOUND", message: "x" };
    const p = progress(flow, [
      { ...base, seq: 0, type: "stepStarted", stepId: "call", stepType: "scenario.call", attempt: 1 },
      { ...base, seq: 1, callPath: ["call"], type: "stepStarted", stepId: "inner", stepType: "file.read", attempt: 1 },
      { ...base, seq: 2, type: "runFinished", status: "failed", error, durationMs: 1200 },
    ] as never);
    expect(p.tops.map((s) => s.state)).toEqual(["done", "done", "failed"]);
    expect(p.finished).toEqual({ status: "failed", error, durationMs: 1200 });
  });
});
