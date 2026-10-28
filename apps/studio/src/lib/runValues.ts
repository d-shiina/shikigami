// Reads the variable writes a run reported, for showing values on links and
// in the variables panel after (or during) a run. Display only.
import type { StepStart, VariableChange } from "../store";
import { formatValue } from "./changes";
import { INPUT_NODE } from "./dataFlow";

/** Writes of `variable` made by step `from` (or the starting values for the input node), in order. */
export function writesFrom(changes: VariableChange[], variable: string, from: string): VariableChange[] {
  const stepId = from === INPUT_NODE ? null : from;
  return changes.filter((c) => c.variable === variable && (c.stepId ?? null) === stepId);
}

export const valueText = (c: VariableChange) =>
  c.secret ? "***" : typeof c.value === "string" && c.truncated ? c.value : formatValue(c.value);

/** One value per time `stepId` ran: what `variable` held when it started. */
export function valuesSeenBy(changes: VariableChange[], starts: StepStart[], variable: string, stepId: string): VariableChange[] {
  const seen: VariableChange[] = [];
  for (const start of starts) {
    if (start.stepId !== stepId) continue;
    const before = changes.filter((c) => c.variable === variable && c.seq < start.seq).at(-1);
    if (before) seen.push(before);
  }
  return seen;
}
