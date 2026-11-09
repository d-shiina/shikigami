import type { RunEventEnvelope } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { emptyTrace, enclosing, type RunTrace, sinceText, spanText, type TraceLine, traceEvent, traceRows, withError } from "./runTrace";

let seq = 0;
const at = (ms: number) => new Date(Date.UTC(2026, 10, 8, 8, 30, 0) + ms).toISOString();
const started = (stepId: string, stepType: string, ms: number, callPath: string[] = [], attempt = 1) =>
  ({ runId: "r", seq: seq++, at: at(ms), callPath, type: "stepStarted", stepId, stepType, attempt }) as RunEventEnvelope;
const finished = (stepId: string, stepType: string, ms: number, durationMs: number, outcome: "succeeded" | "failed" = "succeeded", callPath: string[] = [], willRetry = false) =>
  ({ runId: "r", seq: seq++, at: at(ms), callPath, type: "stepFinished", stepId, stepType, outcome, durationMs, willRetry }) as RunEventEnvelope;
const play = (events: RunEventEnvelope[]): RunTrace => events.reduce((t, e) => traceEvent(t, e), emptyTrace());
const all = () => true;

describe("runTrace", () => {
  it("nests what runs inside loops and calls, and splits a loop into rounds", () => {
    seq = 0;
    const trace = play([
      started("read", "file.readCsv", 0),
      finished("read", "file.readCsv", 600, 600),
      started("loop", "control.forEach", 610),
      started("call", "flow.call", 620),
      started("open", "browser.open", 630, ["call"]),
      finished("open", "browser.open", 900, 270, "succeeded", ["call"]),
      finished("call", "flow.call", 910, 290),
      started("call", "flow.call", 920),
      started("open", "browser.open", 930, ["call"]),
      finished("open", "browser.open", 1000, 70, "failed", ["call"]),
      finished("call", "flow.call", 1010, 90, "failed"),
      finished("loop", "control.forEach", 1020, 410, "failed"),
    ]);
    expect(trace.open).toEqual([]);
    const inner = trace.nodes.filter((n) => n.stepId === "open");
    expect(inner.map((n) => n.parent)).toEqual(trace.nodes.filter((n) => n.stepId === "call").map((n) => n.key));
    const rows = traceRows(trace.nodes, [], (_id, auto) => auto);
    // The finished round is folded, the failed one is open.
    expect(rows.map((r) => (r.kind === "node" ? r.node.stepId : r.kind === "round" ? `round${r.index}` : "line"))).toEqual([
      "read",
      "loop",
      "round0",
      "round1",
      "call",
      "open",
    ]);
    expect(rows.find((r) => r.kind === "round" && r.index === 1)).toMatchObject({ outcome: "failed" });
  });

  it("keeps a retried node on one row and counts its attempts", () => {
    seq = 0;
    let trace = play([started("click", "browser.click", 0), finished("click", "browser.click", 5000, 5000, "failed", [], true)]);
    trace = withError(trace, "click", [], "見つかりません");
    expect(trace.nodes[0]).toMatchObject({ retrying: true, error: "見つかりません" });
    trace = [started("click", "browser.click", 5500, [], 2), finished("click", "browser.click", 6400, 900)].reduce((t, e) => traceEvent(t, e), trace);
    expect(trace.nodes).toHaveLength(1);
    expect(trace.nodes[0]).toMatchObject({ attempt: 2, outcome: "succeeded", retrying: false, durationMs: 6400 });
    expect(trace.nodes[0]!.error).toBeUndefined();
  });

  it("never makes a plain node the parent of a parallel branch's node", () => {
    seq = 0;
    const trace = play([
      started("par", "control.parallel", 0),
      started("a", "browser.click", 10),
      started("b", "excel.readRows", 20),
      finished("a", "browser.click", 30, 20),
      finished("b", "excel.readRows", 40, 20),
      finished("par", "control.parallel", 50, 50),
    ]);
    const par = trace.nodes.find((n) => n.stepId === "par")!;
    expect(trace.nodes.filter((n) => n.stepId !== "par").map((n) => n.parent)).toEqual([par.key, par.key]);
  });

  it("puts a parallel branch's nodes in their own frame, by the flow", () => {
    seq = 0;
    const steps = [
      {
        id: "par",
        type: "control.parallel",
        blocks: {
          a: [{ id: "ga", type: "control.group", blocks: { body: [{ id: "a1", type: "browser.click" }, { id: "a2", type: "browser.click" }] } }],
          b: [{ id: "gb", type: "control.group", blocks: { body: [{ id: "b1", type: "excel.readRows" }] } }],
        },
      },
    ] as never;
    const parentOf = (stepId: string, callPath: string[]) => {
      const inside = enclosing(steps, stepId);
      return inside === undefined ? undefined : inside === null ? null : { stepId: inside, callPath };
    };
    const trace = [
      started("par", "control.parallel", 0),
      started("ga", "control.group", 1),
      started("a1", "browser.click", 2),
      finished("a1", "browser.click", 3, 1),
      started("gb", "control.group", 4),
      started("a2", "browser.click", 5),
      started("b1", "excel.readRows", 6),
    ].reduce((t, e) => traceEvent(t, e, parentOf), emptyTrace());
    const parent = (id: string) => trace.nodes.find((n) => trace.nodes.find((m) => m.stepId === id)!.parent === n.key)?.stepId;
    expect(parent("gb")).toBe("par");
    expect(parent("a2")).toBe("ga");
    expect(parent("b1")).toBe("gb");
  });

  it("ends the nodes a stopped run left running", () => {
    seq = 0;
    const trace = [
      started("loop", "control.forEach", 0),
      started("click", "browser.click", 10),
      { runId: "r", seq: seq++, at: at(900), type: "runFinished", status: "cancelled", durationMs: 900 } as RunEventEnvelope,
    ].reduce((t, e) => traceEvent(t, e), emptyTrace());
    expect(trace.open).toEqual([]);
    expect(trace.nodes.map((n) => [n.outcome, n.stopped, n.durationMs])).toEqual([
      ["skipped", true, 900],
      ["skipped", true, 890],
    ]);
    const round = traceRows(trace.nodes, [], all).find((r) => r.kind === "round");
    expect(round).toMatchObject({ outcome: "skipped" });
  });

  it("filters to the flow's own lines or to the problems, with the rows leading to them", () => {
    seq = 0;
    const trace = play([
      started("note", "log.message", 0),
      finished("note", "log.message", 1, 1),
      started("read", "file.readCsv", 2),
      finished("read", "file.readCsv", 3, 1),
      started("grp", "control.group", 4),
      started("xl", "excel.writeRange", 5),
      finished("xl", "excel.writeRange", 6, 1),
      finished("grp", "control.group", 7, 3),
    ]);
    const key = (id: string) => trace.nodes.find((n) => n.stepId === id)!.key;
    const lines: TraceLine[] = [
      { seq: 100, at: at(1), level: "info", message: "3 件を処理します", node: key("note") },
      { seq: 101, at: at(3), level: "info", message: "3 行を読み込みました", node: key("read") },
      { seq: 102, at: at(6), level: "warn", message: "読み取り専用で開きました", node: key("xl") },
    ];
    const ids = (filter: "all" | "flow" | "problems") =>
      traceRows(trace.nodes, lines, all, filter).map((r) => (r.kind === "node" ? r.node.stepId : r.kind === "line" ? r.line.message : "round"));
    expect(ids("flow")).toEqual(["note", "3 件を処理します"]);
    expect(ids("problems")).toEqual(["grp", "xl", "読み取り専用で開きました"]);
    expect(ids("all")).toHaveLength(7);
    // A warning inside opens its frame when left alone.
    const auto = traceRows(trace.nodes, lines, (_id, a) => a);
    expect(auto.find((r) => r.kind === "node" && r.node.stepId === "grp")).toMatchObject({ problems: { errors: 0, warnings: 1 } });
    expect(auto.some((r) => r.kind === "node" && r.node.stepId === "xl")).toBe(true);
  });

  it("writes times the way the log shows them", () => {
    const units = { sec: "秒", min: "分" };
    expect(spanText(12, units)).toBe("0.01 秒");
    expect(spanText(650, units)).toBe("0.65 秒");
    expect(spanText(16_500, units)).toBe("16.5 秒");
    expect(spanText(65_000, units)).toBe("1 分 05 秒");
    expect(sinceText(3_400)).toBe("0:03");
    expect(sinceText(3_725_000)).toBe("1:02:05");
  });
});
