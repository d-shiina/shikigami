import { describe, expect, it } from "vitest";
import { clockView, wholeSpan } from "./runClock";

const at = (waitMs: number | null, limitMs: number | null) => ({ since: 10_000, waitMs, limitMs });

describe("a running node's clock", () => {
  it("shows nothing but its mark for the first second, when nothing tells how long it takes", () => {
    expect(clockView(at(null, 30_000), undefined, 10_500)).toBeNull();
    expect(clockView(at(null, null), undefined, 10_999)).toBeNull();
  });

  it("then the time it has run, and when it gives up when it has a timeout", () => {
    expect(clockView(at(null, null), undefined, 22_000)).toEqual({ kind: "plain", bar: null, elapsed: 12_000, total: null });
    expect(clockView(at(null, 30_000), undefined, 22_000)).toEqual({ kind: "limit", bar: null, elapsed: 12_000, total: 30_000 });
  });

  it("draws a bar for a delay from the start: its end is known", () => {
    expect(clockView(at(10_000, 30_000), undefined, 10_200)?.bar).toEqual({ elapsed: 200, total: 10_000 });
    // A short delay only flashes: no bar.
    expect(clockView(at(500, 30_000), undefined, 10_200)).toBeNull();
  });

  it("draws a bar against how long the step took before, and says when it takes longer", () => {
    expect(clockView(at(null, 30_000), 20_000, 15_000)).toEqual({ kind: "usual", bar: { elapsed: 5_000, total: 20_000 }, elapsed: 5_000, total: 20_000 });
    expect(clockView(at(null, 30_000), 20_000, 35_000)).toEqual({ kind: "long", bar: { elapsed: 20_000, total: 20_000 }, elapsed: 25_000, total: 20_000 });
    // A step that is usually quick gets no bar.
    expect(clockView(at(null, 30_000), 300, 10_100)).toBeNull();
  });

  it("gives a frame only its timeout: the nodes inside it show the rest", () => {
    expect(clockView(at(null, null), 20_000, 15_000, true)).toBeNull();
    expect(clockView(at(null, 60_000), 20_000, 15_000, true)?.kind).toBe("limit");
  });

  it("reads in whole seconds", () => {
    const units = { sec: "秒", min: "分" };
    expect(wholeSpan(8_400, units)).toBe("8 秒");
    expect(wholeSpan(65_000, units)).toBe("1 分 05 秒");
  });
});
