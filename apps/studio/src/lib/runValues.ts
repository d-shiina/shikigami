// Reads the variable writes a run reported, for showing values on links and
// in the variables panel after (or during) a run. Display only.
import type { VariableChange } from "../store";
import { formatValue } from "./changes";
import { INPUT_NODE } from "./dataFlow";

/** Writes of `variable` made by step `from` (or the starting values for the input node), in order. */
export function writesFrom(changes: VariableChange[], variable: string, from: string): VariableChange[] {
  const stepId = from === INPUT_NODE ? null : from;
  return changes.filter((c) => c.variable === variable && (c.stepId ?? null) === stepId);
}

export const valueText = (c: VariableChange) =>
  c.secret ? "***" : typeof c.value === "string" && c.truncated ? c.value : formatValue(c.value);
