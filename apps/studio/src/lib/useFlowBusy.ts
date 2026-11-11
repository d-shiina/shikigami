// The AI is at work on the open flow. What it has made so far is not a
// finished change: it cannot be looked at as one, run, fixed as a version or
// handed on until the AI is done, so the buttons for those wait.
import { flowBusy, useAgentMaybe } from "../agent";
import { useStudio } from "../context";

export function useFlowBusy(): boolean {
  const id = useStudio((s) => s.flow?.id);
  return useAgentMaybe((a) => flowBusy(a, id), false);
}
