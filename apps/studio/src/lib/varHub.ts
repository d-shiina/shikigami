// The variable box: every variable gets one column in a strip above the
// flow, and steps link to the box instead of to each other. Columns sit
// above the steps that use them, so links run mostly straight up and down.
// Display only.
import type { Step } from "@shikigami/schema";
import { type DataLink, OUTPUT_NODE } from "./dataFlow";
import { outputs } from "./nodeRows";

export const HUB_COL_W = 140;

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

/**
 * Column positions (left edges) for each variable: ordered by where their
 * users are, nudged right so columns never overlap. Unused variables go last.
 */
export function hubColumns(variables: string[], links: HubLink[], socketX: (l: HubLink) => number | undefined): Map<string, number> {
  const want = new Map<string, number>();
  for (const v of variables) {
    const xs = links.filter((l) => l.variable === v).map(socketX).filter((x): x is number => x !== undefined);
    want.set(v, xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length - HUB_COL_W / 2 : Number.POSITIVE_INFINITY);
  }
  const order = [...variables].sort((a, b) => (want.get(a) ?? 0) - (want.get(b) ?? 0));
  const placed = new Map<string, number>();
  let next = Number.NEGATIVE_INFINITY;
  for (const v of order) {
    const w = want.get(v) ?? 0;
    const x = Math.max(Number.isFinite(w) ? w : next, next);
    placed.set(v, x);
    next = x + HUB_COL_W;
  }
  return placed;
}
