// The review desk: AI edits waiting to be looked at, across every flow.
// Opening one shows the flow's chart with what changed marked on
// it, the changes in words, and one place to keep or send them back.
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
import { stepLabel, t, useKeptState } from "../lib/i18n";

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
export function ReviewRail({ onExpand }: { onExpand: () => void }) {
  const inbox = useInbox();
  const open = useStudio((s) => s.open);
  const currentId = useStudio((s) => s.flow?.id);
  return (
    <aside className="flex h-full flex-col items-center gap-2 border-r border-slate-200 bg-paper pt-3">
      <button
        type="button"
        onClick={onExpand}
        title={t.desk.expand}
        className="grid h-7 w-7 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-200 hover:text-ink"
      >
        »
      </button>
      {inbox.map((item) => (
        <button key={item.flowId} type="button" title={item.name} onClick={() => void open(item.flowId)}>
          <Monogram name={item.name} active={item.flowId === currentId} />
        </button>
      ))}
    </aside>
  );
}

export function ReviewInbox({ onCollapse }: { onCollapse?: () => void }) {
  const inbox = useInbox();
  const open = useStudio((s) => s.open);
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
              className="ml-auto grid h-6 w-6 place-items-center rounded-[4px] font-normal text-slate-500 hover:bg-slate-200 hover:text-ink"
            >
              «
            </button>
          )}
        </div>
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
          const active = item.flowId === currentId;
          const firstWaiting = item.waiting && !all[index - 1]?.waiting;
          return (
            <li key={item.flowId}>
              {firstWaiting && <div className="px-2 pt-3 pb-1 text-[11px] font-bold text-slate-400">{t.desk.sentBack}</div>}
              <button
                type="button"
                onClick={() => void open(item.flowId)}
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

/**
 * What the person has done on this review so far: which changes they looked
 * at and how they answered the AI's questions. Kept for the session only,
 * keyed by flow and newest revision so a new edit starts fresh.
 */
type Marks = {
  seen: Record<string, true>;
  answers: Record<string, "ok" | "no">;
  see(key: string): void;
  answer(key: string, value: "ok" | "no" | null): void;
};
const useMarks = create<Marks>((set) => ({
  seen: {},
  answers: {},
  see: (key) => set((m) => (m.seen[key] ? m : { seen: { ...m.seen, [key]: true } })),
  answer: (key, value) =>
    set((m) => {
      const answers = { ...m.answers };
      if (value) answers[key] = value;
      else delete answers[key];
      return { answers };
    }),
}));

/** What the unreviewed edits of the open flow do, in the order a person decides: what changes, what it touches, whether it was tried, what to confirm. */
export function ReviewPanel() {
  const pending = usePendingReview();
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const open = useStudio((s) => s.open);
  const inbox = useInbox();
  const timeline = useStudio((s) => (s.flow ? s.timelines[s.flow.id] : undefined));
  const loadTimeline = useStudio((s) => s.loadTimeline);
  const see = useMarks((m) => m.see);
  const seenMarks = useMarks((m) => m.seen);
  const answers = useMarks((m) => m.answers);
  const [sendBackWith, setSendBackWith] = useState<string | undefined>(undefined);
  const [sending, setSending] = useKeptState("review.sending", false);
  const flowId = flow?.id;
  // An MCP test run only appends evidence; it does not touch the flow
  // file the watcher sees. Re-read while this panel is open and on refocus.
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
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const oldestFirst = useMemo(() => [...pending].reverse(), [pending]);
  const summary = useMemo(() => summarize(oldestFirst, flow?.steps), [oldestFirst, flow]);
  const newest = pending[0];
  const oldest = oldestFirst[0];
  const since = (oldest?.revision ?? 1) - 1;
  const evidence = useMemo(() => (timeline?.evidence ?? []).filter((e) => e.revision > since), [timeline, since]);
  const runs = evidence.filter((e): e is TestRun => e.kind === "testRun");
  const observed = evidence.filter((e): e is Observed => e.kind === "observation");
  const feedback = timeline?.openFeedback?.kind === "review" ? timeline.openFeedback : null;
  const cards = useMemo(
    () => changeCards(oldestFirst, summary, flow?.steps ?? [], feedback?.revision ?? null),
    [oldestFirst, summary, flow, feedback],
  );
  const others = useMemo(
    () => oldestFirst.flatMap((e) => describe(e, flow, defs)).filter((l) => l.verb === "variable" || l.verb === "flow" || l.verb === "replace" || (l.verb === "remove" && !l.stepId && l.subject.startsWith(t.variables))),
    [oldestFirst, flow, defs],
  );
  const effects = useMemo(() => {
    const newestFirst = [...oldestFirst].reverse();
    return effectsOf(flow?.steps ?? [], summary.steps, summary.removed, defs, (step) => stepBefore(step, newestFirst));
  }, [oldestFirst, flow, summary, defs]);
  const checks = useMemo(() => checksOf(oldestFirst), [oldestFirst]);
  const markKey = `${flowId}@${newest?.revision ?? 0}`;
  const selected = selection?.kind === "step" ? selection.stepId : null;
  useEffect(() => {
    if (selected && cards.some((c) => c.stepId === selected)) see(`${markKey}:${selected}`);
  }, [selected, cards, markKey, see]);
  if (!newest || !oldest) {
    const next = inbox.find((i) => i.flowId !== flow?.id && !i.waiting);
    return (
      <div className="p-5 text-[13px]">
        <div className="flex items-center gap-2 font-bold text-moegi-500">✓ {t.desk.reviewed}</div>
        {next ? (
          <button
            type="button"
            onClick={() => void open(next.flowId)}
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
  const title = purpose(oldestFirst, summary);
  const seen = cards.filter((c) => seenMarks[`${markKey}:${c.stepId}`]).length;
  const unanswered = checks.filter((q) => !answers[`${markKey}:${q}`]).length;
  const changedIds = cards.filter((c) => c.kind !== "removed" && !c.movedOnly).map((c) => c.stepId);
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <div className="flex items-start gap-2.5">
          <ActorMark entry={newest} size={28} />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] leading-snug font-bold">{title}</div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {actorLabel(newest)} ・ {summary.created ? t.evidence.revision(newest.revision) : `${t.evidence.revision(oldest.revision - 1)} → ${newest.revision}`} ・ {relativeTime(newest.at)} ・ {headline(summary)}
            </div>
          </div>
        </div>
        {feedback && <FeedbackBox feedback={feedback} fixedAfter={newest.revision > feedback.revision} />}

        <Numbered n={1} title={t.desk.whatChanges} aside={cards.length > 0 ? t.desk.seen(seen, cards.length) : undefined}>
          <div className="space-y-2">
            {cards.map((card) => (
              <ChangeCardView
                key={card.stepId}
                card={card}
                said={card.said.map((text) => dropLine(text, title)).filter(Boolean)}
                defs={defs}
                lines={oldestFirst.flatMap((e) => describe(e, flow, defs)).filter((l) => l.stepId === card.stepId && l.diffs.length > 0)}
                seen={Boolean(seenMarks[`${markKey}:${card.stepId}`])}
                current={card.stepId === selected}
                onSee={() => see(`${markKey}:${card.stepId}`)}
              />
            ))}
          </div>
          {others.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[11px] font-bold text-slate-500">{t.desk.otherChanges}</div>
              <Lines lines={others} detailed />
            </div>
          )}
          {cards.length > 1 && <ChangeStepper />}
        </Numbered>

        <Numbered n={2} title={t.desk.effects}>
          <EffectList effects={effects} />
        </Numbered>

        <Numbered n={3} title={t.desk.testResult} aside={runs.at(-1) ? relativeTime(runs.at(-1)!.finishedAt) : undefined}>
          <TestResult runs={runs} revision={flow?.revision ?? 0} changedIds={changedIds} />
          {observed.length > 0 && (
            <div className="mt-3">
              <Section title={t.desk.screens}>
                <Observations items={observed} />
              </Section>
            </div>
          )}
        </Numbered>

        {checks.length > 0 && (
          <Numbered n={4} title={t.desk.checks} aside={t.desk.checksFrom(checks.length)}>
            <Checks
              checks={checks}
              markKey={markKey}
              onNo={(q) => {
                setSendBackWith(t.desk.checkNote(q));
                setSending(true);
              }}
            />
          </Numbered>
        )}
      </div>
      <ReviewActions
        unanswered={unanswered}
        sending={sending}
        setSending={(on) => {
          setSending(on);
          if (!on) setSendBackWith(undefined);
        }}
        initialReason={sendBackWith}
      />
    </div>
  );
}

function Numbered({ n, title, aside, children }: { n: number; title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold">
        <span className="grid h-[18px] w-[18px] place-items-center rounded-[3px] bg-ink text-[11px] text-paper">{n}</span>
        {title}
        {aside && <span className="ml-auto text-[11px] font-normal text-slate-500">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const KIND_TAG: Record<ChangeCard["kind"], { label: () => string; style: string }> = {
  added: { label: () => t.verbs.add, style: "bg-moegi-100 text-moegi-500" },
  changed: { label: () => t.verbs.update, style: "bg-amber-50 text-amber-700" },
  removed: { label: () => t.verbs.remove, style: "bg-shu-50 text-shu-600" },
};

/** One changed node: what it did before and what it does now, in the flow chart's words, and why. */
/** `text` without its first line when that line is `title` (already the review's heading). */
function dropLine(text: string, title: string): string {
  const [first, ...rest] = text.split("\n");
  return first?.trim() === title ? rest.join("\n").trim() : text;
}

function ChangeCardView({
  card,
  said,
  defs,
  lines,
  seen,
  current,
  onSee,
}: {
  card: ChangeCard;
  said: string[];
  defs: ReadonlyMap<string, StepTypeDef>;
  lines: ChangeLine[];
  seen: boolean;
  current: boolean;
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
    if (card.after) goTo(card.stepId);
  };
  return (
    <div
      className={`rounded-[4px] border border-slate-200 bg-sheet px-2.5 py-2 ${current ? "border-l-[3px] border-l-brand-500 shadow-sheet" : seen ? "border-l-[3px] border-l-moegi-500" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`shrink-0 rounded-[3px] px-1.5 text-[10px] leading-4 font-bold ${tag.style}`}>{tag.label()}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{name ?? stepLabel(step.type, defs.get(step.type)?.label)}</span>
        {card.afterFeedback && <span className="shrink-0 rounded-[3px] bg-shu-50 px-1.5 text-[10px] leading-4 font-bold text-shu-600">{t.desk.afterFeedback}</span>}
        {card.after && (
          <button type="button" onClick={show} className="shrink-0 text-[11px] text-brand-600 hover:underline">
            {t.desk.showInFlow} ›
          </button>
        )}
      </div>
      <div className="mt-1.5 grid grid-cols-[2.2em_1fr] gap-x-1.5 gap-y-1 text-[12.5px] leading-relaxed" onClick={onSee}>
        {before && (
          <>
            <span className="pt-0.5 text-[10.5px] text-slate-500">{t.desk.before}</span>
            <span className={card.kind === "removed" ? "text-shu-600 line-through" : "text-slate-500"}>
              <Marked parts={before} marks={diff?.dropped} other={after} tone="drop" />
            </span>
          </>
        )}
        {after && (
          <>
            <span className="pt-0.5 text-[10.5px] text-slate-500">{t.desk.after}</span>
            <span>
              <Marked parts={after} marks={diff?.added} other={before} tone="add" />
            </span>
          </>
        )}
      </div>
      {card.movedOnly ? (
        <p className="mt-1 text-[12px] text-slate-500">{t.desk.moved}</p>
      ) : (
        same && lines.length > 0 && <p className="mt-1 text-[12px] text-slate-500">{t.desk.sameSentence}</p>
      )}
      {said.map((text) => (
        <p key={text} className="mt-1.5 border-t border-dashed border-slate-200 pt-1.5 text-[12px] leading-relaxed whitespace-pre-wrap text-slate-600">
          <span className="font-semibold text-ink">AI：</span>
          {text}
        </p>
      ))}
      {lines.length > 0 && (
        <div className="mt-1">
          <button type="button" onClick={() => setOpen(!open)} className="text-[11px] text-slate-500 hover:text-ink">
            {open ? "▾" : "▸"} {t.desk.details}
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
  const hit = tone === "add" ? "rounded-[2px] bg-moegi-100 font-semibold text-moegi-500" : "rounded-[2px] bg-shu-50 text-shu-600 line-through";
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
          <button type="button" onClick={() => setShowSame(!showSame)} className="text-[11px] text-slate-500 hover:text-ink">
            {showSame ? "▾" : "▸"} {t.desk.sameEffects(same.length)}
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
      className="flex w-full items-start gap-1.5 rounded-[3px] px-1 py-0.5 text-left text-[12.5px] leading-relaxed hover:bg-slate-100"
    >
      {effect.status === "same" ? (
        <span className="w-[3.2em] shrink-0 text-center text-slate-400">・</span>
      ) : (
        <span className={`mt-0.5 w-[3.2em] shrink-0 rounded-[3px] text-center text-[10px] leading-4 font-bold ${EFFECT_TAG[effect.status]}`}>
          {t.desk.effect[effect.status]}
        </span>
      )}
      <span className={`min-w-0 ${effect.status === "same" ? "text-slate-500" : ""} ${effect.status === "removed" ? "line-through" : ""}`}>
        <span className={danger ? "font-semibold text-shu-600" : effect.reads ? "" : "font-semibold"}>{effect.action}</span>
        {effect.target && <span className="ml-1 font-mono text-[12px] break-all">{effect.target}</span>}
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
      {!current && <p className="rounded-[4px] bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">{t.desk.staleTest}</p>}
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
      {result && result.missed.length > 0 && <p className="rounded-[4px] bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">{t.desk.notCovered(result.missed.length)}</p>}
      {runs.length > 1 && (
        <div>
          <button type="button" onClick={() => setOlder(!older)} className="text-[11px] text-slate-500 hover:text-ink">
            {older ? "▾" : "▸"} {t.desk.olderRuns(runs.length - 1)}
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
    <ul className="space-y-1.5">
      {checks.map((q) => {
        const key = `${markKey}:${q}`;
        const value = answers[key];
        const pick = (v: "ok" | "no") => answer(key, value === v ? null : v);
        const chip = (on: boolean, tone: string) =>
          `rounded-[3px] border px-2 text-[11px] leading-5 ${on ? `${tone} font-semibold` : "border-slate-200 text-slate-600 hover:border-slate-400"}`;
        return (
          <li key={q} className="flex items-start gap-2 rounded-[4px] border border-slate-200 px-2.5 py-2">
            <span
              className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[2px] border text-[9px] text-white ${
                value === "ok" ? "border-moegi-500 bg-moegi-500" : value === "no" ? "border-shu-500 bg-shu-500" : "border-slate-400"
              }`}
            >
              {value === "ok" ? "✓" : value === "no" ? "×" : ""}
            </span>
            <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed">
              <p className="whitespace-pre-wrap">{q}</p>
              <div className="mt-1 flex gap-1.5">
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
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Walk the chart from one changed step to the next (N / Shift+N). */
function ChangeStepper() {
  const changeBy = useStudio((s) => s.changeBy);
  const button = "grid h-6 w-6 place-items-center rounded-[4px] border border-slate-200 text-slate-600 hover:border-brand-500 hover:text-brand-700";
  return (
    <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-slate-500">
      <button type="button" className={button} onClick={() => changeBy(-1)} title={t.desk.prevChangeTitle} aria-label={t.desk.prevChange}>
        ‹
      </button>
      <button type="button" className={button} onClick={() => changeBy(1)} title={t.desk.nextChangeTitle} aria-label={t.outline.nextChange}>
        ›
      </button>
      <kbd className="rounded bg-slate-100 px-1 text-[10px]">N</kbd>
    </div>
  );
}

/** Mark as reviewed, send back to the AI with a reason, or undo everything the AI changed here — each with what it does. */
export function ReviewActions({
  unanswered = 0,
  sending,
  setSending,
  initialReason,
}: {
  unanswered?: number;
  sending: boolean;
  setSending: (on: boolean) => void;
  initialReason?: string;
}) {
  const pending = usePendingReview();
  const history = useStudio((s) => s.history);
  const approveAndPublish = useStudio((s) => s.approveAndPublish);
  const published = useStudio((s) => s.published);
  const revertAll = useStudio((s) => s.revertAll);
  const [hint, setHint] = useState<"keep" | "sendBack" | "revert">("keep");
  if (pending.length === 0) return null;
  const blocker = groupRevertBlocker(pending, history);
  const created = pending.some((e) => e.kind === "create");
  if (sending) {
    return (
      <div className="border-t border-slate-200 bg-sheet px-4 py-3">
        <SendBackForm onCancel={() => setSending(false)} onSent={() => setSending(false)} initialReason={initialReason} />
      </div>
    );
  }
  const means = { keep: t.desk.keepMeans, sendBack: t.desk.sendBackMeans, revert: t.desk.revertMeans }[hint];
  const hover = (key: typeof hint) => ({ onMouseEnter: () => setHint(key), onFocus: () => setHint(key), onMouseLeave: () => setHint("keep"), onBlur: () => setHint("keep") });
  return (
    <div className="space-y-2 border-t border-slate-200 bg-sheet px-4 py-3">
      <div className="flex items-start gap-2">
        <p className="min-h-[2lh] flex-1 text-[11.5px] leading-relaxed text-slate-500">{means}</p>
        {/* A new flow has nothing to go back to; it is deleted from the library instead. */}
        {!created && (
          <button
            type="button"
            onClick={() => void revertAll()}
            disabled={blocker !== null}
            title={blocker ?? `${t.desk.allEdits(pending.length)}\n${t.desk.revertTitle}`}
            {...hover("revert")}
            className="shrink-0 text-[11.5px] text-slate-500 underline-offset-2 enabled:hover:text-shu-600 enabled:hover:underline disabled:text-slate-300"
          >
            ↶ {t.desk.revertAll}
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setSending(true)}
          title={t.desk.sendBackTitle}
          {...hover("sendBack")}
          className="h-9 shrink-0 rounded-[4px] border border-shu-500/60 px-3 text-[13px] font-semibold whitespace-nowrap text-shu-600 hover:bg-shu-50"
        >
          {t.desk.sendBack}
        </button>
        <button
          type="button"
          onClick={() => void approveAndPublish()}
          title={t.desk.keepTitle}
          {...hover("keep")}
          className="h-9 min-w-0 flex-1 truncate rounded-[4px] bg-ink px-3 text-[13px] font-semibold whitespace-nowrap text-paper hover:bg-brand-700"
        >
          ✓ {t.desk.keep}
          {unanswered > 0 && <span className="font-normal opacity-75">{t.desk.unanswered(unanswered)}</span>}
        </button>
      </div>
      <div className="text-[11px] text-slate-500">
        {published ? t.desk.publishedNow(published.version, published.name) : t.desk.notPublishedYet}
      </div>
    </div>
  );
}
