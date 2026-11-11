// What was written where a validation problem is, for the AI asked to fix
// it: Core words the problem in English (a JSON Pointer, the schema's
// message, a fix hint), and this finds the value and the node it points at.
import type { Flow, Step, ValidationIssue } from "@spellsheet/schema";

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
  // A secret's value or personal data never leaves Studio (as in flowForChat).
  const variable = /^\/variables\/(\d+)/.exec(issue.path);
  const def = variable ? flow.variables?.[Number(variable[1])] : undefined;
  if (def?.secret || def?.personal) return null;
  const value = valueAt(flow, issue.path);
  return value === undefined ? null : shortJson(value);
}
