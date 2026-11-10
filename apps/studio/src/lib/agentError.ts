import { ApiError } from "./api";
import { t } from "./i18n";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Starting or stopping the worker went wrong, in the person's words. The
 * command's own message is English for the log and AI clients (wording.md);
 * what Windows said is shown as it is, already in the person's language.
 */
export function agentErrorText(e: unknown): string {
  const r = t.runs;
  if (!(e instanceof ApiError)) return message(e);
  switch (e.code) {
    case "AGENT_START_FAILED": {
      const details = e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>) : {};
      const reason = typeof details.reason === "string" ? details.reason : "";
      return [r.agentStartFailed, reason ? r.agentStartFailedWhy(reason) : "", r.agentStartFailedTodo].filter(Boolean).join(" ");
    }
    case "AGENT_NO_ANSWER":
      return r.agentNoAnswer;
    case "CLI_NOT_FOUND":
      return r.agentNoCli;
    case "AGENT_UNREACHABLE":
      return r.agentUnreachable;
    default:
      return message(e);
  }
}
