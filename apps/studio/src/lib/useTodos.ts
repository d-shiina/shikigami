// The open flow's to-dos for a person (see todos.ts), kept current as the
// flow, the registered secrets and the flow's folder change.
import { useMemo } from "react";
import { useStudio } from "../context";
import { useProjectMaybe } from "../project";
import { personTodos, type Todo } from "./todos";

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
