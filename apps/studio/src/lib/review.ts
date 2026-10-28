// What a group of unreviewed AI edits did to a scenario, for the review desk:
// which steps were added, changed or removed, read straight from the ops and
// inverse ops Core recorded. Display only.
import type { HistoryEntry, Step } from "@shikigami/schema";

export type StepDiff = "added" | "changed";

export type ReviewSummary = {
  /** Step id → how the group changed it; steps it added win over later changes. */
  steps: Map<string, StepDiff>;
  /** Steps the group removed that it had not added itself, as they were. */
  removed: Step[];
  variables: number;
  scenario: boolean;
};

/** `entries` oldest first. */
export function summarize(entries: HistoryEntry[]): ReviewSummary {
  const steps = new Map<string, StepDiff>();
  const removed = new Map<string, Step>();
  const vars = new Set<string>();
  let scenario = false;
  for (const entry of entries) {
    for (const op of entry.ops ?? []) {
      if (op.op === "addStep" && op.step.id) {
        steps.set(op.step.id, "added");
        removed.delete(op.step.id);
      } else if (op.op === "updateStep" || op.op === "moveStep") {
        if (!steps.has(op.stepId)) steps.set(op.stepId, "changed");
      } else if (op.op === "removeStep") {
        const wasAdded = steps.get(op.stepId) === "added";
        steps.delete(op.stepId);
        const before = entry.inverse?.find((i) => i.op === "addStep" && i.step.id === op.stepId);
        if (!wasAdded && before?.op === "addStep") removed.set(op.stepId, before.step);
      } else if (op.op === "setVariable") vars.add(op.variable.name);
      else if (op.op === "removeVariable") vars.add(op.name);
      else if (op.op === "updateScenario") scenario = true;
    }
  }
  return { steps, removed: [...removed.values()], variables: vars.size, scenario };
}

/** "3手順追加・1変更" — what the group did, in a few words. */
export function headline(summary: ReviewSummary): string {
  const count = (d: StepDiff) => [...summary.steps.values()].filter((v) => v === d).length;
  const parts = [
    count("added") && `${count("added")}手順追加`,
    count("changed") && `${count("changed")}手順変更`,
    summary.removed.length && `${summary.removed.length}手順削除`,
    summary.variables && `変数${summary.variables}つ`,
    summary.scenario && "シナリオ設定",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("・") : "変更";
}
