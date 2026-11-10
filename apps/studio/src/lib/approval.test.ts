import { describe, expect, it } from "vitest";
import { clientName, fillTarget, inputRows, minutesLeft, readSubject } from "./approval";

const flow = {
  variables: [
    { name: "orderFile", type: "string", direction: "input", default: "input/orders.xlsx", description: "受注一覧の Excel" },
    { name: "month", type: "string", direction: "input", default: "2026年10月" },
    { name: "total", type: "number", direction: "output", default: 0 },
    { name: "rows", type: "array", default: [] },
  ],
} as const;

describe("clientName", () => {
  it("names known AI clients as people know them", () => {
    expect(clientName("claude-code")).toBe("Claude Code");
    expect(clientName("codex-mcp-client")).toBe("Codex");
  });
  it("keeps an unknown name and gives nothing for none", () => {
    expect(clientName("my-agent")).toBe("my-agent");
    expect(clientName(null)).toBeNull();
  });
});

describe("inputRows", () => {
  it("lists the flow's inputs in order, with the given value or else the default", () => {
    const rows = inputRows(flow as never, { month: "2026年11月" });
    expect(rows).toEqual([
      { name: "orderFile", label: "受注一覧の Excel", value: "input/orders.xlsx", given: false },
      { name: "month", label: null, value: "2026年11月", given: true },
    ]);
  });
  it("adds values the flow does not declare", () => {
    const rows = inputRows(flow as never, { extra: 1 });
    expect(rows.at(-1)).toEqual({ name: "extra", label: null, value: 1, given: true });
  });
  it("lists what was given when there is no flow", () => {
    expect(inputRows(null, { a: "x" })).toEqual([{ name: "a", label: null, value: "x", given: true }]);
    expect(inputRows(null, null)).toEqual([]);
  });
});

describe("readSubject", () => {
  it("reads a run", () => {
    const s = readSubject({
      subject: { flowId: "f", published: true, inputs: { a: 1 }, flows: [{ id: "scn_sub", revision: 2 }] },
    });
    expect(s.published).toBe(true);
    expect(s.inputs).toEqual({ a: 1 });
    expect(s.calledIds).toEqual(["scn_sub"]);
    expect(s.step).toBeNull();
  });
  it("reads test cases and a tested node", () => {
    expect(readSubject({ subject: { testCases: [{ name: "ok", inputs: { a: 1 } }] } }).testCases).toEqual([
      { name: "ok", inputs: { a: 1 } },
    ]);
    const s = readSubject({ subject: { step: { id: "s1", type: "file.delete", params: { path: "x" } }, variables: { v: 1 } } });
    expect(s.step?.type).toBe("file.delete");
    expect(s.variables).toEqual({ v: 1 });
  });
  it("does not fail on an unexpected subject", () => {
    expect(readSubject({ subject: "odd" }).testCases).toEqual([]);
  });
});

describe("fillTarget", () => {
  const rows = inputRows(flow as never, { orderFile: "input/受注_10月.xlsx" });
  it("puts the run's values in plain references", () => {
    expect(fillTarget("{{ orderFile }}", rows)).toBe("input/受注_10月.xlsx");
    expect(fillTarget("output/{{month}}.xlsx", rows)).toBe("output/2026年10月.xlsx");
  });
  it("leaves expressions and unknown names as written", () => {
    expect(fillTarget("{{ dirName(orderFile) }}", rows)).toBe("{{ dirName(orderFile) }}");
    expect(fillTarget("{{ other }}", rows)).toBe("{{ other }}");
  });
});

describe("minutesLeft", () => {
  it("counts down from 30 minutes and stops at 0", () => {
    const at = "2026-11-10T00:00:00Z";
    expect(minutesLeft(at, Date.parse("2026-11-10T00:00:30Z"))).toBe(30);
    expect(minutesLeft(at, Date.parse("2026-11-10T00:29:10Z"))).toBe(1);
    expect(minutesLeft(at, Date.parse("2026-11-10T01:00:00Z"))).toBe(0);
  });
});
