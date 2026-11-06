import { describe, expect, it } from "vitest";
import { columnsOf, leadingElements, runScope } from "./runScope";
import type { RunState } from "../store";

describe("runScope", () => {
  it("recovers the whole rows of a table cut short", () => {
    expect(leadingElements('[{"a":1},{"a":2},{"a":"3…')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(leadingElements('[{"a":"x,y"}]')).toEqual([{ a: "x,y" }]);
    expect(leadingElements('{"a":1')).toBeNull();
    expect(leadingElements("[INFO] started")).toBeNull();
    expect(leadingElements("[INFO] a, b, c…")).toBeNull();
  });

  it("keeps each variable's last value and marks shortened ones", () => {
    const run = {
      flowId: "f",
      changes: [
        { seq: 1, at: "", variable: "rows", value: '[{"金額":"1"},{"金額":"2"…', truncated: true },
        { seq: 2, at: "", variable: "n", value: 1 },
        { seq: 3, at: "", variable: "n", value: 2 },
        { seq: 4, at: "", variable: "pw", value: "***", secret: true },
      ],
    } as unknown as RunState;
    const scope = runScope(run, "f");
    expect(scope.values).toEqual({ rows: [{ 金額: "1" }], n: 2 });
    expect([...scope.partial].sort()).toEqual(["pw", "rows"]);
    expect(columnsOf(scope.values.rows)).toEqual(["金額"]);
    expect(runScope(run, "other").values).toEqual({});
  });
});
