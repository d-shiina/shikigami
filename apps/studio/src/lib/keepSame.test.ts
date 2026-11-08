import { describe, expect, it } from "vitest";
import { keepSame, same } from "./keepSame";

describe("keepSame", () => {
  it("keeps the old object when nothing in it changed, and takes the new one when something did", () => {
    const kept = new Map<string, { id: string; data: { state?: string; reviews: string[]; style: { stroke: string } } }>();
    const vars = new Map([["a", "string"]]);
    const build = (state?: string) => [
      { id: "a", data: { state, reviews: [], style: { stroke: "red" }, vars } },
      { id: "b", data: { reviews: [], style: { stroke: "red" }, vars } },
    ];
    const first = keepSame(kept, build());
    const second = keepSame(kept, build("running"));
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    const third = keepSame(kept, build("running"));
    expect(third[0]).toBe(second[0]);
  });

  it("tells maps apart by identity only", () => {
    expect(same({ m: new Map() }, { m: new Map() }, 3)).toBe(false);
    expect(same([1, { a: 2 }], [1, { a: 2 }], 3)).toBe(true);
    expect(same({ a: 1 }, { a: 1, b: undefined }, 3)).toBe(false);
  });
});
