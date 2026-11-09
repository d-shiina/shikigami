// Calling the person when a run starts waiting for them while they work in
// another window (docs/design/attention.md): the taskbar button flashes
// and a Windows notification says what waits; clicking it brings this
// window to the front. Only when a wait starts, and only while the window
// is behind (the backend checks): its own banner says it otherwise.
import type { ApprovalRequest, Flow } from "@spellsheet/schema";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { PickRequest, SecretRequest } from "./api";
import { t } from "./i18n";

/** One wait: `tag` names it, so the notification is taken back when it ends. */
export interface Ask {
  tag: string;
  title: string;
  body: string;
}

export interface WaitingHuman {
  stepId: string;
  message: string;
  /** The step shows its own dialog in front of the other windows: nothing else to call. */
  dialog?: boolean;
}

/** A run of Writer, as far as calling the person goes. */
export interface WriterWaits {
  run: {
    runId: string;
    flowId: string | null;
    status: string;
    pause: { seq: number; stepId: string; reason: string; callPath: string[] } | null;
  } | null;
  human: WaitingHuman | null;
  flow: Pick<Flow, "id" | "name" | "steps"> | null;
  secretRequests: Pick<SecretRequest, "name">[];
  approvals: Pick<ApprovalRequest, "id">[];
  pickRequests: Pick<PickRequest, "id">[];
}

function stepName(steps: Flow["steps"], id: string): string | null {
  for (const s of steps ?? []) {
    if (s.id === id) return s.name?.trim() || null;
    for (const children of Object.values(s.blocks ?? {})) {
      const found = stepName(children, id);
      if (found !== null) return found;
    }
  }
  return null;
}

/** What Writer waits for the person for now, if anything. */
export function writerAsk(s: WriterWaits): Ask | null {
  const run = s.run;
  const flowName = run && s.flow && run.flowId === s.flow.id ? s.flow.name : null;
  if (run && s.human && !s.human.dialog) {
    return { tag: `human:${run.runId}:${s.human.stepId}`, title: t.attention.waiting(flowName), body: s.human.message };
  }
  // A pause the person did not ask for just now: an error, or a breakpoint
  // reached after the run went on by itself. A step (F10) or 「一時停止」 is theirs.
  const pause = run?.status === "paused" ? run.pause : null;
  if (run && pause && (pause.reason === "error" || pause.reason === "breakpoint")) {
    const node = pause.callPath.length === 0 && s.flow ? stepName(s.flow.steps, pause.stepId) : null;
    return {
      tag: `pause:${run.runId}:${pause.seq}`,
      title: pause.reason === "error" ? t.attention.pausedOnError(flowName) : t.attention.pausedAtBreakpoint(flowName),
      body: t.attention.pauseBody(node),
    };
  }
  // An AI waits in its chat for the person to answer here.
  const ai: [string, string][] = [
    ...s.secretRequests.map((r): [string, string] => [`secret:${r.name}`, t.bar.secretAskTitle]),
    ...s.approvals.map((r): [string, string] => [`approval:${r.id}`, t.approvalAsked]),
    ...s.pickRequests.map((r): [string, string] => [`pick:${r.id}`, t.pickAsked]),
  ];
  if (ai.length > 0) {
    return { tag: `ai:${ai.map(([key]) => key).join(",")}`, title: t.attention.aiTitle, body: ai[0]![1] };
  }
  return null;
}

export interface AttentionBackend {
  call: (ask: Ask) => Promise<void>;
  clear: (tag: string) => Promise<void>;
}

export const attentionApi: AttentionBackend = {
  call: (ask) => invoke<void>("call_attention", { title: ask.title, body: ask.body, tag: ask.tag }),
  clear: (tag) => invoke<void>("clear_attention", { tag }),
};

/**
 * Calls the person when `ask` starts (a new tag), and takes the call back
 * when it ends. An AI's requests that only grow (a second one comes) call
 * again; one answered while others wait does not.
 */
export function useAttention(ask: Ask | null, backend: AttentionBackend = attentionApi) {
  const shown = useRef<Ask | null>(null);
  const tag = ask?.tag ?? null;
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in globalThis) && backend === attentionApi) return;
    const before = shown.current;
    if (before?.tag === tag) return;
    if (before) void backend.clear(before.tag).catch(() => {});
    shown.current = ask;
    if (ask && !(before && isNarrower(ask.tag, before.tag))) void backend.call(ask).catch(() => {});
  }, [tag]);
  // Closing the window takes its call back too.
  useEffect(
    () => () => {
      if (shown.current) void backend.clear(shown.current.tag).catch(() => {});
    },
    [],
  );
}

/** `next` asks for part of what `prev` did (an AI's request answered, others left). */
function isNarrower(next: string, prev: string): boolean {
  if (!next.startsWith("ai:") || !prev.startsWith("ai:")) return false;
  const was = new Set(prev.slice(3).split(","));
  return next
    .slice(3)
    .split(",")
    .every((key) => was.has(key));
}
