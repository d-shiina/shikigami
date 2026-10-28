import type { Step, StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { layoutScenario, NODE_W } from "./layout";

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

describe("layoutScenario", () => {
  it("renders an empty scenario as a single slot", () => {
    const layout = layoutScenario([], defs);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.type).toBe("slot");
  });

  it("chains sequential steps top to bottom", () => {
    const layout = layoutScenario([log("a"), log("b"), log("c")], defs, "vertical");
    const ys = layout.nodes.map((n) => n.position.y);
    expect(ys).toEqual([...ys].sort((p, q) => p - q));
    expect(layout.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["a>b", "b>c"]);
  });

  it("lays out branches side by side and merges them", () => {
    const steps: Step[] = [
      { id: "if", type: "control.if", blocks: { then: [log("t1"), log("t2")] } },
      log("after"),
    ];
    const layout = layoutScenario(steps, defs, "vertical");
    const pos = Object.fromEntries(layout.nodes.map((n) => [n.id, n.position]));
    const elseSlot = layout.nodes.find((n) => n.type === "slot");
    expect(elseSlot?.id).toBe("slot:if:else");
    // then-lane is left of the else-lane
    expect(pos.t1!.x).toBeLessThan(elseSlot!.position.x);
    // both branches flow into "after"
    const intoAfter = layout.edges.filter((e) => e.target === "after").map((e) => e.source);
    expect(intoAfter.sort()).toEqual(["slot:if:else", "t2"]);
    expect(layout.width).toBeGreaterThanOrEqual(NODE_W * 2);
  });

  it("draws loop back-edges and exits from the loop node", () => {
    const steps: Step[] = [
      { id: "loop", type: "control.repeat", blocks: { body: [log("x")] } },
      log("after"),
    ];
    const layout = layoutScenario(steps, defs, "vertical");
    expect(layout.edges.find((e) => e.source === "x" && e.target === "loop")?.loop).toBe(true);
    expect(layout.edges.some((e) => e.source === "loop" && e.target === "after")).toBe(true);
  });

  it("puts each parallel branch in its own lane and joins them", () => {
    const steps: Step[] = [
      { id: "par", type: "control.parallel", blocks: { branches: [log("a"), log("b"), log("c")] } },
      log("after"),
    ];
    const layout = layoutScenario(steps, defs, "vertical");
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    expect(byId.a!.position.y).toBe(byId.b!.position.y);
    expect(byId.a!.position.x).toBeLessThan(byId.b!.position.x);
    expect(byId.b!.position.x).toBeLessThan(byId.c!.position.x);
    // indexes still address the shared "branches" block
    expect(["a", "b", "c"].map((id) => (byId[id]!.data as { index: number }).index)).toEqual([0, 1, 2]);
    const intoAfter = layout.edges.filter((e) => e.target === "after").map((e) => e.source);
    expect(intoAfter.sort()).toEqual(["a", "b", "c"]);
  });

  it("runs left to right by default, with blocks hanging below their step", () => {
    const steps: Step[] = [
      log("a"),
      { id: "if", type: "control.if", blocks: { then: [log("t")], else: [log("e")] } },
      log("after"),
    ];
    const layout = layoutScenario(steps, defs);
    const pos = Object.fromEntries(layout.nodes.map((n) => [n.id, n.position]));
    expect(layout.direction).toBe("horizontal");
    expect(pos.a!.x).toBeLessThan(pos.if!.x);
    expect(pos.if!.x).toBeLessThan(pos.t!.x);
    expect(pos.t!.y).toBeGreaterThan(pos.if!.y);
    expect(pos.t!.y).toBe(pos.e!.y);
    expect(pos.t!.x).toBeLessThan(pos.e!.x);
    expect(pos.e!.x).toBeLessThan(pos.after!.x);
    // the main line stays on one row
    expect(pos.a!.y).toBe(pos.after!.y);
  });
});
