import type { Step } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { boxRange } from "./stepClipboard";

const s = (id: string, type = "log.message", blocks?: Record<string, Step[]>): Step => ({ id, type, params: {}, ...(blocks ? { blocks } : {}) });
const steps: Step[] = [
  s("a"),
  s("loop", "control.repeat", { body: [s("b1"), s("b2"), s("b3")] }),
  s("c"),
  s("if", "control.if", { then: [s("t1")], else: [s("e1")] }),
  s("sw", "control.switch", { cases: [s("k1", "control.case", { body: [s("k1a")] }), s("k2", "control.case")] }),
  s("d"),
];

describe("boxRange", () => {
  it("takes the run from the first to the last node in the box", () => {
    expect(boxRange(steps, ["c", "a"])).toEqual(["a", "loop", "c"]);
  });
  it("keeps to the inside of a frame when the box is inside it", () => {
    expect(boxRange(steps, ["b3", "b2"])).toEqual(["b2", "b3"]);
  });
  it("counts a node inside a frame as the frame when the box reaches outside", () => {
    expect(boxRange(steps, ["b2", "c"])).toEqual(["loop", "c"]);
  });
  it("takes the frame for its head with some of its inside, or two of its branches", () => {
    expect(boxRange(steps, ["loop", "b1"])).toEqual(["loop"]);
    expect(boxRange(steps, ["t1", "e1"])).toEqual(["if"]);
  });
  it("never picks cases on their own", () => {
    expect(boxRange(steps, ["k1", "k2"])).toEqual(["sw"]);
    expect(boxRange(steps, ["k1a", "k2"])).toEqual(["sw"]);
    expect(boxRange(steps, ["k1"])).toEqual(["sw"]);
    expect(boxRange(steps, ["k1a"])).toEqual(["k1a"]);
  });
  it("is empty for nothing known", () => {
    expect(boxRange(steps, [])).toEqual([]);
    expect(boxRange(steps, ["nope"])).toEqual([]);
  });
});
