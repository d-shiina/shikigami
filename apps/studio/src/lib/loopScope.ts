// What a node can use while a flow is built by hand: the repeats it sits in
// (and the rows they walk over), and the results of other nodes a repeat can
// walk over. Pure, so the inspector's pickers can be tested without a screen.
import type { Step, VariableDef } from "@shikigami/schema";
import { isPlainName } from "./expr";
import { outputs } from "./nodeRows";

export const FOR_EACH = "control.forEach";
/** Nodes whose result is a table: their columns can be read from the file before a run. */
export const TABLE_READERS = new Set(["excel.readRows", "file.readCsv"]);

export interface Loop {
  step: Step;
  /** The name each element gets inside (`item`). */
  itemVar: string;
  /** The variable walked over, when it is a plain name (`rows`). */
  items?: string;
}

function loopOf(step: Step): Loop {
  const p = step.params ?? {};
  const items = typeof p.items === "string" ? p.items.trim() : "";
  return {
    step,
    itemVar: typeof p.itemVar === "string" && p.itemVar ? p.itemVar : "item",
    items: isPlainName(items) ? items : undefined,
  };
}

/** The repeats around the node `id`, innermost first. */
export function enclosingLoops(steps: Step[], id: string): Loop[] {
  const walk = (list: Step[], around: Loop[]): Loop[] | null => {
    for (const s of list) {
      if (s.id === id) return around;
      const inner = s.type === FOR_EACH ? [loopOf(s), ...around] : around;
      for (const children of Object.values(s.blocks ?? {})) {
        const found = walk(children, inner);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(steps, []) ?? [];
}

/** The node that saves its result as `variable`. */
export function resultStep(steps: Step[], variable: string): Step | null {
  for (const s of steps) {
    if (s.saveAs === variable) return s;
    for (const children of Object.values(s.blocks ?? {})) {
      const found = resultStep(children, variable);
      if (found) return found;
    }
  }
  return null;
}

export interface ListSource {
  name: string;
  /** The node it comes from; none for a flow variable. */
  step?: Step;
}

/**
 * What the repeat `loopId` can walk over: the results of nodes outside it
 * and the flow's list variables, the nearest above it first.
 */
export function listSources(variables: VariableDef[] | undefined, steps: Step[], loopId: string): ListSource[] {
  const out: ListSource[] = [];
  const seen = new Set<string>();
  const add = (source: ListSource) => {
    if (seen.has(source.name)) return;
    seen.add(source.name);
    out.push(source);
  };
  const before: Step[] = [];
  let found = false;
  const walk = (list: Step[]) => {
    for (const s of list) {
      if (s.id === loopId) {
        found = true;
        return;
      }
      before.push(s);
      for (const children of Object.values(s.blocks ?? {})) {
        walk(children);
        if (found) return;
      }
    }
  };
  walk(steps);
  for (const s of before.reverse()) if (s.saveAs) add({ name: s.saveAs, step: s });
  for (const v of variables ?? []) if (v.type === "array" || v.type === "any" || v.type === undefined) add({ name: v.name });
  // Results saved further down (a flow being built out of order) last.
  const rest = (list: Step[]) => {
    for (const s of list) {
      if (s.id === loopId) continue;
      if (s.saveAs) add({ name: s.saveAs, step: s });
      for (const children of Object.values(s.blocks ?? {})) rest(children);
    }
  };
  rest(steps);
  return out;
}

/** Every variable name a node could read, for 「変数を挿入」, without the loops' own names. */
export function otherVariables(variables: VariableDef[] | undefined, steps: Step[], loops: Loop[]): string[] {
  const names = new Set<string>((variables ?? []).map((v) => v.name));
  const walk = (list: Step[]) => {
    for (const s of list) {
      for (const o of outputs(s)) if (s.type !== FOR_EACH) names.add(o.variable);
      for (const children of Object.values(s.blocks ?? {})) walk(children);
    }
  };
  walk(steps);
  for (const l of loops) names.delete(l.itemVar);
  return [...names];
}
