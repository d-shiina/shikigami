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
/** What a turn costs, in pixels of length: fewer turns read easier than a slightly shorter line. */
const TURN = 40;
/** Room above and below the two ends where the line may go round something. */
const REACH = 400;

/** Whether a straight piece of line from `a` to `b` (across or down) passes no box. */
function free(a: Point, b: Point, boxes: readonly Box[]): boolean {
  const m = CLEAR / 2;
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return !boxes.some((o) => o.x - m < x2 && o.x + o.width + m > x1 && o.y - m < y2 && o.y + o.height + m > y1);
}

const sorted = (values: number[]) => [...new Set(values)].sort((p, q) => p - q);

/**
 * The corners of the line from `from` (a writer's socket, on its right) to
 * `to` (a reader's socket, on its left), passing none of `boxes` (every node
 * on the chart, the two ends included): it leaves to the right and comes in
 * from the left, and between runs along the gaps beside and between nodes,
 * the shortest such way with the fewest turns. `toTop` is where the reader's
 * node starts: with no way round (a chart too crowded), the line goes over in
 * the gap above it.
 */
export function routeLink(from: Point, to: Point, toTop: number, boxes: readonly Box[]): Point[] {
  const out = { x: from.x + CLEAR, y: from.y };
  const into = { x: to.x - CLEAR, y: to.y };
  const top = Math.min(from.y, to.y) - REACH;
  const bottom = Math.max(from.y, to.y) + REACH;
  const near = boxes.filter((b) => b.y < bottom && b.y + b.height > top);
  // Where the line can run: beside each box and between them, and through the two ends.
  const xs = sorted([out.x, into.x, ...near.flatMap((b) => [b.x - CLEAR, b.x + b.width + CLEAR])]);
  const ys = sorted([out.y, into.y, ...near.flatMap((b) => [b.y - CLEAR, b.y + b.height + CLEAR])]).filter((y) => y >= top && y <= bottom);
  const path = shortest(xs, ys, out, into, near);
  if (path) return corners([from, ...path, to]);
  // No way round: over in the gap above the reader.
  const cross = toTop - CLEAR;
  return [from, out, { x: out.x, y: cross }, { x: into.x, y: cross }, into, to];
}

/** The way from `a` to `b` over the grid of `xs` × `ys` with the fewest turns and least length, or null. */
function shortest(xs: number[], ys: number[], a: Point, b: Point, boxes: readonly Box[]): Point[] | null {
  const W = xs.length;
  const H = ys.length;
  const ax = xs.indexOf(a.x);
  const ay = ys.indexOf(a.y);
  const bx = xs.indexOf(b.x);
  const by = ys.indexOf(b.y);
  // A state is a point and the way the line came into it (0 across, 1 down), so a turn can cost.
  const id = (i: number, j: number, d: number) => (j * W + i) * 2 + d;
  const dist = new Float64Array(W * H * 2).fill(Infinity);
  const prev = new Int32Array(W * H * 2).fill(-1);
  const heap: [number, number][] = [];
  const push = (cost: number, state: number) => {
    heap.push([cost, state]);
    let k = heap.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (heap[up]![0] <= heap[k]![0]) break;
      [heap[up], heap[k]] = [heap[k]!, heap[up]!];
      k = up;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };
  // It leaves the writer going across (to the right).
  const start = id(ax, ay, 0);
  dist[start] = 0;
  push(0, start);
  // Whether the step between two neighbouring grid points is clear, worked out once each.
  const clear = new Map<number, boolean>();
  const step = (i: number, j: number, i2: number, j2: number) => {
    const key = Math.min(j * W + i, j2 * W + i2) * W * H + Math.max(j * W + i, j2 * W + i2);
    let ok = clear.get(key);
    if (ok === undefined) {
      ok = free({ x: xs[i]!, y: ys[j]! }, { x: xs[i2]!, y: ys[j2]! }, boxes);
      clear.set(key, ok);
    }
    return ok;
  };
  while (heap.length > 0) {
    const [cost, state] = pop();
    if (cost > dist[state]!) continue;
    const d = state % 2;
    const cell = (state - d) / 2;
    const i = cell % W;
    const j = (cell - i) / W;
    // It comes into the reader across (from the left).
    if (i === bx && j === by && d === 0) {
      const points: Point[] = [];
      for (let s = state; s !== -1; s = prev[s]!) {
        const c = (s - (s % 2)) / 2;
        points.push({ x: xs[c % W]!, y: ys[(c - (c % W)) / W]! });
      }
      return corners(points.reverse());
    }
    for (const [di, dj, nd] of [[1, 0, 0], [-1, 0, 0], [0, 1, 1], [0, -1, 1]] as const) {
      const i2 = i + di;
      const j2 = j + dj;
      if (i2 < 0 || i2 >= W || j2 < 0 || j2 >= H || !step(i, j, i2, j2)) continue;
      const next = id(i2, j2, nd);
      const c = cost + Math.abs(xs[i2]! - xs[i]!) + Math.abs(ys[j2]! - ys[j]!) + (nd === d ? 0 : TURN);
      if (c < dist[next]!) {
        dist[next] = c;
        prev[next] = state;
        push(c, next);
      }
    }
  }
  return null;
}

/** Only the points where the line turns (and its two ends). */
function corners(points: Point[]): Point[] {
  return points.filter((p, k) => {
    if (k === 0 || k === points.length - 1) return true;
    const a = points[k - 1]!;
    const b = points[k + 1]!;
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
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
