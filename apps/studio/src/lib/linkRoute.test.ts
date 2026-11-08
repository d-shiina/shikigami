import { describe, expect, it } from "vitest";
import { type Box, type Point, roundedPath, routeLink } from "./linkRoute";

/** Whether the line through `points` passes inside `box`. */
function crosses(points: Point[], box: Box): boolean {
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    if (x2 > box.x && x1 < box.x + box.width && y2 > box.y && y1 < box.y + box.height) return true;
  }
  return false;
}

describe("routeLink", () => {
  // Three nodes in a column, 290 wide, 100 tall, 56 apart.
  const node = (i: number): Box => ({ x: 0, y: i * 156, width: 290, height: 100 });
  const column = [node(0), node(1), node(2)];

  it("goes round the nodes between the writer and the reader, not behind them", () => {
    // Node 0 writes (right side), node 2 reads (left side).
    const from = { x: 290, y: 80 };
    const to = { x: 0, y: 2 * 156 + 60 };
    const points = routeLink(from, to, node(2).y, column);
    expect(points[0]).toEqual(from);
    expect(points.at(-1)).toEqual(to);
    expect(crosses(points.slice(1, -1), node(1))).toBe(false);
    for (const n of column) expect(crosses(points.slice(1, -1), n)).toBe(false);
    // Over in the gap above the reader.
    expect(points[2]!.y).toBeGreaterThan(node(1).y + node(1).height);
    expect(points[2]!.y).toBeLessThan(node(2).y);
  });

  it("goes past a wider frame head in its way", () => {
    const head: Box = { x: -40, y: 156, width: 400, height: 38 };
    const boxes = [node(0), head, node(2)];
    const points = routeLink({ x: 290, y: 80 }, { x: 0, y: 2 * 156 + 60 }, node(2).y, boxes);
    for (const b of boxes) expect(crosses(points.slice(1, -1), b)).toBe(false);
  });

  it("goes straight across to a reader in a column to the right", () => {
    const reader: Box = { x: 400, y: 156, width: 290, height: 100 };
    const points = routeLink({ x: 290, y: 80 }, { x: 400, y: 200 }, 156, [node(0), reader]);
    expect(points).toHaveLength(4);
    expect(points[1]!.x).toBeLessThan(400);
  });

  it("goes over a column between the writer and a reader further right", () => {
    const middle: Box = { x: 400, y: 156, width: 290, height: 100 };
    const reader: Box = { x: 800, y: 156, width: 290, height: 100 };
    const boxes = [node(0), middle, reader];
    const points = routeLink({ x: 290, y: 80 }, { x: 800, y: 200 }, 156, boxes);
    expect(points.at(-1)).toEqual({ x: 800, y: 200 });
    for (const b of boxes) expect(crosses(points.slice(1, -1), b)).toBe(false);
  });

  it("goes round a column beside the writer and a wide frame head under it", () => {
    const boxes: Box[] = [node(0), { x: 400, y: 0, width: 290, height: 100 }, { x: -32, y: 232, width: 754, height: 38 }, { x: 200, y: 400, width: 290, height: 100 }];
    const points = routeLink({ x: 290, y: 80 }, { x: 200, y: 460 }, 400, boxes);
    for (const b of boxes) expect(crosses(points.slice(1, -1), b)).toBe(false);
  });

  it("goes up to a reader above the writer", () => {
    const points = routeLink({ x: 290, y: 2 * 156 + 80 }, { x: 0, y: 60 }, 0, column);
    for (const n of column) expect(crosses(points.slice(1, -1), n)).toBe(false);
    expect(points[2]!.y).toBeLessThan(0);
  });
});

describe("roundedPath", () => {
  it("rounds each corner", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }])).toBe("M 0 0 L 12 0 Q 20 0 20 8 L 20 20");
  });
});
