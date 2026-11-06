// Named screen parts (`flow.parts`): a node's target can be
// `{ "part": "<name>" }`, so a button used by ten nodes is fixed in one
// place. What uses a part, how to name a new one, and the edits that turn
// a node's own target into a part.
import type { EditOp, Part, Step } from "@shikigami/schema";

/** The apps whose nodes take a `target` that can be a part. */
export const PART_APPS = ["browser", "desktop"] as const;
export type PartAppName = (typeof PART_APPS)[number];

export function appOf(type: string): PartAppName | undefined {
  const app = type.split(".")[0];
  return (PART_APPS as readonly string[]).includes(app ?? "") ? (app as PartAppName) : undefined;
}

/** The part name when `value` is `{ part: "<name>" }` and nothing else. */
export function partRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const name = (value as Record<string, unknown>).part;
  return keys.length === 1 && typeof name === "string" ? name : undefined;
}

function* walk(steps: readonly Step[]): Generator<Step> {
  for (const step of steps) {
    yield step;
    for (const children of Object.values(step.blocks ?? {})) yield* walk(children);
  }
}

/** The nodes whose target names the part. */
export function partUses(steps: readonly Step[], name: string): Step[] {
  return [...walk(steps)].filter((s) => appOf(s.type) && partRef(s.params?.target) === name);
}

const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** A name for a new part: from the target's id / test id / words when they are ASCII, else `part1`, `part2`… */
export function newPartName(target: unknown, taken: Iterable<string>): string {
  const used = new Set(taken);
  const t = (target ?? {}) as Record<string, unknown>;
  const element = (t.element ?? {}) as Record<string, unknown>;
  const words = [element.id, t.testId, element.name, t.name, t.label, t.text, t.placeholder];
  let base = "";
  for (const w of words) {
    if (typeof w !== "string") continue;
    const parts = w.match(/[A-Za-z0-9]+/g);
    if (!parts || parts.join("").length < 2 || /[^\x20-\x7e]/.test(w)) continue;
    base = parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join("");
    break;
  }
  if (!/^[A-Za-z_]/.test(base)) base = base ? `part${base}` : "part";
  if (base !== "part" && !used.has(base)) return base;
  for (let n = 1; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

/**
 * Turns `step`'s own target into a part named `name`, and points every node
 * of the same app with exactly the same target at it too. One batch of ops,
 * so it is one undo.
 */
export function makePartOps(steps: readonly Step[], step: Step, name: string, label: string): { ops: EditOp[]; others: number } | null {
  const app = appOf(step.type);
  const target = step.params?.target;
  if (!app || !target || partRef(target)) return null;
  const part: Part = { app, target: target as Part["target"], ...(label.trim() ? { label: label.trim() } : {}) };
  const ops: EditOp[] = [{ op: "setPart", name, part }];
  let others = 0;
  for (const s of walk(steps)) {
    if (!s.id || appOf(s.type) !== app || !same(s.params?.target, target)) continue;
    if (s.id !== step.id) others += 1;
    // Replace, not merge: a merge patch would keep the old target's fields.
    ops.push({ op: "updateStep", stepId: s.id, patch: { replaceParams: { ...s.params, target: { part: name } } } });
  }
  return { ops, others };
}

/** Puts the part's target back into the node (no longer shared). */
export function detachOps(step: Step, part: Part): EditOp[] {
  return step.id ? [{ op: "updateStep", stepId: step.id, patch: { replaceParams: { ...step.params, target: part.target } } }] : [];
}
