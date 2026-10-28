import { useEffect, useRef } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import type { BottomTab } from "../store";
import { IssuesPanel } from "./IssuesPanel";

const LEVEL_STYLE = {
  debug: "text-slate-400",
  info: "text-slate-700",
  warn: "text-amber-700",
  error: "text-shu-600",
} as const;

/**
 * The panel under the chart: what a run did (log) and what is wrong with the
 * scenario (issues). Both are lists over time or over the whole scenario, read
 * side by side with the chart, so they sit below it rather than beside it.
 */
export function BottomPanel() {
  const tab = useStudio((s) => s.bottom);
  const setTab = useStudio((s) => s.setBottom);
  const run = useStudio((s) => s.run);
  const clear = useStudio((s) => s.clearLog);
  const issueCount = useStudio((s) => s.validation?.issues.length ?? 0);
  if (!tab) return null;
  const tabs: [BottomTab, string, number][] = [
    ["log", t.log, 0],
    ["issues", t.issues, issueCount],
  ];
  return (
    <section className="flex h-48 min-h-0 shrink-0 flex-col border-t border-slate-200 bg-sheet">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-slate-100 px-2">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`relative flex h-full items-center gap-1 px-2 text-xs font-medium ${tab === key ? "text-ink" : "text-slate-500 hover:text-ink"}`}
          >
            {label}
            {count > 0 && <span className="rounded-[3px] bg-slate-200 px-1.5 text-[10px] text-slate-600">{count}</span>}
            {tab === key && <span className="absolute inset-x-2 bottom-[-1px] h-[2px] bg-ink" />}
          </button>
        ))}
        {tab === "log" && run && (
          <span className="ml-2 truncate text-xs text-slate-500">
            {t.status[run.status]} · <span className="font-mono">{run.runId}</span>
          </span>
        )}
        <span className="flex-1" />
        {tab === "log" && run && (
          <button type="button" className="rounded-[3px] px-2 text-xs leading-6 text-slate-500 hover:bg-slate-100 hover:text-ink" onClick={clear}>
            {t.clearLog}
          </button>
        )}
        <button type="button" className="grid h-6 w-6 place-items-center rounded-[3px] text-slate-500 hover:bg-slate-100 hover:text-ink" onClick={() => setTab(null)} title={t.shell.closePanel} aria-label={t.shell.closePanel}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "log" ? <RunLog /> : <IssuesPanel />}</div>
    </section>
  );
}

function RunLog() {
  const run = useStudio((s) => s.run);
  const goTo = useStudio((s) => s.goTo);
  const end = useRef<HTMLDivElement>(null);
  const count = run?.logs.length ?? 0;
  useEffect(() => {
    // Braces matter: WebView2 returns a Promise here, which React would call as a cleanup.
    end.current?.scrollIntoView({ block: "end" });
  }, [count]);

  return (
    <div className="px-3 py-1 font-mono text-xs">
      {run?.logs.map((entry) => (
        <div key={`${entry.seq}-${entry.message}`} className={`flex gap-2 ${LEVEL_STYLE[entry.level]}`}>
          <span className="shrink-0 text-slate-400">{entry.at.slice(11, 19)}</span>
          <span className="whitespace-pre-wrap">{entry.message}</span>
          {entry.stepId && (
            <button type="button" className="ml-auto shrink-0 text-slate-400 hover:text-brand-600" onClick={() => entry.stepId && goTo(entry.stepId)}>
              {entry.stepId.slice(0, 12)}
            </button>
          )}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
