// Every variable of a scenario in one table: what it is, where it starts,
// which steps write it and which read it. Display only, like dataFlow.ts.
import type { Step, VarDirection, VariableDef, VarType } from "@shikigami/schema";
import { CALL, callMap, knownVariables, outputs, referencedVariables } from "./nodeRows";

export type VariableUsage = {
  name: string;
  /** Declared on the scenario; undefined for one a step makes (a loop's element). */
  def?: VariableDef;
  type: VarType;
  /** "made" when no declaration exists and a step creates it. */
  direction: VarDirection | "made";
  /** Step ids in the order they appear. */
  writers: string[];
  readers: string[];
};

/** Params that name the variable a step writes, not a value it reads. */
const WRITE_KEYS: Record<string, string[]> = {
  "variable.set": ["name"],
  "control.forEach": ["itemVar", "indexVar"],
};

const ORDER: VariableUsage["direction"][] = ["input", "inOut", "output", "local", "made"];

export function variableUsage(steps: Step[], variables: VariableDef[] | undefined): VariableUsage[] {
  const known = knownVariables(variables, steps);
  const names = new Set(known.keys());
  const usage = new Map<string, VariableUsage>();
  for (const [name, type] of known) {
    const def = variables?.find((v) => v.name === name);
    usage.set(name, { name, def, type: type ?? "any", direction: def ? (def.direction ?? "local") : "made", writers: [], readers: [] });
  }
  const add = (list: string[], id: string) => list.includes(id) || list.push(id);

  const walk = (list: Step[]) => {
    for (const step of list) {
      if (!step.id) continue;
      const skip = new Set(WRITE_KEYS[step.type] ?? []);
      const read =
        step.type === CALL
          ? Object.values(callMap(step, "inputs"))
          : Object.entries(step.params ?? {})
              .filter(([key]) => !skip.has(key))
              .map(([, value]) => value);
      for (const value of read) for (const name of referencedVariables(value, names)) add(usage.get(name)!.readers, step.id);
      for (const o of outputs(step)) {
        const u = usage.get(o.variable);
        if (u) add(u.writers, step.id);
      }
      for (const children of Object.values(step.blocks ?? {})) walk(children);
    }
  };
  walk(steps);

  return [...usage.values()].sort((a, b) => ORDER.indexOf(a.direction) - ORDER.indexOf(b.direction));
}
