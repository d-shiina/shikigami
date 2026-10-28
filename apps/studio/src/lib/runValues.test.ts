import { describe, expect, it } from "vitest";
import type { VariableChange } from "../store";
import { valuesSeenBy } from "./runValues";

const change = (seq: number, variable: string, value: unknown): VariableChange => ({ seq, at: "", variable, value });

describe("valuesSeenBy", () => {
  it("gives the value a step saw each time it ran", () => {
    const changes = [change(1, "total", 0), change(3, "total", 10), change(5, "total", 30)];
    const starts = [
      { stepId: "log", seq: 2 },
      { stepId: "log", seq: 4 },
      { stepId: "other", seq: 6 },
    ];
    expect(valuesSeenBy(changes, starts, "total", "log").map((c) => c.value)).toEqual([0, 10]);
  });
});
