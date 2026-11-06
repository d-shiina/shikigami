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

  it("does not take the way back up from a step that failed at the end of a loop's body", () => {
    const states: Record<string, StepRunState> = { before: "succeeded", loop: "failed", body: "failed" };
    const out = trailLines([line("before", "loop"), line("loop", "body"), { ...line("body", "loop"), loop: true }], states);
    expect(out.get("before->loop")).toBe("done");
    expect(out.get("loop->body")).toBe("failed");
    expect(out.has("body->loop")).toBe(false);
  });

  it("passes through the \"+\" at the end of a block", () => {
    const states = { if: "succeeded", t: "succeeded", e: "succeeded", after: "running" } as const;
    const lines = [line("if", "t"), line("t", "end:then"), line("end:then", "after"), line("if", "x"), line("x", "end:else"), line("end:else", "after")];
    const out = trailLines(lines, states, new Set(["end:then", "end:else"]));
    expect(out.get("t->end:then")).toBe("done");
    expect(out.get("end:then->after")).toBe("now");
    expect(out.has("x->end:else")).toBe(false);
    expect(out.has("end:else->after")).toBe(false);
    // A step that failed at the end of a block never got past it.
    const failed = trailLines([line("t", "end:then"), line("end:then", "after")], { t: "failed" }, new Set(["end:then"]));
    expect(failed.size).toBe(0);
    // Unless it was set to continue on errors: then the run went on through the "+".
    const lines2 = [line("t", "end:then"), line("end:then", "after")];
    const went = trailLines(lines2, { t: "failed", after: "succeeded" }, new Set(["end:then"]), new Set(["t"]));
    expect(went.get("t->end:then")).toBe("done");
    expect(went.get("end:then->after")).toBe("done");
  });
});
