// Which panels fit beside the chart. The chart is what you work on, so it
// keeps at least CHART_MIN and the panels around it give way, outermost
// first: the sidebar hides (its button in the title bar lays it over the
// chart for a moment), the review inbox folds to its strip, the AI pane
// narrows, and last the AI pane takes the inspector's place on the right
// (closing it brings the inspector back). The window's own minimum (960px)
// always fits. The person can drag each panel's edge; fit then works with
// those widths, and a drag never takes the chart below CHART_MIN.

export const SIDEBAR = 208;
export const INBOX = 248;
export const INBOX_FOLDED = 44;
export const RIGHT = 340;
export const AGENT = 380;
export const AGENT_NARROW = 320;
export const CHART_MIN = 480;

/** Widths the person dragged the panels to. */
export type Sizes = { sidebar: number; inbox: number; right: number; agent: number };

export const DEFAULT_SIZES: Sizes = { sidebar: SIDEBAR, inbox: INBOX, right: RIGHT, agent: AGENT };

/** How far each panel's edge can be dragged. */
export const LIMITS: Record<keyof Sizes, [min: number, max: number]> = {
  sidebar: [176, 360],
  inbox: [200, 440],
  right: [280, 560],
  agent: [AGENT_NARROW, 640],
};

export const clampSize = (panel: keyof Sizes, value: number) => {
  const [min, max] = LIMITS[panel];
  return Math.round(Math.min(max, Math.max(min, value)));
};

/** Sizes read back from storage, each kept within its limits. */
export function readSizes(raw: string | null): Sizes {
  let saved: Partial<Record<keyof Sizes, unknown>> = {};
  try {
    saved = raw ? (JSON.parse(raw) as typeof saved) : {};
  } catch {
    // Fall back to the defaults.
  }
  const size = (panel: keyof Sizes) => {
    const value = saved[panel];
    return typeof value === "number" && Number.isFinite(value) ? clampSize(panel, value) : DEFAULT_SIZES[panel];
  };
  return { sidebar: size("sidebar"), inbox: size("inbox"), right: size("right"), agent: size("agent") };
}

export type Fit = {
  /** The sidebar may be shown (it can still be hidden by hand). */
  sidebar: boolean;
  /** The review inbox is open rather than a strip. */
  inbox: boolean;
  /** The inspector (or the review verdict) has its column. */
  right: boolean;
  /** Width of the AI pane, 0 when closed. */
  agent: number;
  /** What is left for the chart. */
  chart: number;
};

type Shown = {
  /** The AI pane is open. */
  agent: boolean;
  /** There is something to inspect (a scenario is open). Without it the column is not drawn. */
  right: boolean;
  /** The place has a list of its own between the sidebar and the chart (review). */
  inbox: boolean;
  /** The person hid the sidebar; it then takes no room. */
  sidebar: boolean;
};

/** `width`: the whole window. */
export function fit(width: number, shown: Shown, sizes: Sizes = DEFAULT_SIZES): Fit {
  const f: Fit = { sidebar: true, inbox: true, right: shown.right, agent: shown.agent ? sizes.agent : 0, chart: 0 };
  const chart = () =>
    width -
    (f.sidebar && shown.sidebar ? sizes.sidebar : 0) -
    (shown.inbox ? (f.inbox ? sizes.inbox : INBOX_FOLDED) : 0) -
    (f.right ? sizes.right : 0) -
    f.agent;
  if (chart() < CHART_MIN) f.sidebar = false;
  if (chart() < CHART_MIN && shown.inbox) f.inbox = false;
  if (chart() < CHART_MIN && shown.agent) f.agent = Math.min(sizes.agent, AGENT_NARROW);
  if (chart() < CHART_MIN && shown.agent) f.right = false;
  f.chart = chart();
  return f;
}
