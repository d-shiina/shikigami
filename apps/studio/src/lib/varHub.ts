// The variable box: every variable gets one row in a box beside the flow,
// and steps link to the box instead of to each other. Display only.
import type { Step } from "@shikigami/schema";
import { type DataLink, OUTPUT_NODE } from "./dataFlow";
import { outputs } from "./nodeRows";

export type HubLink =
  /** `step` writes `variable` into the box. */
  | { kind: "write"; step: string; variable: string }
  /** `step` reads `variable` from the box into its `handle` socket. */
  | { kind: "read"; step: string; variable: string; handle: string };

export function hubLinks(steps: Step[], links: DataLink[]): HubLink[] {
  const out: HubLink[] = [];
  const walk = (list: Step[]) => {
    for (const s of list) {
      if (s.id) for (const o of outputs(s)) out.push({ kind: "write", step: s.id, variable: o.variable });
      for (const children of Object.values(s.blocks ?? {})) walk(children);
    }
  };
  walk(steps);
  const seen = new Set<string>();
  for (const l of links) {
    if (l.to === OUTPUT_NODE) continue;
    const key = `${l.to}|${l.toHandle}|${l.variable}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "read", step: l.to, variable: l.variable, handle: l.toHandle });
  }
  return out;
}
