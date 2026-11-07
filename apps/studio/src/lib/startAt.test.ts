import type { Step } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import type { RunState } from "../store";
import { canStartAt, valuesBefore } from "./startAt";

const steps = [
  { id: "a", type: "log.message" },
  { id: "g", type: "control.group", blocks: { body: [{ id: "b", type: "log.message" }] } },
  { id: "l", type: "control.forEach", blocks: { body: [{ id: "c", type: "log.message" }] } },
  { id: "t", type: "control.try", blocks: { try: [{ id: "d", type: "log.message" }], catch: [{ id: "e", type: "log.message" }] } },
] as Step[];

describe("run from here", () => {
  it("starts at the top, in groups and in try, not in a repeat or catch", () => {
    expect(canStartAt(steps, "a")).toBe(true);
    expect(canStartAt(steps, "b")).toBe(true);
    expect(canStartAt(steps, "l")).toBe(true);
    expect(canStartAt(steps, "c")).toBe(false);
    expect(canStartAt(steps, "d")).toBe(true);
    expect(canStartAt(steps, "e")).toBe(false);
    expect(canStartAt(steps, "x")).toBeUndefined();
  });

  it("takes the values the last run had when it reached the node", () => {
    const run = {
      flowId: "f",
      starts: [
        { stepId: "a", seq: 2 },
        { stepId: "b", seq: 5 },
      ],
      changes: [
        { seq: 1, variable: "x", value: 1 },
        { seq: 3, variable: "x", value: 2 },
        { seq: 4, variable: "pw", value: "***", secret: true },
        { seq: 4, variable: "rows", value: "[{…", truncated: true },
        { seq: 6, variable: "x", value: 3 },
      ],
    } as unknown as RunState;
    expect(valuesBefore(run, "f", "b")).toEqual({ x: 2 });
    // Never reached: the last values.
    expect(valuesBefore(run, "f", "z")).toEqual({ x: 3 });
    expect(valuesBefore(run, "other", "b")).toEqual({});
  });
});
