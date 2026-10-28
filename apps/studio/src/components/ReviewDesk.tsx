// The review desk: AI edits waiting to be looked at, across every scenario.
// Opening one shows the scenario's flow chart with what changed marked on
// it, the changes in words, and one place to keep or send them back.
import type { HistoryEntry } from "@shikigami/schema";
import { useEffect, useMemo } from "react";
import { useStudio } from "../context";
import { actorLabel, describe, relativeTime } from "../lib/changes";
import { headline, summarize } from "../lib/review";
import { sentence, plain } from "../lib/sentence";
import { approvedUpTo, groupRevertBlocker, pendingIn } from "../store";
import { Explanations, FeedbackBox, Observations, type Observed, type Review, SendBackForm, Section, TestRuns, type TestRun } from "./Evidence";
import { ActorMark, Lines, usePendingReview } from "./Timeline";
import { t, useKeptState } from "../lib/i18n";

export type InboxItem = {
  scenarioId: string;
  name: string;
  entries: HistoryEntry[];
  /** Sent back and the AI has not edited since: nothing for the person to do yet. */
  waiting: Review | null;
};

/** Scenarios with unreviewed AI edits, newest edit first. */
export function useInbox(): InboxItem[] {
  const summaries = useStudio((s) => s.summaries);
  const histories = useStudio((s) => s.histories);
  const reviewed = useStudio((s) => s.reviewed);
  const timelines = useStudio((s) => s.timelines);
  return useMemo(
    () =>
      summaries
        .map((s) => {
          const timeline = timelines[s.id];
          const entries = pendingIn(histories[s.id] ?? [], reviewed[s.id], approvedUpTo(timeline));
          const feedback = timeline?.openFeedback?.kind === "review" ? timeline.openFeedback : null;
          const waiting = feedback && feedback.revision >= (entries[0]?.revision ?? 0) ? feedback : null;
          return { scenarioId: s.id, name: s.name, entries, waiting };
        })
        .filter((i) => i.entries.length > 0)
        .sort((a, b) => (b.entries[0]?.at ?? "").localeCompare(a.entries[0]?.at ?? "")),
    [summaries, histories, reviewed, timelines],
  );
}

export function ReviewInbox() {
  const inbox = useInbox();
  const open = useStudio((s) => s.open);
  const currentId = useStudio((s) => s.scenario?.id);
  return (
    <aside className="flex h-full flex-col border-r border-slate-200 bg-paper">
      <div className="px-3 pt-3 pb-1">
        <div className="text-[12px] font-bold">{t.desk.title}</div>
        <div className="text-[11px] leading-relaxed text-slate-400">{t.desk.hint}</div>
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {inbox.filter((i) => !i.waiting).length === 0 && (
          <li className="mx-1 rounded-[4px] border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
            {t.desk.empty}
          </li>
        )}
        {[...inbox.filter((i) => !i.waiting), ...inbox.filter((i) => i.waiting)].map((item, index, all) => {
          const newest = item.entries[0];
          const active = item.scenarioId === currentId;
          const firstWaiting = item.waiting && !all[index - 1]?.waiting;
          return (
            <li key={item.scenarioId}>
              {firstWaiting && <div className="px-2 pt-3 pb-1 text-[11px] font-bold text-slate-400">{t.desk.sentBack}</div>}
              <button
                type="button"
                onClick={() => void open(item.scenarioId)}
                className={`relative w-full rounded-[4px] px-2.5 py-2 text-left ${active ? "bg-sheet shadow-sheet ring-1 ring-brand-100" : "hover:bg-sheet/70"}`}
              >
                {active && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-[1px] bg-brand-500" />}
                <div className="flex items-center gap-1.5">
                  {newest && <ActorMark entry={newest} size={18} />}
                  <span className="truncate text-[13px] font-bold">{item.name}</span>
                </div>
                <div className="mt-0.5 truncate pl-[24px] text-[11px] text-slate-500">
                  {item.waiting ? t.quote(item.waiting.reason || t.desk.stepNotes) : headline(summarize([...item.entries].reverse()))}
                </div>
                <div className="pl-[24px] text-[10px] text-slate-400">
                  {newest && `${actorLabel(newest)} ・ ${relativeTime(newest.at)}`} ・ {t.desk.edits(item.entries.length)}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

const EVIDENCE_POLL_MS = 5000;

/** What the unreviewed edits of the open scenario did, and one place to keep or send them back. */
export function ReviewPanel() {
  const pending = usePendingReview();
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const open = useStudio((s) => s.open);
  const inbox = useInbox();
  const timeline = useStudio((s) => (s.scenario ? s.timelines[s.scenario.id] : undefined));
  const loadTimeline = useStudio((s) => s.loadTimeline);
  const scenarioId = scenario?.id;
  // An MCP test run only appends evidence; it does not touch the scenario
  // file the watcher sees. Re-read while this panel is open and on refocus.
  useEffect(() => {
    if (!scenarioId) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadTimeline(scenarioId);
    };
    const timer = window.setInterval(refresh, EVIDENCE_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [scenarioId, loadTimeline]);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const oldestFirst = useMemo(() => [...pending].reverse(), [pending]);
  const summary = useMemo(() => summarize(oldestFirst), [oldestFirst]);
  const lines = useMemo(() => oldestFirst.flatMap((e) => describe(e, scenario, defs)), [oldestFirst, scenario, defs]);
  const newest = pending[0];
  const oldest = oldestFirst[0];
  const since = (oldest?.revision ?? 1) - 1;
  const evidence = useMemo(() => (timeline?.evidence ?? []).filter((e) => e.revision > since), [timeline, since]);
  const runs = evidence.filter((e): e is TestRun => e.kind === "testRun");
  const observed = evidence.filter((e): e is Observed => e.kind === "observation");
  const feedback = timeline?.openFeedback?.kind === "review" ? timeline.openFeedback : null;
  if (!newest || !oldest) {
    const next = inbox.find((i) => i.scenarioId !== scenario?.id && !i.waiting);
    return (
      <div className="p-5 text-[13px]">
        <div className="flex items-center gap-2 font-bold text-moegi-500">✓ {t.desk.reviewed}</div>
        {next ? (
          <button
            type="button"
            onClick={() => void open(next.scenarioId)}
            className="mt-4 flex w-full items-center gap-2 rounded-[4px] border border-slate-200 px-3 py-2 text-left hover:border-brand-500"
          >
            <span className="text-[11px] text-slate-400">{t.desk.next}</span>
            <span className="flex-1 truncate font-semibold">{next.name}</span>
            <span className="text-slate-400">→</span>
          </button>
        ) : (
          <p className="mt-2 text-slate-500">{t.desk.noneLeft}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <ActorMark entry={newest} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-bold">{headline(summary)}</div>
            <div className="text-[11px] text-slate-500">
              {actorLabel(newest)} ・ {t.evidence.revision(oldest.revision - 1)} → {newest.revision} ・ {relativeTime(newest.at)}
            </div>
          </div>
        </div>
        {feedback && <FeedbackBox feedback={feedback} fixedAfter={newest.revision > feedback.revision} />}
        <Section title={t.desk.explanation}>
          <Explanations entries={oldestFirst} />
        </Section>
        <Section title={t.desk.testRuns}>
          <TestRuns runs={runs} revision={scenario?.revision ?? 0} />
        </Section>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <Legend color="#2f8a4c" label={t.flow.aiAdded} />
          <Legend color="#f5872a" label={t.flow.aiChanged} />
          {summary.removed.length > 0 && <Legend color="#e8501f" label={t.desk.aiRemoved} />}
          <ChangeStepper />
        </div>
        <section>
          <div className="mb-1.5 text-[11px] font-bold text-slate-500">{t.desk.changes}</div>
          <Lines lines={lines} detailed />
        </section>
        {summary.removed.length > 0 && (
          <section>
            <div className="mb-1.5 text-[11px] font-bold text-shu-600">{t.desk.removed}</div>
            <ul className="space-y-1">
              {summary.removed.map((s) => (
                <li key={s.id} className="rounded-[4px] border border-shu-100 bg-shu-50 px-2 py-1 text-[12px] text-shu-600 line-through">
                  {plain(sentence(s, defs.get(s.type)))}
                </li>
              ))}
            </ul>
          </section>
        )}
        <Section title={t.desk.screens}>
          <Observations items={observed} />
        </Section>
      </div>
      <ReviewActions />
    </div>
  );
}

/** Walk the chart from one changed step to the next (N / Shift+N). */
function ChangeStepper() {
  const changeBy = useStudio((s) => s.changeBy);
  const button = "grid h-6 w-6 place-items-center rounded-[4px] border border-slate-200 text-slate-600 hover:border-brand-500 hover:text-brand-700";
  return (
    <span className="ml-auto flex items-center gap-1 text-slate-500">
      <button type="button" className={button} onClick={() => changeBy(-1)} title={t.desk.prevChangeTitle} aria-label={t.desk.prevChange}>
        ‹
      </button>
      <button type="button" className={button} onClick={() => changeBy(1)} title={t.desk.nextChangeTitle} aria-label={t.outline.nextChange}>
        ›
      </button>
      <kbd className="rounded bg-slate-100 px-1 text-[10px]">N</kbd>
    </span>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 rounded-[3px] bg-slate-100 px-2 py-0.5 text-slate-600">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/** Keep, send back to the AI with a reason, or undo everything the AI changed here. */
export function ReviewActions() {
  const pending = usePendingReview();
  const history = useStudio((s) => s.history);
  const approveAll = useStudio((s) => s.approveAll);
  const revertAll = useStudio((s) => s.revertAll);
  const [sending, setSending] = useKeptState("review.sending", false);
  if (pending.length === 0) return null;
  const blocker = groupRevertBlocker(pending, history);
  if (sending) {
    return (
      <div className="border-t border-slate-200 bg-sheet px-4 py-3">
        <SendBackForm onCancel={() => setSending(false)} onSent={() => setSending(false)} />
      </div>
    );
  }
  return (
    <div className="space-y-2 border-t border-slate-200 bg-sheet px-4 py-3">
      <div className="flex items-center text-[11px] text-slate-400">
        {t.desk.allEdits(pending.length)}
        <button
          type="button"
          onClick={() => void revertAll()}
          disabled={blocker !== null}
          title={blocker ?? t.desk.revertTitle}
          className="ml-auto text-slate-500 underline-offset-2 enabled:hover:text-shu-600 enabled:hover:underline disabled:text-slate-300"
        >
          ↶ {t.desk.revertAll}
        </button>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setSending(true)}
          title={t.desk.sendBackTitle}
          className="h-9 flex-1 rounded-[4px] border border-shu-500/60 px-3 text-[13px] font-semibold text-shu-600 hover:bg-shu-50"
        >
          {t.desk.sendBack}
        </button>
        <button
          type="button"
          onClick={() => void approveAll()}
          className="h-9 flex-[2] rounded-[4px] bg-ink px-4 text-[13px] font-semibold text-paper hover:bg-brand-700"
        >
          ✓ {t.desk.keep}
        </button>
      </div>
    </div>
  );
}
