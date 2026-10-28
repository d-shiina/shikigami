import type { HistoryEntry } from "@shikigami/schema";
import { describe as suite, expect, it } from "vitest";
import { describe } from "./changes";

suite("describe", () => {
  it("pairs each op with its own inverse when a batch updates one step twice", () => {
    const entry: HistoryEntry = {
      kind: "edit",
      revision: 2,
      actor: { kind: "mcp" },
      at: "2026-10-28T00:00:00Z",
      label: "2 edits",
      ops: [
        { op: "updateStep", stepId: "s", patch: { params: { message: "B" } } },
        { op: "updateStep", stepId: "s", patch: { params: { message: "C" } } },
      ],
      // Core stores inverses in reverse order.
      inverse: [
        { op: "updateStep", stepId: "s", patch: { replaceParams: { message: "B" } } },
        { op: "updateStep", stepId: "s", patch: { replaceParams: { message: "A" } } },
      ],
    };
    const lines = describe(entry, null, new Map());
    expect(lines.map((l) => l.diffs[0])).toEqual([
      { field: "message", before: "A", after: "B" },
      { field: "message", before: "B", after: "C" },
    ]);
  });
});
