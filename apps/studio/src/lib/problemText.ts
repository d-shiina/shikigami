// What went wrong in an AI's answer, for the person and for the AI. Core
// words a problem in English for the AI (a JSON Pointer, the schema's
// message, a fix hint); the person reads where it is (the node and the
// setting by their names), what is wrong, and what was written there.
import type { Flow, Step, ValidationIssue } from "@shikigami/schema";
import type { AnswerProblem } from "./api";
import { t } from "./i18n";
import { paramLabel } from "./nodeRows";

/** Longest a written value is shown, in characters. */
const SHOWN = 160;

/** A value as the AI wrote it, on one line and shortened. */
export function shortJson(value: unknown, limit = SHOWN): string {
  const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** The value at a JSON Pointer (`/steps/0/params/condition`). */
export function valueAt(root: unknown, pointer: string): unknown {
  if (!pointer) return root;
  let at: unknown = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) at = at[Number(key)];
    else if (at && typeof at === "object") at = (at as Record<string, unknown>)[key];
    else return undefined;
  }
  return at;
}

/** The innermost step a pointer is in. */
export function stepAt(flow: Flow, pointer: string): Step | undefined {
  const parts = pointer.split("/").slice(1);
  let found: Step | undefined;
  parts.forEach((part, j) => {
    const isStep = /^\d+$/.test(part) && ((j >= 1 && parts[j - 1] === "steps") || (j >= 2 && parts[j - 2] === "blocks"));
    if (!isStep) return;
    const step = valueAt(flow, `/${parts.slice(0, j + 1).join("/")}`);
    if (step && typeof step === "object") found = step as Step;
  });
  return found;
}

/** What the flow has where a check points, for the person and the AI. */
export function writtenAt(flow: Flow, issue: Pick<ValidationIssue, "path">): string | null {
  // A whole node or the whole flow says nothing the AI cannot see.
  if (!issue.path || /\/steps\/\d+$/.test(issue.path)) return null;
  const value = valueAt(flow, issue.path);
  return value === undefined ? null : shortJson(value);
}

/** The setting a pointer names (`…/params/condition` → `condition`). */
function settingOf(path: string): string {
  return /\/params\/([^/]+)/.exec(path)?.[1] ?? "";
}

/** A problem with a pasted answer, in the person's words. */
export function answerProblemText(problem: AnswerProblem): string {
  const p = t.paste.problem;
  const m = problem.message;
  const path = problem.path ?? "";
  const json = /^The JSON is not valid at line (\d+)/.exec(m);
  if (json) return p.json(Number(json[1]));
  if (m.startsWith("No JSON found")) return p.noJson;
  if (m.startsWith("The answer must be one JSON object")) return p.notObject;
  const setting = settingOf(path);
  const field = setting ? paramLabel(setting, undefined) : (path.split("/").pop() ?? "");
  const required = /^"([^"]+)" is a required property/.exec(m);
  if (required) return p.required(required[1] ?? "");
  const extra = /\('([^']+)' (?:was|were) unexpected\)/.exec(m);
  if (extra) return p.unexpected(extra[1] ?? "");
  const type = /is not of type "?([a-z]+)/.exec(m);
  if (type) return p.type(field, p.types[type[1] as keyof typeof p.types] ?? type[1] ?? "");
  if (/is not one of/.test(m)) return p.choice(field);
  return p.other(field);
}
