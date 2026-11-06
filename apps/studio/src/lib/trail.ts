// The way a run went through the chart: which lines it took. A line is taken
// when the run reached both of its ends; the step it leads to says how.
import type { StepRunState } from "../store";

/** How a line was taken: on to a step that finished, failed, or is running now. */
export type LineTrail = "done" | "failed" | "now";

const REACHED = new Set<StepRunState>(["running", "succeeded", "failed", "paused"]);

/** `loop`: the way back up from the end of a loop's body into the loop. */
type Line = { id: string; source: string; target: string; loop?: boolean };

/**
 * The taken lines, by id. A block (if, loop, try) fails with the step inside it
 * that failed: the line into the block keeps the colour of a way that went on,
 * and only the line into the step where it stopped turns red.
 */
export function trailLines(lines: readonly Line[], states: Readonly<Record<string, StepRunState>>): Map<string, LineTrail> {
  const reached = (id: string) => {
    const state = states[id];
    return state !== undefined && REACHED.has(state);
  };
  // A step that failed at the end of a loop's body never went back up.
  const taken = lines.filter((l) => reached(l.source) && reached(l.target) && !(l.loop && states[l.source] === "failed"));
  // Steps the run went on from: down into a block, or on to the next step.
  const wentOn = new Set(taken.map((l) => l.source));
  const out = new Map<string, LineTrail>();
  for (const l of taken) {
    const to = states[l.target];
    out.set(l.id, to === "running" || to === "paused" ? "now" : to === "failed" && !wentOn.has(l.target) ? "failed" : "done");
  }
  return out;
}

