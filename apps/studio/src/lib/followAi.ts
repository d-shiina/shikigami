// Studio follows the AI to a flow it has just made, so the person sees
// the flow chart grow instead of a new row appearing in a list they are not
// looking at. It only takes over a screen with nothing to lose: no flow
// open, or the empty one the person made for the AI to fill.
import type { Flow, Step } from "@shikigami/schema";
import type { AgentActivity } from "../agent";

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
