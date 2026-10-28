import { useEffect, useRef } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

const LEVEL_STYLE = {
  debug: "text-slate-400",
  info: "text-slate-700",
  warn: "text-amber-700",
  error: "text-shu-600",
} as const;

export function RunLog() {
  const run = useStudio((s) => s.run);
  const clear = useStudio((s) => s.clearLog);
  const select = useStudio((s) => s.select);
  const end = useRef<HTMLDivElement>(null);
  const count = run?.logs.length ?? 0;
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [count]);

  return (
    <section className="flex h-full flex-col border-t border-slate-200 bg-sheet">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1">
        <span className="text-xs font-semibold text-slate-500">{t.log}</span>
        {run && (
          <span className="text-xs text-slate-500">
            {t.status[run.status]} · <span className="font-mono">{run.runId}</span>
          </span>
        )}
        <button type="button" className="ml-auto text-xs text-slate-500 hover:underline" onClick={clear}>
          {t.clearLog}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-1 font-mono text-xs">
        {run?.logs.map((entry) => (
          <div key={`${entry.seq}-${entry.message}`} className={`flex gap-2 ${LEVEL_STYLE[entry.level]}`}>
            <span className="shrink-0 text-slate-400">{entry.at.slice(11, 19)}</span>
            <span className="whitespace-pre-wrap">{entry.message}</span>
            {entry.stepId && (
              <button
                type="button"
                className="ml-auto shrink-0 text-slate-400 hover:text-brand-600"
                onClick={() => entry.stepId && select({ kind: "step", stepId: entry.stepId })}
              >
                {entry.stepId.slice(0, 12)}
              </button>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
    </section>
  );
}
