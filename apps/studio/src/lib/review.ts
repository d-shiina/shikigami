// What a group of unreviewed AI edits did to a scenario, for the review desk:
// which steps were added, changed or removed, read straight from the ops and
// inverse ops Core recorded. Display only.
import type { HistoryEntry, Step } from "@shikigami/schema";
import { t } from "./i18n";

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
    const generated = generatedIds(entry);
    for (const op of entry.ops ?? []) {
      const added = op.op === "addStep" ? (op.step.id ?? generated.shift()) : undefined;
      if (added) {
        steps.set(added, "added");
        removed.delete(added);
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

/**
 * Ids Core generated for steps an entry added without one. The journal keeps
 * the ops as sent, so only the inverse `removeStep`s carry them; the inverse
 * runs newest first, hence the reversal.
 */
function generatedIds(entry: HistoryEntry): string[] {
  const given = new Set((entry.ops ?? []).flatMap((op) => (op.op === "addStep" && op.step.id ? [op.step.id] : [])));
  return (entry.inverse ?? [])
    .flatMap((op) => (op.op === "removeStep" && !given.has(op.stepId) ? [op.stepId] : []))
    .reverse();
}

/** "3手順追加・1変更" — what the group did, in a few words. */
export function headline(summary: ReviewSummary): string {
  const count = (d: StepDiff) => [...summary.steps.values()].filter((v) => v === d).length;
  const parts = [
    count("added") && t.headline.added(count("added")),
    count("changed") && t.headline.changed(count("changed")),
    summary.removed.length && t.headline.removed(summary.removed.length),
    summary.variables && t.headline.variables(summary.variables),
    summary.scenario && t.headline.scenario,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(t.headline.sep) : t.headline.none;
}
