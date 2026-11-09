import { X } from "lucide-react";
import { useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import type { TraceFilter } from "../lib/runTrace";
import { type BottomTab, isActive, runBreakpoints, trailOf } from "../store";
import { PERSON_CODES } from "../lib/todos";
import { useTodos } from "../lib/useTodos";
import { IssuesPanel } from "./IssuesPanel";
import { Resizer } from "./Resizer";
import { RunLog, RunLogBar } from "./RunLog";
import { TestsPanel } from "./TestsPanel";

/**
 * The panel under the chart: what a run did (log), what is wrong with the
 * flow (issues) and its test cases (tests). Both are lists over time or over the whole flow, read
 * side by side with the chart, so they sit below it rather than beside it.
 */
const HEIGHT_KEY = "spellsheet.studio.bottom";
const HEIGHT = 192;
const MIN_HEIGHT = 96;

function readHeight(): number {
  try {
    const saved = Number(globalThis.localStorage?.getItem(HEIGHT_KEY));
    return saved >= MIN_HEIGHT ? saved : HEIGHT;
  } catch {
    return HEIGHT;
  }
}

export function BottomPanel() {
  const tab = useStudio((s) => s.bottom);
  const setTab = useStudio((s) => s.setBottom);
  const run = useStudio((s) => s.run);
  const clear = useStudio((s) => s.clearLog);
  // A run that has ended leaves its way on the chart until it is cleared.
  const trail = useStudio((s) => {
    const last = trailOf(s);
    return last !== null && !isActive(last);
  });
  const hideTrail = useStudio((s) => s.hideTrail);
  const breakpointCount = useStudio((s) => runBreakpoints(s).length);
  const clearBreakpoints = useStudio((s) => s.clearBreakpoints);
  const todos = useTodos().length;
  // A part to pick is a to-do, counted once, not also as an error.
  const issueCount = useStudio((s) => s.validation?.issues.filter((i) => !PERSON_CODES.has(i.code)).length ?? 0) + todos;
  const [height, setHeight] = useState(readHeight);
  const [filter, setFilter] = useState<TraceFilter>("all");
  if (!tab) return null;
  const resize = (next: number) => {
    setHeight(next);
    try {
      globalThis.localStorage?.setItem(HEIGHT_KEY, String(next));
    } catch {
      // Only a remembered preference.
    }
  };
  // Leave the chart most of the window.
  const max = Math.max(MIN_HEIGHT, Math.round((globalThis.innerHeight ?? 800) * 0.6));
  const tabs: [BottomTab, string, number][] = [
    ["log", t.log, 0],
    ["issues", t.issues, issueCount],
    ["tests", t.tests.tab, 0],
  ];
  return (
    <section style={{ height: Math.min(height, max) }} className="relative flex min-h-0 shrink-0 flex-col border-t border-slate-200 bg-sheet">
      <Resizer edge="top" size={Math.min(height, max)} min={MIN_HEIGHT} max={max} onSize={resize} onReset={() => resize(HEIGHT)} />
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-slate-100 px-2">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`relative flex h-full shrink-0 items-center gap-1 px-2 text-xs font-medium whitespace-nowrap ${tab === key ? "text-ink" : "text-slate-500 hover:text-ink"}`}
          >
            {label}
            {count > 0 && <span className="rounded-md bg-slate-200 px-1.5 text-[10px] text-slate-600">{count}</span>}
            {tab === key && <span className="absolute inset-x-2 bottom-[-1px] h-[2px] bg-ink" />}
          </button>
        ))}
        {tab === "log" && run ? <RunLogBar filter={filter} onFilter={setFilter} /> : <span className="flex-1" />}
        {tab === "log" && trail && (
          <button type="button" className="shrink-0 rounded-md px-2 text-xs leading-6 whitespace-nowrap text-slate-500 hover:bg-slate-100 hover:text-ink" onClick={hideTrail}>
            {t.clearTrail}
          </button>
        )}
        {tab === "log" && breakpointCount > 0 && (
          <button type="button" className="shrink-0 rounded-md px-2 text-xs leading-6 whitespace-nowrap text-slate-500 hover:bg-slate-100 hover:text-ink" onClick={clearBreakpoints}>
            {t.clearBreakpoints(breakpointCount)}
          </button>
        )}
        {tab === "log" && run && (
          <button type="button" className="shrink-0 rounded-md px-2 text-xs leading-6 whitespace-nowrap text-slate-500 hover:bg-slate-100 hover:text-ink" onClick={clear}>
            {t.clearLog}
          </button>
        )}
        <button type="button" className="grid h-6 w-6 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink" onClick={() => setTab(null)} title={t.shell.closePanel} aria-label={t.shell.closePanel}>
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {tab === "log" ? (
        <div className="min-h-0 flex-1">
          <RunLog filter={filter} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">{tab === "tests" ? <TestsPanel /> : <IssuesPanel />}</div>
      )}
    </section>
  );
}
