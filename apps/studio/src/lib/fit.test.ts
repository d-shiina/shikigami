import { describe, expect, it } from "vitest";
import { AGENT, AGENT_NARROW, CHART_MIN, fit, INBOX_FOLDED, RIGHT } from "./fit";

const editing = { agent: true, right: true, inbox: false, sidebar: true };

describe("fit", () => {
  it("keeps everything on a wide window", () => {
    expect(fit(1920, editing)).toEqual({ sidebar: true, inbox: true, right: true, agent: AGENT });
  });

  it("hides the sidebar first, keeping the inspector beside the AI pane on a 1280px window", () => {
    expect(fit(1280, editing)).toEqual({ sidebar: false, inbox: true, right: true, agent: AGENT });
  });

  it("folds the review inbox next", () => {
    expect(fit(1280, { ...editing, inbox: true })).toEqual({ sidebar: false, inbox: false, right: true, agent: AGENT });
  });

  it("narrows the AI pane, then lets it take the inspector's place, and the chart still fits at 960px", () => {
    const f = fit(960, editing);
    expect(f).toEqual({ sidebar: false, inbox: true, right: false, agent: AGENT_NARROW });
    expect(960 - f.agent).toBeGreaterThanOrEqual(CHART_MIN);
    expect(fit(RIGHT + AGENT_NARROW + CHART_MIN, editing).right).toBe(true);
    expect(fit(INBOX_FOLDED + RIGHT + AGENT_NARROW + CHART_MIN, { ...editing, inbox: true }).right).toBe(true);
  });

  it("keeps the sidebar while nothing is open to inspect", () => {
    expect(fit(1280, { ...editing, right: false })).toEqual({ sidebar: true, inbox: true, right: false, agent: AGENT });
  });

  it("never hides the inspector while the AI pane is closed", () => {
    expect(fit(960, { ...editing, agent: false }).right).toBe(true);
  });

  it("gives the room of a sidebar hidden by hand to the others", () => {
    expect(fit(1280 - 1, { ...editing, sidebar: false }).sidebar).toBe(true);
  });
});
