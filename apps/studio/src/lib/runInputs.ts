// Inputs a run cannot start without: an input variable with no default has
// to be given a value when the run starts, or the run fails at once
// (MISSING_INPUT). Studio asks for them before it runs, and the variable
// lists mark them, so nobody learns it from a failed run.
import type { Flow, VariableDef } from "@shikigami/schema";
import { type Field, fieldsOf, isInput } from "../runner/form";

/** An input with no default: the run asks for its value. */
export const askedAtRun = (v: VariableDef | undefined): boolean => !!v && isInput(v) && v.default === undefined;

/**
 * The form fields for the inputs a run of `flow` lacks. `given` are the
 * values the run already has (「ここから実行」 starts with the earlier run's).
 */
export function missingInputs(flow: Flow, given?: Record<string, unknown>): Field[] {
  return fieldsOf(flow).filter((f) => f.required && !(given && Object.hasOwn(given, f.name)));
}
