// The AI pane's conversation. Each message starts one background turn of the
// person's own agent (Claude Code by default) with Shikigami's MCP server;
// its edits arrive through the scenario watcher and the review queue like
// any other AI edit, so this store only keeps the conversation.
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentApi, AgentEvent, AgentInfo, AgentRequest } from "./lib/api";

export type AgentPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string | null }
  | { kind: "toolFailed"; message: string };

export type ChatItem =
  | { role: "person"; id: string; text: string; context: string | null }
  | {
      role: "ai";
      id: string;
      turnId: string;
      parts: AgentPart[];
      status: "running" | "done" | "failed";
      message: string | null;
    };

export type AgentState = {
  info: AgentInfo | null;
  open: boolean;
  items: ChatItem[];
  /** The conversation to continue; kept across restarts. */
  sessionId: string | null;
  /** The turn in flight. */
  turnId: string | null;
  init(): Promise<void>;
  setOpen(open: boolean): void;
  /** `context` is a short label shown above the message, e.g. the scenario. */
  send(message: string, scenario?: AgentRequest["scenario"], context?: string | null): Promise<boolean>;
  stop(): Promise<void>;
  /** Starts a new conversation. */
  reset(): void;
  onEvent(event: AgentEvent): void;
};

const SESSION_KEY = "shikigami.studio.agentSession";

function loadSession(): string | null {
  try {
    return globalThis.localStorage?.getItem(SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveSession(id: string | null) {
  try {
    if (id) globalThis.localStorage?.setItem(SESSION_KEY, id);
    else globalThis.localStorage?.removeItem(SESSION_KEY);
  } catch {
    // Only lets the next start continue the conversation.
  }
}

let seq = 0;
const nextId = () => `chat_${++seq}`;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createAgentStore(api: AgentApi): StoreApi<AgentState> {
  return createStore<AgentState>()((set, get) => {
    const updateTurn = (turnId: string, change: (item: Extract<ChatItem, { role: "ai" }>) => ChatItem) =>
      set({ items: get().items.map((i) => (i.role === "ai" && i.turnId === turnId ? change(i) : i)) });
    // Events can outrun the reply that names their turn.
    const early = new Map<string, AgentEvent[]>();
    return {
      info: null,
      open: false,
      items: [],
      sessionId: loadSession(),
      turnId: null,

      async init() {
        try {
          set({ info: await api.info() });
        } catch (e) {
          set({ info: { available: false, name: "AI", command: null, problem: errorText(e), remembers: false } });
        }
      },

      setOpen(open) {
        set({ open });
      },

      async send(message, scenario, context = null) {
        const text = message.trim();
        if (!text || get().turnId) return false;
        const person: ChatItem = { role: "person", id: nextId(), text, context };
        set({ items: [...get().items, person], open: true });
        try {
          const turnId = await api.send({ message: text, sessionId: get().info?.remembers ? get().sessionId : null, scenario });
          set({
            turnId,
            items: [...get().items, { role: "ai", id: nextId(), turnId, parts: [], status: "running", message: null }],
          });
          for (const e of early.get(turnId) ?? []) get().onEvent(e);
          early.delete(turnId);
          return true;
        } catch (e) {
          set({
            items: [
              ...get().items,
              { role: "ai", id: nextId(), turnId: "", parts: [], status: "failed", message: errorText(e) },
            ],
          });
          return false;
        }
      },

      async stop() {
        const turnId = get().turnId;
        if (turnId) await api.stop(turnId).catch(() => undefined);
      },

      reset() {
        if (get().turnId) return;
        saveSession(null);
        set({ items: [], sessionId: null });
      },

      onEvent(event) {
        if (event.kind !== "session" && !get().items.some((i) => i.role === "ai" && i.turnId === event.turnId)) {
          early.set(event.turnId, [...(early.get(event.turnId) ?? []), event]);
          return;
        }
        switch (event.kind) {
          case "session":
            saveSession(event.sessionId);
            set({ sessionId: event.sessionId });
            return;
          case "text":
            updateTurn(event.turnId, (i) => ({ ...i, parts: [...i.parts, { kind: "text", text: event.text }] }));
            return;
          case "tool":
            updateTurn(event.turnId, (i) => ({
              ...i,
              parts: [...i.parts, { kind: "tool", name: event.name, detail: event.detail }],
            }));
            return;
          case "toolFailed":
            updateTurn(event.turnId, (i) => ({
              ...i,
              parts: [...i.parts, { kind: "toolFailed", message: event.message }],
            }));
            return;
          case "done":
            updateTurn(event.turnId, (i) => ({ ...i, status: event.ok ? "done" : "failed", message: event.message }));
            if (get().turnId === event.turnId) set({ turnId: null });
            return;
        }
      },
    };
  });
}

export const AgentContext = createContext<StoreApi<AgentState> | null>(null);

export function useAgent<T>(selector: (state: AgentState) => T): T {
  const store = useContext(AgentContext);
  if (!store) throw new Error("AgentContext is missing");
  return useStore(store, selector);
}
