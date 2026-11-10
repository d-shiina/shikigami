// Reads an AI's approval request (ApprovalRequest.subject) as things a person
// can judge: which values the run uses, which node is tested, which flows are
// called. Display only: the MCP server compares the subject itself when the
// approval is used, so nothing here decides what runs.
import type { ApprovalRequest, Flow, Step, VariableDef } from "@spellsheet/schema";
import { variableUsage } from "./variableUsage";

/** The AI clients' MCP names, as people know them. Unknown names show as given. */
const CLIENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude",
  codex: "Codex",
  "codex-mcp-client": "Codex",
  "gemini-cli": "Gemini CLI",
  gemini: "Gemini CLI",
  "copilot-cli": "GitHub Copilot",
  copilot: "GitHub Copilot",
  "github-copilot": "GitHub Copilot",
  cursor: "Cursor",
  "cursor-vscode": "Cursor",
  "visual-studio-code": "VS Code",
};

export function clientName(name: string | null | undefined): string | null {
  if (!name) return null;
  return CLIENTS[name.toLowerCase()] ?? name;
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** One value a run starts with. */
export type InputRow = {
  name: string;
  /** The variable's description, when it has one. */
  label: string | null;
  value: unknown;
  /** false: the AI did not give it, so the flow's default is used. */
  given: boolean;
};

/**
 * The values a run or test case starts with: every input the flow declares,
 * in its order, with what the AI gave or else the default; then anything the
 * AI gave that the flow does not declare.
 */
export function inputRows(flow: Pick<Flow, "variables"> | null, given: unknown): InputRow[] {
  const values = record(given);
  const declared = (flow?.variables ?? []).filter((v) => v.direction === "input" || v.direction === "inOut");
  const rows: InputRow[] = declared.map((v) => {
    const has = Object.hasOwn(values, v.name);
    return { name: v.name, label: v.description?.trim() || null, value: has ? values[v.name] : v.default, given: has };
  });
  const known = new Set(declared.map((v) => v.name));
  for (const [name, value] of Object.entries(values)) {
    if (!known.has(name)) rows.push({ name, label: null, value, given: true });
  }
  return rows;
}

export type TestCasePlan = { name: string; inputs: unknown };

/** What the request is about, read from its subject. */
export type ApprovalSubject = {
  /** runFlow: the published version rather than the working copy. */
  published: boolean;
  /** runFlow: the values given to the run. */
  inputs: unknown;
  /** runFlow from run_tests: the test cases, in the order they run. */
  testCases: TestCasePlan[];
  /** testStep: the node it runs. */
  step: Step | null;
  /** testStep: the variables the node runs with. */
  variables: unknown;
  /** The flows it calls. */
  calledIds: string[];
  /** runFlow: the flow content's revision the approval covers. */
  revision: number | null;
};

export function readSubject(request: Pick<ApprovalRequest, "subject">): ApprovalSubject {
  const s = record(request.subject);
  const step = record(s.step);
  const cases = Array.isArray(s.testCases) ? s.testCases : [];
  const flows = Array.isArray(s.flows) ? s.flows : [];
  return {
    published: s.published === true,
    inputs: s.inputs ?? {},
    testCases: cases.map((c) => record(c)).map((c) => ({ name: String(c.name ?? ""), inputs: c.inputs ?? {} })),
    step: typeof step.type === "string" ? (step as unknown as Step) : null,
    variables: s.variables ?? {},
    revision: typeof s.revision === "number" ? s.revision : null,
    calledIds: flows.map((f) => record(f).id).filter((id): id is string => typeof id === "string"),
  };
}

/** Minutes left before an unanswered request is dropped (the server keeps it 30 minutes). */
export function minutesLeft(requestedAt: string, now = Date.now(), keep = 30): number {
  const left = keep - (now - Date.parse(requestedAt)) / 60_000;
  return Math.max(0, Math.ceil(left));
}

/**
 * The starting values that stay the same for the whole run: no step writes
 * them (a set, a loop element, a saved result, a called flow's output), so
 * every step that reads one sees the starting value.
 */
export function unchangedRows(rows: InputRow[], steps: Step[], variables?: VariableDef[]): InputRow[] {
  const defs: VariableDef[] = variables ?? rows.map((r) => ({ name: r.name, type: "any" }) as VariableDef);
  const written = new Set(variableUsage(steps, defs).filter((u) => u.writers.length > 0).map((u) => u.name));
  return rows.filter((r) => !written.has(r.name));
}

/**
 * A step's target with plain `{{ name }}` references replaced by the values
 * the run starts with, so `{{ orderFile }}` reads as `input/orders.xlsx`.
 * Pass only values no step changes (unchangedRows): anything else
 * (expressions, variables set during the run) stays as written.
 */
export function fillTarget(target: string, rows: InputRow[]): string {
  const values = new Map(rows.map((r) => [r.name, r.value] as const));
  return target.replace(/\{\{\s*([\p{L}_][\p{L}\p{N}_]*)\s*\}\}/gu, (whole, name: string) => {
    const value = values.get(name);
    return typeof value === "string" || typeof value === "number" ? String(value) : whole;
  });
}
