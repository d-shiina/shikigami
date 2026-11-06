// What the run window shows while a run goes: the flow's top-level
// steps, ticked off as the run passes them, and the step it is on now.
import type { RunError, RunEventEnvelope, RunStatus, Flow, Step } from "@shikigami/schema";
import { topOf, topSteps } from "./form";

export type TopState = "waiting" | "running" | "done" | "failed";

export interface Progress {
  tops: { step: Step; state: TopState }[];
  /** The step the run is on (any depth in the started flow). */
  now: Step | null;
  /** When the run started (the first event). */
  startedAt: string | null;
  finished: { status: RunStatus; error: RunError | null; durationMs: number } | null;
}

export function progress(flow: Flow, events: RunEventEnvelope[]): Progress {
  const tops = topSteps(flow);
  const top = topOf(flow);
  const states = new Map<string, TopState>();
  const byId = new Map<string, Step>();
  const index = (steps: Step[]) => {
    for (const s of steps) {
      if (s.id) byId.set(s.id, s);
      for (const children of Object.values(s.blocks ?? {})) index(children);
    }
  };
  index(flow.steps ?? []);
  let now: Step | null = null;
  let finished: Progress["finished"] = null;
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of ordered) {
    // Inside a called flow, the call step of this one is what moves.
    const own = (e.callPath ?? [])[0] ?? ("stepId" in e ? e.stepId : undefined);
    const topId = own ? top.get(own) : undefined;
    if (e.type === "stepStarted") {
      if (topId) {
        // Starting a later step means the ones before it are behind.
        const at = tops.findIndex((s) => s.id === topId);
        for (const s of tops.slice(0, Math.max(0, at))) if (s.id && states.get(s.id) !== "failed") states.set(s.id, "done");
        states.set(topId, "running");
      }
      if ((e.callPath ?? []).length === 0) now = byId.get(e.stepId) ?? now;
    } else if (e.type === "stepFinished" && topId && e.stepId === topId && (e.callPath ?? []).length === 0) {
      states.set(topId, e.outcome === "failed" ? "failed" : "done");
    } else if (e.type === "runFinished") {
      finished = { status: e.status, error: e.error ?? null, durationMs: e.durationMs };
      now = null;
      if (e.status === "failed") for (const [id, state] of states) if (state === "running") states.set(id, "failed");
    }
  }
  return {
    tops: tops.map((step) => ({ step, state: (step.id && states.get(step.id)) || "waiting" })),
    now,
    startedAt: ordered[0]?.at ?? null,
    finished,
  };
}
