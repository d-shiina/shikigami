// A check of the flow (validation issue) in the person's language. Core's
// `message` is English for the AI; Studio words it from `code`, the issue's
// JSON Pointer and the node, naming settings the way the panel does.
import type { Flow, Step, ValidationIssue } from "@shikigami/schema";
import { locale } from "./i18n";
import { issuesEn } from "./locales/issues.en";
import { issuesJa } from "./locales/issues.ja";
import { paramLabel } from "./nodeRows";

export interface IssueContext {
  /** The setting a required-property error names (`path` in `"path" is a required property`). */
  missing: string;
  /** The setting the issue's path points into (`/steps/0/params/sheet` → `sheet`). */
  field: string;
  /** A variable named in the message (`variable 'total' …`). */
  name: string;
  /** The function an unknown-function error names. */
  fn: string;
  /** A setting's name as the panel shows it, for this node. */
  label(key: string): string;
}

export type IssueText = string | ((c: IssueContext) => string);

function findStep(steps: Step[] | undefined, id: string | null | undefined): Step | undefined {
  if (!steps || !id) return undefined;
  for (const step of steps) {
    if (step.id === id) return step;
    for (const block of Object.values(step.blocks ?? {})) {
      const found = findStep(block as Step[], id);
      if (found) return found;
    }
  }
  return undefined;
}

/** The issue in words; Core's message when Studio does not know the code. */
export function issueText(issue: ValidationIssue, flow?: Flow | null): string {
  const entry = (locale === "ja" ? issuesJa : issuesEn)[issue.code];
  if (!entry) return issue.message;
  if (typeof entry === "string") return entry;
  const type = findStep(flow?.steps, issue.stepId)?.type;
  return entry({
    missing: /^"([^"]+)" is a required property/.exec(issue.message)?.[1] ?? "",
    field: /\/params\/([^/]+)/.exec(issue.path)?.[1] ?? "",
    name: /'([^']+)'/.exec(issue.message)?.[1] ?? "",
    fn: /^unknown function: (\S+)/.exec(issue.message)?.[1] ?? "",
    label: (key) => paramLabel(key, type),
  });
}
