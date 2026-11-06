import { describe, expect, it } from "vitest";
import { trailLines } from "./trail";
import type { StepRunState } from "../store";

const line = (source: string, target: string) => ({ id: `${source}->${target}`, source, target });

describe("trailLines", () => {
  it("takes a line only when the run reached both ends", () => {
    const states: Record<string, StepRunState> = { a: "succeeded", b: "succeeded", c: "skipped" };
    const out = trailLines([line("a", "b"), line("a", "x"), line("b", "c")], states);
    expect([...out]).toEqual([["a->b", "done"]]);
  });

  it("says how the step it leads to went", () => {
    const states: Record<string, StepRunState> = { a: "succeeded", b: "failed", c: "running", d: "paused" };
    const out = trailLines([line("a", "b"), line("a", "c"), line("a", "d")], states);
    expect(out.get("a->b")).toBe("failed");
    expect(out.get("a->c")).toBe("now");
    expect(out.get("a->d")).toBe("now");
  });

  it("turns red only into the step where it stopped, not into the block around it", () => {
    // `check` fails because the else branch's `stop` failed.
    const states: Record<string, StepRunState> = { exists: "succeeded", check: "failed", warn: "succeeded", stop: "failed" };
    const out = trailLines([line("exists", "check"), line("check", "warn"), line("warn", "stop"), line("check", "read")], states);
    expect(out.get("exists->check")).toBe("done");
    expect(out.get("check->warn")).toBe("done");
    expect(out.get("warn->stop")).toBe("failed");
    expect(out.has("check->read")).toBe(false);
  });

  it("takes the way back up a loop once its body has run", () => {
    expect(trailLines([line("body", "loop")], { loop: "running", body: "succeeded" }).get("body->loop")).toBe("now");
    expect(trailLines([line("body", "loop")], { loop: "succeeded", body: "succeeded" }).get("body->loop")).toBe("done");
  });
});
