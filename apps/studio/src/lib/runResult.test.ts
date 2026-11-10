import type { Flow, RunEventEnvelope, RunReport, StepTypeDef, Touched } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { appOf, inputValues, insideFolder, originText, outputValues, placeRows, runCounts, writtenFiles } from "./runResult";

const touched = (over: Partial<Touched>): Touched => ({ target: "", stepTypes: ["files.copy"], stepId: "s", count: 1, at: "2026-11-10T08:00:00Z", ...over });

const report = (items: Touched[], outputs: Record<string, unknown> = {}): RunReport =>
  ({
    runId: "run_1",
    flowId: "scn_1",
    flowName: "売上まとめ",
    revision: 3,
    status: "succeeded",
    startedAt: "2026-11-10T08:00:00Z",
    finishedAt: "2026-11-10T08:00:08Z",
    outputs,
    touched: items,
  }) as RunReport;

const defs = new Map<string, StepTypeDef>([
  ["excel.write", { type: "excel.write", label: "Excel 書き込み" } as StepTypeDef],
  ["csv.read", { type: "csv.read", label: "CSV 読み取り" } as StepTypeDef],
]);

describe("placeRows", () => {
  it("lists changes first, says each place as a kind, and shows paths inside the flow's folder", () => {
    const rows = placeRows(
      report([
        touched({ target: "C:\\flows\\売上\\input\\大阪.csv", stepTypes: ["csv.read"], reads: true }),
        touched({ target: "C:\\flows\\売上\\output\\売上まとめ.xlsx", stepTypes: ["excel.write"], file: { size: 10, sha256: "ab" } }),
        touched({ target: "https://example.com/orders", stepTypes: ["browser.open"] }),
        touched({ target: "C:\\flows\\売上\\work\\old.csv", stepTypes: ["files.delete"], gone: true }),
        touched({ target: "keiri@example.com", stepTypes: ["mail.send"] }),
        touched({ target: '{"role":"button","name":"出荷"}', stepTypes: ["browser.click"], screen: true, count: 3 }),
      ]),
      defs,
      "C:\\Flows\\売上",
    );
    expect(rows.map((r) => [r.kind, r.shown])).toEqual([
      ["outputFile", "output/売上まとめ.xlsx"],
      ["deleted", "work/old.csv"],
      ["mail", "keiri@example.com"],
      ["site", "https://example.com/orders"],
      ["screen", "「出荷」ボタン"],
      ["inputFile", "input/大阪.csv"],
    ]);
    expect(rows[0]!.actions).toEqual(["Excel 書き込み"]);
    expect(writtenFiles(rows).map((r) => r.shown)).toEqual(["output/売上まとめ.xlsx"]);
  });

  it("keeps a place outside the flow's folder as the full path", () => {
    expect(insideFolder("\\\\server\\share\\a.xlsx", "C:\\flows\\x")).toBeNull();
    expect(insideFolder("C:/flows/x/output/a.xlsx", "C:\\flows\\x\\")).toBe("output/a.xlsx");
    expect(insideFolder("C:/flows/xy/a.xlsx", "C:\\flows\\x")).toBeNull();
  });
});

describe("appOf", () => {
  it("names the app a file opens in when the button can", () => {
    expect(appOf("output/売上.XLSX")).toBe("excel");
    expect(appOf("報告.docx")).toBe("word");
    expect(appOf("a.pdf")).toBe("pdf");
    expect(appOf("a.csv")).toBeNull();
  });
});

describe("originText", () => {
  it("says where a run was started from", () => {
    expect(originText({ trigger: "studio" })).toBe("Writer");
    expect(originText({ trigger: "studio", requestedBy: "runner" })).toBe("Runner");
    expect(originText({ trigger: "schedule", requestedBy: "毎朝" })).toBe("スケジュール「毎朝」");
    expect(originText({ trigger: "mcp", requestedBy: "claude-code" })).toBe("AI");
  });
});

describe("values", () => {
  const flow = {
    id: "scn_1",
    name: "売上",
    steps: [],
    variables: [
      { name: "month", type: "string", direction: "input", description: "集計する月" },
      { name: "total", type: "number", direction: "output" },
      { name: "tmp", type: "string" },
    ],
  } as unknown as Flow;

  it("reads the inputs the run started with, not later writes", () => {
    const events = [
      { seq: 1, type: "variableChanged", variable: "month", value: "2026-10" },
      { seq: 2, type: "variableChanged", variable: "tmp", value: "x" },
      { seq: 3, type: "stepStarted", stepId: "s1" },
      { seq: 4, type: "variableChanged", variable: "month", value: "changed", stepId: "s1" },
    ] as unknown as RunEventEnvelope[];
    expect(inputValues(flow, events).map((i) => [i.name, i.value])).toEqual([["month", "2026-10"]]);
  });

  it("lists the outputs in the flow's order", () => {
    expect(outputValues(flow, report([], { extra: 1, total: 73050 }))).toEqual([
      ["total", 73050],
      ["extra", 1],
    ]);
  });

  it("counts errors, warnings and the nodes that ran", () => {
    const events = [
      { type: "stepStarted", stepId: "a" },
      { type: "stepStarted", stepId: "a" },
      { type: "stepStarted", stepId: "b", callPath: ["c"] },
      { type: "log", level: "warn" },
      { type: "stepFinished", stepId: "b", outcome: "failed" },
    ] as unknown as RunEventEnvelope[];
    expect(runCounts(events)).toEqual({ errors: 1, warnings: 1, nodes: 2 });
  });
});
