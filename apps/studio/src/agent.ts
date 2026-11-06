// The AI pane's conversations. Each message starts one background turn of
// the person's own agent (Claude Code by default) with Shikigami's MCP
// server; its edits arrive through the scenario watcher and the review queue
// like any other AI edit, so this store only keeps the conversations.
//
// A conversation belongs to one scenario (or to a scenario not created yet),
// and each runs in its own agent process, so the AI can work on several
// scenarios at once while the pane shows the one open in the editor.
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentApi, AgentEvent, AgentInfo, AgentRequest, LoginEvent } from "./lib/api";
import { t } from "./lib/i18n";

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
      /** What the agent is told, when it differs from what the person wrote. */
      prompt?: string;
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

export type Chat = {
  id: string;
  /** The scenario it is about; null until the AI creates one. */
  scenarioId: string | null;
  /** The scenario's name, or the first message of a chat without a scenario. */
  title: string;
  items: ChatItem[];
  /** The agent's conversation to continue; kept across restarts. */
  sessionId: string | null;
  /** The turn in flight. */
  turnId: string | null;
  /** A message is on its way and its turn id not known yet. */
  sending: boolean;
  /** Finished while it was not on screen. */
  unread: boolean;
  /**
   * A correction sent while the AI was working: the running turn is being
   * stopped, and this message goes out as soon as it has.
   */
  interrupting: Extract<ChatItem, { role: "person" }> | null;
  /** What the person is writing here and has not sent. */
  draft: string;
  updatedAt: number;
};

/** Signing the agent in from the pane. */
export type LoginState =
  | { phase: "idle" }
  | { phase: "waiting"; url: string | null; sendingCode: boolean }
  | { phase: "failed"; message: string };

export type ScenarioLabel = { id: string; name: string };

export type AgentState = {
  info: AgentInfo | null;
  open: boolean;
  chats: Chat[];
  /** The conversation the pane shows. */
  current: string;
  login: LoginState;
  init(): Promise<void>;
  setOpen(open: boolean): void;
  /** The editor opened another scenario: show its conversation. */
  focus(scenario: ScenarioLabel | null): void;
  select(chatId: string): void;
  /** A new conversation about `scenario` (null: one that creates a scenario). */
  newChat(scenario: ScenarioLabel | null): void;
  setDraft(chatId: string, draft: string): void;
  /** Forgets a conversation that is not running. */
  remove(chatId: string): void;
  /**
   * Sends to the conversation about `scenario` and shows it. `context` is a
   * short label shown above the message, e.g. the scenario.
   */
  send(message: string, scenario?: AgentRequest["scenario"], context?: string | null): Promise<boolean>;
  /** Sends to one conversation, whichever scenario is open. */
  sendIn(chatId: string, message: string, scenario: AgentRequest["scenario"] | null, context?: string | null): Promise<boolean>;
  stop(chatId?: string): Promise<void>;
  /** Sends the last message of a conversation again. */
  retry(chatId?: string): Promise<boolean>;
  /** Starts the agent's own sign-in; the stopped messages are sent again once it is done. */
  startLogin(): Promise<void>;
  submitLoginCode(code: string): Promise<boolean>;
  cancelLogin(): Promise<void>;
  onLoginEvent(event: LoginEvent): void;
  onEvent(event: AgentEvent): void;
};

export const isBusy = (chat: Chat | undefined): boolean => !!chat && (chat.turnId !== null || chat.sending);

export function currentChat(s: Pick<AgentState, "chats" | "current">): Chat {
  return s.chats.find((c) => c.id === s.current) ?? s.chats[0]!;
}

export const anyBusy = (s: Pick<AgentState, "chats">): boolean => s.chats.some(isBusy);

/** The AI is already working on this scenario in some conversation (other than `except`). */
export const scenarioBusy = (s: Pick<AgentState, "chats">, scenarioId: string | null | undefined, except?: string): boolean =>
  !!scenarioId && s.chats.some((c) => c.id !== except && c.scenarioId === scenarioId && isBusy(c));

/**
 * Put before a correction, so the agent resuming the conversation knows its
 * last turn was cut short on purpose and what is already done stays done.
 */
export const INTERRUPT_NOTE =
  "[The person stopped your previous turn midway to send this correction. Edits you made before that are already in the scenario; check with get_scenario before redoing anything. Follow this message over the earlier request where they differ.]";

const CHATS_KEY = "shikigami.studio.agentChats";
/** Before conversations per scenario: one conversation for everything. */
const OLD_SESSION_KEY = "shikigami.studio.agentSession";
const KEEP = 30;

type Saved = Pick<Chat, "id" | "scenarioId" | "title" | "sessionId" | "updatedAt">;

function load(): Saved[] {
  try {
    const raw = globalThis.localStorage?.getItem(CHATS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Saved[];
      if (Array.isArray(saved)) return saved.filter((c) => typeof c?.id === "string");
    }
    const old = globalThis.localStorage?.getItem(OLD_SESSION_KEY);
    if (old) return [{ id: "chat_earlier", scenarioId: null, title: t.agent.earlier, sessionId: old, updatedAt: 0 }];
  } catch {
    // Only lets the next start continue the conversations.
  }
  return [];
}

function save(chats: Chat[]) {
  try {
    const keep: Saved[] = chats
      .filter((c) => c.sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, KEEP)
      .map(({ id, scenarioId, title, sessionId, updatedAt }) => ({ id, scenarioId, title, sessionId, updatedAt }));
    globalThis.localStorage?.setItem(CHATS_KEY, JSON.stringify(keep));
    globalThis.localStorage?.removeItem(OLD_SESSION_KEY);
  } catch {
    // As above.
  }
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${++seq}`;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const titleOf = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};

function blank(scenario: ScenarioLabel | null): Chat {
  return {
    id: nextId("chat"),
    scenarioId: scenario?.id ?? null,
    title: scenario?.name ?? "",
    items: [],
    sessionId: null,
    turnId: null,
    sending: false,
    unread: false,
    interrupting: null,
    draft: "",
    updatedAt: Date.now(),
  };
}

/** Nothing said and nothing to continue: no need to keep it in the list. */
const empty = (c: Chat) => c.items.length === 0 && !c.sessionId && !isBusy(c) && !c.draft.trim();

export function createAgentStore(api: AgentApi): StoreApi<AgentState> {
  return createStore<AgentState>()((set, get) => {
    const chat = (id: string) => get().chats.find((c) => c.id === id);
    const update = (id: string, change: (c: Chat) => Chat) => {
      set({ chats: get().chats.map((c) => (c.id === id ? change(c) : c)) });
    };
    const updateTurn = (turnId: string, change: (item: Extract<ChatItem, { role: "ai" }>) => ChatItem) => {
      const owner = get().chats.find((c) => c.items.some((i) => i.role === "ai" && i.turnId === turnId));
      if (owner) update(owner.id, (c) => ({ ...c, items: c.items.map((i) => (i.role === "ai" && i.turnId === turnId ? change(i) : i)) }));
      return owner;
    };
    /** Shows `id`, dropping conversations left empty. */
    const show = (id: string, chats = get().chats) => {
      set({
        current: id,
        chats: chats.filter((c) => c.id === id || !empty(c)).map((c) => (c.id === id && c.unread ? { ...c, unread: false } : c)),
      });
    };
    /** The latest conversation about a scenario, or about creating one. */
    const latest = (scenarioId: string | null, chats = get().chats) =>
      chats.filter((c) => c.scenarioId === scenarioId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    // Events can outrun the reply that names their turn.
    const early = new Map<string, AgentEvent[]>();
    // Sends the message already shown as the last person item and adds the reply.
    const dispatch = async (chatId: string, text: string, scenario: AgentRequest["scenario"] | null): Promise<boolean> => {
      // The reply shows at once, so the person sees the message was taken
      // while the agent starts (which can take a while: a dev build first
      // rebuilds the MCP server). It has no turn until the agent is running.
      const id = nextId("item");
      const reply = (c: Chat, change: Partial<Extract<ChatItem, { role: "ai" }>>) =>
        c.items.map((i) => (i.id === id && i.role === "ai" ? { ...i, ...change } : i));
      set({ open: true });
      update(chatId, (c) => ({
        ...c,
        sending: true,
        updatedAt: Date.now(),
        items: [...c.items, { role: "ai", id, turnId: "", parts: [], status: "running", message: null, needsLogin: false }],
      }));
      try {
        const sessionId = get().info?.remembers ? (chat(chatId)?.sessionId ?? null) : null;
        const turnId = await api.send({ message: text, sessionId, scenario });
        update(chatId, (c) => ({ ...c, turnId, sending: false, items: reply(c, { turnId }) }));
        for (const e of early.get(turnId) ?? []) get().onEvent(e);
        early.delete(turnId);
        // Corrected before the agent had even started.
        if (chat(chatId)?.interrupting && chat(chatId)?.turnId === turnId) await api.stop(turnId).catch(() => undefined);
        return true;
      } catch (e) {
        update(chatId, (c) => ({ ...c, sending: false, items: reply(c, { status: "failed", message: errorText(e) }) }));
        void sendInterrupting(chatId);
        return false;
      }
    };
    /** The turn a correction waited for has ended: send the correction. */
    const sendInterrupting = (chatId: string) => {
      const waiting = chat(chatId)?.interrupting;
      if (!waiting || isBusy(chat(chatId))) return Promise.resolve(false);
      update(chatId, (c) => ({ ...c, interrupting: null }));
      return dispatch(chatId, waiting.prompt ?? waiting.text, waiting.scenario);
    };
    const restored: Chat[] = load().map((c) => ({ ...c, items: [], turnId: null, sending: false, unread: false, interrupting: null, draft: "" }));
    const first = blank(null);
    return {
      info: null,
      open: false,
      chats: [first, ...restored],
      current: first.id,
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
        if (open) show(get().current);
      },

      focus(scenario) {
        const id = scenario?.id ?? null;
        const now = currentChat(get());
        if (now.scenarioId === id) {
          if (scenario && now.title !== scenario.name) update(now.id, (c) => ({ ...c, title: scenario.name }));
          return;
        }
        const found = latest(id);
        if (found) {
          if (scenario && found.title !== scenario.name) update(found.id, (c) => ({ ...c, title: scenario.name }));
          show(found.id);
          return;
        }
        const fresh = blank(scenario);
        show(fresh.id, [fresh, ...get().chats]);
      },

      setDraft(chatId, draft) {
        update(chatId, (c) => ({ ...c, draft }));
      },

      select(chatId) {
        if (chat(chatId)) show(chatId);
      },

      newChat(scenario) {
        const now = currentChat(get());
        if (empty(now) && now.scenarioId === (scenario?.id ?? null)) return;
        const fresh = blank(scenario);
        show(fresh.id, [fresh, ...get().chats]);
      },

      remove(chatId) {
        const target = chat(chatId);
        if (!target || isBusy(target)) return;
        const rest = get().chats.filter((c) => c.id !== chatId);
        if (get().current === chatId) {
          // Stay on the same scenario: its older conversation, or a new one.
          const next = latest(target.scenarioId, rest) ?? blank(target.scenarioId ? { id: target.scenarioId, name: target.title } : null);
          show(next.id, rest.includes(next) ? rest : [next, ...rest]);
        } else {
          set({ chats: rest });
        }
        save(get().chats);
      },

      async send(message, scenario, context = null) {
        const id = scenario?.id ?? null;
        const now = currentChat(get());
        let target = now.scenarioId === id ? now : latest(id);
        if (!target) {
          target = blank(scenario ? { id: scenario.id, name: scenario.name } : null);
          set({ chats: [target, ...get().chats] });
        }
        if (isBusy(target) || scenarioBusy(get(), id, target.id)) return false;
        show(target.id);
        return get().sendIn(target.id, message, scenario ?? null, context);
      },

      async sendIn(chatId, message, scenario, context = null) {
        const text = message.trim();
        const target = chat(chatId);
        if (!text || !target || target.interrupting || scenarioBusy(get(), target.scenarioId, chatId)) return false;
        if (isBusy(target)) {
          // A correction mid-turn: stop the turn, then send this in the same
          // conversation so the agent keeps what it has done and heard.
          const person = { role: "person" as const, id: nextId("item"), text, context, scenario, prompt: `${INTERRUPT_NOTE}\n\n${text}` };
          update(chatId, (c) => ({ ...c, interrupting: person, items: [...c.items, person] }));
          if (target.turnId) await api.stop(target.turnId).catch(() => undefined);
          return true;
        }
        const person: ChatItem = { role: "person", id: nextId("item"), text, context, scenario };
        update(chatId, (c) => ({ ...c, title: c.title || titleOf(text), items: [...c.items, person] }));
        return dispatch(chatId, text, scenario);
      },

      async stop(chatId = get().current) {
        const turnId = chat(chatId)?.turnId;
        if (turnId) await api.stop(turnId).catch(() => undefined);
      },

      async retry(chatId = get().current) {
        const target = chat(chatId);
        if (!target || isBusy(target) || scenarioBusy(get(), target.scenarioId, chatId)) return false;
        const items = target.items;
        let index = items.length - 1;
        while (index >= 0 && items[index]?.role !== "person") index--;
        const last = items[index];
        if (!last || last.role !== "person") return false;
        // The same message again: replace the failed reply instead of repeating the message.
        update(chatId, (c) => ({ ...c, items: items.slice(0, index + 1) }));
        return dispatch(chatId, last.prompt ?? last.text, last.scenario);
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
          set({ login: { phase: "failed", message: event.message ?? t.agent.loginFailed } });
          return;
        }
        set({ login: { phase: "idle" } });
        // Signed in: carry on with what the expired login interrupted, in every
        // conversation, but one per scenario (retry refuses a second one).
        for (const c of [...get().chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
          const last = c.items.at(-1);
          if (last?.role === "ai" && last.needsLogin) void get().retry(c.id);
        }
      },

      onEvent(event) {
        const owner = get().chats.find((c) => c.turnId === event.turnId || c.items.some((i) => i.role === "ai" && i.turnId === event.turnId));
        if (!owner) {
          early.set(event.turnId, [...(early.get(event.turnId) ?? []), event]);
          return;
        }
        switch (event.kind) {
          case "session":
            update(owner.id, (c) => ({ ...c, sessionId: event.sessionId }));
            save(get().chats);
            return;
          case "created": {
            if (owner.scenarioId) return;
            // A conversation that set out to make a scenario now belongs to it;
            // an empty one the editor opened for that scenario meanwhile gives way.
            const placeholder = get().chats.find((c) => c.scenarioId === event.scenarioId && empty(c));
            update(owner.id, (c) => ({ ...c, scenarioId: event.scenarioId, title: event.name || c.title }));
            if (placeholder) {
              const rest = get().chats.filter((c) => c.id !== placeholder.id);
              if (get().current === placeholder.id) show(owner.id, rest);
              else set({ chats: rest });
            }
            save(get().chats);
            return;
          }
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
          case "done": {
            // Stopped for a correction: not a failure, the conversation goes on.
            const cut = owner.interrupting !== null && !event.ok;
            updateTurn(event.turnId, (i) => ({
              ...i,
              // Claude Code also says the error as the reply; show it once.
              parts: event.ok ? i.parts : i.parts.filter((p) => !(p.kind === "text" && p.text.trim() === event.message?.trim())),
              status: event.ok || cut ? "done" : "failed",
              message: cut ? t.agent.interrupted : event.message,
              needsLogin: !event.ok && !cut && event.needsLogin,
            }));
            update(owner.id, (c) => ({
              ...c,
              turnId: c.turnId === event.turnId ? null : c.turnId,
              unread: c.unread || get().current !== c.id || !get().open,
              updatedAt: Date.now(),
            }));
            void sendInterrupting(owner.id);
            return;
          }
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

/** The store itself, for handlers that read the state when they run (menus). */
export function useAgentApi(): StoreApi<AgentState> {
  const store = useContext(AgentContext);
  if (!store) throw new Error("AgentContext is missing");
  return store;
}
