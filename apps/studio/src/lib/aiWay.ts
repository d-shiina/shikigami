// How Writer reaches the person's AI. Either Writer runs an AI on this PC
// that works with SpellSheet itself (Claude Code, Codex, … through MCP), or
// the person uses an AI chat that cannot (Microsoft Copilot, ChatGPT in the
// browser, …): then Writer copies each request for that chat, opens it, and
// takes the AI's answer back from the clipboard ("paste" way).
//
// People do not know which kind their AI is, so they are asked which AI they
// use, by name, and Writer decides (see AiStart). Kept in this PC's browser
// storage; the agent itself is still chosen in config.json (AgentPicker).
import { create } from "zustand";
import { useAgent } from "../agent";
import type { AgentKind } from "./api";

/** The AI chats the paste way knows: where "open" goes. */
export type ChatAi = "m365" | "copilot" | "chatgpt" | "gemini" | "claude" | "other";

export const CHAT_AIS: readonly { id: ChatAi; name: string; url: string | null }[] = [
  { id: "m365", name: "Microsoft 365 Copilot", url: "https://m365.cloud.microsoft/chat" },
  { id: "copilot", name: "Microsoft Copilot", url: "https://copilot.microsoft.com/" },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app" },
  { id: "claude", name: "Claude", url: "https://claude.ai/new" },
  { id: "other", name: "AI", url: null },
];

export const chatAi = (id: ChatAi) => CHAT_AIS.find((c) => c.id === id) ?? CHAT_AIS.at(-1)!;

export type Way = "agent" | "paste";

export type AiWayState = {
  /** null until the person has said which AI they use. */
  way: Way | null;
  chat: ChatAi;
  /** Look for the AI's answer on the clipboard when Writer comes back to the front. */
  autoRead: boolean;
  setWay(way: Way, chat?: ChatAi): void;
  /** Asks again which AI the person uses. */
  askAgain(): void;
  setChat(chat: ChatAi): void;
  setAutoRead(on: boolean): void;
};

const KEY = "spellsheet.studio.aiWay";

type Saved = Pick<AiWayState, "way" | "chat" | "autoRead">;

function load(): Saved {
  const fallback: Saved = { way: null, chat: "m365", autoRead: true };
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Saved>;
    return {
      way: saved.way === "agent" || saved.way === "paste" ? saved.way : null,
      chat: CHAT_AIS.some((c) => c.id === saved.chat) ? (saved.chat as ChatAi) : fallback.chat,
      autoRead: saved.autoRead !== false,
    };
  } catch {
    return fallback;
  }
}

function save(state: Saved) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ way: state.way, chat: state.chat, autoRead: state.autoRead }));
  } catch {
    // Asked again next time.
  }
}

export const useAiWay = create<AiWayState>()((set, get) => {
  const change = (next: Partial<Saved>) => {
    set(next);
    save(get());
  };
  return {
    ...load(),
    setWay: (way, chat) => change(chat ? { way, chat } : { way }),
    askAgain: () => change({ way: null }),
    setChat: (chat) => change({ chat }),
    setAutoRead: (autoRead) => change({ autoRead }),
  };
});

export const pasteWay = () => useAiWay.getState().way === "paste";

/**
 * Whether the person can ask the AI now, and the AI's name for buttons:
 * an AI Writer runs that is set up, or an AI chat in the paste way.
 */
export function useAskable(): { ready: boolean; name: string } {
  const info = useAgent((s) => s.info);
  const way = useAiWay((s) => s.way);
  const chat = useAiWay((s) => s.chat);
  if (way === "paste") return { ready: true, name: chat === "other" ? "AI" : chatAi(chat).name };
  return { ready: info?.available === true, name: info?.name ?? "AI" };
}

/**
 * What the person's answer to "which AI do you use?" leads to: an AI Writer
 * runs (agent), or a chat to copy requests into (paste). Some names cover
 * both (ChatGPT in the browser, Codex on the PC), so those ask once more.
 */
export type AiPick =
  | { kind: "agent"; agent: AgentKind }
  | { kind: "paste"; chat: ChatAi }
  /** Asks which of the two the person means. */
  | { kind: "ask"; question: "copilot" | "chatgpt" | "gemini" | "claude" }
  /** Writer looks at what is on this PC. */
  | { kind: "unknown" };

export type Brand = "msCopilot" | "chatgpt" | "gemini" | "claude" | "githubCopilot" | "cursor" | "other" | "unknown";

export const BRANDS: readonly Brand[] = ["msCopilot", "chatgpt", "gemini", "claude", "githubCopilot", "cursor", "other", "unknown"];

export function pickFor(brand: Brand): AiPick {
  switch (brand) {
    case "msCopilot":
      return { kind: "ask", question: "copilot" };
    case "chatgpt":
      return { kind: "ask", question: "chatgpt" };
    case "gemini":
      return { kind: "ask", question: "gemini" };
    case "claude":
      return { kind: "ask", question: "claude" };
    case "githubCopilot":
      return { kind: "agent", agent: "copilot" };
    case "cursor":
      return { kind: "agent", agent: "cursor" };
    case "other":
      return { kind: "paste", chat: "other" };
    case "unknown":
      return { kind: "unknown" };
  }
}

/** The two answers to each follow-up question: [first, second]. */
export const FOLLOW_UPS: Record<"copilot" | "chatgpt" | "gemini" | "claude", readonly [AiPick, AiPick]> = {
  copilot: [
    { kind: "paste", chat: "m365" },
    { kind: "paste", chat: "copilot" },
  ],
  chatgpt: [
    { kind: "paste", chat: "chatgpt" },
    { kind: "agent", agent: "codex" },
  ],
  gemini: [
    { kind: "paste", chat: "gemini" },
    { kind: "agent", agent: "antigravity" },
  ],
  claude: [
    { kind: "paste", chat: "claude" },
    { kind: "agent", agent: "claudeCode" },
  ],
};

/** "I don't know": the AI already on this PC if there is one, else the paste way. */
export function guess(installed: readonly AgentKind[]): AiPick {
  const found = installed.find((k) => k !== "command");
  return found ? { kind: "agent", agent: found } : { kind: "paste", chat: "other" };
}
