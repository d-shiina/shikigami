// Which side panels fit beside the chart. The chart is what you work on, so
// it keeps at least CHART_MIN and the panels around it give way, outermost
// first: the scenario list folds to its strip, then the AI pane narrows, and
// last the AI pane takes the inspector's place on the right (closing it
// brings the inspector back). The window's own minimum (960px) always fits.

export const LIST = 248;
export const LIST_FOLDED = 44;
export const RIGHT = 340;
export const AGENT = 380;
export const AGENT_NARROW = 320;
export const CHART_MIN = 480;

export type Fit = {
  /** The list may be open (it can still be folded by hand). */
  list: boolean;
  /** The inspector (or the review verdict) has its column. */
  right: boolean;
  /** Width of the AI pane, 0 when closed. */
  agent: number;
};

/**
 * `width`: everything right of the rail. `hasRight`: there is something to
 * inspect (a scenario is open); without it the column is not drawn at all.
 */
export function fit(width: number, agentOpen: boolean, hasRight = true): Fit {
  const f: Fit = { list: true, right: hasRight, agent: agentOpen ? AGENT : 0 };
  const chart = () => width - (f.list ? LIST : LIST_FOLDED) - (f.right ? RIGHT : 0) - f.agent;
  if (chart() < CHART_MIN) f.list = false;
  if (chart() < CHART_MIN && agentOpen) f.agent = AGENT_NARROW;
  if (chart() < CHART_MIN && agentOpen) f.right = false;
  return f;
}
