// Turns Core's journal entries into readable Japanese lines for the timeline
// and the review cards. Display only: before/after values come straight from
// the ops and inverse ops Core recorded, nothing is recomputed here.
import type { EditOp, HistoryEntry, Scenario, StepPatch, StepTypeDef } from "@shikigami/schema";
import { findStep } from "../store";
import { t } from "./i18n";

export type FieldDiff = { field: string; before: unknown; after: unknown };

export type ChangeLine = {
  verb: "add" | "update" | "remove" | "move" | "scenario" | "variable" | "replace";
  stepId?: string;
  subject: string;
  diffs: FieldDiff[];
};

const FIELD_LABEL: Record<string, string> = {
  name: t.stepName,
  description: "説明",
  disabled: t.disabled,
  timeoutMs: t.timeoutMs,
  retry: t.retry,
  onError: t.onError,
  saveAs: t.saveAs,
};

const VERB_LABEL: Record<ChangeLine["verb"], string> = {
  add: "追加",
  update: "変更",
  remove: "削除",
  move: "移動",
  scenario: "シナリオ",
  variable: "変数",
  replace: "置換",
};

export const verbLabel = (verb: ChangeLine["verb"]) => VERB_LABEL[verb];

export function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "（なし）";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function patchDiffs(patch: StepPatch, inverse: StepPatch | undefined): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const after = { ...(patch.replaceParams ?? {}), ...(patch.params ?? {}) };
  const before = { ...(inverse?.replaceParams ?? {}), ...(inverse?.params ?? {}) };
  // A merge patch (`params`) only touches its own keys; a replacement touches all.
  const keys = patch.replaceParams ? [...Object.keys(after), ...Object.keys(before)] : Object.keys(after);
  for (const key of new Set(keys)) {
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
      diffs.push({ field: key, before: before[key], after: after[key] });
    }
  }
  for (const key of Object.keys(FIELD_LABEL) as (keyof StepPatch)[]) {
    if (key in patch) diffs.push({ field: FIELD_LABEL[key] ?? key, before: inverse?.[key], after: patch[key] });
  }
  return diffs;
}

/** Name to show for a step: its display name, else its type label. */
function stepName(id: string, scenario: Scenario | null, defs: ReadonlyMap<string, StepTypeDef>, fallback?: EditOp) {
  const step = scenario ? findStep(scenario.steps ?? [], id) : null;
  if (step) return step.name || defs.get(step.type)?.label || step.type;
  if (fallback?.op === "addStep") return fallback.step.name || defs.get(fallback.step.type)?.label || fallback.step.type;
  return id;
}

export function describe(
  entry: HistoryEntry,
  scenario: Scenario | null,
  defs: ReadonlyMap<string, StepTypeDef>,
): ChangeLine[] {
  const inverse = entry.inverse ?? [];
  return (entry.ops ?? []).map((op, index): ChangeLine => {
    // Core records one inverse per op, in reverse order.
    const paired = inverse.length === (entry.ops ?? []).length ? inverse[inverse.length - 1 - index] : undefined;
    switch (op.op) {
      case "addStep":
        return {
          verb: "add",
          stepId: op.step.id ?? undefined,
          subject: op.step.name || defs.get(op.step.type)?.label || op.step.type,
          diffs: Object.entries(op.step.params ?? {}).map(([field, after]) => ({ field, before: undefined, after })),
        };
      case "updateStep": {
        const inv = paired ?? inverse.find((i) => i.op === "updateStep" && i.stepId === op.stepId);
        return {
          verb: "update",
          stepId: op.stepId,
          subject: stepName(op.stepId, scenario, defs),
          diffs: patchDiffs(op.patch, inv?.op === "updateStep" ? inv.patch : undefined),
        };
      }
      case "removeStep": {
        const restored = paired ?? inverse.find((i) => i.op === "addStep" && i.step.id === op.stepId);
        return { verb: "remove", subject: stepName(op.stepId, scenario, defs, restored), diffs: [] };
      }
      case "moveStep":
        return { verb: "move", stepId: op.stepId, subject: stepName(op.stepId, scenario, defs), diffs: [] };
      case "updateScenario":
        return {
          verb: "scenario",
          subject: op.patch.name ?? scenario?.name ?? "",
          diffs: Object.entries(op.patch).map(([field, after]) => ({ field, before: undefined, after })),
        };
      case "setVariable":
        return {
          verb: "variable",
          subject: op.variable.name,
          diffs: [{ field: t.defaultValue, before: undefined, after: op.variable.default }],
        };
      case "removeVariable":
        return { verb: "remove", subject: `${t.variables} ${op.name}`, diffs: [] };
      case "replaceSteps":
        return { verb: "replace", subject: `${op.steps.length} ステップ`, diffs: [] };
    }
  });
}

/** Who made a change, for the avatar and the line header. */
export function actorLabel(entry: HistoryEntry): string {
  if (entry.actor.kind === "mcp" && entry.actor.name) return entry.actor.name;
  return t.actor[entry.actor.kind];
}

export function relativeTime(at: string, now = Date.now()): string {
  const diff = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (diff < 60) return "たった今";
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return at.slice(5, 16).replace("T", " ");
}
