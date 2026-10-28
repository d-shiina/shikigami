import type { Step, StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { neighbor, outline } from "./outline";

const ifDef = { type: "control.if", blocks: [{ name: "then", label: "条件が真" }, { name: "else", label: "条件が偽" }] } as unknown as StepTypeDef;
const steps: Step[] = [
  { id: "a", type: "log.message" },
  // Blocks follow the registry order, not the order in the file.
  { id: "b", type: "control.if", blocks: { else: [{ id: "d", type: "log.message" }], then: [{ id: "c", type: "log.message" }] } },
  { id: "e", type: "log.message" },
];

describe("outline", () => {
  it("lists steps in reading order with depth and block labels", () => {
    const items = outline(steps, new Map([["control.if", ifDef]]));
    expect(items.map((i) => [i.id, i.depth, i.block])).toEqual([
      ["a", 0, undefined],
      ["b", 0, undefined],
      ["c", 1, "then：条件が成り立つとき"],
      ["d", 1, "else：成り立たないとき"],
      ["e", 0, undefined],
    ]);
  });

  it("moves between neighbours, clamped at the ends", () => {
    const ids = ["a", "b", "c"];
    expect(neighbor(ids, "b", 1)).toBe("c");
    expect(neighbor(ids, "c", 1)).toBe("c");
    expect(neighbor(ids, "a", -1)).toBe("a");
    expect(neighbor(ids, null, 1)).toBe("a");
    expect(neighbor(ids, null, -1)).toBe("c");
    expect(neighbor(ids, "b", Infinity)).toBe("c");
    expect(neighbor(ids, null, -Infinity)).toBe("a");
    expect(neighbor([], "a", 1)).toBeUndefined();
  });
});
