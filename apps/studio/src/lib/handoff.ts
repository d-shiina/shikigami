// The paste way (lib/aiWay.ts): what Writer copies for an AI chat, and how
// it reads what the person brings back from it.
import type { Flow } from "@spellsheet/schema";
import { t } from "./i18n";
import { flowForChat } from "./todos";

const fence = (json: string) => "```json\n" + json + "\n```";

/**
 * One request for the AI chat, whole: the chat may be a new one each time
 * and remembers nothing, so the instructions and the flow as it is now go
 * along every time (the person may have changed it meanwhile).
 */
export function composeRequest(message: string, instructions: string, flow: Flow | null, stepId: string | null = null): string {
  const c = t.aiChat.request;
  const step = flow && stepId ? findStep(flow.steps ?? [], stepId) : null;
  return [
    c.head,
    c.how,
    "",
    `===== ${c.instructions} =====`,
    instructions.trim(),
    "",
    `===== ${flow ? c.flow : c.newFlow} =====`,
    flow ? fence(flowForChat(flow)) : c.noFlow,
    "",
    `===== ${c.request} =====`,
    message.trim(),
    ...(step ? ["", c.selected(step.id ?? "", step.name ?? step.type)] : []),
    "",
  ].join("\n");
}

type Step = NonNullable<Flow["steps"]>[number];

function findStep(steps: Step[], id: string): Step | null {
  for (const s of steps) {
    if (s.id === id) return s;
    for (const b of Object.values(s.blocks ?? {})) {
      const found = findStep(b, id);
      if (found) return found;
    }
  }
  return null;
}

/** What Writer itself copied (a request), not an answer to take in. */
export const isOwnRequest = (text: string) => text.trimStart().startsWith(t.aiChat.request.head);

/** Whether the clipboard looks like an AI's answer worth offering to take in. */
export function looksLikeAnswer(text: string): boolean {
  if (!text.trim() || isOwnRequest(text)) return false;
  return text.includes("spellsheet.answer") || /"steps"\s*:\s*\[/.test(text);
}

/**
 * The rest of an answer the chat cut short, put after what came before:
 * the AI is told to go on from exactly where it stopped, in a new code block.
 */
export function joinParts(before: string, more: string): string {
  const open = more.indexOf("```");
  if (open < 0) return before + more;
  const start = more.indexOf("\n", open);
  const body = start < 0 ? "" : more.slice(start + 1);
  const close = body.indexOf("```");
  return before + (close < 0 ? body : body.slice(0, close)) + "\n```\n";
}
