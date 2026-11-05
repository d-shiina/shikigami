import type { HistoryEntry } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { headline, summarize } from "./review";

const entry = (revision: number, ops: HistoryEntry["ops"], inverse: HistoryEntry["inverse"] = []): HistoryEntry => ({
  kind: "edit",
  revision,
  actor: { kind: "mcp", name: "Claude Code" },
  at: "",
  label: "",
  ops,
  inverse,
});

describe("summarize", () => {
  it("nets out what a group of edits did", () => {
    const old = { id: "old", type: "log.message", params: { message: "hi" } };
    const s = summarize([
      entry(2, [{ op: "addStep", step: { id: "a", type: "log.message" } }]),
      entry(3, [{ op: "updateStep", stepId: "a", patch: { name: "x" } }]),
      entry(4, [{ op: "updateStep", stepId: "b", patch: { name: "y" } }]),
      entry(5, [{ op: "removeStep", stepId: "old" }], [{ op: "addStep", step: old }]),
      entry(6, [{ op: "addStep", step: { id: "tmp", type: "log.message" } }]),
      entry(7, [{ op: "removeStep", stepId: "tmp" }], [{ op: "addStep", step: { id: "tmp", type: "log.message" } }]),
    ]);
    expect([...s.steps]).toEqual([
      ["a", "added"],
      ["b", "changed"],
    ]);
    expect(s.removed).toEqual([old]);
    expect(headline(s)).toBe("1ノード追加・1ノード変更・1ノード削除");
  });
});

import { groupRevertBlocker } from "../store";

describe("summarize with generated ids", () => {
  it("finds the ids Core gave steps added without one", () => {
    const s = summarize([
      entry(
        2,
        [
          { op: "addStep", step: { type: "log.message" } },
          { op: "addStep", step: { type: "log.message" } },
        ],
        [
          { op: "removeStep", stepId: "stp_2" },
          { op: "removeStep", stepId: "stp_1" },
        ],
      ),
    ]);
    expect([...s.steps.keys()]).toEqual(["stp_1", "stp_2"]);
  });
});

describe("groupRevertBlocker", () => {
  it("allows reverting a group unless someone else changed the same step later", () => {
    const a = entry(2, [{ op: "updateStep", stepId: "a", patch: { name: "x" } }], [{ op: "updateStep", stepId: "a", patch: { name: "" } }]);
    const b = entry(3, [{ op: "updateStep", stepId: "a", patch: { name: "y" } }], [{ op: "updateStep", stepId: "a", patch: { name: "x" } }]);
    const other = { ...entry(4, [{ op: "updateStep", stepId: "a", patch: { name: "z" } }], [{ op: "updateStep", stepId: "a", patch: { name: "y" } }]), actor: { kind: "studio" as const } };
    expect(groupRevertBlocker([b, a], [a, b])).toBeNull();
    expect(groupRevertBlocker([b, a], [a, b, other])).not.toBeNull();
  });
});

import { changeCards, checksOf, digest, partDiff, purpose, stepBefore } from "./review";

describe("review cards", () => {
  const entries: HistoryEntry[] = [
    {
      ...entry(2, [{ op: "updateStep", stepId: "if", patch: { params: { condition: "amount >= limit && paid == false" } } }], [
        { op: "updateStep", stepId: "if", patch: { params: { condition: "amount >= limit" } } },
      ]),
      summary: "未払いの高額請求だけを要確認にする\n支払済も入っていたため",
      checks: ["一部入金も含めてよい？", ""].filter(Boolean),
      stepIds: ["if"],
    },
    {
      ...entry(3, [{ op: "addStep", step: { id: "log", type: "log.message", params: { message: "done" } } }]),
      summary: "完了を知らせる",
      checks: ["一部入金も含めてよい？", "基準額はこのまま？"],
      stepIds: ["log"],
    },
  ];
  const steps = [
    { id: "if", type: "control.if", params: { condition: "amount >= limit && paid == false" } },
    { id: "log", type: "log.message", params: { message: "done" } },
  ];

  it("takes the purpose from the first line of the oldest summary", () => {
    expect(purpose(entries, summarize(entries))).toBe("未払いの高額請求だけを要確認にする");
    expect(purpose([entry(2, [{ op: "addStep", step: { id: "x", type: "log.message" } }])], summarize([]))).toBe(headline(summarize([])));
  });

  it("collects the questions without repeats", () => {
    expect(checksOf(entries)).toEqual(["一部入金も含めてよい？", "基準額はこのまま？"]);
  });

  it("rebuilds a step as it was before the group", () => {
    expect(stepBefore(steps[0]!, [...entries].reverse()).params).toEqual({ condition: "amount >= limit" });
  });

  it("makes one card per changed step, marking edits after a send-back", () => {
    const cards = changeCards(entries, summarize(entries), steps, 2);
    expect(cards.map((c) => [c.stepId, c.kind, c.afterFeedback, c.said])).toEqual([
      ["if", "changed", false, ["未払いの高額請求だけを要確認にする\n支払済も入っていたため"]],
      ["log", "added", true, ["完了を知らせる"]],
    ]);
    expect(cards[0]?.before?.params).toEqual({ condition: "amount >= limit" });
  });

  it("marks the parts two sentences do not share", () => {
    const d = partDiff([{ text: "もし " }, { code: "a ≥ b" }], [{ text: "もし " }, { code: "a ≥ b かつ c" }]);
    expect(d).toEqual({ dropped: [false, true], added: [false, true] });
  });

  it("digests a test run: which changed steps it reached and what came out", () => {
    const at = "";
    const d = digest(
      {
        report: null,
        truncated: false,
        events: [
          { runId: "r", seq: 0, at, type: "stepStarted", stepId: "if", stepType: "control.if", attempt: 1 },
          { runId: "r", seq: 1, at, type: "log", level: "info", message: "要確認 3 件" },
          { runId: "r", seq: 2, at, type: "stepStarted", stepId: "log", stepType: "log.message", attempt: 1, callPath: ["call"] },
        ],
      },
      ["if", "log"],
    );
    expect(d).toMatchObject({ covered: 1, total: 2, missed: ["log"], logs: ["要確認 3 件"] });
  });
});

import { wordDiff } from "./review";

describe("wordDiff", () => {
  it("marks only the words an expression gained", () => {
    const marked = wordDiff("a ≥ b かつ c ≠ 'x'", "a ≥ b").filter((w) => w.changed).map((w) => w.text);
    expect(marked).toEqual(["かつ", "c", "≠", "'x'"]);
  });
});

describe("replaceSteps", () => {
  it("diffs the replaced tree against the one the inverse restores", () => {
    const old = [
      { id: "a", type: "log.message", params: { message: "hi" } },
      { id: "b", type: "log.message", params: { message: "keep" } },
      { id: "gone", type: "file.delete", params: { path: "x" } },
    ];
    const next = [
      { id: "a", type: "log.message", params: { message: "hello" } },
      { id: "b", type: "log.message", params: { message: "keep" } },
      { id: "new", type: "log.message", params: { message: "added" } },
    ];
    const entries = [entry(2, [{ op: "replaceSteps", steps: next }], [{ op: "replaceSteps", steps: old }])];
    const s = summarize(entries);
    expect([...s.steps]).toEqual([
      ["a", "changed"],
      ["new", "added"],
    ]);
    expect(s.removed.map((r) => r.id)).toEqual(["gone"]);
    expect(stepBefore(next[0]!, entries).params).toEqual({ message: "hi" });
  });

  it("does not judge coverage from a cut-short run record", () => {
    expect(digest({ report: null, truncated: true, events: [] }, ["a"])).toMatchObject({ partial: true, missed: [], covered: 0 });
  });
});
