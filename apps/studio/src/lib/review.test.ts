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
    expect(headline(s)).toBe("1手順追加・1手順変更・1手順削除");
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
