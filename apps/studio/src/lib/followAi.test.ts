import { describe, expect, it } from "vitest";
import { lastAdded, shouldFollow } from "./followAi";

const working = { scenarioId: null, tool: "create_scenario" };

describe("shouldFollow", () => {
  it("opens what the AI made when nothing is open", () => {
    expect(shouldFollow("scn_new", false, working, { place: "library", scenario: null })).toBe(true);
    expect(shouldFollow("scn_new", false, working, { place: "scenarios", scenario: null })).toBe(true);
  });

  it("replaces only an empty scenario", () => {
    const empty = { id: "scn_empty", steps: [] };
    const full = { id: "scn_full", steps: [{ id: "stp_1", type: "log.write" }] };
    expect(shouldFollow("scn_new", false, working, { place: "scenarios", scenario: empty })).toBe(true);
    expect(shouldFollow("scn_new", false, working, { place: "scenarios", scenario: full })).toBe(false);
  });

  it("stays put when the AI is idle, the scenario was known, or the person is elsewhere", () => {
    expect(shouldFollow("scn_new", false, null, { place: "library", scenario: null })).toBe(false);
    expect(shouldFollow("scn_new", true, working, { place: "library", scenario: null })).toBe(false);
    expect(shouldFollow("scn_new", false, working, { place: "settings", scenario: null })).toBe(false);
    expect(shouldFollow("scn_new", false, working, { place: "scenarios", scenario: { id: "scn_new", steps: [] } })).toBe(false);
  });
});

describe("lastAdded", () => {
  const steps = [
    { id: "a", type: "log.message" },
    { id: "b", type: "control.if", blocks: { then: [{ id: "b1", type: "log.message" }] } },
    { id: "c", type: "log.message" },
  ];
  it("is the last new step in reading order, nested ones included", () => {
    expect(lastAdded(["a", "c"], steps)).toBe("b1");
    expect(lastAdded(null, steps)).toBe("c");
  });
  it("is nothing when the edit only changed steps", () => {
    expect(lastAdded(["a", "b", "b1", "c"], steps)).toBeUndefined();
  });
});
