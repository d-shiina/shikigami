// The review desk: AI edits waiting to be looked at, across every flow.
// Opening one shows the flow's chart with what changed marked on
// it, the changes in words, and one place to keep or send them back.
import { ArrowRight, Check, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Undo2, X } from "lucide-react";
import type { HistoryEntry, Step, StepTypeDef } from "@spellsheet/schema";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useStudio } from "../context";
import { api, type RunRecord } from "../lib/api";
import { actorLabel, type ChangeLine, describe, formatValue, relativeTime } from "../lib/changes";
import { effects as effectsOf } from "../lib/effects";
import { type ChangeCard, changeCards, checksOf, digest, headline, partDiff, purpose, stepBefore, summarize, wordDiff } from "../lib/review";
import { type Part, sentence } from "../lib/sentence";
import { approvedUpTo, groupRevertBlocker, pendingIn } from "../store";
import { FeedbackBox, Observations, type Observed, type Review, SendBackForm, Section, TestRuns, type TestRun } from "./Evidence";
import { Monogram } from "./FlowsPage";
import { ActorMark, Lines, usePendingReview } from "./Timeline";
import { Promises, usePromises } from "./Promises";
import { type Promised, promiseCounts } from "../lib/promises";
import { locale, stepLabel, t } from "../lib/i18n";
import { useReviewView } from "../lib/reviewView";
import { inputRows, unchangedRows } from "../lib/approval";
import { readCheck, usedRows } from "../lib/reviewFiles";
import { filePath } from "../lib/preview";
import { projectApi } from "../project";
import { flatten } from "../lib/review";
import { Masthead, Stripe } from "./Masthead";
import { FlowAtAGlance } from "./ReviewFlow";
import { FileBox, OutputValues, UsedTable } from "./ReviewResult";
import type { HighlightTone } from "./Highlight";
import { SheetHeading } from "./SheetHeading";

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
        <ChevronsRight size={15} strokeWidth={1.75} aria-hidden="true" />
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
              <ChevronsLeft size={15} strokeWidth={1.75} aria-hidden="true" />
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
/** What the person has seen and answered on the report; the AI chat answers the same questions (ChatHandoff). */
export const useMarks = create<Marks>((set) => ({
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
  const runs = useMemo(() => evidence.filter((e): e is TestRun => e.kind === "testRun"), [evidence]);
  // One answer for the result as a whole (the files and values the trial run gave), one per judgement the AI made.
  const hasResult = runs.length > 0 || promises.length > 0;
  const resultKey = `${markKey}:result`;
  const unansweredResult = hasResult && !answers[resultKey] ? 1 : 0;
  const unansweredChecks = checks.filter((q) => !answers[`${markKey}:${q}`]).length;
  const questions = (hasResult ? 1 : 0) + checks.length;
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
    runs,
    hasResult,
    resultKey,
    questions,
    unanswered: unansweredResult + unansweredChecks,
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
 * The AI's change as a report on one sheet of paper, with the same head as
 * the manual. A person who does not read flows judges it by three things, in
 * this order: what the trial run produced (the real files and values), the
 * decisions the AI made on its own, and the files and systems it works with.
 * The flow itself is below, folded. The verdict stays at the bottom of the desk.
 */
export function ReviewReport() {
  const r = useReview();
  const answer = useMarks((m) => m.answer);
  const answers = useMarks((m) => m.answers);
  const see = useMarks((m) => m.see);
  const seenMarks = useMarks((m) => m.seen);
  const setSendBackWith = useMarks((m) => m.setSendBackWith);
  const setSending = useMarks((m) => m.setSending);
  const { flow, oldestFirst, summary, newest, oldest, defs, markKey, runs } = r;
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
  const used = useMemo(() => {
    const newestFirst = [...oldestFirst].reverse();
    const effects = effectsOf(flow?.steps ?? [], summary.steps, summary.removed, defs, (step) => stepBefore(step, newestFirst));
    // Targets read with the starting values no node changes: `{{ outFile }}` as output/売上まとめ.xlsx.
    const values = flow ? unchangedRows(inputRows(flow, {}), flow.steps ?? [], flow.variables) : [];
    return usedRows(effects, values);
  }, [oldestFirst, flow, summary, defs]);
  const latest = runs.at(-1) ?? null;
  const record = useRunRecord(latest?.runId ?? null);
  const folderFiles = useFolderFiles(r.flowId, latest?.finishedAt ?? "");
  if (!newest || !oldest) {
    return (
      <div className="canvas-bg h-full overflow-y-auto px-6 pt-14 pb-24">
        <Reviewed />
      </div>
    );
  }
  const title = purpose(oldestFirst, summary);
  const said = [title, ...explanationOf(oldestFirst, title)].filter(Boolean);
  const observed = r.evidence.filter((e): e is Observed => e.kind === "observation");
  const sendBackWithText = (text: string) => {
    if (!r.flowId) return;
    setSendBackWith({ flowId: r.flowId, text });
    setSending(r.flowId);
  };
  const changedIds = cards.filter((c) => c.kind !== "removed" && !c.movedOnly).map((c) => c.stepId);
  const revision = flow?.revision ?? 0;
  const nodeCount = flatten(flow?.steps ?? []).length;
  const live = used.filter((u) => u.status !== "removed");
  const outputFiles = live.filter((u) => u.kind === "outputFile" && u.preview && !u.atRun);
  // The source data to compare the result with: the files it reads by name, and what is in the folders it reads.
  const inputFiles = [
    ...live.filter((u) => u.kind === "inputFile" && u.preview && !u.atRun).map((u) => u.preview!),
    ...live.filter((u) => u.kind === "inputFolder").flatMap((u) => folderFiles.filter((f) => f.startsWith(`${u.target.replace(/[\\/]+$/, "")}/`))),
  ].filter((path, i, all) => all.indexOf(path) === i).slice(0, SOURCE_FILES);
  const outputs = Object.entries(record?.report?.outputs ?? {});
  const stamp = latest?.finishedAt ?? "";
  const statusWord = (status: string) => (t.runLog.status as Record<string, string>)[status] ?? status;
  const when = new Date(newest.at).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  // A small change nobody tried and the AI has no question about reads best from what changed.
  const changesFirst = !summary.created && !r.hasResult && r.checks.length === 0;
  let n = 0;
  const resultAnswer = answers[r.resultKey];
  const chip = (on: boolean, tone: string) =>
    `inline-flex h-8 items-center gap-1 rounded-lg border px-3.5 text-[13px] whitespace-nowrap ${on ? `${tone} font-semibold` : "border-slate-300 bg-sheet text-ink hover:border-slate-500"}`;
  const changes = (number: number) => (
    <PaperSection n={number} title={t.desk.changes} aside={headline(summary)}>
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
        <article
          className="@container relative mx-auto max-w-[940px] overflow-hidden rounded-lg border border-slate-200 bg-sheet px-6 pt-10 pb-7 shadow-sheet xl:px-11 xl:pb-9"
          data-review-report
        >
          <Stripe className="top-0 h-[5px]" />
          <Masthead
            kind={t.desk.reportOf}
            title={flow?.name ?? ""}
            tag={
              <span className={`ml-2.5 inline-block rounded-md px-2 align-[4px] text-[12px] leading-[22px] font-bold ${summary.created ? "bg-moegi-100 text-moegi-500" : "bg-amber-50 text-amber-700"}`}>
                {summary.created ? t.desk.tagCreated : t.desk.tagChanged}
              </span>
            }
            facts={[
              {
                label: t.desk.factBy,
                value: (
                  <span className="flex items-center gap-1.5">
                    <ActorMark entry={newest} size={16} />
                    {actorLabel(newest)}
                  </span>
                ),
              },
              { label: t.desk.factAt, value: `${when}（${relativeTime(newest.at)}）` },
              {
                label: t.desk.factContent,
                value: summary.created ? t.desk.nodeCount(nodeCount) : `${headline(summary)}（${t.evidence.revision(oldest.revision - 1)} → ${newest.revision}）`,
              },
              { label: t.desk.factRun, value: latest ? statusWord(latest.status) : t.desk.factNotRun },
            ]}
          />
          {said.length > 0 && (
            <blockquote className="border-l-[3px] border-brand-100 pl-3 text-[13.5px] leading-[1.7]">
              <div className="text-[12px] text-slate-500">{t.desk.explanationLead}</div>
              {said.map((line) => (
                <p key={line} className="whitespace-pre-wrap">
                  {line}
                </p>
              ))}
            </blockquote>
          )}
          <p className="mt-3 text-[13.5px] leading-[1.7] text-slate-500">{t.desk.lead}</p>
          {r.feedback && (
            <div className="mt-4">
              <FeedbackBox feedback={r.feedback} fixedAfter={newest.revision > r.feedback.revision} />
            </div>
          )}

          {changesFirst && changes(++n)}

          <PaperSection
            id="review-result"
            n={++n}
            tone="check"
            title={t.desk.result}
            note={t.desk.resultNote}
            aside={latest ? `${t.desk.factRun} ・ ${relativeTime(latest.finishedAt)}` : undefined}
          >
            <div className="space-y-3">
              {!latest && (
                <div className="rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-600">
                  <p>{t.evidence.notTested}</p>
                  <button type="button" onClick={() => sendBackWithText(t.desk.askTryRun)} className="mt-1 text-[12.5px] font-semibold text-brand-600 hover:underline">
                    {t.desk.askTryRunButton}
                  </button>
                </div>
              )}
              {latest && latest.revision !== revision && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700">{t.desk.staleTest}</p>}
              {latest && latest.status !== "succeeded" && (
                <p className="rounded-lg bg-shu-50 px-3 py-2 text-[12.5px] leading-relaxed text-shu-600">
                  <b>{statusWord(latest.status)}</b>
                  {latest.errorMessage && <span className="ml-2 break-all">{latest.errorMessage}</span>}
                </p>
              )}
              {latest && outputFiles.map((f) => <FileBox key={f.target} flowId={r.flowId} path={f.preview!} label={t.desk.outputFile} stamp={stamp} />)}
              {latest && <OutputValues outputs={outputs} />}
              {latest && inputFiles.length > 0 && (
                <Fold title={t.desk.sourceData(inputFiles.length)} note={t.desk.sourceDataNote} plain>
                  <div className="space-y-2">
                    {inputFiles.map((path) => (
                      <FileBox key={path} flowId={r.flowId} path={path} label={t.desk.inputFile} stamp={stamp} quiet />
                    ))}
                  </div>
                </Fold>
              )}
              {r.flowId && (r.promises.length > 0 || latest) && (
                <AutoChecks
                  flowId={r.flowId}
                  revision={revision}
                  promises={r.promises}
                  onAsk={() => sendBackWithText(t.promises.askReason)}
                />
              )}
              {r.hasResult && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-paper px-4 py-3">
                  <p className="min-w-[12em] flex-1 text-[14px] font-bold">{t.desk.resultAsk}</p>
                  <button type="button" onClick={() => answer(r.resultKey, resultAnswer === "ok" ? null : "ok")} className={chip(resultAnswer === "ok", "border-moegi-500 bg-moegi-100 text-moegi-500")}>
                    {resultAnswer === "ok" && <Check size={13} strokeWidth={2.25} aria-hidden="true" />}
                    {t.desk.resultRight}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (resultAnswer !== "no") sendBackWithText(t.desk.resultWrongNote);
                      answer(r.resultKey, resultAnswer === "no" ? null : "no");
                    }}
                    className={chip(resultAnswer === "no", "border-shu-500 bg-shu-50 text-shu-600")}
                  >
                    {t.desk.resultWrong}
                  </button>
                </div>
              )}
            </div>
          </PaperSection>

          {r.checks.length > 0 && (
            <PaperSection
              id="review-checks"
              n={++n}
              tone="check"
              title={t.desk.judgements}
              note={t.desk.judgementsNote}
              aside={t.desk.answeredOf(r.checks.filter((q) => answers[`${markKey}:${q}`]).length, r.checks.length)}
            >
              <Checks checks={r.checks} markKey={markKey} onNo={(q) => sendBackWithText(t.desk.checkNote(readCheck(q).rule))} />
            </PaperSection>
          )}

          <PaperSection id="review-effects" n={++n} title={t.desk.used} note={t.desk.usedNote}>
            <UsedTable rows={used} created={summary.created} />
          </PaperSection>

          {!summary.created && !changesFirst && changes(++n)}

          <div className="mt-9 space-y-2">
            {flow && (
              <Fold title={t.desk.flowContent(nodeCount)}>
                <FlowAtAGlance flow={flow} defs={defs} />
              </Fold>
            )}
            {(runs.length > 0 || observed.length > 0) && (
              <Fold title={t.desk.tryRuns} aside={latest ? relativeTime(latest.finishedAt) : undefined}>
                <div className="space-y-4">
                  <TestResult runs={runs} revision={revision} changedIds={changedIds} />
                  {observed.length > 0 && (
                    <Section title={t.desk.screens}>
                      <Observations items={observed} />
                    </Section>
                  )}
                </div>
              </Fold>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}

/** How many input files the report offers to compare with the result. */
const SOURCE_FILES = 8;

/** The files in the flow's folder the report can show, read again after each trial run. */
function useFolderFiles(flowId: string | undefined, stamp: string): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    setFiles([]);
    if (!flowId) return;
    let live = true;
    projectApi.list(flowId).then(
      (list) => live && setFiles(list.files.map((f) => f.path).filter((path) => filePath(path) !== null)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [flowId, stamp]);
  return files;
}

/** A part of the report kept folded: there to open, not to read first. */
function Fold({ title, note, aside, plain = false, children }: { title: string; note?: string; aside?: string; plain?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={plain ? "" : "rounded-lg border border-slate-200"}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center gap-1.5 text-left hover:text-ink ${plain ? "text-[12.5px] text-slate-600" : "px-3 py-2.5 text-[13px] font-bold text-slate-600"}`}
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-slate-400" aria-hidden="true" /> : <ChevronRight size={13} className="shrink-0 text-slate-400" aria-hidden="true" />}
        {title}
        {note && <span className="font-normal text-slate-500">{note}</span>}
        {aside && <span className="ml-auto text-[12px] font-normal text-slate-500">{aside}</span>}
      </button>
      {open && <div className={plain ? "mt-2" : "border-t border-slate-200 px-3 py-3"}>{children}</div>}
    </section>
  );
}

/**
 * What the machine checked: each expected result the AI wrote, as a chip that
 * says whether the flow gives it. The table behind them (inputs, expected
 * values, running them again) opens on demand.
 */
function AutoChecks({ flowId, revision, promises, onAsk }: { flowId: string; revision: number; promises: Promised[]; onAsk: () => void }) {
  const [open, setOpen] = useState(false);
  const tone = (p: Promised) => (!p.kept ? "bg-slate-100 text-slate-600" : p.kept.passed ? "bg-moegi-100 text-moegi-500" : "bg-shu-50 text-shu-600");
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px]">
        <span className="font-bold text-slate-500">{t.desk.autoChecks}</span>
        {promises.length === 0 && <span className="text-slate-500">{t.desk.autoChecksNone}</span>}
        {promises.map((p) => (
          <span key={p.name} className={`inline-flex items-center gap-1 rounded-md px-2 leading-6 ${tone(p)}`}>
            {p.kept?.passed ? <Check size={12} strokeWidth={2.25} aria-hidden="true" /> : p.kept ? <X size={12} strokeWidth={2.25} aria-hidden="true" /> : null}
            {p.text}
            {!p.kept && <span className="text-[11.5px]">（{t.promises.unchecked}）</span>}
            {p.kept && !p.kept.passed && <span className="text-[11.5px]">（{t.promises.broken}）</span>}
          </span>
        ))}
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-0.5 text-[12px] text-brand-600 hover:underline">
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          {t.desk.autoChecksDetail}
        </button>
      </div>
      {open && (
        <div className="mt-2 rounded-lg border border-slate-200 px-3 py-2.5">
          <Promises flowId={flowId} revision={revision} promises={promises} answering={false} answers={{}} onAnswer={() => undefined} onWrong={() => undefined} onAsk={onAsk} />
        </div>
      )}
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
          questions={r.questions}
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

export function PaperSection({ id, n, title, note, aside, tone, children }: { id?: string; n?: number; title: string; note?: string; aside?: string; tone?: HighlightTone; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-9 scroll-mt-6">
      <h2>
        <SheetHeading n={n} tone={tone} aside={aside}>
          {title}
        </SheetHeading>
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
            <p className="min-w-[16em] flex-1 text-[13.5px] leading-relaxed font-semibold">
              {readCheck(q).rule}
              {readCheck(q).example && <span className="mt-0.5 block text-[12.5px] font-normal whitespace-pre-wrap text-slate-500">{readCheck(q).example}</span>}
            </p>
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
  questions = 0,
  broken = 0,
  sending,
  setSending,
  initialReason,
  compact = false,
  onBack,
}: {
  unanswered?: number;
  /** How many answers the report asks for (the result, each judgement). */
  questions?: number;
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
        {!compact && questions > 0 && (
          <div className="mb-0.5 flex items-center gap-2.5 text-[12.5px] whitespace-nowrap">
            <span className="flex gap-1" aria-hidden="true">
              {Array.from({ length: questions }, (_, i) => (
                <i key={i} className={`h-1.5 w-6 rounded-full ${i < questions - unanswered ? "bg-moegi-500" : "bg-slate-200"}`} />
              ))}
            </span>
            {t.desk.progress(questions - unanswered, questions)}
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
