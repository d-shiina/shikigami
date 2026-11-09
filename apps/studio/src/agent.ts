// The AI pane's conversations. Each message starts one background turn of
// the person's own agent (Claude Code, Codex, Gemini CLI or GitHub Copilot) with SpellSheet's MCP
// server; its edits arrive through the flow watcher and the review queue
// like any other AI edit, so this store only keeps the conversations.
//
// A conversation belongs to one flow (or to a flow not created yet),
// and each runs in its own agent process, so the AI can work on several
// flows at once while the pane shows the one open in the editor.
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentApi, AgentChoice, AgentEvent, ChoiceOption, AgentInfo, AgentKind, AgentRequest, InstallEvent, LoginEvent } from "./lib/api";
import { t } from "./lib/i18n";

export type AgentPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string | null }
  | { kind: "toolFailed"; message: string }
  /**
   * The AI asks the person to choose. `answer` is what they pressed or
   * wrote next; until then the card offers the options.
   */
  | { kind: "choice"; question: string; options: ChoiceOption[]; recommended: number | null; reason: string | null; answer: string | null };

export type ChatItem =
  | {
      role: "person";
      id: string;
      text: string;
      context: string | null;
      /** Kept so the message can be sent again, e.g. after signing in. */
      flow: AgentRequest["flow"] | null;
      /** What the agent is told, when it differs from what the person wrote. */
      prompt?: string;
      /** Answers the AI's card above, which shows it, so it is not drawn again. */
      answers?: boolean;
    }
  | {
      role: "ai";
      id: string;
      turnId: string;
      parts: AgentPart[];
      status: "running" | "done" | "failed";
      /** The tool call being written now, before it shows as a part. */
      preparing: string | null;
      message: string | null;
      /** Failed because the agent is signed out or its login expired. */
      needsLogin: boolean;
    };

export type Chat = {
  id: string;
  /** The flow it is about; null until the AI creates one. */
  flowId: string | null;
  /** The flow's name, or the first message of a chat without a flow. */
  title: string;
  items: ChatItem[];
  /** The agent's conversation to continue; kept across restarts. */
  sessionId: string | null;
  /** Which agent `sessionId` belongs to (missing in chats from before there was a choice: Claude Code). */
  agent?: AgentKind;
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

/** Installing the agent from the pane. */
export type InstallState =
  | { phase: "idle" }
  | { phase: "running"; lines: string[] }
  /** Asked to stop; the button is back once the installer is gone. */
  | { phase: "stopping" }
  | { phase: "failed"; message: string };

export type FlowLabel = { id: string; name: string };

export type AgentState = {
  info: AgentInfo | null;
  open: boolean;
  chats: Chat[];
  /** The conversation the pane shows. */
  current: string;
  login: LoginState;
  install: InstallState;
  /** The agents Studio can run; null until read. */
  choices: AgentChoice[] | null;
  init(): Promise<void>;
  /** Uses another agent from the next message on. */
  chooseAgent(kind: AgentKind): Promise<void>;
  setOpen(open: boolean): void;
  /** The editor opened another flow: show its conversation. */
  focus(flow: FlowLabel | null): void;
  select(chatId: string): void;
  /** A new conversation about `flow` (null: one that creates a flow). */
  newChat(flow: FlowLabel | null): void;
  setDraft(chatId: string, draft: string): void;
  /** Forgets a conversation that is not running. */
  remove(chatId: string): void;
  /**
   * Sends to the conversation about `flow` and shows it. `context` is a
   * short label shown above the message, e.g. the flow.
   */
  send(message: string, flow?: AgentRequest["flow"], context?: string | null): Promise<boolean>;
  /** Sends to one conversation, whichever flow is open. */
  sendIn(chatId: string, message: string, flow: AgentRequest["flow"] | null, context?: string | null): Promise<boolean>;
  stop(chatId?: string): Promise<void>;
  /** Sends the last message of a conversation again. */
  retry(chatId?: string): Promise<boolean>;
  /** Starts the agent's own sign-in; the stopped messages are sent again once it is done. */
  startLogin(): Promise<void>;
  submitLoginCode(code: string): Promise<boolean>;
  cancelLogin(): Promise<void>;
  onLoginEvent(event: LoginEvent): void;
  /** Installs the agent with its own installer, then signs in when needed. */
  startInstall(kind: AgentKind): Promise<void>;
  cancelInstall(): Promise<void>;
  onInstallEvent(event: InstallEvent): void;
  onEvent(event: AgentEvent): void;
};

export const isBusy = (chat: Chat | undefined): boolean => !!chat && (chat.turnId !== null || chat.sending);

export function currentChat(s: Pick<AgentState, "chats" | "current">): Chat {
  return s.chats.find((c) => c.id === s.current) ?? s.chats[0]!;
}

export const anyBusy = (s: Pick<AgentState, "chats">): boolean => s.chats.some(isBusy);

/** The AI is already working on this flow in some conversation (other than `except`). */
export const flowBusy = (s: Pick<AgentState, "chats">, flowId: string | null | undefined, except?: string): boolean =>
  !!flowId && s.chats.some((c) => c.id !== except && c.flowId === flowId && isBusy(c));

/**
 * Put before a correction, so the agent resuming the conversation knows its
 * last turn was cut short on purpose and what is already done stays done.
 */
export const INTERRUPT_NOTE =
  "[The person stopped your previous turn midway to send this correction. Edits you made before that are already in the flow; check with get_flow before redoing anything. Follow this message over the earlier request where they differ.]";

const CHATS_KEY = "spellsheet.studio.agentChats";
/** Before conversations per flow: one conversation for everything. */
const OLD_SESSION_KEY = "spellsheet.studio.agentSession";
const KEEP = 30;

type Saved = Pick<Chat, "id" | "flowId" | "title" | "sessionId" | "agent" | "updatedAt">;

function load(): Saved[] {
  try {
    const raw = globalThis.localStorage?.getItem(CHATS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Saved[];
      if (Array.isArray(saved)) return saved.filter((c) => typeof c?.id === "string");
    }
    const old = globalThis.localStorage?.getItem(OLD_SESSION_KEY);
    if (old) return [{ id: "chat_earlier", flowId: null, title: t.agent.earlier, sessionId: old, updatedAt: 0 }];
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
      .map(({ id, flowId, title, sessionId, agent, updatedAt }) => ({ id, flowId, title, sessionId, agent, updatedAt }));
    globalThis.localStorage?.setItem(CHATS_KEY, JSON.stringify(keep));
    globalThis.localStorage?.removeItem(OLD_SESSION_KEY);
  } catch {
    // As above.
  }
}

/** The person's next message answers every card still waiting in the conversation. */
export const waitsForChoice = (items: ChatItem[]): boolean =>
  items.some((i) => i.role === "ai" && i.parts.some((p) => p.kind === "choice" && p.answer === null));

export function answerChoices(items: ChatItem[], answer: string): ChatItem[] {
  return items.map((i) =>
    i.role === "ai" && i.parts.some((p) => p.kind === "choice" && p.answer === null)
      ? { ...i, parts: i.parts.map((p) => (p.kind === "choice" && p.answer === null ? { ...p, answer } : p)) }
      : i,
  );
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

function blank(flow: FlowLabel | null): Chat {
  return {
    id: nextId("chat"),
    flowId: flow?.id ?? null,
    title: flow?.name ?? "",
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
    /** The latest conversation about a flow, or about creating one. */
    const latest = (flowId: string | null, chats = get().chats) =>
      chats.filter((c) => c.flowId === flowId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    // Events can outrun the reply that names their turn.
    const early = new Map<string, AgentEvent[]>();
    // Which agent ran each turn: the person may switch agents while one runs.
    const turnAgent = new Map<string, AgentKind>();
    // Sends the message already shown as the last person item and adds the reply.
    const dispatch = async (chatId: string, text: string, flow: AgentRequest["flow"] | null): Promise<boolean> => {
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
        items: [...c.items, { role: "ai", id, turnId: "", parts: [], status: "running", preparing: null, message: null, needsLogin: false }],
      }));
      try {
        const info = get().info;
        const c = chat(chatId);
        // Another agent cannot continue this one's conversation: it starts afresh.
        const sameAgent = (c?.agent ?? "claudeCode") === info?.kind;
        const sessionId = info?.remembers && sameAgent ? (c?.sessionId ?? null) : null;
        const turnId = await api.send({ message: text, sessionId, flow });
        if (info) turnAgent.set(turnId, info.kind);
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
      return dispatch(chatId, waiting.prompt ?? waiting.text, waiting.flow);
    };
    const restored: Chat[] = load().map((c) => ({ ...c, items: [], turnId: null, sending: false, unread: false, interrupting: null, draft: "" }));
    const first = blank(null);
    return {
      info: null,
      open: false,
      chats: [first, ...restored],
      current: first.id,
      login: { phase: "idle" },
      install: { phase: "idle" },
      choices: null,

      async init() {
        void api.choices().then(
          (choices) => set({ choices }),
          () => set({ choices: [] }),
        );
        try {
          set({ info: await api.info() });
        } catch (e) {
          set({ info: { available: false, kind: "claudeCode", name: "AI", command: null, problem: errorText(e), remembers: false, installable: false, signsIn: false } });
        }
      },

      setOpen(open) {
        set({ open });
        if (open) show(get().current);
      },

      focus(flow) {
        const id = flow?.id ?? null;
        const now = currentChat(get());
        if (now.flowId === id) {
          if (flow && now.title !== flow.name) update(now.id, (c) => ({ ...c, title: flow.name }));
          return;
        }
        const found = latest(id);
        if (found) {
          if (flow && found.title !== flow.name) update(found.id, (c) => ({ ...c, title: flow.name }));
          show(found.id);
          return;
        }
        const fresh = blank(flow);
        show(fresh.id, [fresh, ...get().chats]);
      },

      setDraft(chatId, draft) {
        update(chatId, (c) => ({ ...c, draft }));
      },

      select(chatId) {
        if (chat(chatId)) show(chatId);
      },

      newChat(flow) {
        const now = currentChat(get());
        if (empty(now) && now.flowId === (flow?.id ?? null)) return;
        const fresh = blank(flow);
        show(fresh.id, [fresh, ...get().chats]);
      },

      remove(chatId) {
        const target = chat(chatId);
        if (!target || isBusy(target)) return;
        const rest = get().chats.filter((c) => c.id !== chatId);
        if (get().current === chatId) {
          // Stay on the same flow: its older conversation, or a new one.
          const next = latest(target.flowId, rest) ?? blank(target.flowId ? { id: target.flowId, name: target.title } : null);
          show(next.id, rest.includes(next) ? rest : [next, ...rest]);
        } else {
          set({ chats: rest });
        }
        save(get().chats);
      },

      async send(message, flow, context = null) {
        const id = flow?.id ?? null;
        const now = currentChat(get());
        let target = now.flowId === id ? now : latest(id);
        if (!target) {
          target = blank(flow ? { id: flow.id, name: flow.name } : null);
          set({ chats: [target, ...get().chats] });
        }
        if (isBusy(target) || flowBusy(get(), id, target.id)) return false;
        show(target.id);
        return get().sendIn(target.id, message, flow ?? null, context);
      },

      async sendIn(chatId, message, flow, context = null) {
        const text = message.trim();
        const target = chat(chatId);
        if (!text || !target || target.interrupting || flowBusy(get(), target.flowId, chatId)) return false;
        if (isBusy(target)) {
          // A correction mid-turn: stop the turn, then send this in the same
          // conversation so the agent keeps what it has done and heard.
          const person = { role: "person" as const, id: nextId("item"), text, context, flow, prompt: `${INTERRUPT_NOTE}\n\n${text}`, answers: waitsForChoice(target.items) };
          update(chatId, (c) => ({ ...c, interrupting: person, items: [...answerChoices(c.items, text), person] }));
          if (target.turnId) await api.stop(target.turnId).catch(() => undefined);
          return true;
        }
        const person: ChatItem = { role: "person", id: nextId("item"), text, context, flow, answers: waitsForChoice(target.items) };
        update(chatId, (c) => ({ ...c, title: c.title || titleOf(text), items: [...answerChoices(c.items, text), person] }));
        return dispatch(chatId, text, flow);
      },

      async stop(chatId = get().current) {
        const turnId = chat(chatId)?.turnId;
        if (turnId) await api.stop(turnId).catch(() => undefined);
      },

      async retry(chatId = get().current) {
        const target = chat(chatId);
        if (!target || isBusy(target) || flowBusy(get(), target.flowId, chatId)) return false;
        const items = target.items;
        let index = items.length - 1;
        while (index >= 0 && items[index]?.role !== "person") index--;
        const last = items[index];
        if (!last || last.role !== "person") return false;
        // The same message again: replace the failed reply instead of repeating the message.
        update(chatId, (c) => ({ ...c, items: items.slice(0, index + 1) }));
        return dispatch(chatId, last.prompt ?? last.text, last.flow);
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

      async chooseAgent(kind) {
        if (get().info?.kind === kind) return;
        const info = await api.select(kind);
        set({ info, login: { phase: "idle" }, install: { phase: "idle" }, choices: (get().choices ?? []).map((c) => ({ ...c, selected: c.kind === kind })) });
      },

      async startInstall(kind) {
        set({ install: { phase: "running", lines: [] } });
        try {
          await api.install(kind);
        } catch (e) {
          set({ install: { phase: "failed", message: errorText(e) } });
        }
      },

      async cancelInstall() {
        if (get().install.phase !== "running") return;
        set({ install: { phase: "stopping" } });
        await api.cancelInstall().catch(() => set({ install: { phase: "idle" } }));
      },

      onInstallEvent(event) {
        const install = get().install;
        if (event.kind === "cancelled") {
          if (install.phase === "stopping") set({ install: { phase: "idle" } });
          return;
        }
        if (install.phase !== "running") return;
        if (event.kind === "progress") {
          set({ install: { phase: "running", lines: [...install.lines.slice(-19), event.line] } });
          return;
        }
        if (!event.ok) {
          set({ install: { phase: "failed", message: event.message ?? t.agent.installFailed } });
          return;
        }
        set({ install: { phase: "idle" } });
        // Installed: the pane now shows the agent, and signs in when the account is not there yet.
        void get().init();
        if (event.needsLogin) void get().startLogin();
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
        // conversation, but one per flow (retry refuses a second one).
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
            update(owner.id, (c) => ({ ...c, sessionId: event.sessionId, agent: turnAgent.get(event.turnId) ?? get().info?.kind }));
            save(get().chats);
            return;
          case "created": {
            if (owner.flowId) return;
            // A conversation that set out to make a flow now belongs to it;
            // an empty one the editor opened for that flow meanwhile gives way.
            const placeholder = get().chats.find((c) => c.flowId === event.flowId && empty(c));
            update(owner.id, (c) => ({ ...c, flowId: event.flowId, title: event.name || c.title }));
            if (placeholder) {
              const rest = get().chats.filter((c) => c.id !== placeholder.id);
              if (get().current === placeholder.id) show(owner.id, rest);
              else set({ chats: rest });
            }
            save(get().chats);
            return;
          }
          case "preparing":
            updateTurn(event.turnId, (i) => ({ ...i, preparing: event.name }));
            return;
          case "text":
            updateTurn(event.turnId, (i) => ({ ...i, parts: [...i.parts, { kind: "text", text: event.text }] }));
            return;
          case "tool":
            updateTurn(event.turnId, (i) => ({
              ...i,
              preparing: null,
              parts: [...i.parts, { kind: "tool", name: event.name, detail: event.detail }],
            }));
            return;
          case "choice":
            updateTurn(event.turnId, (i) => ({
              ...i,
              preparing: null,
              parts: [
                ...i.parts,
                { kind: "choice", question: event.question, options: event.options, recommended: event.recommended, reason: event.reason, answer: null },
              ],
            }));
            return;
          case "toolFailed":
            updateTurn(event.turnId, (i) => ({
              ...i,
              parts: [...i.parts, { kind: "toolFailed", message: event.message }],
            }));
            return;
          case "done": {
            turnAgent.delete(event.turnId);
            // Stopped for a correction: not a failure, the conversation goes on.
            const cut = owner.interrupting !== null && !event.ok;
            updateTurn(event.turnId, (i) => ({
              ...i,
              // Claude Code also says the error as the reply; show it once.
              parts: event.ok ? i.parts : i.parts.filter((p) => !(p.kind === "text" && p.text.trim() === event.message?.trim())),
              status: event.ok || cut ? "done" : "failed",
              message: cut ? t.agent.interrupted : event.message,
              needsLogin: !event.ok && !cut && event.needsLogin,
              preparing: null,
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

/**
 * What the AI is doing right now, for the places that report it outside the
 * pane (the status bar, the flow chart following its edits): null when idle.
 */
export type AgentActivity = {
  /** The flow open when the person asked, if any. */
  flowId: string | null;
  /** The tool it is writing or last called, e.g. "add_step"; null while it thinks. */
  tool: string | null;
};

export function activity(state: Pick<AgentState, "chats" | "current">): AgentActivity | null {
  // The conversation on screen if it is working, else the latest one that is.
  const shown = state.chats.find((c) => c.id === state.current);
  const chat = isBusy(shown) ? shown : [...state.chats].filter(isBusy).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!chat) return null;
  const items = chat.items;
  const reply = items.at(-1);
  let person: Extract<ChatItem, { role: "person" }> | undefined;
  for (let i = items.length - 1; i >= 0 && !person; i--) {
    const item = items[i];
    if (item?.role === "person") person = item;
  }
  let tool: string | null = null;
  if (reply?.role === "ai") {
    if (reply.preparing) tool = reply.preparing;
    else
      for (let i = reply.parts.length - 1; i >= 0 && !tool; i--) {
        const part = reply.parts[i];
        if (part?.kind === "tool") tool = part.name;
      }
  }
  return { flowId: chat.flowId ?? person?.flow?.id ?? null, tool };
}

export const AgentContext = createContext<StoreApi<AgentState> | null>(null);

export function useAgent<T>(selector: (state: AgentState) => T): T {
  const store = useContext(AgentContext);
  if (!store) throw new Error("AgentContext is missing");
  return useStore(store, selector);
}

/** For parts also drawn without the AI pane around them (tests, the review desk's pieces). */
export function useAgentMaybe<T>(selector: (state: AgentState) => T, fallback: T): T {
  const store = useContext(AgentContext);
  return useStore(store ?? EMPTY, store ? selector : () => fallback);
}

const EMPTY = createStore<AgentState>()(() => ({}) as AgentState);

/** The store itself, for handlers that read the state when they run (menus). */
export function useAgentApi(): StoreApi<AgentState> {
  const store = useContext(AgentContext);
  if (!store) throw new Error("AgentContext is missing");
  return store;
}

/**
 * Opens the AI pane ready to ask: a new conversation when `fresh` is given
 * (null: one that creates a flow), else the conversation about `about` when
 * given (the person may have been reading another one), `draft` written in
 * when the box is empty, and the cursor in the box. The person sends it.
 */
export function openAsk(api: StoreApi<AgentState>, options: { fresh?: FlowLabel | null; about?: FlowLabel; draft?: string } = {}) {
  const a = api.getState();
  if (options.fresh !== undefined) a.newChat(options.fresh);
  else if (options.about) a.focus(options.about);
  a.setOpen(true);
  const chat = currentChat(api.getState());
  if (options.draft && !chat.draft.trim()) a.setDraft(chat.id, options.draft);
  requestAnimationFrame(() => {
    const box = document.querySelector<HTMLTextAreaElement>("[data-agent-input]");
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });
}

/** The store when the AI pane is around, else null (parts also drawn in tests). */
export function useAgentApiMaybe(): StoreApi<AgentState> | null {
  return useContext(AgentContext);
}
