import { describe, expect, it, vi } from "vitest";
import { createAgentStore, currentChat, expectAnswerFor, type PasteHelpers } from "./agent";
import type { AgentApi, AgentInfo } from "./lib/api";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });

const missing: AgentInfo = { available: false, kind: "claudeCode", name: "Claude Code", command: null, problem: "not installed", remembers: true, installable: true, signsIn: true, usesApiKey: false, hasApiKey: false };

function fakeAgent(): AgentApi {
  return {
    info: vi.fn(async () => missing),
    choices: vi.fn(async () => []),
    select: vi.fn(async () => missing),
    setApiKey: vi.fn(async () => missing),
    send: vi.fn(async () => "turn_1"),
    stop: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    takeNotes: vi.fn(async () => []),
    login: vi.fn(async () => undefined),
    loginCode: vi.fn(async () => undefined),
    cancelLogin: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    cancelInstall: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    openLink: vi.fn(async () => undefined),
  };
}

function helpers(on = true): PasteHelpers & { copied: string[] } {
  const copied: string[] = [];
  return {
    copied,
    active: () => on,
    compose: vi.fn(async (message, flow) => `REQUEST ${flow?.id ?? "new"}: ${message}`),
    copy: vi.fn(async (text) => void copied.push(text)),
    open: vi.fn(),
  };
}

describe("the paste way", () => {
  it("copies the request for the AI chat instead of running an AI, and opens the chat once", async () => {
    const api = fakeAgent();
    const paste = helpers();
    const store = createAgentStore(api, paste);
    await store.getState().init();
    expect(await store.getState().send("請求書を集計して", null)).toBe(true);
    expect(api.send).not.toHaveBeenCalled();
    expect(paste.copied).toEqual(["REQUEST new: 請求書を集計して"]);
    const items = currentChat(store.getState()).items;
    expect(items.map((i) => i.role)).toEqual(["person", "ai"]);
    expect(items[1]).toMatchObject({ role: "ai", status: "done", handoff: { prompt: "REQUEST new: 請求書を集計して" } });

    await store.getState().sendIn(store.getState().current, "もう少し", null);
    expect(paste.open).toHaveBeenCalledTimes(1);
  });

  it("sends to the AI as before when the paste way is off", async () => {
    const api = fakeAgent();
    const store = createAgentStore(api, helpers(false));
    await store.getState().send("直して", { id: "scn_a", name: "A" });
    expect(api.send).toHaveBeenCalled();
  });

  it("keeps what the answer became, and a new flow becomes the conversation's", async () => {
    const store = createAgentStore(fakeAgent(), helpers());
    await store.getState().send("作って", null);
    const chat = currentChat(store.getState());
    const item = chat.items[1]!;
    store.getState().settleHandoff(chat.id, item.id, {
      result: { kind: "taken", flowId: "scn_new", name: "集計", isNew: true, revision: 1, changes: [], forAi: [], checks: 0 },
    });
    store.getState().adoptFlow(chat.id, { id: "scn_new", name: "集計" });
    expect(currentChat(store.getState())).toMatchObject({ flowId: "scn_new", title: "集計" });
    expect(currentChat(store.getState()).items[1]).toMatchObject({ handoff: { result: { kind: "taken", flowId: "scn_new" } } });
  });

  it("copies a fix or the rest of a cut answer as it is, carrying what came before", async () => {
    const paste = helpers();
    const store = createAgentStore(fakeAgent(), paste);
    await store.getState().send("作って", null);
    const id = store.getState().current;
    await store.getState().handOffAs(id, "続きの依頼", "Go on from …", "```json\n{\"steps\": [");
    expect(paste.copied.at(-1)).toBe("Go on from …");
    const items = currentChat(store.getState()).items;
    expect(items.at(-2)).toMatchObject({ role: "person", text: "続きの依頼" });
    expect(items.at(-1)).toMatchObject({ handoff: { prompt: "Go on from …", partial: "```json\n{\"steps\": [" } });
  });

  it("waits for an answer brought from a chat begun elsewhere", () => {
    const store = createAgentStore(fakeAgent(), helpers());
    expectAnswerFor(store, { id: "scn_a", name: "A" });
    const chat = currentChat(store.getState());
    expect(chat.flowId).toBe("scn_a");
    expect(chat.items.at(-1)).toMatchObject({ role: "ai", handoff: { prompt: "" } });
    expect(store.getState().open).toBe(true);
  });
});
