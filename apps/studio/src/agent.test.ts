import { describe, expect, it, vi } from "vitest";
import { type AgentState, createAgentStore, currentChat } from "./agent";
import type { AgentApi, AgentInfo } from "./lib/api";

function fakeStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

const now = (s: AgentState) => currentChat(s);

const ready: AgentInfo = { available: true, name: "Claude Code", command: "claude", problem: null, remembers: true };

function fakeAgent(overrides: Partial<AgentApi> = {}): AgentApi {
  return {
    info: vi.fn(async () => ready),
    send: vi.fn(async () => "turn_1"),
    stop: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    loginCode: vi.fn(async () => undefined),
    cancelLogin: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("agent store", () => {
  it("shows the turn as it streams and continues the conversation next time", async () => {
    const api = fakeAgent();
    const store = createAgentStore(api);
    await store.getState().init();
    await store.getState().send("待ちを延ばして", { id: "scn_a", name: "A", stepId: "stp_1" }, "「A」について");
    expect(api.send).toHaveBeenLastCalledWith({
      message: "待ちを延ばして",
      sessionId: null,
      scenario: { id: "scn_a", name: "A", stepId: "stp_1" },
    });
    expect(store.getState().open).toBe(true);
    expect(now(store.getState()).turnId).toBe("turn_1");

    const s = store.getState();
    s.onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess" });
    s.onEvent({ turnId: "turn_1", kind: "tool", name: "update_step", detail: "待ちを10秒に" });
    s.onEvent({ turnId: "turn_1", kind: "text", text: "延ばしました" });
    s.onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: 0.01, needsLogin: false });

    const ai = now(store.getState()).items[1];
    expect(ai).toMatchObject({
      role: "ai",
      status: "done",
      parts: [
        { kind: "tool", name: "update_step", detail: "待ちを10秒に" },
        { kind: "text", text: "延ばしました" },
      ],
    });
    expect(now(store.getState()).turnId).toBeNull();

    await store.getState().send("ありがとう", { id: "scn_a", name: "A" });
    expect(api.send).toHaveBeenLastCalledWith({ message: "ありがとう", sessionId: "sess", scenario: { id: "scn_a", name: "A" } });
  });

  it("keeps events that arrive before the turn is known", async () => {
    let release: (id: string) => void = () => undefined;
    const api = fakeAgent({ send: vi.fn(() => new Promise<string>((r) => (release = r))) });
    const store = createAgentStore(api);
    await store.getState().init();
    const sent = store.getState().send("作って");
    store.getState().onEvent({ turnId: "turn_9", kind: "text", text: "早い返事" });
    release("turn_9");
    await sent;
    expect(now(store.getState()).items[1]).toMatchObject({ parts: [{ kind: "text", text: "早い返事" }] });
  });

  it("refuses a second message while the first is still being sent", async () => {
    let release: (id: string) => void = () => undefined;
    const api = fakeAgent({ send: vi.fn(() => new Promise<string>((r) => (release = r))) });
    const store = createAgentStore(api);
    await store.getState().init();
    const first = store.getState().send("一つ目");
    expect(await store.getState().send("二つ目")).toBe(false);
    // The message and its reply, which shows while the agent starts.
    expect(now(store.getState()).items).toHaveLength(2);
    expect(now(store.getState()).items[1]).toMatchObject({ role: "ai", status: "running", turnId: "" });
    release("turn_1");
    await first;
    expect(api.send).toHaveBeenCalledOnce();
    expect(now(store.getState()).turnId).toBe("turn_1");
    expect(now(store.getState()).sending).toBe(false);
  });

  it("refuses a second message while one runs and reports a refused send", async () => {
    const api = fakeAgent();
    const store = createAgentStore(api);
    await store.getState().init();
    await store.getState().send("一つ目");
    expect(await store.getState().send("二つ目")).toBe(false);
    expect(api.send).toHaveBeenCalledOnce();

    const refusing = createAgentStore(
      fakeAgent({ send: vi.fn(async () => Promise.reject(new Error("登録済みのパスワードが含まれています"))) }),
    );
    expect(await refusing.getState().send("pass1234")).toBe(false);
    expect(now(refusing.getState()).items[1]).toMatchObject({ status: "failed", message: "登録済みのパスワードが含まれています" });
    expect(now(refusing.getState()).turnId).toBeNull();
  });

  it("starts over without the old conversation", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().send("一つ目");
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess" });
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: false, message: "止めました", costUsd: null, needsLogin: false });
    expect(now(store.getState()).items[1]).toMatchObject({ status: "failed", message: "止めました" });
    const old = store.getState().current;
    store.getState().newChat(null);
    expect(store.getState().current).not.toBe(old);
    expect(now(store.getState()).items).toEqual([]);
    expect(now(store.getState()).sessionId).toBeNull();
    // The old one stays in the list and can be continued.
    store.getState().select(old);
    expect(now(store.getState()).sessionId).toBe("sess");
  });

  it("shows an error once and signs in from the pane, then sends the message again", async () => {
    let turn = 0;
    const api = fakeAgent({ send: vi.fn(async () => `turn_${++turn}`) });
    const store = createAgentStore(api);
    await store.getState().init();
    await store.getState().send("ニュースをまとめて", { id: "scn_a", name: "A" }, "A");
    const expired = "Failed to authenticate: OAuth session expired and could not be refreshed";
    store.getState().onEvent({ turnId: "turn_1", kind: "text", text: expired });
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: false, message: expired, costUsd: null, needsLogin: true });
    expect(now(store.getState()).items[1]).toMatchObject({ status: "failed", needsLogin: true, parts: [] });

    await store.getState().startLogin();
    expect(api.login).toHaveBeenCalledOnce();
    store.getState().onLoginEvent({ kind: "url", url: "https://claude.com/cai/oauth/authorize?x" });
    expect(store.getState().login).toMatchObject({ phase: "waiting", url: "https://claude.com/cai/oauth/authorize?x" });
    expect(await store.getState().submitLoginCode(" abc#123 ")).toBe(true);
    expect(api.loginCode).toHaveBeenCalledWith(" abc#123 ");

    store.getState().onLoginEvent({ kind: "done", ok: true, message: null });
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send).toHaveBeenLastCalledWith({ message: "ニュースをまとめて", sessionId: null, scenario: { id: "scn_a", name: "A" } });
    // The message is shown once; the failed reply gives way to the new one.
    const items = now(store.getState()).items;
    expect(items.filter((i) => i.role === "person")).toHaveLength(1);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ role: "ai", turnId: "turn_2", status: "running" });
    expect(store.getState().login).toEqual({ phase: "idle" });
  });

  it("keeps the sign-in box with the reason when signing in fails", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().startLogin();
    store.getState().onLoginEvent({ kind: "done", ok: false, message: "timed out" });
    expect(store.getState().login).toEqual({ phase: "failed", message: "timed out" });
  });
  it("keeps one conversation per scenario and runs them at once", async () => {
    let turn = 0;
    const api = fakeAgent({ send: vi.fn(async () => `turn_${++turn}`) });
    const store = createAgentStore(api);
    await store.getState().init();
    store.getState().focus({ id: "scn_a", name: "A" });
    await store.getState().send("Aを直して", { id: "scn_a", name: "A" });
    const a = store.getState().current;
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess_a" });

    // The editor opens B while A is still working.
    store.getState().focus({ id: "scn_b", name: "B" });
    expect(now(store.getState())).toMatchObject({ scenarioId: "scn_b", items: [] });
    expect(await store.getState().send("Bも直して", { id: "scn_b", name: "B" })).toBe(true);
    expect(api.send).toHaveBeenLastCalledWith({ message: "Bも直して", sessionId: null, scenario: { id: "scn_b", name: "B" } });
    const b = store.getState().current;
    expect(b).not.toBe(a);

    // A finishes out of sight: marked to look at, and B's turn is untouched.
    store.getState().onEvent({ turnId: "turn_1", kind: "text", text: "Aを直しました" });
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: null, needsLogin: false });
    const chatA = store.getState().chats.find((c) => c.id === a)!;
    expect(chatA).toMatchObject({ turnId: null, unread: true });
    expect(chatA.items[1]).toMatchObject({ status: "done", parts: [{ kind: "text", text: "Aを直しました" }] });
    expect(now(store.getState()).turnId).toBe("turn_2");

    // Back on A: its conversation, read now, continues its own session.
    store.getState().focus({ id: "scn_a", name: "A" });
    expect(store.getState().current).toBe(a);
    expect(now(store.getState()).unread).toBe(false);
    await store.getState().send("ありがとう", { id: "scn_a", name: "A" });
    expect(api.send).toHaveBeenLastCalledWith({ message: "ありがとう", sessionId: "sess_a", scenario: { id: "scn_a", name: "A" } });
  });

  it("does not let two conversations work on one scenario at once", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    store.getState().focus({ id: "scn_a", name: "A" });
    await store.getState().send("一つ目", { id: "scn_a", name: "A" });
    store.getState().newChat({ id: "scn_a", name: "A" });
    expect(await store.getState().sendIn(store.getState().current, "二つ目", { id: "scn_a", name: "A" })).toBe(false);
  });

  it("gives a conversation that created a scenario to that scenario", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().send("請求書のシナリオを作って");
    const making = store.getState().current;
    expect(now(store.getState())).toMatchObject({ scenarioId: null, title: "請求書のシナリオを作って" });
    // Studio opens the new scenario before the agent reports it.
    store.getState().focus({ id: "scn_new", name: "請求書" });
    expect(store.getState().current).not.toBe(making);
    store.getState().onEvent({ turnId: "turn_1", kind: "created", scenarioId: "scn_new", name: "請求書" });
    expect(store.getState().current).toBe(making);
    expect(now(store.getState())).toMatchObject({ scenarioId: "scn_new", title: "請求書" });
    expect(store.getState().chats.filter((c) => c.scenarioId === "scn_new")).toHaveLength(1);
  });

  it("remembers each conversation across restarts", async () => {
    fakeStorage();
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().send("Aを直して", { id: "scn_a", name: "A" });
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess_a" });
    const again = createAgentStore(fakeAgent());
    again.getState().focus({ id: "scn_a", name: "A" });
    expect(now(again.getState())).toMatchObject({ scenarioId: "scn_a", sessionId: "sess_a", items: [] });
    vi.unstubAllGlobals();
  });

  it("carries the one conversation from before over", () => {
    fakeStorage().set("shikigami.studio.agentSession", "sess_old");
    const store = createAgentStore(fakeAgent());
    expect(store.getState().chats.some((c) => c.sessionId === "sess_old" && c.scenarioId === null)).toBe(true);
    vi.unstubAllGlobals();
  });
  it("takes a correction while the AI works: stops the turn, then sends it in the same conversation", async () => {
    let turn = 0;
    const api = fakeAgent({ send: vi.fn(async () => `turn_${++turn}`) });
    const store = createAgentStore(api);
    await store.getState().init();
    const a = { id: "scn_a", name: "A" };
    store.getState().focus(a);
    await store.getState().send("CSVで保存して", a);
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess" });
    const chatId = store.getState().current;

    expect(await store.getState().sendIn(chatId, "やっぱりExcelで", a)).toBe(true);
    expect(api.stop).toHaveBeenCalledWith("turn_1");
    expect(api.send).toHaveBeenCalledOnce();
    // Only one correction at a time.
    expect(await store.getState().sendIn(chatId, "もう一つ", a)).toBe(false);

    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: false, message: "止めました", costUsd: null, needsLogin: false });
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    const last = vi.mocked(api.send).mock.calls[1]![0];
    expect(last.sessionId).toBe("sess");
    expect(last.message).toContain("やっぱりExcelで");
    expect(last.message).toContain("stopped your previous turn");
    const items = now(store.getState()).items;
    expect(items.map((i) => i.role)).toEqual(["person", "ai", "person", "ai"]);
    expect(items[1]).toMatchObject({ status: "done" });
    expect(items[2]).toMatchObject({ text: "やっぱりExcelで" });
    expect(now(store.getState())).toMatchObject({ interrupting: null, turnId: "turn_2" });
  });
});
