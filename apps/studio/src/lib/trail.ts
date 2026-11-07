// The way a run went through the chart: which lines it took. A line is taken
// when the run reached both of its ends; the step it leads to says how.
import type { StepRunState } from "../store";

/** How a line was taken: on to a step that finished, failed, or is running now. */
export type LineTrail = "done" | "failed" | "now";

const REACHED = new Set<StepRunState>(["running", "succeeded", "failed", "paused"]);

type Line = { id: string; source: string; target: string };

/**
 * The taken lines, by id. A block (if, loop, try) fails with the step inside it
 * that failed: the line into the block keeps the colour of a way that went on,
 * and only the line into the step where it stopped turns red.
 */
export function trailLines(
  lines: readonly Line[],
  stepStates: Readonly<Record<string, StepRunState>>,
  through: ReadonlySet<string> = new Set(),
  continues: ReadonlySet<string> = new Set(),
): Map<string, LineTrail> {
  // A point the line only passes through (the "+" at the end of a block) was
  // passed when a line into it came from a step the run got past: one that
  // succeeded, or failed and was set to continue on errors (`continues`).
  const states: Record<string, StepRunState> = { ...stepStates };
  const passed = (id: string, seen: Set<string>): boolean =>
    lines.some((l) => {
      if (l.target !== id || seen.has(l.source)) return false;
      if (through.has(l.source)) return passed(l.source, new Set([...seen, l.source]));
      const state = stepStates[l.source];
      return state === "succeeded" || (state === "failed" && continues.has(l.source));
    });
  for (const id of through) if (passed(id, new Set([id]))) states[id] = "succeeded";
  const reached = (id: string) => {
    const state = states[id];
    return state !== undefined && REACHED.has(state);
  };
  const taken = lines.filter((l) => reached(l.source) && reached(l.target));
  // Steps the run went on from: down into a block, or on to the next step.
  const wentOn = new Set(taken.map((l) => l.source));
  const out = new Map<string, LineTrail>();
  for (const l of taken) {
    const to = states[l.target];
    out.set(l.id, to === "running" || to === "paused" ? "now" : to === "failed" && !wentOn.has(l.target) ? "failed" : "done");
  }
  return out;
}

