import { describe, expect, it, vi } from "vitest";
import { createAgentStore } from "./agent";
import type { AgentApi, AgentInfo } from "./lib/api";

const ready: AgentInfo = { available: true, name: "Claude Code", command: "claude", problem: null, remembers: true };

function fakeAgent(overrides: Partial<AgentApi> = {}): AgentApi {
  return {
    info: vi.fn(async () => ready),
    send: vi.fn(async () => "turn_1"),
    stop: vi.fn(async () => undefined),
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
    s.onEvent({ turnId: "turn_1", kind: "done", ok: true, message: null, costUsd: 0.01 });

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
    store.getState().onEvent({ turnId: "turn_1", kind: "done", ok: false, message: "止めました", costUsd: null });
    expect(store.getState().items[1]).toMatchObject({ status: "failed", message: "止めました" });
    store.getState().reset();
    expect(store.getState().items).toEqual([]);
    expect(store.getState().sessionId).toBeNull();
  });
});
