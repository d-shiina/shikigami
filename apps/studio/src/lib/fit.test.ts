import { describe, expect, it } from "vitest";
import { AGENT, AGENT_NARROW, CHART_MIN, DEFAULT_SIZES, fit, INBOX_FOLDED, readSizes, RIGHT } from "./fit";

const editing = { agent: true, right: true, inbox: false };

describe("which panels fit beside the chart", () => {
  it("shows everything on a wide window", () => {
    expect(fit(1920, editing)).toMatchObject({ inbox: true, right: true, agent: AGENT });
  });

  it("keeps the inspector beside the AI pane on a 1280px window", () => {
    const f = fit(1280, editing);
    expect(f).toMatchObject({ inbox: true, right: true, agent: AGENT });
    expect(f.chart).toBe(1280 - RIGHT - AGENT);
  });

  it("folds the review inbox, then narrows the AI pane", () => {
    expect(fit(1280, { ...editing, inbox: true })).toMatchObject({ inbox: false, right: true, agent: AGENT });
    expect(fit(1200, { ...editing, inbox: true })).toMatchObject({ inbox: false, right: true, agent: AGENT_NARROW });
  });

  it("gives the inspector's place to the AI pane only when both cannot fit", () => {
    const f = fit(960, editing);
    expect(f).toMatchObject({ inbox: true, right: false, agent: AGENT_NARROW });
    expect(960 - f.agent).toBeGreaterThanOrEqual(CHART_MIN);
    expect(fit(RIGHT + AGENT_NARROW + CHART_MIN, editing).right).toBe(true);
    expect(fit(INBOX_FOLDED + RIGHT + AGENT_NARROW + CHART_MIN, { ...editing, inbox: true }).right).toBe(true);
  });

  it("works with the widths the person dragged the panels to", () => {
    const wide = { ...DEFAULT_SIZES, right: 520 };
    expect(fit(1920, editing, wide).chart).toBe(1920 - 520 - AGENT);
  });
});

describe("sizes read back from storage", () => {
  it("keeps each within its limits and falls back to the defaults", () => {
    expect(readSizes(null)).toEqual(DEFAULT_SIZES);
    expect(readSizes("not json")).toEqual(DEFAULT_SIZES);
    expect(readSizes(JSON.stringify({ sidebar: 300, right: "x", agent: 400 }))).toEqual({ ...DEFAULT_SIZES, agent: 400 });
  });
});
