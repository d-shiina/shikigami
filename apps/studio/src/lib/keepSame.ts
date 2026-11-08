/**
 * The chart's nodes and lines are built afresh on every render, and a run
 * renders the chart on every event it sends (each step, log line and value).
 * React Flow redraws a node or a line whenever its object is new, so a run
 * redrew the whole chart many times a second, and the view following the run
 * stuttered. Keeping the previous object where nothing in it changed lets
 * React Flow skip all but the nodes and lines that did.
 */

const plain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Whether `a` and `b` hold the same things, looking `depth` levels into plain objects and arrays. */
export function same(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (depth <= 0) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i], depth - 1)) return false;
    return true;
  }
  if (!plain(a) || !plain(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !same(a[key], b[key], depth - 1)) return false;
  }
  return true;
}

/** How deep a node or a line is looked into: itself, its data, what its data holds, and one more. */
const DEPTH = 4;

/** Each item as it was last time when nothing in it changed; `kept` is updated to this time's. */
export function keepSame<T extends { id: string }>(kept: Map<string, T>, items: T[]): T[] {
  const out = items.map((item) => {
    const before = kept.get(item.id);
    return before && same(before, item, DEPTH) ? before : item;
  });
  kept.clear();
  for (const item of out) kept.set(item.id, item);
  return out;
}
