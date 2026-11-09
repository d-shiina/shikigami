// The review desk: AI edits waiting to be looked at, across every flow.
// Opening one shows the flow's chart with what changed marked on
// it, the changes in words, and one place to keep or send them back.
import { ArrowRight, Check, ChevronDown, ChevronRight, CloudUpload, Undo2, X } from "lucide-react";
import type { HistoryEntry, Step, StepTypeDef } from "@shikigami/schema";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useStudio } from "../context";
import { api, type RunRecord } from "../lib/api";
import { actorLabel, type ChangeLine, describe, formatValue, relativeTime } from "../lib/changes";
import { type Effect, effects as effectsOf } from "../lib/effects";
import { type ChangeCard, changeCards, checksOf, digest, headline, partDiff, purpose, stepBefore, summarize, wordDiff } from "../lib/review";
import { type Part, sentence } from "../lib/sentence";
import { approvedUpTo, groupRevertBlocker, pendingIn } from "../store";
import { FeedbackBox, Observations, type Observed, type Review, SendBackForm, Section, TestRuns, type TestRun } from "./Evidence";
import { Monogram } from "./FlowsPage";
import { ActorMark, Lines, usePendingReview } from "./Timeline";
import { Promises, usePromises } from "./Promises";
import { promiseCounts } from "../lib/promises";
import { stepLabel, t } from "../lib/i18n";
import { useReviewView } from "../lib/reviewView";

export type InboxItem = {
  flowId: string;
  name: string;
  entries: HistoryEntry[];
  /** Sent back and the AI has not edited since: nothing for the person to do yet. */
  waiting: Review | null;
};

/** Flows with unreviewed AI edits, newest edit first. */
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
          return { flowId: s.id, name: s.name, entries, waiting };
        })
        .filter((i) => i.entries.length > 0)
        .sort((a, b) => (b.entries[0]?.at ?? "").localeCompare(a.entries[0]?.at ?? "")),
    [summaries, histories, reviewed, timelines],
  );
}

/** The inbox folded to a strip when the window is narrow: one mark per flow that waits. */
/** Opens a flow on the review desk at its report. */
function useOpenReport(): (flowId: string) => void {
  const open = useStudio((s) => s.open);
  const setView = useReviewView((s) => s.setView);
  return (flowId) => {
    setView("report");
    void open(flowId);
  };
}

export function ReviewRail({ onExpand }: { onExpand: () => void }) {
  const inbox = useInbox();
  const openReport = useOpenReport();
  const currentId = useStudio((s) => s.flow?.id);
  return (
    <aside className="flex h-full flex-col items-center gap-2 border-r border-slate-200 bg-paper pt-3">
      <button
        type="button"
        onClick={onExpand}
        title={t.desk.expand}
        className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-200 hover:text-ink"
      >
        »
      </button>
      {inbox.map((item) => (
        <button key={item.flowId} type="button" title={item.name} onClick={() => openReport(item.flowId)}>
          <Monogram name={item.name} active={item.flowId === currentId} />
        </button>
      ))}
    </aside>
  );
}

export function ReviewInbox({ onCollapse }: { onCollapse?: () => void }) {
  const inbox = useInbox();
  const openReport = useOpenReport();
  const currentId = useStudio((s) => s.flow?.id);
  return (
    <aside className="flex h-full flex-col border-r border-slate-200 bg-paper">
      <div className="px-3 pt-3 pb-1">
        <div className="flex items-center text-[12px] font-bold">
          {t.desk.title}
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              title={t.close}
              className="ml-auto grid h-6 w-6 place-items-center rounded-lg font-normal text-slate-500 hover:bg-slate-200 hover:text-ink"
            >
              «
            </button>
          )}
        </div>
        <div className="text-[11px] leading-relaxed text-slate-400">{t.desk.hint}</div>
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {inbox.filter((i) => !i.waiting).length === 0 && (
          <li className="mx-1 rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
            {t.desk.empty}
          </li>
        )}
        {[...inbox.filter((i) => !i.waiting), ...inbox.filter((i) => i.waiting)].map((item, index, all) => {
          const newest = item.entries[0];
          const active = item.flowId === currentId;
          const firstWaiting = item.waiting && !all[index - 1]?.waiting;
          return (
            <li key={item.flowId}>
              {firstWaiting && <div className="px-2 pt-3 pb-1 text-[11px] font-bold text-slate-400">{t.desk.sentBack}</div>}
              <button
                type="button"
                onClick={() => openReport(item.flowId)}
                className={`relative w-full rounded-lg px-2.5 py-2 text-left ${active ? "bg-sheet shadow-sheet ring-1 ring-brand-100" : "hover:bg-sheet/70"}`}
              >
                {active && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-xs bg-brand-500" />}
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

/**
 * What the person has done on this review so far: which changes they looked
 * at and how they answered the AI's questions. Kept for the session only,
 * keyed by flow and newest revision so a new edit starts fresh.
 */
type Marks = {
  seen: Record<string, true>;
  answers: Record<string, "ok" | "no">;
  /** What the send-back form starts with, when an answer opened it, and on which flow. */
  sendBackWith: { flowId: string; text: string } | undefined;
  setSendBackWith(value: { flowId: string; text: string } | undefined): void;
  /**
   * The flow whose send-back form is open. Kept here so it survives switching between the
   * report and the chart, and tied to the flow so it never opens on another one.
   */
  sending: string | null;
  setSending(flowId: string | null): void;
  see(key: string): void;
  answer(key: string, value: "ok" | "no" | null): void;
};
const useMarks = create<Marks>((set) => ({
  seen: {},
  answers: {},
  sendBackWith: undefined,
  setSendBackWith: (value) => set({ sendBackWith: value }),
  sending: null,
  setSending: (flowId) => set(flowId ? { sending: flowId } : { sending: null, sendBackWith: undefined }),
  see: (key) => set((m) => (m.seen[key] ? m : { seen: { ...m.seen, [key]: true } })),
  answer: (key, value) =>
    set((m) => {
      const answers = { ...m.answers };
      if (value) answers[key] = value;
      else delete answers[key];
      return { answers };
    }),
}));

/** Re-reads the open flow's evidence while it is reviewed: an MCP test run only appends evidence, which the file watcher does not see. */
function usePollEvidence(flowId: string | undefined) {
  const loadTimeline = useStudio((s) => s.loadTimeline);
  useEffect(() => {
    if (!flowId) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadTimeline(flowId);
    };
    const timer = window.setInterval(refresh, EVIDENCE_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [flowId, loadTimeline]);
}

/** Everything the review of the open flow's unreviewed AI edits is made of, shared by the report and the bar under the chart. */
function useReview() {
  const pending = usePendingReview();
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const timeline = useStudio((s) => (s.flow ? s.timelines[s.flow.id] : undefined));
  const answers = useMarks((m) => m.answers);
  const flowId = flow?.id;
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const oldestFirst = useMemo(() => [...pending].reverse(), [pending]);
  const summary = useMemo(() => summarize(oldestFirst, flow?.steps), [oldestFirst, flow]);
  const newest = pending[0];
  const oldest = oldestFirst[0];
  const since = (oldest?.revision ?? 1) - 1;
  const evidence = useMemo(() => (timeline?.evidence ?? []).filter((e) => e.revision > since), [timeline, since]);
  // An AI often writes and runs its test cases just before the edit, at the revision before it.
  const testEvidence = useMemo(
    () => (timeline?.evidence ?? []).filter((e) => (e.kind === "testCase" || e.kind === "testCases") && e.revision >= since),
    [timeline, since],
  );
  const promises = usePromises(flowId, testEvidence, flow?.revision ?? 0);
  const feedback = timeline?.openFeedback?.kind === "review" ? timeline.openFeedback : null;
  const checks = useMemo(() => checksOf(oldestFirst), [oldestFirst]);
  const markKey = `${flowId}@${newest?.revision ?? 0}`;
  const freshPromises = promises.filter((p) => p.fresh);
  const unansweredPromises = freshPromises.filter((p) => !answers[`${markKey}:promise:${p.name}`]).length;
  const unansweredChecks = checks.filter((q) => !answers[`${markKey}:${q}`]).length;
  return {
    flow,
    flowId,
    defs,
    pending,
    oldestFirst,
    summary,
    newest,
    oldest,
    evidence,
    promises,
    freshPromises,
    feedback,
    checks,
    markKey,
    unansweredPromises,
    unansweredChecks,
    unanswered: unansweredPromises + unansweredChecks,
    broken: promiseCounts(promises).broken,
  };
}

/** The AI's explanation of its edits, oldest first, without the line that is already the report's title. */
function explanationOf(entries: HistoryEntry[], title: string): string[] {
  const lines = entries.flatMap((e) => (e.summary ?? "").split("\n").map((l) => l.trim().replace(/^[-・*]\s*/, "")));
  return [...new Set(lines.filter((l) => l && l !== title))];
}

/** Nothing left to review in the open flow: say so, and offer the next flow that waits. */
function Reviewed() {
  const flow = useStudio((s) => s.flow);
  const open = useStudio((s) => s.open);
  const setView = useReviewView((s) => s.setView);
  const inbox = useInbox();
  const next = inbox.find((i) => i.flowId !== flow?.id && !i.waiting);
  return (
    <div className="mx-auto max-w-[520px] text-[13px]">
      <div className="flex items-center gap-2 font-bold text-moegi-500">
        <Check size={14} strokeWidth={2} aria-hidden="true" />
        {t.desk.reviewed}
      </div>
      {next ? (
        <button
          type="button"
          onClick={() => {
            setView("report");
            void open(next.flowId);
          }}
          className="mt-4 flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-sheet px-3 py-2 text-left hover:border-brand-500"
        >
          <span className="text-[11px] text-slate-400">{t.desk.next}</span>
          <span className="flex-1 truncate font-semibold">{next.name}</span>
          <ArrowRight size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
        </button>
      ) : (
        <p className="mt-2 text-slate-500">{t.desk.noneLeft}</p>
      )}
    </div>
  );
}

/**
 * The AI's change as a report on one sheet of paper, the same paper as the
 * procedure: what the AI says it did, the three things to decide at a
 * glance, then the promises, the AI's questions, what it touches outside and
 * what changed, with the verdict always at the bottom of the desk.
 */
export function ReviewReport() {
  const r = useReview();
  const answer = useMarks((m) => m.answer);
  const answers = useMarks((m) => m.answers);
  const see = useMarks((m) => m.see);
  const seenMarks = useMarks((m) => m.seen);
  const setSendBackWith = useMarks((m) => m.setSendBackWith);
  const setSending = useMarks((m) => m.setSending);
  const [runsOpen, setRunsOpen] = useState<boolean | null>(null);
  const { flow, oldestFirst, summary, newest, oldest, defs, markKey } = r;
  const cards = useMemo(
    () => changeCards(oldestFirst, summary, flow?.steps ?? [], r.feedback?.revision ?? null),
    [oldestFirst, summary, flow, r.feedback],
  );
  const others = useMemo(
    () =>
      oldestFirst
        .flatMap((e) => describe(e, flow, defs))
        .filter((l) => l.verb === "variable" || l.verb === "flow" || l.verb === "replace" || (l.verb === "remove" && !l.stepId && l.subject.startsWith(t.variables))),
    [oldestFirst, flow, defs],
  );
  const effects = useMemo(() => {
    const newestFirst = [...oldestFirst].reverse();
    return effectsOf(flow?.steps ?? [], summary.steps, summary.removed, defs, (step) => stepBefore(step, newestFirst));
  }, [oldestFirst, flow, summary, defs]);
  if (!newest || !oldest) {
    return (
      <div className="canvas-bg h-full overflow-y-auto px-6 pt-14 pb-24">
        <Reviewed />
      </div>
    );
  }
  const title = purpose(oldestFirst, summary);
  const explanation = explanationOf(oldestFirst, title);
  const runs = r.evidence.filter((e): e is TestRun => e.kind === "testRun");
  const observed = r.evidence.filter((e): e is Observed => e.kind === "observation");
  const sendBackWithText = (text: string) => {
    if (!r.flowId) return;
    setSendBackWith({ flowId: r.flowId, text });
    setSending(r.flowId);
  };
  const changedIds = cards.filter((c) => c.kind !== "removed" && !c.movedOnly).map((c) => c.stepId);
  const showRuns = runsOpen ?? r.freshPromises.length === 0;
  const flowName = flow?.name ?? "";
  // A small change with no new promise reads best from what changed; otherwise the promises lead.
  const changesFirst = r.freshPromises.length === 0 && r.checks.length === 0;
  let n = changesFirst ? 1 : 0;
  const sectionCount = 1 + (r.checks.length > 0 ? 1 : 0) + 2;
  const changesSection = (
    <PaperSection n={changesFirst ? 1 : sectionCount} title={t.desk.changes} aside={headline(summary)}>
            <div className="space-y-3">
              {cards.map((card) => (
                <ChangeCardView
                  key={card.stepId}
                  card={card}
                  defs={defs}
                  lines={oldestFirst.flatMap((e) => describe(e, flow, defs)).filter((l) => l.stepId === card.stepId && l.diffs.length > 0)}
                  seen={Boolean(seenMarks[`${markKey}:${card.stepId}`])}
                  onSee={() => see(`${markKey}:${card.stepId}`)}
                />
              ))}
            </div>
            {others.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[12px] font-bold text-slate-500">{t.desk.otherChanges}</div>
                <Lines lines={others} detailed />
              </div>
            )}
          </PaperSection>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="canvas-bg min-h-0 flex-1 overflow-y-auto px-6 pt-8 pb-12">
        <article className="@container mx-auto max-w-[940px] rounded-lg border border-slate-200 bg-sheet px-6 py-7 shadow-sheet xl:px-11 xl:py-9" data-review-report>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-b-[1.5px] border-ink pb-2 text-[12px] text-slate-500">
            <span className="truncate">
              {flowName} ・ {t.desk.reportOf}
            </span>
            <span className="flex items-center gap-1.5">
              <ActorMark entry={newest} size={16} />
              {actorLabel(newest)} ・ {relativeTime(newest.at)} ・{" "}
              {summary.created ? t.evidence.revision(newest.revision) : `${t.evidence.revision(oldest.revision - 1)} → ${newest.revision}`} ・ {headline(summary)}
            </span>
          </div>
          <h1 className="mt-5 text-[22px] leading-snug font-bold">{title}</h1>
          {explanation.length > 0 && (
            <div className="mt-2 text-[13px] leading-relaxed text-slate-600">
              <div className="text-[12px] text-slate-500">{t.desk.explanationLead}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {explanation.map((line) => (
                  <li key={line} className="whitespace-pre-wrap">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.feedback && (
            <div className="mt-4">
              <FeedbackBox feedback={r.feedback} fixedAfter={newest.revision > r.feedback.revision} />
            </div>
          )}
          <Tiles review={r} effects={effects} />

          {changesFirst && changesSection}
          <PaperSection id="review-promises" n={++n} title={t.promises.title} note={t.desk.promisesNote} aside={r.freshPromises.length > 0 ? t.promises.fromAi(r.freshPromises.length) : undefined}>
            {r.flowId && (
              <Promises
                flowId={r.flowId}
                revision={flow?.revision ?? 0}
                promises={r.promises}
                answers={Object.fromEntries(
                  r.freshPromises.flatMap((p) => {
                    const a = answers[`${markKey}:promise:${p.name}`];
                    return a ? [[p.name, a]] : [];
                  }),
                )}
                onAnswer={(name, value) => answer(`${markKey}:promise:${name}`, value)}
                onWrong={(p) => sendBackWithText(t.promises.wrongNote(p.text))}
                onAsk={() => sendBackWithText(t.promises.askReason)}
              />
            )}
          </PaperSection>

          {r.checks.length > 0 && (
            <PaperSection id="review-checks" n={++n} title={t.desk.checks} note={t.desk.checksNote} aside={t.desk.checksFrom(r.checks.length)}>
              <Checks checks={r.checks} markKey={markKey} onNo={(q) => sendBackWithText(t.desk.checkNote(q))} />
            </PaperSection>
          )}

          <PaperSection id="review-effects" n={++n} title={t.desk.effects} note={t.desk.effectsNote}>
            <EffectList effects={effects} />
          </PaperSection>

          {!changesFirst && changesSection}

          {(runs.length > 0 || observed.length > 0) && (
            <section className="mt-8">
              <button
                type="button"
                onClick={() => setRunsOpen(!showRuns)}
                className="flex w-full items-center gap-1.5 border-t border-slate-200 pt-3 text-left text-[13px] font-bold text-slate-600 hover:text-ink"
              >
                <span className="w-3 text-slate-400">{showRuns ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}</span>
                {t.desk.tryRuns}
                {runs.at(-1) && <span className="ml-auto text-[12px] font-normal text-slate-500">{relativeTime(runs.at(-1)!.finishedAt)}</span>}
              </button>
              {showRuns && (
                <div className="mt-3 space-y-4">
                  <TestResult runs={runs} revision={flow?.revision ?? 0} changedIds={changedIds} />
                  {observed.length > 0 && (
                    <Section title={t.desk.screens}>
                      <Observations items={observed} />
                    </Section>
                  )}
                </div>
              )}
            </section>
          )}
        </article>
      </div>
    </div>
  );
}

/**
 * The verdict at the bottom of the review desk, under the report and under the
 * chart, procedure or variables opened from it (with the way back). One
 * component in one place, so a send-back being written survives switching.
 */
export function ReviewFoot({ report }: { report: boolean }) {
  const r = useReview();
  usePollEvidence(r.flowId);
  const setView = useReviewView((s) => s.setView);
  const sendBackWith = useMarks((m) => (m.sendBackWith && m.sendBackWith.flowId === r.flowId ? m.sendBackWith.text : undefined));
  const sending = useMarks((m) => m.sending !== null && m.sending === r.flowId);
  const setSending = useMarks((m) => m.setSending);
  if (!r.newest) return null;
  return (
    <div className={`shrink-0 border-t border-slate-200 bg-sheet ${report ? "shadow-raised" : ""}`}>
      {/* A long send-back (many notes, a tall reason) scrolls here instead of pushing the buttons off screen. */}
      <div className={`max-h-[60vh] overflow-y-auto ${report ? "mx-auto max-w-[940px] px-6" : "px-4"}`}>
        <ReviewActions
          compact={!report}
          unanswered={r.unanswered}
          broken={r.broken}
          sending={sending}
          setSending={(on) => setSending(on ? (r.flowId ?? null) : null)}
          initialReason={sending ? sendBackWith : undefined}
          onBack={report ? undefined : () => setView("report")}
        />
      </div>
    </div>
  );
}

/** The three things to decide, at a glance: whether the promises hold, what waits for an answer, and what changes outside. Each leads to its section. */
function Tiles({ review: r, effects }: { review: ReturnType<typeof useReview>; effects: Effect[] }) {
  const counts = promiseCounts(r.promises);
  const changed = effects.filter((e) => e.status !== "same");
  const danger = changed.some((e) => e.risk === "dangerous" && e.status !== "removed");
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const promise =
    r.promises.length === 0
      ? { tone: "plain", big: t.desk.tileNoPromises, small: t.desk.tileNoPromisesSub }
      : counts.broken > 0
        ? { tone: "bad", big: t.desk.tileBroken(counts.broken), small: t.desk.tileOfPromises(r.promises.length) }
        : counts.unchecked > 0
          ? { tone: "plain", big: t.desk.tileUnchecked(counts.unchecked), small: t.desk.tileUncheckedSub }
          : { tone: "good", big: t.desk.tileKept, small: t.desk.tilePromises(r.promises.length) };
  const asked = r.freshPromises.length + r.checks.length;
  const ask =
    r.unanswered > 0
      ? { tone: "plain", big: t.desk.tileAsk(r.unanswered), small: t.desk.tileAskSub(r.unansweredPromises, r.unansweredChecks) }
      : { tone: "plain", big: t.desk.tileAnswered, small: asked > 0 ? t.desk.tileAnsweredSub : "" };
  const first = changed[0];
  const outside =
    changed.length > 0
      ? {
          tone: danger ? "bad" : "plain",
          big: t.desk.tileEffects(changed.length),
          small: first ? `${t.desk.effect[first.status]}：${first.action}${first.target ? ` ${first.target}` : ""}` : "",
        }
      : { tone: "plain", big: t.desk.tileNoEffects, small: t.desk.tileNoEffectsSub };
  const tone = {
    bad: "bg-shu-50 text-shu-600",
    good: "bg-moegi-100 text-moegi-500",
    plain: "bg-slate-100 text-ink",
  } as Record<string, string>;
  const tiles: [string, typeof promise][] = [
    ["review-promises", promise],
    ...(asked > 0 ? ([[r.checks.length > 0 && r.unansweredPromises === 0 ? "review-checks" : "review-promises", ask]] as [string, typeof promise][]) : []),
    ["review-effects", outside],
  ];
  return (
    <div className="mt-5 flex flex-col gap-2.5 @min-[640px]:flex-row">
      {tiles.map(([id, tile]) => (
        <button key={tile.big} type="button" onClick={() => jump(id)} className={`min-w-0 flex-1 rounded-lg px-3.5 py-2.5 text-left hover:brightness-[0.97] ${tone[tile.tone]}`}>
          <span className="block text-[16px] leading-snug font-bold">{tile.big}</span>
          {tile.small && <span className={`mt-0.5 block truncate text-[12px] ${tile.tone === "plain" ? "text-slate-600" : ""}`}>{tile.small}</span>}
        </button>
      ))}
    </div>
  );
}

function PaperSection({ id, n, title, note, aside, children }: { id?: string; n?: number; title: string; note?: string; aside?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-9 scroll-mt-6">
      <h2 className="flex items-center gap-2 text-[15px] font-bold">
        {n !== undefined && <span className="grid h-5 w-5 place-items-center rounded-md bg-ink text-[11.5px] text-paper">{n}</span>}
        {title}
        {aside && <span className="ml-auto text-[12px] font-normal text-slate-500">{aside}</span>}
      </h2>
      {note && <p className="mt-0.5 mb-3 ml-7 text-[12px] text-slate-500">{note}</p>}
      <div className={note ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

const KIND_TAG: Record<ChangeCard["kind"], { label: () => string; style: string }> = {
  added: { label: () => t.verbs.add, style: "bg-moegi-100 text-moegi-500" },
  changed: { label: () => t.verbs.update, style: "bg-amber-50 text-amber-700" },
  removed: { label: () => t.verbs.remove, style: "bg-shu-50 text-shu-600" },
};

/** One changed node: what it did before and what it does now, in the flow chart's words, side by side on the paper. */
function ChangeCardView({
  card,
  defs,
  lines,
  seen,
  onSee,
}: {
  card: ChangeCard;
  defs: ReadonlyMap<string, StepTypeDef>;
  lines: ChangeLine[];
  seen: boolean;
  onSee: () => void;
}) {
  const goTo = useStudio((s) => s.goTo);
  const [open, setOpen] = useState(false);
  const read = (step: Step | null) => (step ? sentence(step, defs.get(step.type)) : null);
  const before = read(card.before);
  const after = read(card.after);
  const diff = before && after ? partDiff(before, after) : null;
  const same = diff !== null && !diff.added.some(Boolean) && !diff.dropped.some(Boolean);
  const step = (card.after ?? card.before)!;
  const name = step.name || null;
  const tag = KIND_TAG[card.kind];
  const show = () => {
    onSee();
    // Going to a node leaves the report for the chart (the review desk follows `reveal`).
    if (card.after) goTo(card.stepId);
  };
  const side = (label: string, body: React.ReactNode) => (
    <div className="min-w-0 px-3.5 py-2.5 text-[12.5px] leading-relaxed">
      <div className="text-[11px] font-semibold text-slate-500">{label}</div>
      {body}
    </div>
  );
  return (
    <div onClick={onSee}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="min-w-0 truncate text-[13px] font-bold">{name ?? stepLabel(step.type, defs.get(step.type)?.label)}</span>
        <span className={`shrink-0 rounded-md px-1.5 text-[10px] leading-4 font-bold ${tag.style}`}>{tag.label()}</span>
        {card.afterFeedback && <span className="shrink-0 rounded-md bg-shu-50 px-1.5 text-[10px] leading-4 font-bold text-shu-600">{t.desk.afterFeedback}</span>}
        {seen && <Check size={12} strokeWidth={2.25} className="shrink-0 text-moegi-500" aria-label={t.desk.seenMark} />}
        {card.after && (
          <button type="button" onClick={show} className="ml-auto shrink-0 text-[12px] text-brand-600 hover:underline">
            {t.desk.showInFlow} ›
          </button>
        )}
      </div>
      {before && after ? (
        <div className="grid overflow-hidden rounded-lg border border-slate-200 @min-[640px]:grid-cols-2">
          {side(
            t.desk.before,
            <span className="text-slate-600">
              <Marked parts={before} marks={diff?.dropped} other={after} tone="drop" />
            </span>,
          )}
          <div className="border-t border-slate-200 @min-[640px]:border-t-0 @min-[640px]:border-l">
            {side(
              t.desk.after,
              <span>
                <Marked parts={after} marks={diff?.added} other={before} tone="add" />
              </span>,
            )}
          </div>
        </div>
      ) : (
        // Added or removed: only one side to show.
        <div className="rounded-lg border border-slate-200">
          {side(
            after ? t.desk.after : t.desk.before,
            <span className={after ? "" : "text-shu-600 line-through"}>
              <Marked parts={(after ?? before)!} other={null} tone={after ? "add" : "drop"} />
            </span>,
          )}
        </div>
      )}
      {card.movedOnly ? (
        <p className="mt-1 text-[12px] text-slate-500">{t.desk.moved}</p>
      ) : (
        same && lines.length > 0 && <p className="mt-1 text-[12px] text-slate-500">{t.desk.sameSentence}</p>
      )}
      {lines.length > 0 && (
        <div className="mt-1">
          <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-ink">
            {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            {t.desk.details}
          </button>
          {open && (
            <div className="mt-1">
              <Lines lines={lines} detailed />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A sentence with the parts that differ from the other side marked. */
function Marked({ parts, marks, other, tone }: { parts: Part[]; marks?: boolean[]; other: Part[] | null; tone: "add" | "drop" }) {
  const hit = tone === "add" ? "rounded-sm bg-moegi-100 font-semibold text-moegi-500" : "rounded-sm bg-shu-50 text-shu-600 line-through";
  // A changed expression is one chip on both sides: mark the words inside it instead of the whole chip.
  const counterpart = (i: number) => {
    const o = other?.[i];
    return o && "code" in o ? o.code : null;
  };
  return (
    <>
      {parts.map((p, i) => {
        if ("text" in p) {
          return (
            <span key={i} className={marks?.[i] ? hit : ""}>
              {p.text}
            </span>
          );
        }
        const pair = marks?.[i] ? counterpart(i) : null;
        return (
          <code key={i} className={`mx-0.5 rounded bg-brand-50 px-1 font-mono text-[12px] text-brand-600 ${marks?.[i] && pair === null ? hit : ""}`}>
            {pair === null
              ? p.code
              : wordDiff(p.code, pair).map((w, j) => (
                  <span key={j} className={w.changed ? hit : ""}>
                    {w.text}
                  </span>
                ))}
          </code>
        );
      })}
    </>
  );
}

/** What the flow touches outside, with what this review changes on top. */
function EffectList({ effects }: { effects: Effect[] }) {
  const [showSame, setShowSame] = useState(false);
  const changed = effects.filter((e) => e.status !== "same");
  const same = effects.filter((e) => e.status === "same");
  if (effects.length === 0) return <p className="text-[12px] text-slate-500">{t.desk.noEffects}</p>;
  return (
    <div className="space-y-1">
      {changed.length === 0 && <p className="text-[12px] text-slate-600">{t.desk.noEffectChange}</p>}
      {changed.map((e) => (
        <EffectRow key={`${e.status}${e.action}${e.target}`} effect={e} />
      ))}
      {same.length > 0 && (
        <>
          <button type="button" onClick={() => setShowSame(!showSame)} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-ink">
            {showSame ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            {t.desk.sameEffects(same.length)}
          </button>
          {showSame && same.map((e) => <EffectRow key={`same${e.action}${e.target}`} effect={e} />)}
        </>
      )}
    </div>
  );
}

const EFFECT_TAG: Record<Effect["status"], string> = {
  added: "bg-moegi-100 text-moegi-500",
  changed: "bg-amber-50 text-amber-700",
  removed: "bg-slate-100 text-slate-600",
  same: "",
};

function EffectRow({ effect }: { effect: Effect }) {
  const goTo = useStudio((s) => s.goTo);
  const danger = effect.risk === "dangerous";
  return (
    <button
      type="button"
      onClick={() => effect.status !== "removed" && effect.stepId && goTo(effect.stepId)}
      className="flex w-full items-start gap-1.5 rounded-md px-1 py-0.5 text-left text-[12.5px] leading-relaxed hover:bg-slate-100"
    >
      {effect.status === "same" ? (
        <span className="w-[3.2em] shrink-0 text-center text-slate-400">・</span>
      ) : (
        <span className={`mt-0.5 w-[3.2em] shrink-0 rounded-md text-center text-[10px] leading-4 font-bold ${EFFECT_TAG[effect.status]}`}>
          {t.desk.effect[effect.status]}
        </span>
      )}
      <span className={`min-w-0 ${effect.status === "same" ? "text-slate-500" : ""} ${effect.status === "removed" ? "line-through" : ""}`}>
        <span className={danger ? "font-semibold text-shu-600" : effect.reads ? "" : "font-semibold"}>{effect.action}</span>
        {effect.target && <span className="ml-1 font-mono text-[12px] break-all">{effect.target}</span>}
        {effect.external && (
          <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-amber-700">
            <CloudUpload size={12} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
            {t.desk.sentOutside(effect.external.service, effect.external.data)}
          </span>
        )}
      </span>
    </button>
  );
}

// Run records do not change once a run has finished.
const records = new Map<string, Promise<RunRecord>>();
function useRunRecord(runId: string | null): RunRecord | null {
  const [record, setRecord] = useState<RunRecord | null>(null);
  useEffect(() => {
    setRecord(null);
    if (!runId) return;
    let live = true;
    let request = records.get(runId);
    if (!request) {
      request = api.runRecord(runId);
      records.set(runId, request);
      request.catch(() => records.delete(runId));
    }
    request.then(
      (r) => live && setRecord(r),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [runId]);
  return record;
}

/** The newest AI test run: whether it ran the current content, reached the changed nodes, and what came out. */
function TestResult({ runs, revision, changedIds }: { runs: TestRun[]; revision: number; changedIds: string[] }) {
  const latest = runs.at(-1) ?? null;
  const record = useRunRecord(latest?.runId ?? null);
  const [older, setOlder] = useState(false);
  if (!latest) return <TestRuns runs={[]} revision={revision} />;
  const current = latest.revision === revision;
  const result = record ? digest(record, changedIds) : null;
  return (
    <div className="space-y-1.5">
      <TestRuns runs={[latest]} revision={revision} />
      {!current && <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">{t.desk.staleTest}</p>}
      {result && (
        <div className="grid grid-cols-[6.5em_1fr] gap-x-2 gap-y-0.5 px-1 text-[12px]">
          {result.total > 0 && !result.partial && (
            <>
              <span className="text-slate-500">{t.desk.changedNodes}</span>
              <span className={result.missed.length > 0 ? "text-amber-700" : ""}>{t.desk.covered(result.covered, result.total)}</span>
            </>
          )}
          {result.outputs.length > 0 && (
            <>
              <span className="text-slate-500">{t.desk.outputs}</span>
              <span className="min-w-0 space-y-0.5">
                {result.outputs.map(([name, value]) => (
                  <span key={name} className="block truncate">
                    <code className="font-mono text-[11.5px] text-brand-600">{name}</code> = {formatValue(value)}
                  </span>
                ))}
              </span>
            </>
          )}
          {result.logs.length > 0 && (
            <>
              <span className="text-slate-500">{t.desk.logs}</span>
              <span className="min-w-0 space-y-0.5">
                {result.logs.map((line, i) => (
                  <span key={i} className="block truncate">
                    {line}
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
      )}
      {result && result.missed.length > 0 && <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">{t.desk.notCovered(result.missed.length)}</p>}
      {runs.length > 1 && (
        <div>
          <button type="button" onClick={() => setOlder(!older)} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-ink">
            {older ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            {t.desk.olderRuns(runs.length - 1)}
          </button>
          {older && <TestRuns runs={runs.slice(0, -1)} revision={revision} />}
        </div>
      )}
    </div>
  );
}

/** The AI's questions only a person can answer. "No…" opens the send-back form with the question quoted. */
function Checks({ checks, markKey, onNo }: { checks: string[]; markKey: string; onNo: (q: string) => void }) {
  const answers = useMarks((m) => m.answers);
  const answer = useMarks((m) => m.answer);
  return (
    <ul className="border-t border-slate-200">
      {checks.map((q) => {
        const key = `${markKey}:${q}`;
        const value = answers[key];
        const pick = (v: "ok" | "no") => answer(key, value === v ? null : v);
        const chip = (on: boolean, tone: string) =>
          `rounded-md border px-2.5 text-[12px] leading-6 whitespace-nowrap ${on ? `${tone} font-semibold` : "border-slate-200 text-slate-600 hover:border-slate-400"}`;
        return (
          <li key={q} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 border-b border-slate-100 px-1 py-2.5">
            <span
              className={`mt-[4px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border text-white ${
                value === "ok" ? "border-moegi-500 bg-moegi-500" : value === "no" ? "border-shu-500 bg-shu-500" : "border-slate-400"
              }`}
            >
              {value === "ok" ? <Check size={10} strokeWidth={3} /> : value === "no" ? <X size={10} strokeWidth={3} /> : null}
            </span>
            <p className="min-w-[16em] flex-1 text-[13px] leading-relaxed font-semibold whitespace-pre-wrap">{q}</p>
            <div className="flex shrink-0 gap-1.5">
              <button type="button" onClick={() => pick("ok")} className={chip(value === "ok", "border-moegi-500 text-moegi-500")}>
                {t.desk.answerOk}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (value !== "no") onNo(q);
                  pick("no");
                }}
                className={chip(value === "no", "border-shu-500 text-shu-600")}
              >
                {t.desk.answerNo}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Mark as reviewed, send back to the AI with a reason, or undo everything the
 * AI changed here — each with what it does. Laid out in one row under the
 * report's paper; `compact` is the strip kept under the chart, with the way
 * back to the report.
 */
export function ReviewActions({
  unanswered = 0,
  broken = 0,
  sending,
  setSending,
  initialReason,
  compact = false,
  onBack,
}: {
  unanswered?: number;
  broken?: number;
  sending: boolean;
  setSending: (on: boolean) => void;
  initialReason?: string;
  compact?: boolean;
  onBack?: () => void;
}) {
  const pending = usePendingReview();
  const history = useStudio((s) => s.history);
  const approveAndPublish = useStudio((s) => s.approveAndPublish);
  const published = useStudio((s) => s.published);
  const revertAll = useStudio((s) => s.revertAll);
  const [hint, setHint] = useState<"keep" | "sendBack" | "revert" | null>(null);
  if (pending.length === 0) return null;
  const blocker = groupRevertBlocker(pending, history);
  const created = pending.some((e) => e.kind === "create");
  if (sending) {
    return (
      <div className="py-3">
        <SendBackForm onCancel={() => setSending(false)} onSent={() => setSending(false)} initialReason={initialReason} />
      </div>
    );
  }
  const where = published ? t.desk.publishedNow(published.version, published.name) : t.desk.notPublishedYet;
  const means = hint === null ? null : { keep: t.desk.keepMeans, sendBack: t.desk.sendBackMeans, revert: t.desk.revertMeans }[hint];
  const hover = (key: NonNullable<typeof hint>) => ({ onMouseEnter: () => setHint(key), onFocus: () => setHint(key), onMouseLeave: () => setHint(null), onBlur: () => setHint(null) });
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${compact ? "py-2" : "py-3"}`}>
      <div className="min-w-[14em] flex-1">
        {(broken > 0 || (compact && unanswered > 0)) && (
          <div className="flex flex-wrap gap-x-3 text-[12px]">
            {broken > 0 && <span className="font-semibold text-shu-600">{t.desk.barBroken(broken)}</span>}
            {compact && unanswered > 0 && <span className="text-slate-500">{t.desk.barUnanswered(unanswered)}</span>}
          </div>
        )}
        {!compact || means ? <p className="line-clamp-2 text-[11.5px] leading-relaxed text-slate-500">{means ?? where}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title={t.desk.backToReportTitle}
            className="h-8 rounded-lg border border-slate-300 px-3 text-[12.5px] whitespace-nowrap text-ink hover:bg-paper"
          >
            {t.desk.backToReport}
          </button>
        )}
        {/* A new flow has nothing to go back to; it is deleted from the library instead. */}
        {!created && (
          <button
            type="button"
            onClick={() => void revertAll()}
            disabled={blocker !== null}
            title={blocker ?? `${t.desk.allEdits(pending.length)}\n${t.desk.revertTitle}`}
            {...hover("revert")}
            className="flex items-center gap-1 text-[12px] whitespace-nowrap text-slate-500 underline-offset-2 enabled:hover:text-shu-600 enabled:hover:underline disabled:text-slate-300"
          >
            <Undo2 size={12} aria-hidden="true" />
            {t.desk.revertAll}
          </button>
        )}
        <button
          type="button"
          onClick={() => setSending(true)}
          title={t.desk.sendBackTitle}
          {...hover("sendBack")}
          className="h-8 rounded-lg border border-shu-500/60 px-3 text-[13px] font-semibold whitespace-nowrap text-shu-600 hover:bg-shu-50"
        >
          {t.desk.sendBack}
        </button>
        <button
          type="button"
          onClick={() => void approveAndPublish()}
          title={t.desk.keepTitle}
          {...hover("keep")}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-semibold whitespace-nowrap text-on-primary hover:bg-primary-hover"
        >
          <Check size={14} strokeWidth={2} aria-hidden="true" />
          {t.desk.keep}
          {unanswered > 0 && <span className="font-normal opacity-75">{t.desk.unanswered(unanswered)}</span>}
        </button>
      </div>
    </div>
  );
}
