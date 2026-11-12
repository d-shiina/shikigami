// What Studio tells the AI when a run paused on an error: enough to fix the
// step without seeing the screen (the AI's MCP server runs in another
// process, so the paused browser is not open there).
import type { Flow, StepTypeDef } from "@spellsheet/schema";
import type { RunEvidence } from "./api";
import type { Pause } from "../store";
import { findStep } from "../store";
import { stepLabel, t } from "./i18n";

/** Longest page / window tree quoted in the request. */
const MAX_TREE_CHARS = 6000;
/** Longest single variable value quoted. */
const MAX_VALUE_CHARS = 300;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The request text, in Studio's language. */
export function fixRequest(input: {
  flow: Pick<Flow, "id" | "name" | "steps">;
  runId: string;
  pause: Pause;
  evidence: RunEvidence | null;
  defs: StepTypeDef[];
}): string {
  const { flow, runId, pause, evidence } = input;
  const step = findStep(flow.steps ?? [], pause.stepId);
  const def = input.defs.find((d) => d.type === pause.stepType);
  const kind = stepLabel(pause.stepType, def?.label);
  const f = t.fix;
  const label = step?.name ? f.named(kind, step.name) : kind;
  const lines = [f.intro(flow.name, flow.id ?? "", label, pause.stepId, pause.stepType), "", `${f.error}: ${pause.error?.code ?? "?"}: ${pause.error?.message ?? ""}`];
  if (pause.error?.details != null) lines.push(`${f.details}: ${cut(JSON.stringify(pause.error.details), 1500)}`);
  if (step) lines.push("", `${f.failedStep}:`, "```json", JSON.stringify(step.params ?? {}, null, 2), "```");
  const vars = Object.entries(pause.variables);
  if (vars.length > 0) {
    lines.push("", `${f.variables}:`);
    for (const [name, value] of vars) lines.push(`- ${name} = ${cut(JSON.stringify(value) ?? "null", MAX_VALUE_CHARS)}`);
  }
  const observation = evidence?.observation;
  if (observation) {
    lines.push("", `${f.screen(observation.title)}:`);
    if (observation.tree) lines.push("```", cut(observation.tree, MAX_TREE_CHARS), "```");
  }
  lines.push("", `${f.asks}:`, ...f.rules.map((rule) => `- ${rule}`));
  if (observation) lines.push(`- ${f.observation(observation.id)}`);
  lines.push(`- ${f.logs(runId)}`);
  return lines.join("\n");
}

/**
 * The request when a run ended on an error (not paused): the run is over, so
 * the AI fixes the flow and the person runs it again.
 */
export function failureRequest(input: {
  flow: Pick<Flow, "id" | "name" | "steps">;
  runId: string;
  error: { code: string; message: string; stepId?: string | null; stepType?: string | null; details?: unknown };
  defs: StepTypeDef[];
}): string {
  const { flow, runId, error } = input;
  const f = t.fix;
  const step = error.stepId ? findStep(flow.steps ?? [], error.stepId) : null;
  const type = step?.type ?? error.stepType ?? "";
  const def = input.defs.find((d) => d.type === type);
  const kind = type ? stepLabel(type, def?.label) : "";
  const label = step?.name ? f.named(kind, step.name) : kind;
  const lines = [f.introFailed(flow.name, flow.id ?? "", label, error.stepId ?? "", type), "", `${f.error}: ${error.code}: ${error.message}`];
  if (error.details != null) lines.push(`${f.details}: ${cut(JSON.stringify(error.details), 1500)}`);
  if (step) lines.push("", `${f.failedStep}:`, "```json", JSON.stringify(step.params ?? {}, null, 2), "```");
  lines.push("", `${f.asks}:`, ...f.rulesFailed.map((rule) => `- ${rule}`), `- ${f.logs(runId)}`);
  return lines.join("\n");
}
