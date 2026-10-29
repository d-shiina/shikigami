// The scenario's steps as a table of contents beside the flow chart: click
// one (or use ↑↓) and the chart brings it into view.
import { useEffect, useMemo, useRef } from "react";
import { useStudio } from "../context";
import { outline } from "../lib/outline";
import { summarize } from "../lib/review";
import { plain, sentence } from "../lib/sentence";
import { CATEGORY_COLOR } from "./CommandPalette";
import { usePendingReview } from "./Timeline";
import { t } from "../lib/i18n";

const RUN_DOT: Record<string, string> = {
  running: "bg-accent-500 animate-pulse",
  succeeded: "bg-moegi-500",
  failed: "bg-shu-500",
  skipped: "bg-slate-300",
};

export function OutlinePanel() {
  const open = useStudio((s) => s.outlineOpen);
  const setOpen = useStudio((s) => s.setOutlineOpen);
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const runSteps = useStudio((s) => s.run?.steps);
  const validation = useStudio((s) => s.validation);
  const reviewing = useStudio((s) => s.reviewing);
  const goTo = useStudio((s) => s.goTo);
  const pending = usePendingReview();
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const items = useMemo(() => outline(scenario?.steps ?? [], defs), [scenario, defs]);
  const changed = useMemo(() => (reviewing ? summarize([...pending].reverse()).steps : new Map()), [reviewing, pending]);
  const errors = useMemo(
    () => new Set((validation?.issues ?? []).filter((i) => i.severity === "error" && i.stepId).map((i) => i.stepId)),
    [validation],
  );
  const selected = selection?.kind === "step" ? selection.stepId : null;
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!selected) return;
    list.current?.querySelector(`[data-step="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, open]);
  if (!open || !scenario) return null;

  return (
    <nav className="absolute top-3 left-3 z-10 flex max-h-[calc(100%-6rem)] w-[264px] flex-col overflow-hidden rounded-[4px] border border-slate-200 bg-sheet/95 shadow-raised backdrop-blur">
<<<<<<< HEAD
      <div className="flex items-center gap-2 border-b border-slate-100 py-1 pr-1 pl-3 text-[11px] text-slate-500">
=======
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
>>>>>>> origin/claude/project-thread-jekwf7
        <span className="font-bold text-ink">{t.outline.steps}</span>
        <span>{items.length}</span>
        <span className="ml-auto">
          <kbd className="rounded bg-slate-100 px-1">↑↓</kbd> {t.outline.move}
          {reviewing && (
            <>
              {" "}
              <kbd className="rounded bg-slate-100 px-1">N</kbd> {t.outline.nextChange}
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t.close}
          title={`${t.close} (O)`}
          className="grid h-6 w-6 place-items-center rounded-[3px] text-slate-500 hover:bg-slate-100 hover:text-ink"
        >
          ✕
        </button>
      </div>
      <ol ref={list} className="flex-1 overflow-y-auto py-1">
        {items.map((item, i) => {
          const def = defs.get(item.step.type);
          const color = CATEGORY_COLOR[def?.category ?? item.step.type.split(".")[0] ?? "other"] ?? CATEGORY_COLOR.other;
          const run = runSteps?.[item.id];
          const diff = changed.get(item.id);
          const active = item.id === selected;
          return (
            <li key={item.id} data-step={item.id}>
              {item.block && (
                <div className="truncate pt-1 pr-2 text-[10px] text-slate-400" style={{ paddingLeft: 12 + item.depth * 14 }}>
                  {item.block}
                </div>
              )}
              <button
                type="button"
                onClick={() => goTo(item.id)}
                className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12px] ${
                  active ? "bg-brand-50 text-brand-700" : "text-ink hover:bg-slate-50"
                } ${item.step.disabled ? "opacity-50" : ""}`}
                style={{ paddingLeft: 8 + item.depth * 14 }}
              >
                <span className={`w-5 shrink-0 text-right font-mono text-[10px] ${active ? "text-brand-600" : "text-slate-400"}`}>{i + 1}</span>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
                <span className={`min-w-0 flex-1 truncate ${active ? "font-semibold" : ""}`}>
                  {item.step.name || plain(sentence(item.step, def))}
                </span>
                {diff && (
                  <span className={`shrink-0 rounded-[3px] px-1.5 text-[9px] leading-4 font-bold text-white ${diff === "added" ? "bg-moegi-500" : "bg-accent-500"}`}>
                    {diff === "added" ? t.diffKind.added : t.diffKind.changed}
                  </span>
                )}
                {errors.has(item.id) && <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-shu-500 text-[9px] font-bold text-white">!</span>}
                {run && <span className={`h-2 w-2 shrink-0 rounded-full ${RUN_DOT[run] ?? ""}`} />}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
