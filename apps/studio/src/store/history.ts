// The change history: what is waiting for review, and what can be undone.
import type { HistoryEntry, ReviewTimeline } from "@spellsheet/schema";
import { t } from "../lib/i18n";
import type { StudioState } from "./index";

export const isExternal = (entry: HistoryEntry) => entry.actor.kind !== "studio";

/** Whether Core recorded ops that can be sent back to revert this entry. */
export const isRevertible = (entry: HistoryEntry) =>
  entry.kind !== "create" && entry.kind !== "delete" && (entry.inverse?.length ?? 0) > 0;

/** What an entry's ops touch; "*" when they rewrite the whole step tree. */
export function targets(entry: HistoryEntry): Set<string> {
  const keys = new Set<string>();
  for (const op of entry.ops ?? []) {
    if (op.op === "addStep") keys.add(`step:${op.step.id}`);
    else if (op.op === "updateStep" || op.op === "removeStep" || op.op === "moveStep") keys.add(`step:${op.stepId}`);
    else if (op.op === "setVariable") keys.add(`var:${op.variable.name}`);
    else if (op.op === "removeVariable") keys.add(`var:${op.name}`);
    else if (op.op === "updateFlow") keys.add("flow");
    else keys.add("*");
  }
  return keys;
}

/**
 * Why an entry cannot be reverted safely, or null. Core's inverse ops restore
 * whole previous values (e.g. all params), so sending them after a later edit
 * to the same step or variable would silently undo that later edit too.
 */
export function revertBlocker(entry: HistoryEntry, history: HistoryEntry[]): string | null {
  if (!isRevertible(entry)) return t.revertUnsupported;
  const mine = targets(entry);
  for (const later of history) {
    if (later.revision <= entry.revision) continue;
    for (const key of targets(later)) {
      if (key === "*" || mine.has("*") || mine.has(key)) return t.revertBlocked;
    }
  }
  return null;
}

/** External edits the user has not reviewed yet, newest first. */
export function pendingReview(
  state: Pick<StudioState, "history" | "reviewed" | "flow"> & Partial<Pick<StudioState, "timelines">>,
): HistoryEntry[] {
  const id = state.flow?.id ?? "";
  return pendingIn(state.history, state.reviewed[id], approvedUpTo(state.timelines?.[id]));
}

/** The last revision someone approved (on any PC sharing this workspace's history), or 0. */
export function approvedUpTo(timeline: ReviewTimeline | undefined): number {
  return timeline?.lastApproval?.revision ?? 0;
}

/** Unreviewed external edits in one flow's journal, newest first. */
export function pendingIn(history: HistoryEntry[], reviewed: number[] | undefined, approved = 0): HistoryEntry[] {
  const seen = new Set(reviewed ?? []);
  return history
    .filter((e) => isExternal(e) && (isRevertible(e) || e.kind === "create") && e.revision > approved && !seen.has(e.revision))
    .reverse();
}

/**
 * Why a group of entries cannot be reverted together, or null: an entry
 * outside the group changed the same thing afterwards.
 */
export function groupRevertBlocker(group: HistoryEntry[], history: HistoryEntry[]): string | null {
  if (group.some((e) => !isRevertible(e))) return t.revertUnsupported;
  const inGroup = new Set(group.map((e) => e.revision));
  const oldest = Math.min(...group.map((e) => e.revision));
  const mine = new Set(group.flatMap((e) => [...targets(e)]));
  for (const later of history) {
    if (later.revision <= oldest || inGroup.has(later.revision)) continue;
    for (const key of targets(later)) {
      if (key === "*" || mine.has("*") || mine.has(key)) return t.revertBlocked;
    }
  }
  return null;
}

/** Step IDs an entry's ops point at (for highlighting on the canvas). */
export function touchedSteps(entry: HistoryEntry): string[] {
  const ids: string[] = [];
  for (const op of entry.ops ?? []) {
    if (op.op === "addStep" && op.step.id) ids.push(op.step.id);
    else if (op.op === "updateStep" || op.op === "moveStep") ids.push(op.stepId);
  }
  return ids;
}
