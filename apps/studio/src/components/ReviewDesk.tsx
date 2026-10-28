// The review desk: AI edits waiting to be looked at, across every scenario.
// Opening one shows the scenario's flow chart with what changed marked on
// it, the changes in words, and one place to keep or send them back.
import type { HistoryEntry } from "@shikigami/schema";
import { useMemo } from "react";
import { useStudio } from "../context";
import { actorLabel, describe, relativeTime } from "../lib/changes";
import { headline, summarize } from "../lib/review";
import { sentence, plain } from "../lib/sentence";
import { groupRevertBlocker, pendingIn } from "../store";
import { ActorMark, Lines, usePendingReview } from "./Timeline";

export type InboxItem = { scenarioId: string; name: string; entries: HistoryEntry[] };

/** Scenarios with unreviewed AI edits, newest edit first. */
export function useInbox(): InboxItem[] {
  const summaries = useStudio((s) => s.summaries);
  const histories = useStudio((s) => s.histories);
  const reviewed = useStudio((s) => s.reviewed);
  return useMemo(
    () =>
      summaries
        .map((s) => ({ scenarioId: s.id, name: s.name, entries: pendingIn(histories[s.id] ?? [], reviewed[s.id]) }))
        .filter((i) => i.entries.length > 0)
        .sort((a, b) => (b.entries[0]?.at ?? "").localeCompare(a.entries[0]?.at ?? "")),
    [summaries, histories, reviewed],
  );
}

export function ReviewInbox() {
  const inbox = useInbox();
  const open = useStudio((s) => s.open);
  const currentId = useStudio((s) => s.scenario?.id);
  return (
    <aside className="flex h-full flex-col border-r border-slate-200 bg-paper">
      <div className="px-3 pt-3 pb-1">
        <div className="text-[12px] font-bold">AIからの変更</div>
        <div className="text-[11px] leading-relaxed text-slate-400">見て「残す」と、そのまま本番の実行に使われます</div>
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {inbox.length === 0 && (
          <li className="mx-1 rounded-[6px] border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
            確認待ちはありません
          </li>
        )}
        {inbox.map((item) => {
          const newest = item.entries[0];
          const active = item.scenarioId === currentId;
          return (
            <li key={item.scenarioId}>
              <button
                type="button"
                onClick={() => void open(item.scenarioId)}
                className={`relative w-full rounded-[6px] px-2.5 py-2 text-left ${active ? "bg-sheet shadow-sm ring-1 ring-brand-100" : "hover:bg-sheet/70"}`}
              >
                {active && <span className="swirl absolute top-2 bottom-2 left-0 w-[3px] rounded-full" />}
                <div className="flex items-center gap-1.5">
                  {newest && <ActorMark entry={newest} size={18} />}
                  <span className="truncate text-[13px] font-bold">{item.name}</span>
                </div>
                <div className="mt-0.5 pl-[24px] text-[11px] text-slate-500">{headline(summarize([...item.entries].reverse()))}</div>
                <div className="pl-[24px] text-[10px] text-slate-400">
                  {newest && `${actorLabel(newest)} ・ ${relativeTime(newest.at)}`} ・ {item.entries.length}回の編集
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/** What the unreviewed edits of the open scenario did, and one place to keep or send them back. */
export function ReviewPanel() {
  const pending = usePendingReview();
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const open = useStudio((s) => s.open);
  const inbox = useInbox();
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const oldestFirst = useMemo(() => [...pending].reverse(), [pending]);
  const summary = useMemo(() => summarize(oldestFirst), [oldestFirst]);
  const lines = useMemo(() => oldestFirst.flatMap((e) => describe(e, scenario, defs)), [oldestFirst, scenario, defs]);
  const newest = pending[0];
  const oldest = oldestFirst[0];
  if (!newest || !oldest) {
    const next = inbox.find((i) => i.scenarioId !== scenario?.id);
    return (
      <div className="p-5 text-[13px]">
        <div className="flex items-center gap-2 font-bold text-moegi-500">✓ このシナリオは確認済みです</div>
        {next ? (
          <button
            type="button"
            onClick={() => void open(next.scenarioId)}
            className="mt-4 flex w-full items-center gap-2 rounded-[6px] border border-slate-200 px-3 py-2 text-left hover:border-brand-500"
          >
            <span className="text-[11px] text-slate-400">次</span>
            <span className="flex-1 truncate font-semibold">{next.name}</span>
            <span className="text-slate-400">→</span>
          </button>
        ) : (
          <p className="mt-2 text-slate-500">確認待ちはもうありません。</p>
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
              {actorLabel(newest)} ・ 版 {oldest.revision - 1} → {newest.revision} ・ {relativeTime(newest.at)}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <Legend color="#2f8a4c" label="AIが追加" />
          <Legend color="#f5872a" label="AIが変更" />
          {summary.removed.length > 0 && <Legend color="#e8501f" label="AIが削除（下に一覧）" />}
        </div>
        <section>
          <div className="mb-1.5 text-[11px] font-bold text-slate-500">変わったところ</div>
          <Lines lines={lines} detailed />
        </section>
        {summary.removed.length > 0 && (
          <section>
            <div className="mb-1.5 text-[11px] font-bold text-shu-600">消した手順</div>
            <ul className="space-y-1">
              {summary.removed.map((s) => (
                <li key={s.id} className="rounded-[4px] border border-shu-100 bg-shu-50 px-2 py-1 text-[12px] text-shu-600 line-through">
                  {plain(sentence(s, defs.get(s.type)))}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <ReviewActions />
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/** Keep or send back everything the AI changed here, in one place. */
export function ReviewActions() {
  const pending = usePendingReview();
  const history = useStudio((s) => s.history);
  const approveAll = useStudio((s) => s.approveAll);
  const revertAll = useStudio((s) => s.revertAll);
  if (pending.length === 0) return null;
  const blocker = groupRevertBlocker(pending, history);
  return (
    <div className="space-y-2 border-t border-slate-200 bg-sheet px-4 py-3">
      <div className="text-[11px] text-slate-400">AIの {pending.length} 回の編集をまとめて</div>
      <div className="flex gap-2">
      <button
        type="button"
        onClick={() => void revertAll()}
        disabled={blocker !== null}
        title={blocker ?? "AIが変える前に戻します（新しい変更として記録されます）"}
        className="h-9 flex-1 rounded-[6px] border border-shu-500/60 px-3 text-[13px] font-semibold text-shu-600 enabled:hover:bg-shu-50 disabled:border-slate-200 disabled:text-slate-400"
      >
        ↶ 差し戻す
      </button>
      <button
        type="button"
        onClick={approveAll}
        className="h-9 flex-[2] rounded-[6px] bg-ink px-4 text-[13px] font-semibold text-white hover:bg-brand-700"
      >
        ✓ 残して本番に使う
      </button>
      </div>
    </div>
  );
}
