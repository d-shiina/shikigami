// The open flow's to-dos for a person (see todos.ts), kept current as the
// flow, the registered secrets and the flow's folder change.
import { useMemo } from "react";
import { useStudio } from "../context";
import { useProjectMaybe } from "../project";
import type { Step } from "@spellsheet/schema";
import { unsetParams } from "./nodeRows";
import { authorIssues, personTodos, type Todo } from "./todos";

export function useTodos(): Todo[] {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const secrets = useStudio((s) => s.secrets);
  const secretsLoaded = useStudio((s) => s.secretsLoaded);
  const files = useProjectMaybe((s) => (flow && s.flowId === flow.id ? s.files : null), null);
  return useMemo(() => {
    if (!flow) return [];
    const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
    const names = secretsLoaded ? new Set(secrets.map((s) => s.name)) : null;
    return personTodos(flow, defs, names, files);
  }, [flow, stepTypes, secrets, secretsLoaded, files]);
}

/** Required settings still empty, over the whole open flow (blocks too). */
export function useUnsetCount(): number {
  const flowSteps = useStudio((s) => s.flow?.steps);
  const stepTypes = useStudio((s) => s.stepTypes);
  return useMemo(() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
    let n = 0;
    const walk = (steps: Step[]) => {
      for (const step of steps) {
        n += unsetParams(step, defs.get(step.type)).length;
        for (const block of Object.values(step.blocks ?? {})) walk(block);
      }
    };
    walk(flowSteps ?? []);
    return n;
  }, [flowSteps, stepTypes]);
}

/**
 * What still stands between the open flow and handing it out: errors, empty
 * settings, a person's to-dos, and whether the last run here failed.
 */
export function useFlowHealth() {
  const flowId = useStudio((s) => s.flow?.id);
  const validation = useStudio((s) => s.validation);
  const lastFailed = useStudio((s) => s.run !== null && s.run.flowId === flowId && s.run.status === "failed");
  const unset = useUnsetCount();
  const todos = useTodos().length;
  return { errors: authorIssues(validation).length, unset, todos, lastFailed };
}
