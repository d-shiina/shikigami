import type { Step, StepTypeDef } from "@shikigami/schema";
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
    const got = stepInputs([loop], fill, undefined, vars, { row: { name: "A" } });
    expect(got.values).toEqual({ row: { name: "A" }, greeting: "こんにちは" });
    expect(got.missing).toEqual(["who"]);
  });

  it("asks for a run through the repeat when the row has no value yet", () => {
    expect(stepInputs([loop], fill, undefined, [], {}).missing).toEqual(["row"]);
  });
});
