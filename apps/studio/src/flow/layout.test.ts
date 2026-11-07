import type { Step, StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { CASE_H, HEAD_H, layoutFlow, LOOP_LINE_X, NODE_W, type StepNodeData } from "./layout";

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
    def("control.switch", ["cases", "default"]),
    def("control.case", ["body"]),
    def("control.try", ["try", "catch", "finally"]),
    def("control.group", ["body"]),
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

  it("gives each case of a switch its own column under a tab, then default, and joins them", () => {
    const steps: Step[] = [
      {
        id: "sw",
        type: "control.switch",
        params: { value: "kind" },
        blocks: {
          cases: [
            { id: "c1", type: "control.case", params: { values: ["A"] }, blocks: { body: [log("a")] } },
            { id: "c2", type: "control.case", params: { values: ["B"] } },
          ],
          default: [log("d")],
        },
      },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    const node = (id: string) => layout.nodes.find((n) => n.id === id)!;
    // Cases side by side under the switch, in order, then default.
    const xs = ["c1", "slot:c2:body", "d"].map((id) => node(id).position.x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    // A case is the tab over its column, which starts where the default's does.
    expect(node("c1").data).toMatchObject({ kind: "step", tab: true });
    expect(node("c1").position.y).toBe(node("c2").position.y);
    expect(node("c1").position.y + CASE_H).toBeLessThan(node("a").position.y);
    expect(node("a").position.y).toBe(node("d").position.y);
    // No column to add a case: the switch's head offers it.
    expect(layout.nodes.some((n) => n.id === "slot:sw:cases")).toBe(false);
    expect((node("sw").data as StepNodeData).head).toMatchObject({ addCase: true, collapsed: false });
    // Every column meets at the switch's join, and that goes on to the next step.
    const into = (id: string) => layout.edges.filter((e) => e.target === id).map((e) => e.source).sort();
    expect(into("join:sw")).toEqual(["end:c1:body", "end:sw:default", "slot:c2:body"]);
    expect(into("after")).toEqual(["join:sw"]);
    // One frame, around the switch: a case is a branch of it, not a frame of its own.
    expect(layout.frames.map((f) => [f.id, f.kind])).toEqual([["sw", "switch"]]);
  });

  it("makes the step of a frame its head, as wide as the frame, with the line through its middle", () => {
    const steps: Step[] = [log("a"), { id: "g", type: "control.group", blocks: { body: [log("x")] } }, log("after")];
    const layout = layoutFlow(steps, defs);
    const node = (id: string) => layout.nodes.find((n) => n.id === id)!;
    const frame = layout.frames.find((f) => f.id === "g")!;
    const head = (node("g").data as StepNodeData).head!;
    expect(node("g").position).toEqual({ x: frame.x, y: frame.y });
    expect(head.width).toBe(frame.width);
    expect(node("g").position.x + head.lineX).toBe(node("a").position.x + NODE_W / 2);
    expect(node("x").position.y).toBeGreaterThan(frame.y + HEAD_H);
    // One column: its join is not marked, only where the line leaves the frame.
    expect(node("join:g").data).toMatchObject({ kind: "join", shown: false });
    expect(node("join:g").position.y).toBeLessThan(frame.y + frame.height);
  });

  it("folds a frame to its head, saying how much is inside", () => {
    const steps: Step[] = [{ id: "g", type: "control.group", blocks: { body: [log("x"), { id: "l", type: "control.repeat", blocks: { body: [log("y")] } }] } }, log("after")];
    const layout = layoutFlow(steps, defs, undefined, new Set(["g"]));
    expect(layout.nodes.map((n) => n.id)).toEqual(["g", "after", "slot:end"]);
    expect(layout.frames).toEqual([]);
    expect((layout.nodes[0]!.data as StepNodeData).head).toMatchObject({ collapsed: true, count: 3, width: NODE_W });
    expect(layout.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["g>after"]);
  });

  it("shows a try's finally only once it has nodes; until then the head offers it", () => {
    const at = (finallySteps: Step[]) =>
      layoutFlow([{ id: "t", type: "control.try", blocks: { try: [log("a")], catch: [log("b")], finally: finallySteps } }], defs);
    const without = at([]);
    expect(without.nodes.some((n) => n.id === "slot:t:finally")).toBe(false);
    expect((without.nodes.find((n) => n.id === "t")!.data as StepNodeData).head).toMatchObject({ addFinally: true });
    const withIt = at([log("f")]);
    expect(withIt.nodes.some((n) => n.id === "f")).toBe(true);
    expect((withIt.nodes.find((n) => n.id === "t")!.data as StepNodeData).head?.addFinally).toBeUndefined();
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
    // both branches meet at the if's join, which flows into "after"
    const into = (id: string) => layout.edges.filter((e) => e.target === id).map((e) => e.source).sort();
    expect(into("join:if")).toEqual(["end:if:then", "slot:if:else"]);
    expect(into("after")).toEqual(["join:if"]);
    expect(layout.nodes.find((n) => n.id === "join:if")?.data).toMatchObject({ kind: "join", shown: true });
    expect(layout.edges.some((e) => e.source === "t2" && e.target === "end:if:then")).toBe(true);
    expect(layout.width).toBeGreaterThanOrEqual(NODE_W * 2);
  });

  it("draws loop back-edges, and leaves a loop from the bottom of its frame", () => {
    const steps: Step[] = [
      { id: "loop", type: "control.repeat", blocks: { body: [log("x")] } },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    expect(layout.edges.some((e) => e.source === "x" && e.target === "end:loop:body")).toBe(true);
    expect(layout.edges.find((e) => e.source === "end:loop:body" && e.target === "loop")?.loop).toBe(true);
    // Out of the frame's bottom; a hidden line from the head carries a run's trail there.
    expect(layout.edges.find((e) => e.source === "loop" && e.target === "join:loop")?.hidden).toBe(true);
    expect(layout.edges.some((e) => e.source === "join:loop" && e.target === "after")).toBe(true);
    expect(layout.nodes.find((n) => n.id === "join:loop")?.data).toMatchObject({ shown: false });
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
    const intoJoin = layout.edges.filter((e) => e.target === "join:par").map((e) => e.source);
    expect(intoJoin.sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps the main line on one column, with blocks below their step", () => {
    const steps: Step[] = [
      log("a"),
      { id: "if", type: "control.if", blocks: { then: [log("t")], else: [log("e")] } },
      log("after"),
    ];
    const layout = layoutFlow(steps, defs);
    const pos = Object.fromEntries(layout.nodes.map((n) => [n.id, n.position]));
    const head = (layout.nodes.find((n) => n.id === "if")!.data as StepNodeData).head!;
    expect(pos.if!.x + head.lineX).toBe(pos.a!.x + NODE_W / 2);
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
    for (const id of ["x", "inner", "y"]) expect(contains(outer, box(id))).toBe(true);
    expect(contains(inner, box("y"))).toBe(true);
    expect(contains(inner, box("x"))).toBe(false);
    expect(contains(outer, box("before"))).toBe(false);
    expect(contains(outer, box("after"))).toBe(false);
    // The inner frame sits inside the outer one and ends above its bottom.
    expect(inner.x).toBeGreaterThan(outer.x);
    expect(inner.right).toBeLessThan(outer.right);
    expect(inner.bottom).toBeLessThan(outer.bottom);
    // The line back up runs inside the loop's frame, left of the inner one, under the loop's icon.
    const back = layout.edges.find((e) => e.source === "end:outer:body" && e.target === "outer")!;
    expect(back.detourX).toBe(outer.x + LOOP_LINE_X);
    expect(back.detourX! + 12).toBeLessThan(inner.x);
    expect(back.label).toBe("次の回へ");
    // It is left from the bottom of the frame, after everything in it.
    const exit = layout.nodes.find((n) => n.id === "join:outer")!;
    expect(exit.position.y).toBeGreaterThan(inner.bottom);
    expect(exit.position.y).toBeLessThan(outer.bottom);
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
    expect(into("join:if")).toEqual(["end:if:else", "end:if:then"]);
    expect(into("end:loop:body")).toEqual(["join:if"]);
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
