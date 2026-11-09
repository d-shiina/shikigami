import type { DistributedFlow, DistributionView } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { fresh } from "./Distribution";

const flow = (state: DistributedFlow["state"]): DistributedFlow => ({
  flowId: `flw_${state}`,
  name: state,
  version: { number: 2, uid: "u", name: "v2" },
  exportedAt: "2026-11-09T00:00:00Z",
  path: `\\\\fs01\\x\\${state}.spx`,
  state,
});

const view = (name: string, flows: DistributedFlow[], error?: string): DistributionView => ({
  folder: { name, path: `\\\\fs01\\${name}` },
  flows,
  checkedAt: "2026-11-09T00:00:00Z",
  ...(error ? { error } : {}),
});

describe("fresh", () => {
  it("counts only what is new here or newer than this PC's version", () => {
    expect(fresh([view("経理課", [flow("new"), flow("update"), flow("latest"), flow("older")]), view("総務課", [flow("latest")])])).toEqual([{ folder: "経理課", count: 2 }]);
  });

  it("says nothing before looking or for a folder that cannot be opened", () => {
    expect(fresh(null)).toEqual([]);
    expect(fresh([view("経理課", [], "not found")])).toEqual([]);
  });
});
