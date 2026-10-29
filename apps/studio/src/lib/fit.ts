// Which panels fit beside the chart. The chart is what you work on, so it
// keeps at least CHART_MIN and the panels around it give way, outermost
// first: the sidebar hides (its button in the title bar lays it over the
// chart for a moment), the review inbox folds to its strip, the AI pane
// narrows, and last the AI pane takes the inspector's place on the right
// (closing it brings the inspector back). The window's own minimum (960px)
// always fits.

export const SIDEBAR = 208;
export const INBOX = 248;
export const INBOX_FOLDED = 44;
export const RIGHT = 340;
export const AGENT = 380;
export const AGENT_NARROW = 320;
export const CHART_MIN = 480;

export type Fit = {
  /** The sidebar may be shown (it can still be hidden by hand). */
  sidebar: boolean;
  /** The review inbox is open rather than a strip. */
  inbox: boolean;
  /** The inspector (or the review verdict) has its column. */
  right: boolean;
  /** Width of the AI pane, 0 when closed. */
  agent: number;
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
export function fit(width: number, shown: Shown): Fit {
  const f: Fit = { sidebar: true, inbox: true, right: shown.right, agent: shown.agent ? AGENT : 0 };
  const chart = () =>
    width -
    (f.sidebar && shown.sidebar ? SIDEBAR : 0) -
    (shown.inbox ? (f.inbox ? INBOX : INBOX_FOLDED) : 0) -
    (f.right ? RIGHT : 0) -
    f.agent;
  if (chart() < CHART_MIN) f.sidebar = false;
  if (chart() < CHART_MIN && shown.inbox) f.inbox = false;
  if (chart() < CHART_MIN && shown.agent) f.agent = AGENT_NARROW;
  if (chart() < CHART_MIN && shown.agent) f.right = false;
  return f;
}
