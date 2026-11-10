import { describe, expect, it, vi } from "vitest";
import { activity, type AgentState, createAgentStore, currentChat, openAsk } from "./agent";
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

const ready: AgentInfo = { available: true, kind: "claudeCode", name: "Claude Code", command: "claude", problem: null, remembers: true, installable: false, signsIn: true, usesApiKey: false, hasApiKey: false };

function fakeAgent(overrides: Partial<AgentApi> = {}): AgentApi {
  return {
    info: vi.fn(async () => ready),
    choices: vi.fn(async () => []),
    select: vi.fn(async (kind) => ({ ...ready, kind, name: kind })),
    setApiKey: vi.fn(async (key) => ({ ...ready, hasApiKey: key !== null })),
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
    ...overrides,
  };
}

describe("agent store", () => {
  it("starts a new conversation when another AI is chosen", async () => {
    const api = fakeAgent();
    const store = createAgentStore(api);
    await store.getState().init();
    await store.getState().send("直して", { id: "scn_a", name: "A" });
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "claude-1" });
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: null, needsLogin: false });
    expect(now(store.getState())).toMatchObject({ sessionId: "claude-1", agent: "claudeCode" });

    await store.getState().chooseAgent("codex");
    expect(store.getState().info?.kind).toBe("codex");
    await store.getState().send("続けて", { id: "scn_a", name: "A" });
    expect(api.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: null }));
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "codex-1" });
    expect(now(store.getState())).toMatchObject({ sessionId: "codex-1", agent: "codex" });
  });

  it("shows the AI's choices as a card and the next message answers it", async () => {
    const api = fakeAgent({ send: vi.fn(async () => `turn_${(api.send as ReturnType<typeof vi.fn>).mock.calls.length}`) });
    const store = createAgentStore(api);
    await store.getState().init();
    await store.getState().send("在庫切れの扱いを足して", { id: "scn_a", name: "A" });
    store.getState().onEvent({
      turnId: "turn_1",
      kind: "choice",
      question: "在庫切れの注文はどうしますか？",
      options: [
        { label: "飛ばして一覧に残す", description: "出荷できた分だけ進めます。" },
        { label: "そこで止めて人に聞く", description: null },
      ],
      recommended: 0,
      reason: null,
    });
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: null, needsLogin: false });
    expect(now(store.getState()).items[1]).toMatchObject({ parts: [{ kind: "choice", recommended: 0, answer: null }] });

    await store.getState().send("飛ばして一覧に残す", { id: "scn_a", name: "A" });
    expect(api.send).toHaveBeenLastCalledWith(expect.objectContaining({ message: "飛ばして一覧に残す" }));
    const items = now(store.getState()).items;
    expect(items[1]).toMatchObject({ parts: [{ kind: "choice", answer: "飛ばして一覧に残す" }] });
    expect(items[2]).toMatchObject({ role: "person", text: "飛ばして一覧に残す", answers: true });
  });

  it("keeps a conversation with the AI that ran it when the AI is switched mid-turn", async () => {
    const api = fakeAgent();
    const store = createAgentStore(api);
    await store.getState().init();
    await store.getState().send("作って", { id: "scn_a", name: "A" });
    await store.getState().chooseAgent("copilot");
    // Copilot-like agents name the conversation only at the end of the turn.
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "claude-1" });
    expect(now(store.getState())).toMatchObject({ sessionId: "claude-1", agent: "claudeCode" });
    await store.getState().send("続けて", { id: "scn_a", name: "A" });
    expect(api.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: null }));
  });

  it("says what the AI is writing before the tool call arrives, and what it works on", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    expect(activity(store.getState())).toBeNull();
    await store.getState().send("受注を集めるフローを作って", { id: "scn_empty", name: "新しいフロー", empty: true });
    expect(activity(store.getState())).toEqual({ flowId: "scn_empty", tool: null });

    store.getState().onEvent({ turnId: "turn_1", kind: "preparing", name: "update_flow" });
    expect(now(store.getState()).items[1]).toMatchObject({ preparing: "update_flow", parts: [] });
    expect(activity(store.getState())?.tool).toBe("update_flow");

    store.getState().onEvent({ turnId: "turn_1", kind: "tool", name: "update_flow", detail: "ログインして一覧を開く" });
    expect(now(store.getState()).items[1]).toMatchObject({ preparing: null });
    expect(activity(store.getState())?.tool).toBe("update_flow");

    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: null, needsLogin: false });
    expect(activity(store.getState())).toBeNull();
  });

  it("shows the turn as it streams and continues the conversation next time", async () => {
    const api = fakeAgent();
    const store = createAgentStore(api);
    await store.getState().init();
    await store.getState().send("待ちを延ばして", { id: "scn_a", name: "A", stepId: "stp_1" }, "「A」について");
    expect(api.send).toHaveBeenLastCalledWith({
      message: "待ちを延ばして",
      sessionId: null,
      flow: { id: "scn_a", name: "A", stepId: "stp_1" },
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
    expect(api.send).toHaveBeenLastCalledWith({ message: "ありがとう", sessionId: "sess", flow: { id: "scn_a", name: "A" } });
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
    expect(api.send).toHaveBeenLastCalledWith({ message: "ニュースをまとめて", sessionId: null, flow: { id: "scn_a", name: "A" } });
    // The message is shown once; the failed reply gives way to the new one.
    const items = now(store.getState()).items;
    expect(items.filter((i) => i.role === "person")).toHaveLength(1);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ role: "ai", turnId: "turn_2", status: "running" });
    expect(store.getState().login).toEqual({ phase: "idle" });
  });

  it("asks for the API key instead of signing in, then sends the message again", async () => {
    let turn = 0;
    const gemini: AgentInfo = { ...ready, kind: "gemini", name: "Gemini CLI", signsIn: false, usesApiKey: true, hasApiKey: false };
    const api = fakeAgent({
      info: vi.fn(async () => gemini),
      send: vi.fn(async () => `turn_${++turn}`),
      setApiKey: vi.fn(async (key) => ({ ...gemini, hasApiKey: key !== null })),
    });
    const store = createAgentStore(api);
    await store.getState().init();
    await store.getState().send("請求書を集めて", { id: "scn_a", name: "A" });
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: false, message: "API key not valid", costUsd: null, needsLogin: true });
    await store.getState().startLogin();
    expect(api.login).not.toHaveBeenCalled();
    expect(store.getState().login).toEqual({ phase: "idle" });

    await store.getState().saveApiKey("AIza-test");
    expect(api.setApiKey).toHaveBeenCalledWith("AIza-test");
    expect(store.getState().info?.hasApiKey).toBe(true);
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  });

  it("keeps the sign-in box with the reason when signing in fails", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().startLogin();
    store.getState().onLoginEvent({ kind: "done", ok: false, message: "timed out" });
    expect(store.getState().login).toEqual({ phase: "failed", message: "timed out" });
  });
  it("keeps one conversation per flow and runs them at once", async () => {
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
    expect(now(store.getState())).toMatchObject({ flowId: "scn_b", items: [] });
    expect(await store.getState().send("Bも直して", { id: "scn_b", name: "B" })).toBe(true);
    expect(api.send).toHaveBeenLastCalledWith({ message: "Bも直して", sessionId: null, flow: { id: "scn_b", name: "B" } });
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
    expect(api.send).toHaveBeenLastCalledWith({ message: "ありがとう", sessionId: "sess_a", flow: { id: "scn_a", name: "A" } });
  });

  it("does not let two conversations work on one flow at once", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    store.getState().focus({ id: "scn_a", name: "A" });
    await store.getState().send("一つ目", { id: "scn_a", name: "A" });
    store.getState().newChat({ id: "scn_a", name: "A" });
    expect(await store.getState().sendIn(store.getState().current, "二つ目", { id: "scn_a", name: "A" })).toBe(false);
  });

  it("gives a conversation that created a flow to that flow", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().send("請求書のフローを作って");
    const making = store.getState().current;
    expect(now(store.getState())).toMatchObject({ flowId: null, title: "請求書のフローを作って" });
    // Studio opens the new flow before the agent reports it.
    store.getState().focus({ id: "scn_new", name: "請求書" });
    expect(store.getState().current).not.toBe(making);
    store.getState().onEvent({ turnId: "turn_1", kind: "created", flowId: "scn_new", name: "請求書" });
    expect(store.getState().current).toBe(making);
    expect(now(store.getState())).toMatchObject({ flowId: "scn_new", title: "請求書" });
    expect(store.getState().chats.filter((c) => c.flowId === "scn_new")).toHaveLength(1);
  });

  it("remembers each conversation across restarts", async () => {
    fakeStorage();
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().send("Aを直して", { id: "scn_a", name: "A" });
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess_a" });
    store.getState().onEvent({ turnId: "turn_1", kind: "text", text: "直しました" });
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: null, needsLogin: false });
    await vi.waitFor(() => expect(now(store.getState()).sending).toBe(false));
    const again = createAgentStore(fakeAgent());
    again.getState().focus({ id: "scn_a", name: "A" });
    expect(now(again.getState())).toMatchObject({ flowId: "scn_a", sessionId: "sess_a" });
    // The words stay, not only the AI's memory of them.
    expect(now(again.getState()).items).toMatchObject([
      { role: "person", text: "Aを直して" },
      { role: "ai", status: "done", parts: [{ kind: "text", text: "直しました" }] },
    ]);
    vi.unstubAllGlobals();
  });

  it("a reply cut off by closing Writer ends there when the conversation comes back", async () => {
    fakeStorage();
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().send("Aを直して", { id: "scn_a", name: "A" });
    store.getState().onEvent({ turnId: "turn_1", kind: "text", text: "見ています" });
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess_a" });
    store.getState().onEvent({ turnId: "turn_1", kind: "text", text: "フローを読みました" });
    // Kept as it grows, not only when the reply is done.
    await new Promise((r) => setTimeout(r, 1100));
    const again = createAgentStore(fakeAgent());
    again.getState().focus({ id: "scn_a", name: "A" });
    const chat = now(again.getState());
    expect(chat.items[1]).toMatchObject({ parts: [{ kind: "text", text: "見ています" }, { kind: "text", text: "フローを読みました" }] });
    expect(chat.items[1]).toMatchObject({ role: "ai", status: "done", message: "Writer を閉じたため、ここで止まりました" });
    expect(chat.turnId).toBeNull();
    vi.unstubAllGlobals();
  });

  it("carries the one conversation from before over", () => {
    fakeStorage().set("spellsheet.studio.agentSession", "sess_old");
    const store = createAgentStore(fakeAgent());
    expect(store.getState().chats.some((c) => c.sessionId === "sess_old" && c.flowId === null)).toBe(true);
    vi.unstubAllGlobals();
  });
  it("passes on what the person writes while the AI works, without stopping it", async () => {
    let turn = 0;
    const api = fakeAgent({ send: vi.fn(async () => `turn_${++turn}`) });
    const store = createAgentStore(api);
    await store.getState().init();
    const a = { id: "scn_a", name: "A" };
    store.getState().focus(a);
    await store.getState().send("CSVで保存して", a);
    store.getState().onEvent({ turnId: "turn_1", kind: "text", text: "作っています" });
    const chatId = store.getState().current;

    expect(await store.getState().sendIn(chatId, "保存先は output/ の下に", a)).toBe(true);
    expect(await store.getState().sendIn(chatId, "ファイル名に日付も", a)).toBe(true);
    expect(api.stop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(api.note).toHaveBeenCalledTimes(2));
    const [first, second] = now(store.getState()).items.slice(2);
    expect(api.note).toHaveBeenCalledWith("turn_1", first!.id, "保存先は output/ の下に");
    expect(first).toMatchObject({ role: "person", note: "waiting" });

    // Read with a tool result: shown there, and the reply goes on below it.
    store.getState().onEvent({ turnId: "turn_1", kind: "heard", ids: [first!.id] });
    store.getState().onEvent({ turnId: "turn_1", kind: "text", text: "output/ に保存します" });
    let items = now(store.getState()).items;
    expect(items.map((i) => (i.role === "person" ? `person:${i.note ?? ""}` : `ai:${i.status}`))).toEqual([
      "person:",
      "ai:done",
      "person:heard",
      "ai:running",
      "person:waiting",
    ]);
    expect(items[3]).toMatchObject({ parts: [{ kind: "text", text: "output/ に保存します" }] });
    expect(items[4]).toMatchObject({ id: second!.id });

    // The turn ends; the AI also read the second one before it did.
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: null, needsLogin: false });
    await vi.waitFor(() => expect(api.takeNotes).toHaveBeenCalledWith("turn_1"));
    await vi.waitFor(() => expect(now(store.getState()).sending).toBe(false));
    items = now(store.getState()).items;
    expect(items[4]).toMatchObject({ note: "heard" });
    expect(api.send).toHaveBeenCalledOnce();
  });

  it("sends what the AI did not read as the next message", async () => {
    let turn = 0;
    const api = fakeAgent({ send: vi.fn(async () => `turn_${++turn}`) });
    const store = createAgentStore(api);
    await store.getState().init();
    const a = { id: "scn_a", name: "A" };
    store.getState().focus(a);
    await store.getState().send("CSVで保存して", a);
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess" });
    const chatId = store.getState().current;
    await store.getState().sendIn(chatId, "やっぱりExcelで", a);
    const note = now(store.getState()).items[2]!;
    vi.mocked(api.takeNotes).mockResolvedValueOnce([note.id]);

    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: null, needsLogin: false });
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    const last = vi.mocked(api.send).mock.calls[1]![0];
    expect(last.sessionId).toBe("sess");
    expect(last.message).toContain("やっぱりExcelで");
    expect(last.message).toContain("your turn ended before you read it");
    const items = now(store.getState()).items;
    expect(items.map((i) => i.role)).toEqual(["person", "ai", "person", "ai"]);
    expect(items[2]).toMatchObject({ text: "やっぱりExcelで", note: undefined });
    expect(now(store.getState())).toMatchObject({ turnId: "turn_2" });
    // A retry sends the same message again, note included.
    store.getState().onEvent({ turnId: "turn_2", kind: "done", ok: false, message: "失敗", costUsd: null, needsLogin: false });
    await vi.waitFor(() => expect(now(store.getState()).turnId).toBeNull());
    await store.getState().retry(chatId);
    expect(vi.mocked(api.send).mock.calls[2]![0].message).toBe(last.message);
  });

  it("stopping with a message waiting sends it at once as a correction", async () => {
    let turn = 0;
    const api = fakeAgent({ send: vi.fn(async () => `turn_${++turn}`) });
    const store = createAgentStore(api);
    await store.getState().init();
    const a = { id: "scn_a", name: "A" };
    store.getState().focus(a);
    await store.getState().send("CSVで保存して", a);
    const chatId = store.getState().current;
    await store.getState().sendIn(chatId, "待って、Excelで", a);
    const note = now(store.getState()).items[2]!;
    vi.mocked(api.takeNotes).mockResolvedValueOnce([note.id]);
    await store.getState().stop(chatId);
    expect(api.stop).toHaveBeenCalledWith("turn_1");

    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: false, message: "止めました", costUsd: null, needsLogin: false });
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.send).mock.calls[1]![0].message).toContain("stopped your previous turn");
    expect(now(store.getState()).items[1]).toMatchObject({ status: "done" });
  });

  it("a message written while the agent starts reaches it once it runs", async () => {
    let release: (id: string) => void = () => undefined;
    const api = fakeAgent({ send: vi.fn(() => new Promise<string>((r) => (release = r))) });
    const store = createAgentStore(api);
    await store.getState().init();
    const a = { id: "scn_a", name: "A" };
    store.getState().focus(a);
    const sent = store.getState().send("CSVで保存して", a);
    const chatId = store.getState().current;
    await store.getState().sendIn(chatId, "日付つきで", a);
    expect(api.note).not.toHaveBeenCalled();
    release("turn_9");
    await sent;
    expect(api.note).toHaveBeenCalledWith("turn_9", expect.any(String), "日付つきで");
  });

  it("keeps a conversation with an unsent draft when another flow is opened", () => {
    const store = createAgentStore(fakeAgent());
    store.getState().focus({ id: "scn_a", name: "A" });
    const a = store.getState().current;
    store.getState().setDraft(a, "書きかけ");
    store.getState().focus({ id: "scn_b", name: "B" });
    store.getState().focus({ id: "scn_a", name: "A" });
    expect(store.getState().current).toBe(a);
    expect(now(store.getState()).draft).toBe("書きかけ");
  });

  it("retries only one conversation per flow after signing in", async () => {
    let turn = 0;
    const api = fakeAgent({ send: vi.fn(async () => `turn_${++turn}`) });
    const store = createAgentStore(api);
    await store.getState().init();
    const a = { id: "scn_a", name: "A" };
    const expired = { kind: "done" as const, ok: false, message: "Not logged in", costUsd: null, needsLogin: true };
    await store.getState().send("一つ目", a);
    store.getState().onEvent({ turnId: "turn_1", ...expired });
    store.getState().newChat(a);
    await store.getState().sendIn(store.getState().current, "二つ目", a);
    store.getState().onEvent({ turnId: "turn_2", ...expired });
    await store.getState().startLogin();
    store.getState().onLoginEvent({ kind: "done", ok: true, message: null });
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 10));
    expect(api.send).toHaveBeenCalledTimes(3);
  });

  it("installs the AI from the pane, then signs in when the account is not there yet", async () => {
    const missing: AgentInfo = { ...ready, available: false, command: null, problem: "Claude Code がまだありません", installable: true };
    let found = false;
    const login = vi.fn(async () => undefined);
    const store = createAgentStore(fakeAgent({ info: vi.fn(async () => (found ? ready : missing)), login }));
    await store.getState().init();
    expect(store.getState().info?.installable).toBe(true);
    await store.getState().startInstall("claudeCode");
    expect(store.getState().install).toMatchObject({ phase: "running", step: null, lines: [] });
    // The stage it is at, then its words.
    store.getState().onInstallEvent({ kind: "step", step: "installer" });
    expect(store.getState().install).toMatchObject({ phase: "running", step: "installer" });
    store.getState().onInstallEvent({ kind: "progress", line: "Downloading…" });
    expect(store.getState().install).toMatchObject({ phase: "running", step: "installer", lines: ["Downloading…"] });
    // The installer failed: its words, and a way to try again.
    store.getState().onInstallEvent({ kind: "done", ok: false, message: "no network", needsLogin: false });
    expect(store.getState().install).toEqual({ phase: "failed", message: "no network" });
    await store.getState().startInstall("claudeCode");
    found = true;
    store.getState().onInstallEvent({ kind: "done", ok: true, message: null, needsLogin: true });
    await vi.waitFor(() => expect(store.getState().info?.available).toBe(true));
    expect(store.getState().install).toEqual({ phase: "idle" });
    // Installed and signed out: the sign-in starts by itself.
    expect(login).toHaveBeenCalledTimes(1);
    expect(store.getState().login.phase).toBe("waiting");
  });

  it("notes when the installer last printed, so a quiet unpack is not taken for a hang", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = createAgentStore(fakeAgent());
      await store.getState().startInstall("gemini");
      expect(store.getState().install).toMatchObject({ startedAt: 1_000, lastAt: 1_000 });
      vi.setSystemTime(5_000);
      store.getState().onInstallEvent({ kind: "step", step: "package" });
      vi.setSystemTime(9_000);
      store.getState().onInstallEvent({ kind: "progress", line: "npm http fetch GET 200 https://registry.npmjs.org/@google%2fgemini-cli 403ms" });
      expect(store.getState().install).toMatchObject({ step: "package", startedAt: 1_000, lastAt: 9_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers the install button again only once a stopped installer is gone", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().startInstall("claudeCode");
    await store.getState().cancelInstall();
    expect(store.getState().install).toEqual({ phase: "stopping" });
    // Its last words arrive late and change nothing.
    store.getState().onInstallEvent({ kind: "progress", line: "…" });
    expect(store.getState().install).toEqual({ phase: "stopping" });
    store.getState().onInstallEvent({ kind: "cancelled" });
    expect(store.getState().install).toEqual({ phase: "idle" });
  });

  it("asks about a node in that flow's conversation, even while another one is shown", async () => {
    fakeStorage();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    store.getState().focus({ id: "scn_a", name: "A" });
    store.getState().newChat({ id: "scn_b", name: "B" });
    expect(now(store.getState()).flowId).toBe("scn_b");

    openAsk(store, { about: { id: "scn_a", name: "A" }, draft: "「受注を読む」を直して" });
    expect(now(store.getState())).toMatchObject({ flowId: "scn_a", draft: "「受注を読む」を直して" });
    expect(store.getState().open).toBe(true);
  });
});
