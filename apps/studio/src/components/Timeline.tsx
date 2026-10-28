import type { HistoryEntry } from "@shikigami/schema";
import { useMemo } from "react";
import { useStudio } from "../context";
import { actorLabel, type ChangeLine, describe, formatValue, relativeTime, verbLabel } from "../lib/changes";
import { t } from "../lib/i18n";
import { isExternal, pendingReview, revertBlocker } from "../store";

/** Unreviewed external edits, memoised so selectors stay referentially stable. */
export function usePendingReview(): HistoryEntry[] {
  const history = useStudio((s) => s.history);
  const reviewed = useStudio((s) => s.reviewed);
  const scenario = useStudio((s) => s.scenario);
  const timelines = useStudio((s) => s.timelines);
  return useMemo(
    () => pendingReview({ history, reviewed, scenario, timelines }),
    [history, reviewed, scenario, timelines],
  );
}

/**
 * Approve/revert act on a whole journal entry. When the entry changed more
 * than the step a button sits beside, say so and list everything it covers.
 */
export function entryScope(lines: ChangeLine[]): { suffix: string; title?: string } {
  if (lines.length <= 1) return { suffix: "" };
  return {
    suffix: t.timelineAll(lines.length),
    title: `${t.wholeEntry}\n${lines.map((l) => `・${verbLabel(l.verb)} ${l.subject}`).join("\n")}`,
  };
}

export function ActorMark({ entry, size = 24 }: { entry: HistoryEntry; size?: number }) {
  const external = isExternal(entry);
  return (
    <span
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full text-[10px] font-bold ${
        entry.actor.kind === "mcp"
          ? "bg-brand-500 text-white"
          : external
            ? "bg-slate-300 text-slate-700"
            : "bg-ink text-paper"
      }`}
      title={actorLabel(entry)}
    >
      {entry.actor.kind === "mcp" ? "AI" : entry.actor.kind === "studio" ? t.personMark : t.actor[entry.actor.kind].slice(0, 2)}
    </span>
  );
}

const VERB_STYLE: Record<ChangeLine["verb"], string> = {
  add: "bg-moegi-100 text-moegi-500",
  update: "bg-brand-50 text-brand-600",
  remove: "bg-shu-50 text-shu-600",
  move: "bg-slate-100 text-slate-600",
  scenario: "bg-slate-100 text-slate-600",
  variable: "bg-mizu-100 text-mizu-500",
  replace: "bg-shu-50 text-shu-600",
};

export function Lines({ lines, detailed }: { lines: ChangeLine[]; detailed: boolean }) {
  const goTo = useStudio((s) => s.goTo);
  return (
    <ul className="space-y-1.5">
      {lines.map((line, i) => (
        <li key={`${line.verb}${line.stepId ?? line.subject}${i}`} className="text-sm">
          <button
            type="button"
            disabled={!line.stepId}
            onClick={() => line.stepId && goTo(line.stepId)}
            className="flex w-full items-center gap-1.5 text-left enabled:hover:text-brand-600"
          >
            <span className={`rounded px-1 text-[10px] font-semibold ${VERB_STYLE[line.verb]}`}>{verbLabel(line.verb)}</span>
            <span className="truncate">{line.subject}</span>
          </button>
          {detailed && line.diffs.length > 0 && (
            <dl className="mt-1 space-y-0.5 rounded border border-slate-200 bg-sheet px-2 py-1 font-mono text-[11px]">
              {line.diffs.map((d) => (
                <div key={d.field} className="flex flex-wrap items-baseline gap-x-1.5">
                  <dt className="text-slate-500">{d.field}</dt>
                  {d.before !== undefined && (
                    <dd className="text-shu-600 line-through decoration-shu-500/50">{formatValue(d.before)}</dd>
                  )}
                  {d.before !== undefined && <span className="text-slate-400">→</span>}
                  <dd className="text-moegi-500">{formatValue(d.after)}</dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

function ReviewCard({ entry }: { entry: HistoryEntry }) {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const approve = useStudio((s) => s.approve);
  const revert = useStudio((s) => s.revert);
  const history = useStudio((s) => s.history);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const lines = describe(entry, scenario, defs);
  const blocker = revertBlocker(entry, history);
  return (
    <li className="rounded-[4px] border border-shu-100 bg-sheet p-3 shadow-sheet">
      <div className="mb-2 flex items-center gap-2">
        <ActorMark entry={entry} size={20} />
        <span className="text-xs font-semibold">{actorLabel(entry)}</span>
        <span className="text-xs text-slate-500">
          rev {entry.revision} · {relativeTime(entry.at)}
        </span>
      </div>
      <Lines lines={lines} detailed />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => approve(entry.revision)}
          className="flex-1 rounded-[4px] bg-ink px-2 py-1 text-xs font-medium text-paper hover:bg-slate-700"
        >
          ✓ {t.approve}
        </button>
        <button
          type="button"
          onClick={() => revert(entry)}
          disabled={blocker !== null}
          title={blocker ?? undefined}
          className="flex-1 rounded-[4px] border border-shu-500 px-2 py-1 text-xs font-medium text-shu-600 enabled:hover:bg-shu-50 disabled:border-slate-300 disabled:text-slate-400"
        >
          ↶ {t.revert}
        </button>
      </div>
    </li>
  );
}

function Entry({ entry, pending }: { entry: HistoryEntry; pending: boolean }) {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const revert = useStudio((s) => s.revert);
  const history = useStudio((s) => s.history);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const lines = describe(entry, scenario, defs);
  return (
    <li className="group relative flex gap-3 pb-4 pl-1">
      <span className="absolute top-6 bottom-0 left-[16px] w-px bg-slate-200 group-last:hidden" />
      <ActorMark entry={entry} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-semibold">{actorLabel(entry)}</span>
          <span className="text-slate-500">{t.change[entry.kind]}</span>
          {pending && <span className="rounded bg-shu-500 px-1 text-[10px] text-white">{t.unreviewed}</span>}
          <span className="ml-auto shrink-0 text-slate-400">{relativeTime(entry.at)}</span>
        </div>
        <div className="mt-1">
          {lines.length > 0 ? <Lines lines={lines} detailed={false} /> : <span className="text-sm text-slate-500">
              {entry.kind === "create" ? t.scenarioCreated : entry.kind === "delete" ? t.scenarioDeleted : entry.label}
            </span>}
        </div>
        {revertBlocker(entry, history) === null && (
          <button
            type="button"
            onClick={() => revert(entry)}
            className="mt-1 hidden text-xs text-slate-500 group-hover:inline hover:text-shu-600"
          >
            ↶ {t.revertThis}
          </button>
        )}
      </div>
    </li>
  );
}

/** Who changed what, AI and people on one line of time, newest first. */
export function Timeline() {
  const history = useStudio((s) => s.history);
  const pending = usePendingReview();
  const approveAll = useStudio((s) => s.approveAll);
  const pendingRevs = new Set(pending.map((e) => e.revision));
  const entries = [...history].reverse();

  return (
    <div className="space-y-5 p-4">
      {pending.length > 0 && (
        <section>
          <div className="mb-1 flex items-center gap-2">
            <span className="bg-brand-500 h-2.5 w-2.5 rounded-full" />
            <h3 className="text-sm font-semibold">
              {t.review}
              <span className="ml-1 text-shu-600">{pending.length}</span>
            </h3>
            {pending.length > 1 && (
              <button type="button" onClick={() => void approveAll()} className="ml-auto text-xs text-slate-500 hover:text-ink">
                {t.approveAll}
              </button>
            )}
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-slate-500">{t.reviewHint}</p>
          <ul className="space-y-2">
            {pending.map((e) => (
              <ReviewCard key={e.revision} entry={e} />
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3 className="mb-3 text-sm font-semibold">{t.timeline}</h3>
        {entries.length === 0 ? (
          <p className="text-sm text-slate-400">{t.timelineEmpty}</p>
        ) : (
          <ol>
            {entries.map((e) => (
              <Entry key={`${e.revision}-${e.at}`} entry={e} pending={pendingRevs.has(e.revision)} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
