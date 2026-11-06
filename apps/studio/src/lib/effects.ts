// What a flow does outside itself (sites it opens, files it reads, writes
// or deletes, mail, commands, other apps), read from the step types' risk
// levels and path params, and which of those a review group adds, changes or
// removes. Display only: nothing here decides whether a step may run.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { stepLabel } from "./i18n";
import type { StepDiff } from "./review";
import { flatten } from "./review";

export type EffectStatus = "added" | "changed" | "removed" | "same";

export type Effect = {
  stepId: string;
  /** The step type's label, e.g. "ファイルを削除". */
  action: string;
  /** The file, folder, URL or command it acts on, as written in the flow. */
  target: string;
  risk: StepTypeDef["risk"];
  /** Only reads (risk "safe"). */
  reads: boolean;
  status: EffectStatus;
};

/** Steps that only move around inside a window or ask the person: not effects outside. */
const INSIDE = /^(browser\.(?!(?:open|attach|download|upload)$)|desktop\.(?!launch$)|dialog\.|clipboard\.|control\.|variable\.|log\.|flow\.|wait\.|flow\.call$|config\.read$)/;

const TARGET_PARAMS = ["url", "command", "program", "path", "to"];

function targetOf(step: Step, def: StepTypeDef | undefined): string | null {
  const params = step.params ?? {};
  for (const key of [...(def?.pathParams ?? []), ...TARGET_PARAMS]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0) return value.filter((v) => typeof v === "string").join(", ");
  }
  return null;
}

/** One effect for a step that touches something outside, or null. */
export function effectOf(step: Step, def: StepTypeDef | undefined, status: EffectStatus): Effect | null {
  if (INSIDE.test(step.type)) return null;
  const target = targetOf(step, def);
  const risk = def?.risk ?? "interactive";
  if (risk === "safe" && !target) return null;
  return {
    stepId: step.id ?? "",
    action: stepLabel(step.type, def?.label),
    target: target ?? "",
    risk,
    reads: risk === "safe",
    status,
  };
}

/**
 * The flow's effects, with the group's changes marked. Dangerous ones
 * come first, then new, changed and removed ones, then the rest; an effect
 * that several steps have in common is listed once.
 */
export function effects(
  steps: Step[],
  changed: ReadonlyMap<string, StepDiff>,
  removed: Step[],
  defs: ReadonlyMap<string, StepTypeDef>,
  /** The step as it was before the group, to tell a changed target from an unchanged one. */
  before: (step: Step) => Step | null = () => null,
): Effect[] {
  const all: Effect[] = [];
  for (const step of flatten(steps)) {
    const def = defs.get(step.type);
    const diff = changed.get(step.id ?? "");
    let status: EffectStatus = diff ?? "same";
    if (diff === "changed") {
      const old = before(step);
      const was = old ? effectOf(old, def, "same") : null;
      const now = effectOf(step, def, "same");
      // Same target and same params (only the name or settings changed): nothing changes outside.
      if (was && now && was.target === now.target && JSON.stringify(old?.params ?? {}) === JSON.stringify(step.params ?? {})) status = "same";
      else if (was && !now) {
        all.push({ ...was, status: "removed" });
        continue;
      }
    }
    const effect = effectOf(step, def, status);
    if (effect) all.push(effect);
  }
  for (const step of removed) {
    const effect = effectOf(step, defs.get(step.type), "removed");
    if (effect) all.push(effect);
  }
  const seen = new Set<string>();
  const unique = all.filter((e) => {
    const key = `${e.status}\u0000${e.action}\u0000${e.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const order = (e: Effect) => (e.status === "same" ? 10 : 0) + (e.risk === "dangerous" ? 0 : e.reads ? 2 : 1);
  return unique.sort((a, b) => order(a) - order(b));
}
