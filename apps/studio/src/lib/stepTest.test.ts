import type { Step, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { stepInputs, stepReads } from "./stepTest";

const setDef = { type: "variable.set", expressionParams: ["expression"] } as unknown as StepTypeDef;

describe("stepReads", () => {
  it("reads every name of a bare expression and only the holes elsewhere", () => {
    const step: Step = { id: "a", type: "variable.set", params: { name: "total", expression: "price * qty" } };
    expect(stepReads(step, setDef, new Set(["price", "qty", "total"])).sort()).toEqual(["price", "qty"]);
    const fill: Step = { id: "b", type: "browser.fill", params: { target: { label: "price" }, value: "{{ item.name }}" } };
    expect(stepReads(fill, undefined, new Set(["price", "item"]))).toEqual(["item"]);
  });
});

describe("stepInputs", () => {
  const loop: Step = {
    id: "loop",
    type: "control.forEach",
    params: { items: "rows", itemVar: "row" },
    blocks: { body: [{ id: "fill", type: "browser.fill", params: { value: "{{ row.name }} {{ greeting }} {{ who }}" } }] },
  };
  const fill = loop.blocks!.body![0]!;

  it("takes the last run's values, then starting values, and names what is missing", () => {
    const vars = [
      { name: "greeting", type: "string", direction: "local", default: "こんにちは" },
      { name: "who", type: "string", direction: "input" },
    ] as never;
    const got = stepInputs([loop], fill, () => undefined, vars, { values: { row: { name: "A" } } });
    expect(got.values).toEqual({ row: { name: "A" }, greeting: "こんにちは" });
    expect(got.missing).toEqual(["who"]);
  });

  it("asks for a run through the repeat when the row has no value yet", () => {
    expect(stepInputs([loop], fill, () => undefined, [], { values: {} }).missing).toEqual(["row"]);
  });

  it("counts what a control node's blocks read, but not what is made inside it", () => {
    const vars = [{ name: "customer", type: "string", direction: "local", default: "A社" }] as never;
    const loopDef = { type: "control.forEach", expressionParams: ["items"] } as unknown as StepTypeDef;
    const got = stepInputs([loop], loop, (t) => (t === "control.forEach" ? loopDef : undefined), [...vars, { name: "rows", type: "array", direction: "local" }] as never, { values: { rows: [{ name: "x" }], greeting: "hi", who: "me" } });
    // `row` is made by the repeat itself.
    expect(got.missing).toEqual([]);
    expect(Object.keys(got.values).sort()).toEqual(["greeting", "rows", "who"]);
  });

  it("does not run a node on a value the last run recorded only in part", () => {
    const got = stepInputs([loop], fill, () => undefined, [], { values: { row: [1], greeting: "", who: "" }, partial: new Set(["row"]) });
    expect(got.partial).toEqual(["row"]);
    expect(got.values).not.toHaveProperty("row");
  });
});
