import type { Step, StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { layoutFlow, NODE_W } from "./layout";

const def = (type: string, blocks: string[] = []): StepTypeDef => ({
  type,
  category: "control",
  label: type,
  description: "",
  paramsSchema: {},
  blocks: blocks.map((name) => ({ name, label: name })),
  hasOutput: false,
  risk: "safe",
});

const defs = new Map(
  [
    def("log.message"),
    def("control.if", ["then", "else"]),
    def("control.repeat", ["body"]),
    def("control.parallel", ["branches"]),
  ].map(
    (d) => [d.type, d] as const,
  ),
);

const log = (id: string): Step => ({ id, type: "log.message" });

describe("layoutFlow", () => {
  it("makes room below an unfolded call", () => {
    const steps = [log("a"), log("b")];
    const folded = layoutFlow(steps, defs);
    const open = layoutFlow(steps, defs, new Map([["a", 120]]));
    const y = (l: typeof open, id: string) => l.nodes.find((n) => n.id === id)!.position.y;
    expect(y(open, "b") - y(folded, "b")).toBe(120);
    expect(open.height - folded.height).toBe(120);
  });

  it("renders an empty flow as a single slot", () => {
    const layout = layoutFlow([], defs);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.type).toBe("slot");
  });

  it("chains sequential steps top to bottom", () => {
    const layout = layoutFlow([log("a"), log("b"), log("c")], defs);
    const ys = layout.nodes.map((n) => n.position.y);
    expect(ys).toEqual([...ys].sort((p, q) => p - q));
    expect(layout.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["a>b", "b>c"]);
  });

  it("lays out branches side by side and merges them", () => {
    const steps: Step[] = [
      { id: "if", type: "control.if", blocks: { then: [log("t1"), log("t2")] } },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    const pos = Object.fromEntries(layout.nodes.map((n) => [n.id, n.position]));
    const elseSlot = layout.nodes.find((n) => n.id.startsWith("slot:"));
    expect(elseSlot?.id).toBe("slot:if:else");
    // then-lane is left of the else-lane
    expect(pos.t1!.x).toBeLessThan(elseSlot!.position.x);
    // both branches flow into "after"
    const intoAfter = layout.edges.filter((e) => e.target === "after").map((e) => e.source);
    expect(intoAfter.sort()).toEqual(["end:if:then", "slot:if:else"]);
    expect(layout.edges.some((e) => e.source === "t2" && e.target === "end:if:then")).toBe(true);
    expect(layout.width).toBeGreaterThanOrEqual(NODE_W * 2);
  });

  it("draws loop back-edges and exits from the loop node", () => {
    const steps: Step[] = [
      { id: "loop", type: "control.repeat", blocks: { body: [log("x")] } },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    expect(layout.edges.some((e) => e.source === "x" && e.target === "end:loop:body")).toBe(true);
    expect(layout.edges.find((e) => e.source === "end:loop:body" && e.target === "loop")?.loop).toBe(true);
    expect(layout.edges.some((e) => e.source === "loop" && e.target === "after")).toBe(true);
  });

  it("puts each parallel branch in its own lane and joins them", () => {
    const steps: Step[] = [
      { id: "par", type: "control.parallel", blocks: { branches: [log("a"), log("b"), log("c")] } },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    expect(byId.a!.position.y).toBe(byId.b!.position.y);
    expect(byId.a!.position.x).toBeLessThan(byId.b!.position.x);
    expect(byId.b!.position.x).toBeLessThan(byId.c!.position.x);
    // indexes still address the shared "branches" block
    expect(["a", "b", "c"].map((id) => (byId[id]!.data as { index: number }).index)).toEqual([0, 1, 2]);
    const intoAfter = layout.edges.filter((e) => e.target === "after").map((e) => e.source);
    expect(intoAfter.sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps the main line on one column, with blocks below their step", () => {
    const steps: Step[] = [
      log("a"),
      { id: "if", type: "control.if", blocks: { then: [log("t")], else: [log("e")] } },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    const pos = Object.fromEntries(layout.nodes.map((n) => [n.id, n.position]));
    expect(pos.a!.x).toBe(pos.if!.x);
    expect(pos.a!.x).toBe(pos.after!.x);
    expect(pos.t!.y).toBeGreaterThan(pos.if!.y);
    expect(pos.t!.y).toBe(pos.e!.y);
    expect(pos.t!.x).toBeLessThan(pos.e!.x);
    expect(pos.after!.y).toBeGreaterThan(pos.t!.y);
  });

  it("frames a loop with everything inside it, apart from what comes after", () => {
    const steps: Step[] = [
      log("before"),
      { id: "outer", type: "control.repeat", blocks: { body: [log("x"), { id: "inner", type: "control.repeat", blocks: { body: [log("y")] } }] } },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    const box = (id: string) => {
      const n = layout.nodes.find((node) => node.id === id)!;
      return { x: n.position.x, y: n.position.y, right: n.position.x + NODE_W, bottom: n.position.y + 40 };
    };
    const frame = (id: string) => {
      const f = layout.frames.find((fr) => fr.id === id)!;
      return { ...f, right: f.x + f.width, bottom: f.y + f.height };
    };
    const contains = (f: ReturnType<typeof frame>, b: ReturnType<typeof box>) =>
      f.x < b.x && f.right > b.right && f.y < b.y && f.bottom > b.bottom;
    const outer = frame("outer");
    const inner = frame("inner");
    expect([outer.kind, outer.depth, inner.kind, inner.depth]).toEqual(["loop", 0, "loop", 1]);
    for (const id of ["outer", "x", "inner", "y"]) expect(contains(outer, box(id))).toBe(true);
    expect(contains(inner, box("y"))).toBe(true);
    expect(contains(inner, box("x"))).toBe(false);
    expect(contains(outer, box("before"))).toBe(false);
    expect(contains(outer, box("after"))).toBe(false);
    // The inner frame sits inside the outer one and ends above its bottom.
    expect(inner.x).toBeGreaterThan(outer.x);
    expect(inner.right).toBeLessThan(outer.right);
    expect(inner.bottom).toBeLessThan(outer.bottom);
    // The lines around a loop's body run inside its frame, outside the inner one.
    const back = layout.edges.find((e) => e.source === "end:outer:body" && e.target === "outer")!;
    expect(back.detourX).toBeGreaterThan(inner.right);
    expect(back.detourX).toBeLessThan(outer.right);
    const exit = layout.edges.find((e) => e.source === "outer" && e.target === "after")!;
    expect(exit.detourX).toBeGreaterThan(outer.x);
  });

  it("frames branches too, and keeps side-by-side frames apart", () => {
    const steps: Step[] = [
      {
        id: "if",
        type: "control.if",
        blocks: {
          then: [{ id: "l1", type: "control.repeat", blocks: { body: [log("a")] } }],
          else: [{ id: "l2", type: "control.repeat", blocks: { body: [log("b")] } }],
        },
      },
    ];
    const layout = layoutFlow(steps, defs);
    const f = Object.fromEntries(layout.frames.map((fr) => [fr.id, fr]));
    expect(f.if!.kind).toBe("if");
    expect(f.l1!.x + f.l1!.width).toBeLessThan(f.l2!.x);
    expect(f.l1!.x).toBeGreaterThan(f.if!.x);
    expect(f.l2!.x + f.l2!.width).toBeLessThan(f.if!.x + f.if!.width);
    expect(layoutFlow([log("a")], defs).frames).toEqual([]);
  });

  it("ends every block that has nodes with a \"+\" under its last node, inside its frame", () => {
    const steps: Step[] = [
      {
        id: "loop",
        type: "control.repeat",
        blocks: { body: [{ id: "if", type: "control.if", blocks: { then: [log("t")], else: [log("e1"), log("e2")] } }] },
      },
      { id: "par", type: "control.parallel", blocks: { branches: [log("p1"), log("p2")] } },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    const tails = layout.nodes.filter((n) => n.data.kind === "slot" && n.data.tail);
    // Each branch, the loop's body after the if; not a parallel's branches (that would add a branch), not the flow itself.
    expect(tails.map((n) => n.id).sort()).toEqual(["end:if:else", "end:if:then", "end:loop:body"]);
    for (const n of tails) expect(n.data).toMatchObject({ kind: "slot", parentId: n.id.split(":")[1], block: n.id.split(":")[2] });
    const pos = Object.fromEntries(layout.nodes.map((n) => [n.id, n.position]));
    // Under the last node of its block, on its line.
    expect(pos["end:if:then"]!.y).toBeGreaterThan(pos.t!.y);
    expect(pos["end:if:else"]!.y).toBeGreaterThan(pos.e2!.y);
    expect(pos["end:if:then"]!.x + 12).toBe(pos.t!.x + NODE_W / 2);
    // The branches run through their "+" into the end of the loop's body, and that back up into the loop.
    const into = (id: string) => layout.edges.filter((e) => e.target === id).map((e) => e.source).sort();
    expect(into("end:if:then")).toEqual(["t"]);
    expect(into("end:if:else")).toEqual(["e2"]);
    expect(into("end:loop:body")).toEqual(["end:if:else", "end:if:then"]);
    expect(layout.edges.find((e) => e.source === "end:loop:body")?.target).toBe("loop");
    // Inside the frames: the branches' in the if's, the body's below it but in the loop's.
    const frame = (id: string) => layout.frames.find((f) => f.id === id)!;
    const inside = (id: string, n: string) => {
      const f = frame(id);
      const p = pos[n]!;
      return p.y > f.y && p.y + 24 < f.y + f.height;
    };
    expect(inside("if", "end:if:then")).toBe(true);
    expect(inside("if", "end:loop:body")).toBe(false);
    expect(inside("loop", "end:loop:body")).toBe(true);
  });
});
