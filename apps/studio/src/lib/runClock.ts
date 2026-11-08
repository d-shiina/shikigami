import type { StepClock } from "../store";

/** Below this long a running node shows only its mark: most nodes are done by then. */
export const CLOCK_AFTER_MS = 1000;
/** Steps that usually take less than this get no bar: it would only flash. */
export const BAR_FROM_MS = 1500;

/**
 * What a running node shows of its time: words, and a bar when how far it
 * got is really known — a delay's time, or how long the step took in the
 * runs before. A step whose end nobody can tell gets the time only, never
 * a bar that pretends.
 */
export type ClockView = {
  kind: "wait" | "usual" | "long" | "limit" | "plain";
  /** Elapsed and total ms of the bar, or null for no bar. */
  bar: { elapsed: number; total: number } | null;
  /** The words beside the mark; null while it has only just begun. */
  elapsed: number;
  total: number | null;
};

/**
 * The view of a running step's clock at `now`. `usualMs` is how long the
 * step took in earlier runs; `frame` steps (a loop, an if…) show only a
 * timeout of their own, since the nodes inside them show the rest.
 */
export function clockView(clock: StepClock, usualMs: number | undefined, now: number, frame = false): ClockView | null {
  const elapsed = Math.max(0, now - clock.since);
  if (clock.waitMs !== null && clock.waitMs >= BAR_FROM_MS) {
    return { kind: "wait", bar: { elapsed: Math.min(elapsed, clock.waitMs), total: clock.waitMs }, elapsed, total: clock.waitMs };
  }
  if (!frame && clock.waitMs === null && usualMs !== undefined && usualMs >= BAR_FROM_MS) {
    const long = elapsed > usualMs;
    return { kind: long ? "long" : "usual", bar: { elapsed: Math.min(elapsed, usualMs), total: usualMs }, elapsed, total: usualMs };
  }
  if (elapsed < CLOCK_AFTER_MS) return null;
  if (clock.limitMs !== null) return { kind: "limit", bar: null, elapsed, total: clock.limitMs };
  return frame ? null : { kind: "plain", bar: null, elapsed, total: null };
}

/** A time in whole seconds: 8 秒, 1 分 05 秒. */
export function wholeSpan(ms: number, units: { sec: string; min: string }): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} ${units.sec}`;
  return `${Math.floor(total / 60)} ${units.min} ${String(total % 60).padStart(2, "0")} ${units.sec}`;
}
