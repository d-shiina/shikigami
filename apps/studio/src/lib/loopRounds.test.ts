import { describe, expect, it } from "vitest";
import { loopRoundsText } from "./keywords";

describe("loopRoundsText", () => {
  it("says how far a loop got, in its own unit", () => {
    expect(loopRoundsText("control.forEach", 12, 12, "done")).toBe("12 件中 12 件");
    expect(loopRoundsText("control.forEach", 7, 12, "left")).toBe("12 件中 7 件目で抜けた");
    expect(loopRoundsText("control.forEach", 3, 12, "running")).toBe("3 / 12 件目");
    expect(loopRoundsText("control.repeat", 2, 3, "failed")).toBe("3 回中 2 回目でエラー");
    expect(loopRoundsText("control.while", 7, null, "done")).toBe("7 回");
    expect(loopRoundsText("control.while", 4, null, "stopped")).toBe("4 回目で中止");
  });
});
