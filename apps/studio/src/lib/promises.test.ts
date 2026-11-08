import type { Evidence } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { promiseCounts, promisesOf, promiseTerms } from "./promises";

const actor = { kind: "mcp" as const, name: "Claude Code" };
const cases = [
  { name: "合計", case: { description: "3 支店分で 73,050 円になる", inputs: { folder: "tests/3支店" }, expect: { outputs: { grandTotal: 73050 } } } },
  { name: "返品", case: { description: "返品の行は合計に入れない", inputs: { folder: "tests/返品" }, expect: { outputs: { grandTotal: 100 } } } },
  { name: "フォルダーが無い", case: { inputs: { folder: "無い" }, expect: { status: "failed" as const, errorCode: "FILE_NOT_FOUND" } } },
];

describe("promisesOf", () => {
  it("puts the promises of this change first, each with its newest result", () => {
    const evidence: Evidence[] = [
      { revision: 4, at: "2026-11-08T01:00:00Z", actor, kind: "testCase", name: "返品" },
      { revision: 5, at: "2026-11-08T01:01:00Z", actor, kind: "testCases", results: [
        { name: "返品", passed: false, runId: "run_1", status: "succeeded", mismatches: [{ at: "outputs.grandTotal", expected: 100, actual: 130 }] },
        { name: "合計", passed: true, runId: "run_2", status: "succeeded" },
      ] },
    ];
    const list = promisesOf(cases, evidence, 6);
    expect(list.map((p) => [p.name, p.fresh])).toEqual([
      ["返品", true],
      ["合計", false],
      ["フォルダーが無い", false],
    ]);
    expect(list[0]!.text).toBe("返品の行は合計に入れない");
    expect(list[0]!.kept).toMatchObject({ passed: false, by: "ai", stale: true });
    expect(list[2]!.text).toBe("フォルダーが無い");
    expect(list[2]!.kept).toBeNull();
    expect(promiseCounts(list)).toEqual({ broken: 1, unchecked: 3 });

    // Run again from the review on the current content.
    const after = promisesOf(cases, evidence, 6, {
      revision: 6,
      at: "2026-11-08T02:00:00Z",
      results: [{ name: "返品", passed: true, runId: "run_3", status: "succeeded", mismatches: [], durationMs: 10 }],
    });
    expect(after[0]!.kept).toMatchObject({ passed: true, by: "studio", stale: false });
  });
});

describe("promisesOf with a rewritten case", () => {
  it("drops a result from before the case was saved again", () => {
    const evidence: Evidence[] = [
      { revision: 5, at: "2026-11-08T01:00:00Z", actor, kind: "testCases", results: [{ name: "合計", passed: true, runId: "run_1", status: "succeeded" }] },
      { revision: 5, at: "2026-11-08T01:05:00Z", actor, kind: "testCase", name: "合計", replaced: true },
    ];
    const [first] = promisesOf(cases, evidence, 5);
    expect(first).toMatchObject({ name: "合計", fresh: true, replaced: true, kept: null });
    // Also a run from the review before the rewrite.
    const [again] = promisesOf(cases, evidence, 5, {
      revision: 5,
      at: "2026-11-08T01:02:00Z",
      results: [{ name: "合計", passed: true, runId: "run_2", status: "succeeded", mismatches: [], durationMs: 1 }],
    });
    expect(again!.kept).toBeNull();
  });
});

describe("promiseTerms", () => {
  it("says the input and the expected result in one line each", () => {
    expect(promiseTerms(cases[0]!.case)).toEqual({ given: "folder ＝ 「tests/3支店」", then: "grandTotal ＝ 73050" });
    expect(promiseTerms(cases[2]!.case).then).toBe("エラーで止まる");
    expect(promiseTerms({}).given).toBeNull();
  });
});
