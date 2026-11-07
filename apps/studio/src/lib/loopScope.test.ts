import type { Step } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { enclosingLoops, listSources, otherVariables, resultStep } from "./loopScope";

const read: Step = { id: "s1", type: "excel.readRows", params: { path: "input/受注.xlsx" }, saveAs: "orders" };
const fill: Step = { id: "s3", type: "browser.fill", params: { target: {}, value: "" } };
const inner: Step = { id: "s4", type: "control.forEach", params: { items: "order.lines", itemVar: "line" }, blocks: { body: [fill] } };
const loop: Step = { id: "s2", type: "control.forEach", params: { items: "orders", itemVar: "order" }, blocks: { body: [inner] } };
const after: Step = { id: "s5", type: "file.readCsv", params: { path: "input/b.csv" }, saveAs: "rows" };
const steps = [read, loop, after];

describe("what a node can use while the flow is built", () => {
  it("find the repeats around a node, innermost first", () => {
    const loops = enclosingLoops(steps, "s3");
    expect(loops.map((l) => l.itemVar)).toEqual(["line", "order"]);
    expect(loops[0]!.items).toBeUndefined(); // `order.lines` is not a plain variable
    expect(loops[1]!.items).toBe("orders");
    expect(enclosingLoops(steps, "s5")).toEqual([]);
  });

  it("find the node a result comes from", () => {
    expect(resultStep(steps, "orders")?.id).toBe("s1");
    expect(resultStep(steps, "nothing")).toBeNull();
  });

  it("offer a repeat the results above it first, then the flow's lists, then the rest", () => {
    const sources = listSources([{ name: "ids", type: "array" }, { name: "count", type: "number" }], steps, "s2");
    expect(sources.map((s) => s.name)).toEqual(["orders", "ids", "rows"]);
    expect(sources[0]!.step?.id).toBe("s1");
    expect(sources[1]!.step).toBeUndefined();
  });

  it("list the other variables a field can insert, without the repeats' own names", () => {
    expect(otherVariables([{ name: "today" }], steps, enclosingLoops(steps, "s3"))).toEqual(["today", "orders", "rows"]);
  });
});
