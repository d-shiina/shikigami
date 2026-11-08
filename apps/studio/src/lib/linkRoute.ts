// The way a variable's line goes from the step that writes it to the step
// that reads it, around the nodes instead of behind them. A step writes on
// its right side and reads on its left, so the line leaves to the right, runs
// down (or up) the first free gap right of the writer, crosses over in the
// gap just above the reader, and comes down its left side into the socket.
// Display only: the chart's positions are a view (see flow/layout.ts).

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

/** Between a line and the node it passes. */
const CLEAR = 10;
/** Tries before giving up on a free gap (a very crowded chart): the line then goes where it got to. */
const MAX_TRIES = 40;

const overlapsY = (b: Box, y1: number, y2: number) => b.y < Math.max(y1, y2) && b.y + b.height > Math.min(y1, y2);
const overlapsX = (b: Box, x1: number, x2: number) => b.x < Math.max(x1, x2) && b.x + b.width > Math.min(x1, x2);

/** The first x from `x` going `dir` (1 right, -1 left) where a vertical line from y1 to y2 passes no box. */
function freeX(x: number, y1: number, y2: number, boxes: readonly Box[], dir: 1 | -1): number {
  for (let i = 0; i < MAX_TRIES; i++) {
    const hit = boxes.find((b) => overlapsY(b, y1, y2) && b.x - CLEAR / 2 < x && b.x + b.width + CLEAR / 2 > x);
    if (!hit) return x;
    x = dir === 1 ? hit.x + hit.width + CLEAR : hit.x - CLEAR;
  }
  return x;
}

/** The lowest y at or above `y` where a horizontal line from x1 to x2 passes no box. */
function freeY(y: number, x1: number, x2: number, boxes: readonly Box[]): number {
  for (let i = 0; i < MAX_TRIES; i++) {
    const hit = boxes.find((b) => overlapsX(b, x1, x2) && b.y - CLEAR / 2 < y && b.y + b.height + CLEAR / 2 > y);
    if (!hit) return y;
    y = hit.y - CLEAR;
  }
  return y;
}

/**
 * The corners of the line from `from` (a writer's socket, on its right) to
 * `to` (a reader's socket, on its left), whose node's top is at `toTop`,
 * passing none of `boxes` (every node on the chart, the two ends included).
 */
export function routeLink(from: Point, to: Point, toTop: number, boxes: readonly Box[]): Point[] {
  // The reader is right of the free gap beside the writer (another column): down that gap, across at its height,
  // when nothing (a column between them) is in the way across.
  const beside = freeX(from.x + CLEAR, from.y, to.y, boxes, 1);
  if (to.x - CLEAR >= beside && freeY(to.y, beside, to.x, boxes) === to.y) return [from, { x: beside, y: from.y }, { x: beside, y: to.y }, to];
  // Else down (or up) the gap right of the writer, over in the gap above the reader, and down its left side.
  let cross = toTop - CLEAR;
  let right = beside;
  let left = to.x - CLEAR;
  for (let i = 0; i < 4; i++) {
    right = freeX(from.x + CLEAR, from.y, cross, boxes, 1);
    left = freeX(to.x - CLEAR, cross, to.y, boxes, -1);
    const y = freeY(cross, left, right, boxes);
    if (y === cross) break;
    cross = y;
  }
  return [from, { x: right, y: from.y }, { x: right, y: cross }, { x: left, y: cross }, { x: left, y: to.y }, to];
}

/** An SVG path through `points` with rounded corners. */
export function roundedPath(points: readonly Point[], radius = 8): string {
  const pts = points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
  if (pts.length === 0) return "";
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1]!, pts[i]!, pts[i + 1]!];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const inX = b.x - Math.sign(b.x - a.x) * r;
    const inY = b.y - Math.sign(b.y - a.y) * r;
    const outX = b.x + Math.sign(c.x - b.x) * r;
    const outY = b.y + Math.sign(c.y - b.y) * r;
    d += ` L ${inX} ${inY} Q ${b.x} ${b.y} ${outX} ${outY}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}
