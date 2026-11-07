import { describe, expect, it } from "vitest";
import { AGENT, AGENT_NARROW, CHART_MIN, DEFAULT_SIZES, fit, INBOX_FOLDED, readSizes, RIGHT, SIDEBAR, SIDEBAR_MINI } from "./fit";

const editing = { agent: true, right: true, inbox: false, sidebar: true };

describe("fit", () => {
  it("keeps everything on a wide window", () => {
    expect(fit(1920, editing)).toMatchObject({ sidebar: true, inbox: true, right: true, agent: AGENT });
  });

  it("folds the sidebar to its icons first, keeping the inspector beside the AI pane on a 1280px window", () => {
    const f = fit(1280, editing);
    expect(f).toMatchObject({ sidebar: false, inbox: true, right: true, agent: AGENT });
    expect(f.chart).toBe(1280 - SIDEBAR_MINI - RIGHT - AGENT);
  });

  it("folds the review inbox next", () => {
    expect(fit(1280, { ...editing, inbox: true })).toMatchObject({ sidebar: false, inbox: false, right: true, agent: AGENT_NARROW });
  });

  it("narrows the AI pane, then lets it take the inspector's place, and the chart still fits at 960px", () => {
    const f = fit(960, editing);
    expect(f).toMatchObject({ sidebar: false, inbox: true, right: false, agent: AGENT_NARROW });
    expect(960 - SIDEBAR_MINI - f.agent).toBeGreaterThanOrEqual(CHART_MIN);
    expect(fit(SIDEBAR_MINI + RIGHT + AGENT_NARROW + CHART_MIN, editing).right).toBe(true);
    expect(fit(SIDEBAR_MINI + INBOX_FOLDED + RIGHT + AGENT_NARROW + CHART_MIN, { ...editing, inbox: true }).right).toBe(true);
  });

  it("keeps the sidebar while nothing is open to inspect", () => {
    expect(fit(1280, { ...editing, right: false })).toMatchObject({ sidebar: true, inbox: true, right: false, agent: AGENT });
  });

  it("never hides the inspector while the AI pane is closed", () => {
    expect(fit(960, { ...editing, agent: false }).right).toBe(true);
  });

  it("gives the room of a sidebar folded by hand to the others, keeping its icons", () => {
    const f = fit(1280 - 1, { ...editing, sidebar: false });
    expect(f.sidebar).toBe(true);
    expect(f.chart).toBe(1280 - 1 - SIDEBAR_MINI - RIGHT - AGENT);
  });

  it("works with the widths the person dragged to", () => {
    const wide = { ...DEFAULT_SIZES, right: 520 };
    expect(fit(1920, editing, wide).chart).toBe(1920 - SIDEBAR - 520 - AGENT);
    // A wider inspector gives way to the AI pane sooner.
    expect(fit(1280, editing, wide)).toMatchObject({ right: false, agent: AGENT_NARROW });
    expect(fit(1280, editing, wide).chart).toBeGreaterThanOrEqual(CHART_MIN);
  });

  it("reads saved widths within their limits", () => {
    expect(readSizes(null)).toEqual(DEFAULT_SIZES);
    expect(readSizes("not json")).toEqual(DEFAULT_SIZES);
    expect(readSizes(JSON.stringify({ sidebar: 9999, right: "x", agent: 400 }))).toEqual({ ...DEFAULT_SIZES, sidebar: 360, agent: 400 });
  });
});
