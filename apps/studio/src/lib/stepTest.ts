// 「ノードの単体実行」: only the node runs. The variables it reads are given
// the values the last run left (or their starting values); nothing before
// it runs again. Pure, so what is sent can be tested without a screen.
import type { Step, StepTypeDef, VariableDef } from "@shikigami/schema";
import { enclosingLoops } from "./loopScope";
import { referencedVariables } from "./nodeRows";

export type StepInputs = {
  /** The values sent with the node, by variable name. */
  values: Record<string, unknown>;
  /** Variables the node reads that have no value yet: run up to the node first. */
  missing: string[];
};

/** The variables `step` reads, given the names that exist (`known`). */
export function stepReads(step: Step, def: StepTypeDef | undefined, known: ReadonlySet<string>): string[] {
  const bare = new Set(def?.expressionParams ?? []);
  const found = new Set<string>();
  for (const [key, value] of Object.entries(step.params ?? {})) {
    // A bare expression (`price * 2`) reads every name in it; elsewhere only `{{ }}` holes count.
    const refs =
      typeof value !== "string" ? referencedVariables(value, known)
      : bare.has(key) ? referencedVariables(value.replace(/\{\{|\}\}/g, ""), known)
      : value.includes("{{") ? referencedVariables(value, known)
      : [];
    for (const r of refs) found.add(r);
  }
  return [...found];
}

/**
 * What to send when `step` runs alone: each variable it reads, from
 * `scope` (the last run) or else its starting value. A repeat's row
 * (`item`) only has a value once a run went through the repeat.
 */
export function stepInputs(
  steps: Step[],
  step: Step,
  def: StepTypeDef | undefined,
  variables: VariableDef[] | undefined,
  scope: Record<string, unknown>,
): StepInputs {
  const loopVars = enclosingLoops(steps, step.id ?? "").flatMap((l) => {
    const index = l.step.params?.indexVar;
    return typeof index === "string" && index ? [l.itemVar, index] : [l.itemVar];
  });
  const known = new Set([...(variables ?? []).map((v) => v.name), ...loopVars, ...Object.keys(scope)]);
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const name of stepReads(step, def, known)) {
    if (name in scope) values[name] = scope[name];
    else {
      const start = variables?.find((v) => v.name === name)?.default;
      if (start !== undefined && start !== null) values[name] = start;
      else missing.push(name);
    }
  }
  return { values, missing };
}
