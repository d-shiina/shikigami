// 業務の棚卸し on Writer's side: the words and numbers of the sheet, and the
// messages that start the AI's interview or have it build a flow for one
// task. The scoring itself is Flow Core's (spellsheet_core::inventory), so the
// sheet and the AI always see the same order.
import type { StoreApi } from "zustand";
import { type AgentState, openAsk } from "../agent";
import type { Assessment, Frequency, TaskAssessment, WorkInventory, WorkTask } from "@spellsheet/schema";
import { t } from "./i18n";

export type { Assessment, Frequency, Group, InventoryPatch, InventorySummary, Level, Period, TaskAssessment, WorkInventory, WorkTask } from "@spellsheet/schema";

/** One stock-take and its numbers, as Writer reads them (src-tauri/src/inventory.rs). */
export type InventoryView = { inventory: WorkInventory; assessment: Assessment };

/** Saved time per month (minutes) from which a task is worth a flow of its own (Flow Core's WORTH_MINUTES). */
export const WORTH_MINUTES = 300;

/** Hours with one decimal at most: 8, 1.5, 0.3. */
export function hours(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

/** A number as people write it: 1, 2.5. */
export function plain(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** 「毎日 1 回」「週 3 回」, "3 a week". */
export function oftenText(f: Frequency): string {
  return t.inventory.often(plain(f.times), t.inventory.periods[f.per]);
}

/** The tasks in the order Flow Core gave, each with its numbers. */
export function ordered(view: InventoryView): { task: WorkTask; score: TaskAssessment }[] {
  const byId = new Map((view.inventory.tasks ?? []).map((task) => [task.id, task]));
  return view.assessment.tasks.flatMap((score) => {
    const task = byId.get(score.taskId);
    return task ? [{ task, score }] : [];
  });
}

/** The words for "build this flow": what was heard about the task, so the AI starts from it. */
export function buildRequest(inventory: WorkInventory, task: WorkTask): string {
  const i = t.inventory;
  const line = (label: string, items: string[] | undefined) => (items?.length ? [`${label}：${items.join("、")}`] : []);
  const lines = [
    ...(task.description ? [task.description] : []),
    ...(task.frequency ? [`${i.columns.often}：${oftenText(task.frequency)}`] : []),
    ...line(i.steps, task.steps),
    ...line(i.usedSystems, task.systems),
    ...line(i.inputs, task.inputs),
    ...line(i.outputs, task.outputs),
    ...(task.exceptions ? [`${i.exceptions}：${task.exceptions}`] : []),
  ];
  return i.buildMessage(task.name, lines, inventory.id, task.id);
}

/**
 * Sends `message` in a new AI conversation, as the first screen's request box
 * does: when the AI is not set up yet, the pane shows how and the message
 * waits in its box.
 */
export function sendFresh(agent: StoreApi<AgentState>, message: string) {
  openAsk(agent, { fresh: null, draft: message });
  const a = agent.getState();
  if (!a.info?.available) return;
  a.setDraft(a.current, "");
  void a.sendIn(a.current, message, null).then((sent) => !sent && a.setDraft(a.current, message));
}

/** Where a task sits on the chart: x by ease, y by the time it could save (0 to 1 each). */
export function chartPoint(task: WorkTask, score: TaskAssessment, most: number): { x: number; y: number } | null {
  if (score.savableMinutes == null || !task.ease) return null;
  const x = task.ease === "high" ? 0.83 : task.ease === "medium" ? 0.6 : 0.2;
  // The middle line is WORTH_MINUTES: above it the top half, scaled to the largest.
  const top = Math.max(most, WORTH_MINUTES * 2);
  const saved = score.savableMinutes;
  const y = saved >= WORTH_MINUTES ? 0.5 + ((saved - WORTH_MINUTES) / (top - WORTH_MINUTES)) * 0.42 : (saved / WORTH_MINUTES) * 0.42 + 0.06;
  return { x, y: Math.min(0.94, y) };
}
