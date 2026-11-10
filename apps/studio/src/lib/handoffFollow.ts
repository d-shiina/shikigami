import type { ValidationIssue } from "@spellsheet/schema";
import type { ChatItem } from "../agent";
import { t } from "./i18n";
import { isQuestion, readCheck } from "./reviewFiles";

/** How many times in a row the AI was asked to fix the same thing before Writer offers to fix it by hand. */
export const BY_HAND_AFTER = 3;

/**
 * The person's answers to the AI's questions, as the next message for the AI.
 * Only the answered ones go; null when none is answered yet.
 */
export function answersText(questions: string[], answers: Record<string, "ok" | "no" | undefined>, right: Record<string, string | undefined>): string | null {
  const lines = questions.flatMap((q) => {
    const rule = readCheck(q).rule;
    const answer = answers[q];
    if (answer === "ok") return [t.aiChat.answerYes(rule)];
    if (answer === "no" && isQuestion(q)) return [`- ${t.desk.questionAnswer(rule, (right[q] ?? "").trim())}`];
    if (answer === "no") return [t.aiChat.answerNo(rule, (right[q] ?? "").trim())];
    return [];
  });
  return lines.length > 0 ? t.aiChat.answersBody(lines.join("\n")) : null;
}

const issueKey = (issue: ValidationIssue) => `${issue.code}:${issue.stepId ?? issue.path}`;

/**
 * The problems of the chat's last take-in that every one of the last
 * BY_HAND_AFTER take-ins of the same flow also had: asking the AI again is
 * unlikely to help. With how many take-ins in a row have it.
 */
export function stuckIssues(items: ChatItem[], flowId: string): { issue: ValidationIssue; times: number }[] {
  const taken = items.flatMap((item) =>
    item.role === "ai" && item.handoff?.result?.kind === "taken" && item.handoff.result.flowId === flowId ? [item.handoff.result.forAi] : [],
  );
  const last = taken.at(-1);
  if (!last) return [];
  return last.flatMap((issue) => {
    const key = issueKey(issue);
    let times = 0;
    for (let i = taken.length - 1; i >= 0 && (taken[i] ?? []).some((other) => issueKey(other) === key); i--) times++;
    return times >= BY_HAND_AFTER ? [{ issue, times }] : [];
  });
}
