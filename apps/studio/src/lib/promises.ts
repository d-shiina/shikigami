// 「こうなれば正しい」: the flow's test cases read as promises. An AI writes
// one per behaviour it adds or changes (the case's description says it in
// business words); the person judges whether each promise is right, and the
// case's last run says whether the flow keeps it.
import type { CaseResult, Evidence, Mismatch, TestCase } from "@spellsheet/schema";
import { create } from "zustand";
import { shortValue } from "./testCases";
import { locale, t } from "./i18n";

export type Kept = {
  passed: boolean;
  mismatches: Mismatch[];
  /** Who ran it: the AI over MCP, or the person from the review. */
  by: "ai" | "studio";
  /** The run checked an older revision than the one under review. */
  stale: boolean;
  runId: string;
};

export type Promised = {
  name: string;
  /** What should hold, in words: the case's description, else its name. */
  text: string;
  testCase: TestCase;
  /** The AI wrote or rewrote it during the changes under review. */
  fresh: boolean;
  replaced: boolean;
  kept: Kept | null;
};

/** Results of the promises run from the review this session, by flow. */
export const useChecked = create<Record<string, { revision: number; at: string; results: CaseResult[] }>>(() => ({}));

/**
 * The flow's promises: the ones written in the changes under review first,
 * then the ones kept from before, each with its newest result.
 * `evidence` is the review's (test cases the AI saved and ran);
 * `checked` is what the person ran here, if anything.
 */
export function promisesOf(
  cases: { name: string; case: TestCase }[],
  evidence: Evidence[],
  revision: number,
  checked?: { revision: number; at: string; results: CaseResult[] },
): Promised[] {
  const fresh = new Map<string, boolean>();
  // When each case was last saved: a result from before that tested other expectations.
  const savedAt = new Map<string, number>();
  const results = new Map<string, { at: number; kept: Kept }>();
  const time = (at: string) => Date.parse(at);
  for (const e of evidence) {
    if (e.kind === "testCase") {
      fresh.set(e.name, (fresh.get(e.name) ?? false) || Boolean(e.replaced));
      savedAt.set(e.name, time(e.at));
    }
    if (e.kind === "testCases") {
      for (const r of e.results) {
        results.set(r.name, { at: time(e.at), kept: { passed: r.passed, mismatches: r.mismatches ?? [], by: "ai", stale: e.revision !== revision, runId: r.runId } });
      }
    }
  }
  if (checked) {
    for (const r of checked.results) {
      const prior = results.get(r.name);
      if (prior && prior.at > time(checked.at)) continue;
      results.set(r.name, { at: time(checked.at), kept: { passed: r.passed, mismatches: r.mismatches, by: "studio", stale: checked.revision !== revision, runId: r.runId } });
    }
  }
  for (const [name, at] of savedAt) {
    const result = results.get(name);
    if (result && result.at < at) results.delete(name);
  }
  const all = cases.map(({ name, case: testCase }) => ({
    name,
    text: testCase.description?.trim() || name,
    testCase,
    fresh: fresh.has(name),
    replaced: fresh.get(name) ?? false,
    kept: results.get(name)?.kept ?? null,
  }));
  return [...all.filter((p) => p.fresh), ...all.filter((p) => !p.fresh)];
}

/** 「入力」 and 「結果」 of a promise in one line each, for the person to check the numbers. */
export function promiseTerms(
  testCase: TestCase,
  /** What each variable is, by name (its description): a person reads "読んだ支店の数", not "branchCount". */
  labels: ReadonlyMap<string, string> = new Map(),
): { given: string | null; then: string } {
  const term = ([k, v]: [string, unknown]) => `${labels.get(k) ?? k} ＝ ${typeof v === "number" ? v.toLocaleString(locale === "ja" ? "ja-JP" : "en-US") : shortValue(v, 40)}`;
  const inputs = Object.entries(testCase.inputs ?? {});
  const given = inputs.length > 0 ? inputs.map(term).join("、") : null;
  const expect = testCase.expect ?? {};
  const status = expect.status ?? "succeeded";
  const outputs = Object.entries(expect.outputs ?? {}).map(term);
  let then: string;
  if (status === "failed") then = t.promises.stops;
  else if (status === "cancelled") then = t.promises.cancelled;
  else then = outputs.length > 0 ? outputs.join("、") : t.promises.finishes;
  if (status === "failed" && outputs.length > 0) then = `${then}（${outputs.join("、")}）`;
  return { given, then };
}

/** How the promises stand, for the button and the list's heading. */
export function promiseCounts(promises: Promised[]): { broken: number; unchecked: number } {
  return {
    broken: promises.filter((p) => p.kept && !p.kept.passed).length,
    unchecked: promises.filter((p) => !p.kept || p.kept.stale).length,
  };
}
