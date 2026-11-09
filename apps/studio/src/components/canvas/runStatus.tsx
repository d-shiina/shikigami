// How a node shows a run: the done / running / error mark, the clock and
// the progress bar of a long wait.
import { useEffect, useState } from "react";
import { useStudio } from "../../context";
import { t } from "../../lib/i18n";
import { type ClockView, clockView, wholeSpan } from "../../lib/runClock";
import type { StepNodeProps } from "./StepNode";

/** A small round mark and a word, the way Linear shows an issue's status. */
export function StatusMark({ kind, text, title }: { kind: "done" | "running" | "paused" | "error" | "todo" | "ai"; text?: string; title?: string }) {
  const mark = {
    done: "bg-moegi-500",
    running: "bg-accent-500 animate-pulse",
    paused: "bg-mizu-500",
    error: "bg-shu-500",
    todo: "border-[1.5px] border-dashed border-amber-600",
    ai: "border-[1.5px] border-brand-500 bg-[conic-gradient(var(--color-brand-500)_180deg,transparent_0)]",
  }[kind];
  return (
    <span title={title} className="flex shrink-0 items-center gap-1 text-[11.5px] whitespace-nowrap text-slate-500">
      <span className={`h-[10px] w-[10px] shrink-0 rounded-full ${mark}`} />
      {text}
    </span>
  );
}

/** Now, again every second while `on`: what a running node's clock reads. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** A running step's clock as the node shows it now; null while the run is paused or it has only just begun. */
export function useClockView(key: string | undefined, stepId: string, frame: boolean): { view: ClockView; since: number } | null {
  const clock = useStudio((s) => (key && s.run?.status === "running" ? s.run.clocks[key] : undefined));
  // How long it took before is known for the open flow's own steps.
  const usual = useStudio((s) => (key?.startsWith("|") && s.stepTimes && s.stepTimes.flowId === s.run?.flowId ? s.stepTimes.times[stepId] : undefined));
  const now = useNow(!!clock);
  if (!clock) return null;
  const view = clockView(clock, usual, now, frame);
  return view ? { view, since: clock.since } : null;
}

export const CLOCK_UNITS = () => ({ sec: t.runLog.sec, min: t.runLog.min });

/** What a running node's clock says: time left, against the usual time, or against its timeout. */
export function clockText(view: ClockView): string {
  const units = CLOCK_UNITS();
  const took = wholeSpan(view.elapsed, units);
  const total = view.total === null ? "" : wholeSpan(view.total, units);
  return {
    // Rounded up: it never says 0 秒 while it still waits.
    wait: t.flow.clockLeft(wholeSpan(Math.ceil(Math.max(0, (view.total ?? 0) - view.elapsed) / 1000) * 1000, units)),
    usual: t.flow.clockUsual(took, total),
    long: t.flow.clockLong(took, total),
    limit: t.flow.clockLimit(took, total),
    plain: took,
  }[view.kind];
}

/** The mark in a running frame's head and, once it takes a while, how long it has run and when it gives up. */
export function RunClock({ clock, stepId, frame }: { clock?: string; stepId: string; frame: boolean }) {
  const shown = useClockView(clock, stepId, frame);
  if (!shown) return <StatusMark kind="running" />;
  const { view } = shown;
  const text = clockText(view);
  return (
    <span
      title={t.flow.clockTitle[view.kind]}
      className={`flex shrink-0 items-center gap-1 text-[11.5px] whitespace-nowrap tabular-nums ${view.kind === "long" ? "text-amber-700" : "text-slate-500"}`}
    >
      <span className="h-[10px] w-[10px] shrink-0 animate-pulse rounded-full bg-accent-500" />
      {text}
    </span>
  );
}

/**
 * Along the bottom of a running node, how far it got: drawn only when
 * that is known (a delay, or how long the step took before). It grows by
 * itself (a CSS animation), so the node is not drawn again for it.
 */
export function RunBar({ clock, stepId }: { clock: string; stepId: string }) {
  const shown = useClockView(clock, stepId, false);
  if (!shown) return null;
  const { view } = shown;
  const bar = view.bar;
  return (
    <>
      {bar && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-lg bg-accent-500/15">
          {/* A new attempt or pass starts the bar again. */}
          <RunBarFill key={`${shown.since}:${bar.total}`} elapsed={bar.elapsed} total={bar.total} long={view.kind === "long"} />
        </span>
      )}
      {/* Under the node's right corner, clear of the line out of its centre, so its head keeps its name. */}
      <span
        title={t.flow.clockTitle[view.kind]}
        className={`pointer-events-none absolute top-full right-1 mt-1 text-[11px] leading-4 whitespace-nowrap tabular-nums ${
          view.kind === "long" ? "font-medium text-amber-700" : "text-slate-500"
        }`}
      >
        {clockText(view)}
      </span>
    </>
  );
}

export function RunBarFill({ elapsed, total, long }: { elapsed: number; total: number; long: boolean }) {
  // Where the bar was when it appeared: the animation goes on from there.
  const [from] = useState(elapsed);
  return (
    <span
      className={`run-bar block h-full bg-accent-500 ${long ? "opacity-50" : ""}`}
      style={{ animationDuration: `${total}ms`, animationDelay: `-${from}ms`, ["--run-bar-steps" as string]: Math.max(1, Math.round(total / 1000)) }}
    />
  );
}

/** The right end of a node's head: how it ran, what is left to do, who changed it. */
export function NodeStatus({ data }: { data: StepNodeProps["data"] }) {
  const marks: React.ReactNode[] = [];
  if (data.runState === "running") marks.push(data.head ? <RunClock key="run" clock={data.clock} stepId={data.step.id ?? ""} frame /> : <StatusMark key="run" kind="running" />);
  if (data.runState === "succeeded") marks.push(<StatusMark key="run" kind="done" title={t.flow.ranOk} />);
  if (data.runState === "paused") marks.push(<StatusMark key="run" kind="paused" />);
  if (data.runState === "failed") marks.push(<StatusMark key="run" kind="error" text={t.flow.ranFailed} />);
  if (data.byAi) marks.push(<StatusMark key="ai" kind="ai" text="AI" title={t.unreviewed} />);
  if (data.unsetCount > 0) marks.push(<StatusMark key="unset" kind="todo" text={t.flow.unset(data.unsetCount)} title={t.flow.unsetTitle} />);
  if (data.todos.length > 0) marks.push(<StatusMark key="todo" kind="todo" text={t.todos.badge} title={data.todos.join("\n")} />);
  if (data.issueCount > 0 && data.runState !== "failed") marks.push(<StatusMark key="issue" kind="error" text={String(data.issueCount)} title={t.flow.issues(data.issueCount)} />);
  if (marks.length === 0) return null;
  return <span className="ml-auto flex shrink-0 items-center gap-2 pl-1">{marks}</span>;
}
