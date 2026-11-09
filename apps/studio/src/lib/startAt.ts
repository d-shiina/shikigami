// 「ここから実行」: where a run may start, and the values it starts with.
import type { Step } from "@spellsheet/schema";
import type { RunState } from "../store";

/**
 * Whether a run can start at `stepId`: at the top of the flow, or inside
 * groups and try blocks (entered as if their earlier nodes were done), not
 * inside a repeat or a branch, where which round or branch is not known.
 * `undefined` when the flow has no such node.
 */
export function canStartAt(steps: readonly Step[], stepId: string): boolean | undefined {
  for (const step of steps) {
    if (step.id === stepId) return true;
    for (const [name, block] of Object.entries(step.blocks ?? {})) {
      const inner = canStartAt(block, stepId);
      if (inner === undefined) continue;
      const enterable = (step.type === "control.group" && name === "body") || (step.type === "control.try" && name === "try");
      return inner && enterable;
    }
  }
  return undefined;
}

/**
 * What the variables held when the last run reached `stepId` (their last
 * values when it never did), leaving out secrets and values only kept in
 * part: the run started there begins with these.
 */
export function valuesBefore(run: RunState | null, flowId: string | undefined, stepId: string): Record<string, unknown> {
  if (!run || !flowId || run.flowId !== flowId) return {};
  const reached = run.starts.find((s) => s.stepId === stepId)?.seq ?? Number.POSITIVE_INFINITY;
  const values: Record<string, unknown> = {};
  for (const change of run.changes) {
    if (change.seq >= reached) break;
    if (change.secret || change.truncated) delete values[change.variable];
    else values[change.variable] = change.value;
  }
  return values;
}
