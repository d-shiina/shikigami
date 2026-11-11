import type { Step, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { FAIL_LANE, layoutChart } from "./chart";

const def = (type: string, category: string): [string, StepTypeDef] => [type, { type, category, label: type } as unknown as StepTypeDef];
const defs = new Map([
  def("browser.click", "browser"),
  def("excel.appendRows", "office"),
  def("variable.set", "variable"),
  def("desktop.launch", "windows"),
  def("desktop.click", "windows"),
  def("control.forEach", "control"),
  def("control.if", "control"),
  def("control.continue", "control"),
  def("control.try", "control"),
  def("control.fail", "control"),
  def("control.parallel", "control"),
]);
let n = 0;
const s = (type: string, blocks?: Record<string, Step[]>): Step => ({ id: `s${++n}`, type, params: {}, ...(blocks ? { blocks } : {}) }) as Step;

describe("layoutChart", () => {
  it("gives each app a column, in the order the flow first touches it", () => {
    const chart = layoutChart([s("browser.click"), s("variable.set"), s("excel.appendRows"), s("browser.click")], defs);
    expect(chart.lanes.map((l) => l.key)).toEqual(["browser", "excel"]);
    // Work on nothing outside stays where the line is, as a tag.
    expect(chart.rows.map((r) => [r.lane, r.kind === "step" && r.quiet])).toEqual([
      [0, false],
      [0, true],
      [1, false],
      [0, false],
    ]);
    expect(chart.links).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);
  });

  it("draws an if whose one side only stops as a guard, with the other side on the line", () => {
    const chart = layoutChart(
      [s("control.forEach", { body: [s("control.if", { then: [s("control.continue")], else: [s("excel.appendRows")] })] })],
      defs,
    );
    expect(chart.rows.map((r) => r.kind)).toEqual(["head", "guard", "step"]);
    expect(chart.bands).toHaveLength(1);
    expect(chart.bands[0]).toMatchObject({ kind: "loop", inner: 0 });
  });

  it("draws an if with work on a side as a band for that answer", () => {
    const chart = layoutChart([s("control.if", { then: [s("browser.click"), s("browser.click")], else: [] })], defs);
    expect(chart.rows[0]).toMatchObject({ kind: "head", band: "when", block: "then" });
    expect(chart.bands.map((b) => b.kind)).toEqual(["when"]);
  });

  it("draws no way to a catch whose steps are all switched off", () => {
    const chart = layoutChart([s("control.try", { try: [s("browser.click")], catch: [{ ...s("log.message"), disabled: true }] })], defs);
    expect(chart.brackets).toEqual([]);
    expect(chart.failLane).toBeNull();
    expect(chart.rows).toHaveLength(1);
  });

  it("stands what runs on failure in a column of its own, beside the rows it covers", () => {
    const chart = layoutChart([s("control.try", { try: [s("browser.click"), s("browser.click")], catch: [s("control.fail")], finally: [s("browser.click")] })], defs);
    expect(chart.lanes.at(-1)?.key).toBe(FAIL_LANE);
    expect(chart.brackets).toHaveLength(1);
    const caught = chart.rows[chart.brackets[0]!.to]!;
    expect(caught).toMatchObject({ kind: "stop", lane: chart.failLane, y: chart.rows[0]!.y });
    expect(chart.rows.at(-2)).toMatchObject({ kind: "head", band: "always" });
  });

  it("runs branches side by side from a bar to a bar, beside each other where they share a column", () => {
    const chart = layoutChart(
      [s("browser.click"), s("control.parallel", { branches: [s("browser.click"), s("browser.click"), s("excel.appendRows")] }), s("excel.appendRows")],
      defs,
    );
    expect(chart.rows.map((r) => r.kind)).toEqual(["step", "head", "bar", "step", "step", "step", "bar", "step"]);
    const [a, b, c] = [chart.rows[3]!, chart.rows[4]!, chart.rows[5]!];
    // They start at the same height.
    expect(new Set([a.y, b.y, c.y]).size).toBe(1);
    expect([a.lane, a.off, b.lane, b.off, c.lane, c.off]).toEqual([0, 0, 0, 1, 1, 0]);
    expect(chart.lanes.map((l) => l.cols)).toEqual([2, 1]);
    // What follows waits for them all: each goes into the bar, and the bar goes on.
    expect(chart.links.filter((l) => l.to === 6).map((l) => l.from)).toEqual([3, 4, 5]);
  });

  it("gives each window of a desktop app a column, with the program's steps in its first window", () => {
    const on = (window: Record<string, string>): Step => ({ ...s("desktop.click"), params: { target: { window, element: { id: "ok" } } } }) as Step;
    const chart = layoutChart(
      [
        { ...s("desktop.launch"), params: { path: "C:\\Program Files\\Hanbai\\hanbai.exe" } } as Step,
        on({ title: "販売管理", process: "hanbai.exe" }),
        on({ title: "登録しました", process: "hanbai.exe" }),
        on({ process: "HANBAI.EXE" }),
        // A part of the flow names no window: it stays where the step before it worked.
        { ...s("desktop.click"), params: { target: { part: "save" } } } as Step,
      ],
      defs,
    );
    expect(chart.lanes.map((l) => [l.group, l.name])).toEqual([
      ["windows", "販売管理"],
      ["windows", "登録しました"],
    ]);
    expect(chart.rows.map((r) => r.lane)).toEqual([0, 0, 1, 0, 0]);
  });
});
