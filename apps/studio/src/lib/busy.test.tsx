// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBusy } from "./busy";

describe("useBusy", () => {
  it("runs the work once for clicks that come before it is done, and again after", async () => {
    const { result } = renderHook(() => useBusy());
    let finish!: () => void;
    const work = vi.fn(() => new Promise<string>((resolve) => (finish = () => resolve("済"))));
    let first!: Promise<string | undefined>;
    act(() => {
      first = result.current[1](work);
    });
    // Both from the same render, as two clicks before React draws again.
    let second!: Promise<string | undefined>;
    act(() => {
      second = result.current[1](work);
    });
    expect(await second).toBeUndefined();
    expect(work).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toBe(true);
    await act(async () => finish());
    expect(await first).toBe("済");
    expect(result.current[0]).toBe(false);
    await act(async () => {
      await result.current[1](async () => "また");
    });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("lets the next click through after the work failed", async () => {
    const { result } = renderHook(() => useBusy());
    await act(async () => {
      await result.current[1](() => Promise.reject(new Error("だめ"))).catch(() => {});
    });
    expect(result.current[0]).toBe(false);
    const again = vi.fn(async () => 1);
    await act(async () => {
      await result.current[1](again);
    });
    expect(again).toHaveBeenCalledTimes(1);
  });
});
