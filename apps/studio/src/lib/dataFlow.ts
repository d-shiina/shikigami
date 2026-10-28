// Which step a variable's value comes from, for drawing Blender-style links
// between sockets. Display only: it follows the steps in the order they are
// written and links each read to the latest write before it, or to the
// scenario's starting values. It never decides anything the Runtime does.
import type { Step, StepTypeDef, VariableDef } from "@shikigami/schema";
import { nodeRows, outputs } from "./nodeRows";

/** Pseudo node ids for the scenario's own inputs and outputs. */
export const INPUT_NODE = "@input";
export const OUTPUT_NODE = "@output";

export type DataLink = {
  variable: string;
  /** Step id that wrote it, or INPUT_NODE for the starting value. */
  from: string;
  /** Step id whose param reads it, or OUTPUT_NODE for a returned value. */
  to: string;
  /** Handle on the reading side: `in:<param>` on a step, `in:<variable>` on the output node. */
  toHandle: string;
};

export const outHandle = (variable: string) => `out:${variable}`;
export const inHandle = (key: string) => `in:${key}`;

export function dataLinks(
  steps: Step[],
  variables: VariableDef[] | undefined,
  defs: ReadonlyMap<string, StepTypeDef>,
  known: ReadonlySet<string>,
): DataLink[] {
  const links: DataLink[] = [];
  const declared = new Set((variables ?? []).map((v) => v.name));
  const writer = new Map<string, string>();
  const seen = new Set<string>();
  const link = (l: DataLink) => {
    const key = `${l.from}|${l.variable}|${l.to}|${l.toHandle}`;
    if (!seen.has(key)) links.push(l);
    seen.add(key);
  };

  const walk = (list: Step[]) => {
    for (const step of list) {
      if (!step.id) continue;
      for (const row of nodeRows(step, defs.get(step.type), known)) {
        if (row.kind !== "param") continue;
        for (const variable of row.refs) {
          const from = writer.get(variable) ?? (declared.has(variable) ? INPUT_NODE : undefined);
          if (from && from !== step.id) link({ variable, from, to: step.id, toHandle: inHandle(row.key) });
        }
      }
      for (const o of outputs(step)) writer.set(o.variable, step.id);
      for (const children of Object.values(step.blocks ?? {})) walk(children);
    }
  };
  walk(steps);

  for (const v of variables ?? []) {
    if (v.direction !== "output" && v.direction !== "inOut") continue;
    link({ variable: v.name, from: writer.get(v.name) ?? INPUT_NODE, to: OUTPUT_NODE, toHandle: inHandle(v.name) });
  }
  return links;
}
