// 「ノードの単体実行」: only the node runs. The variables it reads are given
// the values the last run left (or their starting values); nothing before
// it runs again. Pure, so what is sent can be tested without a screen.
import type { Step, StepTypeDef, VariableDef } from "@shikigami/schema";
import { enclosingLoops } from "./loopScope";
import { callMap, referencedVariables } from "./nodeRows";
import { BINDS, CALL, FOR_EACH } from "./stepTypes";

export type StepInputs = {
  /** The values sent with the node, by variable name. */
  values: Record<string, unknown>;
  /** Variables the node reads that have no value yet: run up to the node first. */
  missing: string[];
  /** Variables the last run recorded only in part (too large): the node is not run on a preview. */
  partial: string[];
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

/** The variables a node binds for what runs inside it (`itemVar`, `indexVar`, `errorVar`). */
function binds(step: Step): string[] {
  const p = step.params ?? {};
  const names = (BINDS[step.type] ?? []).map((k) => p[k]).filter((v): v is string => typeof v === "string" && v !== "");
  if (step.type === FOR_EACH && typeof p.itemVar !== "string") names.push("item");
  return names;
}

/** Every variable a node makes: its bindings, its result and a call's outputs. */
function bound(step: Step): string[] {
  const names = binds(step);
  if (step.saveAs) names.push(step.saveAs);
  if (step.type === CALL) for (const v of Object.values(callMap(step, "outputs"))) if (typeof v === "string" && v) names.push(v);
  return names;
}

/**
 * What to send when `step` runs alone: each variable it reads, from
 * `scope` (the last run) or else its starting value. A control node runs
 * its blocks too, so what they read counts, except what is made inside it
 * (a repeat's row, a result saved by an inner node). A repeat's row
 * (`item`) around the node only has a value once a run went through it.
 * A value the last run only recorded in part (a large table) is not sent:
 * the node would run on its first rows as if they were all of it.
 */
export function stepInputs(
  steps: Step[],
  step: Step,
  defOf: (type: string) => StepTypeDef | undefined,
  variables: VariableDef[] | undefined,
  scope: { values: Record<string, unknown>; partial?: ReadonlySet<string> },
): StepInputs {
  const loopVars = enclosingLoops(steps, step.id ?? "").flatMap((l) => {
    const index = l.step.params?.indexVar;
    return typeof index === "string" && index ? [l.itemVar, index] : [l.itemVar];
  });
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  const partial: string[] = [];
  const subtree: Step[] = [];
  const walk = (s: Step) => {
    subtree.push(s);
    for (const children of Object.values(s.blocks ?? {})) children.forEach(walk);
  };
  walk(step);
  // Made inside: the node's own bindings (not its result, which it may also read) and everything its blocks make.
  const inside = new Set([
    ...binds(step),
    ...subtree.slice(1).flatMap(bound),
  ]);
  const known = new Set([...(variables ?? []).map((v) => v.name), ...loopVars, ...Object.keys(scope.values), ...subtree.flatMap(bound)]);
  const reads = new Set(subtree.flatMap((s) => stepReads(s, defOf(s.type), known)).filter((n) => !inside.has(n)));
  for (const name of reads) {
    if (scope.partial?.has(name)) partial.push(name);
    else if (name in scope.values) values[name] = scope.values[name];
    else {
      const start = variables?.find((v) => v.name === name)?.default;
      if (start !== undefined && start !== null) values[name] = start;
      else missing.push(name);
    }
  }
  return { values, missing, partial };
}
