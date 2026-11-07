import type { Step, StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { freeName, resultName } from "./resultName";

const def = (type: string, hasOutput = true) => ({ type, hasOutput }) as unknown as StepTypeDef;

describe("resultName", () => {
  it("names a result after what the node returns", () => {
    expect(resultName(def("excel.readRows"), [], [])).toBe("rows");
    expect(resultName(def("browser.getText"), [], [])).toBe("text");
    expect(resultName(def("acme.getStatus"), [], [])).toBe("status");
  });

  it("leaves nodes that return nothing alone", () => {
    expect(resultName(def("browser.click", false), [], [])).toBeUndefined();
  });

  it("gives no variable to nodes that act rather than read", () => {
    expect(resultName(def("browser.click"), [], [])).toBeUndefined();
    expect(resultName(def("control.forEach"), [], [])).toBeUndefined();
    expect(resultName(def("dialog.input"), [], [])).toBe("answer");
  });

  it("never reuses a name already in the flow", () => {
    const steps = [{ id: "a", type: "excel.readRows", saveAs: "rows" }] as Step[];
    expect(resultName(def("excel.readRows"), [], steps)).toBe("rows2");
    expect(freeName("item", [{ name: "item" } as never], [])).toBe("item2");
  });
});
