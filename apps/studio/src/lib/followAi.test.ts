import { describe, expect, it } from "vitest";
import type { Chat, ChatItem } from "../agent";
import { askedForFlow, draftingOver, lastAdded, mayDraft, shouldFollow } from "./followAi";

const working = { flowId: null, tool: "create_flow" };

describe("shouldFollow", () => {
  it("opens what the AI made when nothing is open", () => {
    expect(shouldFollow("scn_new", false, working, { place: "library", flow: null })).toBe(true);
    expect(shouldFollow("scn_new", false, working, { place: "flows", flow: null })).toBe(true);
  });

  it("replaces only an empty flow when asked about another one", () => {
    const empty = { id: "scn_empty", steps: [] };
    const full = { id: "scn_full", steps: [{ id: "stp_1", type: "log.write" }] };
    const aboutFull = { flowId: "scn_full", tool: "create_flow" };
    expect(shouldFollow("scn_new", false, aboutFull, { place: "flows", flow: empty })).toBe(true);
    expect(shouldFollow("scn_new", false, aboutFull, { place: "flows", flow: full })).toBe(false);
  });

  it("opens a flow asked for in a new-flow conversation, over the flow open", () => {
    const full = { id: "scn_full", steps: [{ id: "stp_1", type: "log.write" }] };
    expect(shouldFollow("scn_new", false, working, { place: "flows", flow: full })).toBe(true);
    // The conversation already moved to the flow it made.
    expect(shouldFollow("scn_new", false, { flowId: "scn_new", tool: "create_flow" }, { place: "flows", flow: full })).toBe(true);
  });

  it("stays put when the AI is idle, the flow was known, or the person is elsewhere", () => {
    expect(shouldFollow("scn_new", false, null, { place: "library", flow: null })).toBe(false);
    expect(shouldFollow("scn_new", true, working, { place: "library", flow: null })).toBe(false);
    expect(shouldFollow("scn_new", false, working, { place: "settings", flow: null })).toBe(false);
    expect(shouldFollow("scn_new", false, working, { place: "flows", flow: { id: "scn_new", steps: [] } })).toBe(false);
  });
});

describe("lastAdded", () => {
  const steps = [
    { id: "a", type: "log.message" },
    { id: "b", type: "control.if", blocks: { then: [{ id: "b1", type: "log.message" }] } },
    { id: "c", type: "log.message" },
  ];
  it("is the last new step in reading order, nested ones included", () => {
    expect(lastAdded(["a", "c"], steps)).toBe("b1");
    expect(lastAdded(null, steps)).toBe("c");
  });
  it("is nothing when the edit only changed steps", () => {
    expect(lastAdded(["a", "b", "b1", "c"], steps)).toBeUndefined();
  });
});

const person = (text: string): ChatItem => ({ role: "person", id: `p_${text}`, text, context: null, flow: null });
const reply = (parts: Extract<ChatItem, { role: "ai" }>["parts"] = []): ChatItem => ({
  role: "ai",
  id: "a",
  turnId: "turn_1",
  parts,
  status: "done",
  preparing: null,
  message: null,
  needsLogin: false,
});
const chat = (over: Partial<Chat>): Chat => ({
  id: "chat_1",
  flowId: null,
  title: "受注を集める",
  items: [],
  sessionId: null,
  turnId: null,
  sending: false,
  unread: false,
  draft: "",
  updatedAt: 0,
  ...over,
});
const question = { kind: "choice" as const, question: "どの画面？", options: [], recommended: null, reason: null, answer: null };

describe("askedForFlow", () => {
  it("shows the new flow as soon as a new-flow conversation is sent a message", () => {
    const before = chat({ items: [person("受注を集めるフローを作って")] });
    const after = { ...before, sending: true };
    expect(askedForFlow([before], [after])).toEqual({ chatId: "chat_1", title: "受注を集める", request: "受注を集めるフローを作って" });
  });

  it("names the flow by the first request, not by an answer to the AI's question", () => {
    const before = chat({ items: [person("受注を集めるフローを作って"), reply([question]), person("一覧画面")] });
    expect(askedForFlow([before], [{ ...before, turnId: "turn_2" }])?.request).toBe("受注を集めるフローを作って");
  });

  it("ignores conversations about a flow, and ones already at work", () => {
    const about = chat({ flowId: "scn_1", items: [person("直して")] });
    expect(askedForFlow([about], [{ ...about, sending: true }])).toBeNull();
    const busy = chat({ items: [person("作って")], turnId: "turn_1" });
    expect(askedForFlow([busy], [{ ...busy, updatedAt: 1 }])).toBeNull();
  });
});

describe("mayDraft", () => {
  it("takes over the library and the editor, not other pages or a run", () => {
    expect(mayDraft("library", false)).toBe(true);
    expect(mayDraft("flows", false)).toBe(true);
    expect(mayDraft("settings", false)).toBe(false);
    expect(mayDraft("review", false)).toBe(false);
    expect(mayDraft("flows", true)).toBe(false);
  });
});

describe("draftingOver", () => {
  it("keeps showing while the AI works or waits for an answer", () => {
    expect(draftingOver(chat({ turnId: "turn_1" }))).toBe(false);
    expect(draftingOver(chat({ items: [person("作って"), reply([question])] }))).toBe(false);
  });

  it("ends when the turn ends with no flow and no question, or the conversation is gone", () => {
    expect(draftingOver(chat({ items: [person("使い方は？"), reply([{ kind: "text", text: "…" }])] }))).toBe(true);
    expect(draftingOver(undefined)).toBe(true);
    expect(draftingOver(chat({ flowId: "scn_new", items: [person("作って"), reply()] }))).toBe(true);
  });
});
