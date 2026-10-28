import { describe, expect, it, vi } from "vitest";
import { createAgentStore } from "./agent";
import type { AgentApi, AgentInfo } from "./lib/api";

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
    expect(store.getState().turnId).toBe("turn_1");

    const s = store.getState();
    s.onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess" });
    s.onEvent({ turnId: "turn_1", kind: "tool", name: "update_step", detail: "待ちを10秒に" });
    s.onEvent({ turnId: "turn_1", kind: "text", text: "延ばしました" });
    s.onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: 0.01, needsLogin: false });

    const ai = store.getState().items[1];
    expect(ai).toMatchObject({
      role: "ai",
      status: "done",
      parts: [
        { kind: "tool", name: "update_step", detail: "待ちを10秒に" },
        { kind: "text", text: "延ばしました" },
      ],
    });
    expect(store.getState().turnId).toBeNull();

    await store.getState().send("ありがとう");
    expect(api.send).toHaveBeenLastCalledWith({ message: "ありがとう", sessionId: "sess", scenario: undefined });
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
    expect(store.getState().items[1]).toMatchObject({ parts: [{ kind: "text", text: "早い返事" }] });
  });

  it("refuses a second message while the first is still being sent", async () => {
    let release: (id: string) => void = () => undefined;
    const api = fakeAgent({ send: vi.fn(() => new Promise<string>((r) => (release = r))) });
    const store = createAgentStore(api);
    await store.getState().init();
    const first = store.getState().send("一つ目");
    expect(await store.getState().send("二つ目")).toBe(false);
    store.getState().reset();
    expect(store.getState().items).toHaveLength(1);
    release("turn_1");
    await first;
    expect(api.send).toHaveBeenCalledOnce();
    expect(store.getState().turnId).toBe("turn_1");
    expect(store.getState().sending).toBe(false);
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
    expect(refusing.getState().items[1]).toMatchObject({ status: "failed", message: "登録済みのパスワードが含まれています" });
    expect(refusing.getState().turnId).toBeNull();
  });

  it("starts over without the old conversation", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().send("一つ目");
    store.getState().onEvent({ turnId: "turn_1", kind: "session", sessionId: "sess" });
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: false, message: "止めました", costUsd: null, needsLogin: false });
    expect(store.getState().items[1]).toMatchObject({ status: "failed", message: "止めました" });
    store.getState().reset();
    expect(store.getState().items).toEqual([]);
    expect(store.getState().sessionId).toBeNull();
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
    expect(store.getState().items[1]).toMatchObject({ status: "failed", needsLogin: true, parts: [] });

    await store.getState().startLogin();
    expect(api.login).toHaveBeenCalledOnce();
    store.getState().onLoginEvent({ kind: "url", url: "https://claude.com/cai/oauth/authorize?x" });
    expect(store.getState().login).toMatchObject({ phase: "waiting", url: "https://claude.com/cai/oauth/authorize?x" });
    expect(await store.getState().submitLoginCode(" abc#123 ")).toBe(true);
    expect(api.loginCode).toHaveBeenCalledWith(" abc#123 ");

    store.getState().onLoginEvent({ kind: "done", ok: true, message: null });
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send).toHaveBeenLastCalledWith({ message: "ニュースをまとめて", sessionId: null, scenario: { id: "scn_a", name: "A" } });
    expect(store.getState().login).toEqual({ phase: "idle" });
  });

  it("keeps the sign-in box with the reason when signing in fails", async () => {
    const store = createAgentStore(fakeAgent());
    await store.getState().init();
    await store.getState().startLogin();
    store.getState().onLoginEvent({ kind: "done", ok: false, message: "timed out" });
    expect(store.getState().login).toEqual({ phase: "failed", message: "timed out" });
  });
});
