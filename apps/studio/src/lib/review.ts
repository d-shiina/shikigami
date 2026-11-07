// What a group of unreviewed AI edits did to a flow, for the review desk:
// which steps were added, changed or removed, read straight from the ops and
// inverse ops Core recorded. Display only.
import type { HistoryEntry, Step, StepPatch } from "@shikigami/schema";
import type { RunRecord } from "./api";
import type { Part } from "./sentence";
import { t } from "./i18n";

export type StepDiff = "added" | "changed";

export type ReviewSummary = {
  /** Step id → how the group changed it; steps it added win over later changes. */
  steps: Map<string, StepDiff>;
  /** Steps the group removed that it had not added itself, as they were. */
  removed: Step[];
  variables: number;
  flow: boolean;
  /** The group made the flow: every step it has now counts as added. */
  created: boolean;
};

/**
 * `entries` oldest first. `current` is the flow's steps now: a `create` entry
 * records no ops (the flow arrived whole), so its steps are read from there.
 */
export function summarize(entries: HistoryEntry[], current: Step[] = []): ReviewSummary {
  const steps = new Map<string, StepDiff>();
  const removed = new Map<string, Step>();
  const vars = new Set<string>();
  let flow = false;
  let created = false;
  for (const entry of entries) {
    if (entry.kind === "create") {
      created = true;
      for (const step of flatten(current)) if (step.id) steps.set(step.id, "added");
      continue;
    }
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
      else if (op.op === "updateFlow") flow = true;
      else if (op.op === "replaceSteps") {
        // The whole tree at once: compare it with the tree the inverse puts back.
        const old = entry.inverse?.find((i) => i.op === "replaceSteps");
        const before = new Map(flatten(old?.op === "replaceSteps" ? old.steps : []).flatMap((s) => (s.id ? [[s.id, s] as const] : [])));
        const after = new Map(flatten(op.steps).flatMap((s) => (s.id ? [[s.id, s] as const] : [])));
        for (const [id, step] of after) {
          const was = before.get(id);
          if (!was) {
            steps.set(id, "added");
            removed.delete(id);
          } else if (!steps.has(id) && JSON.stringify(own(was)) !== JSON.stringify(own(step))) steps.set(id, "changed");
        }
        for (const [id, step] of before) {
          if (after.has(id)) continue;
          const wasAdded = steps.get(id) === "added";
          steps.delete(id);
          if (!wasAdded) removed.set(id, step);
        }
      }
    }
  }
  return { steps, removed: [...removed.values()], variables: vars.size, flow, created };
}

/** A step without its children, to tell whether the step itself changed. */
function own(step: Step): Omit<Step, "blocks"> {
  const { blocks: _blocks, ...rest } = step;
  return rest;
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

/** "3ノード追加・1変更" — what the group did, in a few words. */
export function headline(summary: ReviewSummary): string {
  const count = (d: StepDiff) => [...summary.steps.values()].filter((v) => v === d).length;
  if (summary.created) return t.headline.created(count("added"));
  const parts = [
    count("added") && t.headline.added(count("added")),
    count("changed") && t.headline.changed(count("changed")),
    summary.removed.length && t.headline.removed(summary.removed.length),
    summary.variables && t.headline.variables(summary.variables),
    summary.flow && t.headline.flow,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(t.headline.sep) : t.headline.none;
}

/**
 * What the group is for, in the AI's words: the first line of the oldest
 * summary (the AI is asked to start with what the flow now does
 * differently). Falls back to the counts.
 */
export function purpose(entries: HistoryEntry[], summary: ReviewSummary): string {
  const first = entries.find((e) => e.summary?.trim())?.summary?.trim().split("\n")[0]?.trim();
  return first || headline(summary);
}

/** Questions the AI asked a person to confirm, oldest first, without repeats. */
export function checksOf(entries: HistoryEntry[]): string[] {
  return [...new Set(entries.flatMap((e) => e.checks ?? []))];
}

/** Applies a step patch the way Core does (merge or replace params, then fields). */
export function applyPatch(step: Step, patch: StepPatch): Step {
  const next: Step = { ...step };
  if (patch.replaceParams) next.params = { ...patch.replaceParams };
  else if (patch.params) {
    const params: Record<string, unknown> = { ...(step.params ?? {}) };
    for (const [key, value] of Object.entries(patch.params)) {
      if (value === null) delete params[key];
      else params[key] = value;
    }
    next.params = params;
  }
  for (const key of ["name", "description", "disabled", "timeoutMs", "retry", "onError", "saveAs"] as const) {
    if (key in patch) (next as unknown as Record<string, unknown>)[key] = patch[key] ?? undefined;
  }
  return next;
}

/** A step as it was before the group: the current step with the group's inverse patches applied, newest first. */
export function stepBefore(current: Step, newestFirst: HistoryEntry[]): Step {
  let step = current;
  for (const entry of newestFirst) {
    for (const op of entry.inverse ?? []) {
      if (op.op === "updateStep" && op.stepId === current.id) step = applyPatch(step, op.patch);
      else if (op.op === "replaceSteps") {
        const old = flatten(op.steps).find((s) => s.id === current.id);
        if (old) step = { ...old, blocks: current.blocks };
      }
    }
  }
  return step;
}

export type ChangeCard = {
  stepId: string;
  kind: StepDiff | "removed";
  before: Step | null;
  after: Step | null;
  /** The AI's summaries of the edits that touched this step, oldest first. */
  said: string[];
  /** Only moved: the step itself reads the same. */
  movedOnly: boolean;
  /** Touched by an edit made after the last send-back. */
  afterFeedback: boolean;
};

/** One card per step the group added, changed or removed, in flow order for the ones that still exist. */
export function changeCards(
  oldestFirst: HistoryEntry[],
  summary: ReviewSummary,
  steps: Step[],
  feedbackRevision: number | null,
): ChangeCard[] {
  const newestFirst = [...oldestFirst].reverse();
  const touching = (id: string) => oldestFirst.filter((e) => (e.stepIds ?? []).includes(id));
  const said = (id: string) => [...new Set(touching(id).flatMap((e) => (e.summary?.trim() ? [e.summary.trim()] : [])))];
  const afterFeedback = (id: string) => feedbackRevision !== null && touching(id).some((e) => e.revision > feedbackRevision);
  const updated = (id: string) => oldestFirst.some((e) => (e.ops ?? []).some((op) => op.op === "updateStep" && op.stepId === id));
  const cards: ChangeCard[] = [];
  for (const step of flatten(steps)) {
    const kind = summary.steps.get(step.id ?? "");
    if (!kind || !step.id) continue;
    const before = kind === "added" ? null : stepBefore(step, newestFirst);
    cards.push({
      stepId: step.id,
      kind,
      before,
      after: step,
      said: said(step.id),
      movedOnly: kind === "changed" && !updated(step.id),
      afterFeedback: afterFeedback(step.id),
    });
  }
  for (const step of summary.removed) {
    const id = step.id ?? "";
    cards.push({ stepId: id, kind: "removed", before: step, after: null, said: said(id), movedOnly: false, afterFeedback: afterFeedback(id) });
  }
  return cards;
}

/** Every step in flow order, children after their parent. */
export function flatten(steps: Step[]): Step[] {
  return steps.flatMap((s) => [s, ...Object.values(s.blocks ?? {}).flatMap(flatten)]);
}

/**
 * Which parts of two sentences differ, so the review can mark what was added
 * or dropped. Parts are matched by their text, as a multiset.
 */
export function partDiff(before: Part[], after: Part[]): { dropped: boolean[]; added: boolean[] } {
  const key = (p: Part) => ("text" in p ? `t:${p.text.trim()}` : `c:${p.code}`);
  const mark = (from: Part[], other: Part[]) => {
    const left = new Map<string, number>();
    for (const p of other) left.set(key(p), (left.get(key(p)) ?? 0) + 1);
    return from.map((p) => {
      const k = key(p);
      if (k === "t:") return false;
      const n = left.get(k) ?? 0;
      if (n > 0) {
        left.set(k, n - 1);
        return false;
      }
      return true;
    });
  };
  return { dropped: mark(before, after), added: mark(after, before) };
}

export type TestDigest = {
  /** Changed steps (added or changed) the run reached. */
  covered: number;
  total: number;
  /** Changed steps the run never reached. */
  missed: string[];
  /** The record was cut short, so coverage is unknown (`covered` and `missed` are empty). */
  partial: boolean;
  outputs: [string, unknown][];
  /** The run's own log lines (log.message and warnings), last few. */
  logs: string[];
};

const LOG_LINES = 3;

/** What a recorded test run did, as far as the review cares. */
export function digest(record: RunRecord, changedIds: string[]): TestDigest {
  const ran = new Set<string>();
  const logs: string[] = [];
  for (const event of record.events) {
    if ((event.callPath ?? []).length > 0) continue;
    if (event.type === "stepStarted") ran.add(event.stepId);
    else if (event.type === "log" && event.level !== "debug") logs.push(event.message);
  }
  const partial = record.truncated;
  const missed = partial ? [] : changedIds.filter((id) => !ran.has(id));
  return {
    partial,
    covered: partial ? 0 : changedIds.length - missed.length,
    total: changedIds.length,
    missed,
    outputs: Object.entries(record.report?.outputs ?? {}),
    logs: logs.slice(-LOG_LINES),
  };
}

/**
 * `text` split into words (and the spaces between them), each marked when it
 * is not part of the longest run of words `text` shares with `other`.
 */
export function wordDiff(text: string, other: string): { text: string; changed: boolean }[] {
  const a = text.split(/(\s+)/).filter((w) => w !== "");
  const b = other.split(/(\s+)/).filter((w) => w !== "");
  // Longest common subsequence over words; expressions are short.
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: { text: string; changed: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length) {
    if (j < b.length && a[i] === b[j]) {
      out.push({ text: a[i]!, changed: false });
      i++;
      j++;
    } else if (j < b.length && dp[i]![j + 1]! >= dp[i + 1]![j]!) j++;
    else {
      const word = a[i]!;
      out.push({ text: word, changed: word.trim() !== "" });
      i++;
    }
  }
  return out;
}
