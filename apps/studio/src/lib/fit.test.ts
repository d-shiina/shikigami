import { describe, expect, it } from "vitest";
import { AGENT, AGENT_NARROW, CHART_MIN, fit, LIST, LIST_FOLDED, RIGHT } from "./fit";

describe("fit", () => {
  it("keeps everything on a wide window", () => {
    expect(fit(1848, true)).toEqual({ list: true, right: true, agent: AGENT });
  });

  it("folds the list first", () => {
    const width = LIST + RIGHT + AGENT + CHART_MIN - 1;
    expect(fit(width, true)).toEqual({ list: false, right: true, agent: AGENT });
  });

  it("narrows the AI pane next, keeping the inspector on a 1280px window", () => {
    expect(fit(1280 - 72, true)).toEqual({ list: false, right: true, agent: AGENT_NARROW });
  });

  it("lets the AI pane take the inspector's place last, and the chart still fits at the window's minimum", () => {
    const width = 960 - 72;
    const f = fit(width, true);
    expect(f).toEqual({ list: false, right: false, agent: AGENT_NARROW });
    expect(width - LIST_FOLDED - f.agent).toBeGreaterThanOrEqual(CHART_MIN);
    expect(fit(LIST_FOLDED + RIGHT + AGENT_NARROW + CHART_MIN, true).right).toBe(true);
  });

  it("leaves out the inspector while nothing is open, so the list keeps its room", () => {
    expect(fit(1280 - 72, true, false)).toEqual({ list: true, right: false, agent: AGENT });
  });

  it("never hides the inspector while the AI pane is closed", () => {
    expect(fit(960 - 72, false)).toEqual({ list: false, right: true, agent: 0 });
  });
});
