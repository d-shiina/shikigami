// Studio follows the AI to a flow it has just made, so the person sees
// the flow chart grow instead of a new row appearing in a list they are not
// looking at. It only takes over a screen with nothing to lose: no flow
// open, or the empty one the person made for the AI to fill.
import type { Flow, Step } from "@spellsheet/schema";
import { type AgentActivity, type Chat, isBusy, waitsForChoice } from "../agent";
import type { Drafting, Place } from "../store";

type Where = {
  place: string;
  flow: Pick<Flow, "id" | "steps"> | null;
};

/**
 * Whether to open `createdId`, a flow that appeared while the AI was
 * working. `known` is whether it was in the list before the change.
 */
export function shouldFollow(createdId: string, known: boolean, activity: AgentActivity | null, where: Where): boolean {
  if (known || !activity) return false;
  // Elsewhere (secrets, settings) the person is doing something else.
  if (where.place !== "library" && where.place !== "flows") return false;
  const open = where.flow;
  if (!open) return true;
  if (open.id === createdId) return false;
  // Asked for a new flow, the person wants to watch it grow, whatever was open.
  // (Flows are saved as they are edited, so nothing open is lost.)
  if (activity.flowId === null || activity.flowId === createdId) return true;
  return (open.steps ?? []).length === 0;
}

/** Every step ID in reading order, nested blocks included. */
export function stepIds(steps: Step[]): string[] {
  return steps.flatMap((step) => [...(step.id ? [step.id] : []), ...Object.values(step.blocks ?? {}).flatMap(stepIds)]);
}

/**
 * The step to bring into view after an AI edit: the last one it added, in
 * reading order. `before` is null when the flow was not shown before
 * (Studio just opened what the AI made), so all of its steps are new.
 */
export function lastAdded(before: string[] | null, after: Step[]): string | undefined {
  const seen = new Set(before ?? []);
  return stepIds(after)
    .filter((id) => !seen.has(id))
    .at(-1);
}

/**
 * A conversation that sets out to make a flow (no flow yet) has just been
 * sent a message: the editor shows the new flow being made from then on,
 * not only once the AI has created it. Null when no such message went out.
 */
export function askedForFlow(before: Chat[], after: Chat[]): Drafting | null {
  for (const chat of after) {
    if (chat.flowId !== null || !isBusy(chat)) continue;
    const was = before.find((c) => c.id === chat.id);
    if (was && isBusy(was)) continue;
    // What was asked first names the flow; an answer to the AI's question does not.
    const first = chat.items.find((i) => i.role === "person");
    if (first?.role !== "person") continue;
    return { chatId: chat.id, title: chat.title, request: first.text };
  }
  return null;
}

/**
 * Whether the screen may give way to a new flow being made: the library or
 * the editor (as for following, elsewhere the person is doing something
 * else), and not while the open flow holds the person: a run of it under
 * way, or a project file edited by hand and not saved.
 */
export function mayDraft(place: Place, held: boolean): boolean {
  return (place === "library" || place === "flows") && !held;
}

/**
 * Whether the flow being made stops being shown: the conversation is gone,
 * or its turn ended with no flow and no question for the person (they asked
 * something else; the answer is in the pane). A flow made is opened by
 * following it, which puts the drafting screen down by itself.
 */
export function draftingOver(chat: Chat | undefined): boolean {
  if (!chat) return true;
  if (isBusy(chat)) return false;
  return chat.flowId !== null || !waitsForChoice(chat.items);
}
