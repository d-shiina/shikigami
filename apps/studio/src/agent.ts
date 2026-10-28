// The AI pane's conversation. Each message starts one background turn of the
// person's own agent (Claude Code by default) with Shikigami's MCP server;
// its edits arrive through the scenario watcher and the review queue like
// any other AI edit, so this store only keeps the conversation.
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentApi, AgentEvent, AgentInfo, AgentRequest, LoginEvent } from "./lib/api";

export type AgentPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string | null }
  | { kind: "toolFailed"; message: string };

export type ChatItem =
  | {
      role: "person";
      id: string;
      text: string;
      context: string | null;
      /** Kept so the message can be sent again, e.g. after signing in. */
      scenario: AgentRequest["scenario"] | null;
    }
  | {
      role: "ai";
      id: string;
      turnId: string;
      parts: AgentPart[];
      status: "running" | "done" | "failed";
      message: string | null;
      /** Failed because the agent is signed out or its login expired. */
      needsLogin: boolean;
    };

/** Signing the agent in from the pane. */
export type LoginState =
  | { phase: "idle" }
  | { phase: "waiting"; url: string | null; sendingCode: boolean }
  | { phase: "failed"; message: string };

export type AgentState = {
  info: AgentInfo | null;
  open: boolean;
  items: ChatItem[];
  /** The conversation to continue; kept across restarts. */
  sessionId: string | null;
  /** The turn in flight. */
  turnId: string | null;
  /** A message is on its way and its turn id not known yet. */
  sending: boolean;
  login: LoginState;
  init(): Promise<void>;
  setOpen(open: boolean): void;
  /** `context` is a short label shown above the message, e.g. the scenario. */
  send(message: string, scenario?: AgentRequest["scenario"], context?: string | null): Promise<boolean>;
  stop(): Promise<void>;
  /** Sends the last message again. */
  retry(): Promise<boolean>;
  /** Starts the agent's own sign-in; the last message is sent again once it is done. */
  startLogin(): Promise<void>;
  submitLoginCode(code: string): Promise<boolean>;
  cancelLogin(): Promise<void>;
  onLoginEvent(event: LoginEvent): void;
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
    // Sends the message already shown as the last person item and adds the reply.
    const dispatch = async (text: string, scenario: AgentRequest["scenario"] | null): Promise<boolean> => {
      set({ open: true, sending: true });
      try {
        const turnId = await api.send({ message: text, sessionId: get().info?.remembers ? get().sessionId : null, scenario });
        set({
          turnId,
          sending: false,
          items: [
            ...get().items,
            { role: "ai", id: nextId(), turnId, parts: [], status: "running", message: null, needsLogin: false },
          ],
        });
        for (const e of early.get(turnId) ?? []) get().onEvent(e);
        early.delete(turnId);
        return true;
      } catch (e) {
        set({
          sending: false,
          items: [
            ...get().items,
            { role: "ai", id: nextId(), turnId: "", parts: [], status: "failed", message: errorText(e), needsLogin: false },
          ],
        });
        return false;
      }
    };
    return {
      info: null,
      open: false,
      items: [],
      sessionId: loadSession(),
      turnId: null,
      sending: false,
      login: { phase: "idle" },

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
        if (!text || get().turnId || get().sending) return false;
        const person: ChatItem = { role: "person", id: nextId(), text, context, scenario: scenario ?? null };
        set({ items: [...get().items, person] });
        return dispatch(text, scenario ?? null);
      },

      async stop() {
        const turnId = get().turnId;
        if (turnId) await api.stop(turnId).catch(() => undefined);
      },

      async retry() {
        if (get().turnId || get().sending) return false;
        const items = get().items;
        let index = items.length - 1;
        while (index >= 0 && items[index]?.role !== "person") index--;
        const last = items[index];
        if (!last || last.role !== "person") return false;
        // The same message again: replace the failed reply instead of repeating the message.
        set({ items: items.slice(0, index + 1) });
        return dispatch(last.text, last.scenario);
      },

      async startLogin() {
        set({ login: { phase: "waiting", url: null, sendingCode: false } });
        try {
          await api.login();
        } catch (e) {
          set({ login: { phase: "failed", message: errorText(e) } });
        }
      },

      async submitLoginCode(code) {
        const login = get().login;
        if (login.phase !== "waiting" || !code.trim()) return false;
        set({ login: { ...login, sendingCode: true } });
        try {
          await api.loginCode(code);
          return true;
        } catch (e) {
          set({ login: { phase: "failed", message: errorText(e) } });
          return false;
        } finally {
          const now = get().login;
          if (now.phase === "waiting") set({ login: { ...now, sendingCode: false } });
        }
      },

      async cancelLogin() {
        set({ login: { phase: "idle" } });
        await api.cancelLogin().catch(() => undefined);
      },

      onLoginEvent(event) {
        const login = get().login;
        if (login.phase !== "waiting") return;
        if (event.kind === "url") {
          set({ login: { ...login, url: event.url } });
          return;
        }
        if (!event.ok) {
          set({ login: { phase: "failed", message: event.message ?? "ログインできませんでした" } });
          return;
        }
        set({ login: { phase: "idle" } });
        // Signed in: carry on with what the expired login interrupted.
        const last = get().items.at(-1);
        if (last?.role === "ai" && last.needsLogin) void get().retry();
      },

      reset() {
        if (get().turnId || get().sending) return;
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
            updateTurn(event.turnId, (i) => ({
              ...i,
              // Claude Code also says the error as the reply; show it once.
              parts: event.ok ? i.parts : i.parts.filter((p) => !(p.kind === "text" && p.text.trim() === event.message?.trim())),
              status: event.ok ? "done" : "failed",
              message: event.message,
              needsLogin: !event.ok && event.needsLogin,
            }));
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
