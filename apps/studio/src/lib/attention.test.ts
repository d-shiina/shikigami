// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Ask, type AttentionBackend, useAttention, type WriterWaits, writerAsk } from "./attention";
import { setLocale } from "./i18n";

afterEach(() => setLocale("ja", false));

const flow = { id: "scn_a", name: "経費精算", steps: [{ id: "s1", type: "browser.click", name: "送信を押す" }] } as WriterWaits["flow"];
const base: WriterWaits = { run: null, human: null, flow, secretRequests: [], approvals: [], pickRequests: [] };
const running = (over: Partial<NonNullable<WriterWaits["run"]>> = {}): WriterWaits["run"] => ({
  runId: "run_1",
  flowId: "scn_a",
  status: "running",
  pause: null,
  ...over,
});

describe("writerAsk", () => {
  it("calls for a step that waits for the person, with what it asks", () => {
    const ask = writerAsk({ ...base, run: running(), human: { stepId: "s1", message: "ブラウザでサインインしてください" } });
    expect(ask).toEqual({ tag: "human:run_1:s1", title: "「経費精算」が操作を待っています", body: "ブラウザでサインインしてください" });
  });

  it("leaves a dialog alone: it comes to the front by itself", () => {
    expect(writerAsk({ ...base, run: running(), human: { stepId: "s1", message: "答えてください", dialog: true } })).toBeNull();
  });

  it("calls for a pause on an error or a breakpoint, not for one the person asked for", () => {
    const pause = (reason: string, seq = 5) => running({ status: "paused", pause: { seq, stepId: "s1", reason, callPath: [] } });
    expect(writerAsk({ ...base, run: pause("error") })).toEqual({
      tag: "pause:run_1:5",
      title: "「経費精算」がエラーで一時停止しました",
      body: "「送信を押す」で止まっています。Writer で続け方を選んでください",
    });
    expect(writerAsk({ ...base, run: pause("breakpoint", 9) })?.title).toBe("「経費精算」がブレークポイントで一時停止しました");
    expect(writerAsk({ ...base, run: pause("step") })).toBeNull();
    expect(writerAsk({ ...base, run: pause("requested") })).toBeNull();
  });

  it("does not name another flow than the one that runs", () => {
    const ask = writerAsk({ ...base, run: running({ flowId: "scn_b" }), human: { stepId: "s1", message: "待っています" } });
    expect(ask?.title).toBe("フローが操作を待っています");
  });

  it("calls for an AI's requests", () => {
    const ask = writerAsk({ ...base, approvals: [{ id: "apr_1" }], pickRequests: [{ id: "pick_1" }] });
    expect(ask).toEqual({ tag: "ai:approval:apr_1,pick:pick_1", title: "AI が Writer での操作を待っています", body: "AI が承認を求めています" });
    expect(writerAsk(base)).toBeNull();
  });
});

describe("useAttention", () => {
  const backend = () => ({ call: vi.fn(async () => {}), clear: vi.fn(async () => {}) }) satisfies AttentionBackend;
  const ask = (tag: string): Ask => ({ tag, title: "t", body: "b" });

  it("calls once when a wait starts and takes it back when it ends", () => {
    const b = backend();
    const { rerender, unmount } = renderHook(({ a }: { a: Ask | null }) => useAttention(a, b), { initialProps: { a: null as Ask | null } });
    expect(b.call).not.toHaveBeenCalled();
    rerender({ a: ask("human:run_1:s1") });
    rerender({ a: { ...ask("human:run_1:s1"), body: "same wait" } });
    expect(b.call).toHaveBeenCalledTimes(1);
    rerender({ a: null });
    expect(b.clear).toHaveBeenCalledWith("human:run_1:s1");
    rerender({ a: ask("pause:run_1:7") });
    expect(b.call).toHaveBeenCalledTimes(2);
    unmount();
    expect(b.clear).toHaveBeenLastCalledWith("pause:run_1:7");
  });

  it("does not call again when an AI's request is answered and others remain", () => {
    const b = backend();
    const { rerender } = renderHook(({ a }: { a: Ask | null }) => useAttention(a, b), { initialProps: { a: ask("ai:approval:1,pick:2") as Ask | null } });
    expect(b.call).toHaveBeenCalledTimes(1);
    rerender({ a: ask("ai:pick:2") });
    expect(b.call).toHaveBeenCalledTimes(1);
    rerender({ a: ask("ai:pick:2,secret:x") });
    expect(b.call).toHaveBeenCalledTimes(2);
  });
});
