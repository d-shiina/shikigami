import { describe, expect, it } from "vitest";
import { lastAdded, shouldFollow } from "./followAi";

const working = { flowId: null, tool: "create_flow" };

describe("shouldFollow", () => {
  it("opens what the AI made when nothing is open", () => {
    expect(shouldFollow("scn_new", false, working, { place: "library", flow: null })).toBe(true);
    expect(shouldFollow("scn_new", false, working, { place: "flows", flow: null })).toBe(true);
  });

  it("replaces only an empty flow when asked about another one", () => {
    const empty = { id: "scn_empty", steps: [] };
    const full = { id: "scn_full", steps: [{ id: "stp_1", type: "log.write" }] };
    const aboutFull = { flowId: "scn_full", tool: "create_flow" };
    expect(shouldFollow("scn_new", false, aboutFull, { place: "flows", flow: empty })).toBe(true);
    expect(shouldFollow("scn_new", false, aboutFull, { place: "flows", flow: full })).toBe(false);
  });

  it("opens a flow asked for in a new-flow conversation, over the flow open", () => {
    const full = { id: "scn_full", steps: [{ id: "stp_1", type: "log.write" }] };
    expect(shouldFollow("scn_new", false, working, { place: "flows", flow: full })).toBe(true);
    // The conversation already moved to the flow it made.
    expect(shouldFollow("scn_new", false, { flowId: "scn_new", tool: "create_flow" }, { place: "flows", flow: full })).toBe(true);
  });

  it("stays put when the AI is idle, the flow was known, or the person is elsewhere", () => {
    expect(shouldFollow("scn_new", false, null, { place: "library", flow: null })).toBe(false);
    expect(shouldFollow("scn_new", true, working, { place: "library", flow: null })).toBe(false);
    expect(shouldFollow("scn_new", false, working, { place: "settings", flow: null })).toBe(false);
    expect(shouldFollow("scn_new", false, working, { place: "flows", flow: { id: "scn_new", steps: [] } })).toBe(false);
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
