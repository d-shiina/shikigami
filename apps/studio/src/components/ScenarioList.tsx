import type { ScenarioSummary } from "@shikigami/schema";
import { useMemo, useState } from "react";
import { useStudio } from "../context";
import { relativeTime } from "../lib/changes";
import { t } from "../lib/i18n";

/** Two-letter monogram, so scenarios are told apart at a glance. */
function Monogram({ name, active }: { name: string; active: boolean }) {
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${
        active ? "swirl text-white shadow-sm" : "bg-brand-50 text-brand-700"
      }`}
    >
      {[...name.trim()][0] ?? "?"}
    </span>
  );
}

function ScenarioItem({ summary, active }: { summary: ScenarioSummary; active: boolean }) {
  const open = useStudio((s) => s.open);
  const duplicate = useStudio((s) => s.duplicate);
  const remove = useStudio((s) => s.remove);
  const [confirming, setConfirming] = useState(false);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => open(summary.id)}
        onKeyDown={(e) => e.key === "Enter" && open(summary.id)}
        className={`group relative flex cursor-pointer gap-2.5 rounded-xl px-2.5 py-2 ${
          active ? "bg-sheet shadow-[0_1px_3px_rgba(15,27,42,.12)] ring-1 ring-brand-100" : "hover:bg-sheet/70"
        }`}
      >
        <Monogram name={summary.name} active={active} />
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[13px] ${active ? "font-bold" : "font-medium"}`}>{summary.name}</div>
          {summary.description && <div className="truncate text-[11px] text-slate-500">{summary.description}</div>}
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
            <span className="rounded bg-slate-100 px-1 font-medium text-slate-500">{summary.stepCount} 手順</span>
            {summary.updatedAt ? <span>{relativeTime(summary.updatedAt)}に更新</span> : <span>版 {summary.revision}</span>}
          </div>
        </div>
        <div className="absolute right-2 bottom-1.5 hidden gap-0.5 group-hover:flex group-focus-within:flex">
          <button
            type="button"
            title={t.duplicate}
            className="rounded-md bg-sheet px-1.5 py-0.5 text-[10px] text-slate-500 shadow-sm hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              void duplicate(summary.id);
            }}
          >
            {t.duplicate}
          </button>
          <button
            type="button"
            title={t.confirmDelete}
            className={`rounded-md px-1.5 py-0.5 text-[10px] shadow-sm ${
              confirming ? "bg-shu-600 text-white" : "bg-sheet text-slate-500 hover:text-shu-600"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (confirming) void remove(summary.id);
              setConfirming(!confirming);
            }}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? "削除する" : t.delete}
          </button>
        </div>
      </div>
    </li>
  );
}

export function ScenarioList() {
  const summaries = useStudio((s) => s.summaries);
  const currentId = useStudio((s) => s.scenario?.id);
  const create = useStudio((s) => s.create);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q ? summaries.filter((s) => `${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(q)) : summaries;
    return [...hits].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [summaries, query]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await create(name.trim() || t.defaultScenarioName);
    setName("");
    setCreating(false);
  };

  return (
    <aside className="flex h-full flex-col border-r border-slate-200 bg-paper">
      <div className="flex items-center px-4 pt-4 pb-2">
        <span className="text-[11px] font-bold tracking-[.18em] text-slate-500">{t.scenarios}</span>
        <span className="ml-1.5 rounded-full bg-slate-200 px-1.5 text-[10px] font-semibold text-slate-600">{summaries.length}</span>
        <button
          type="button"
          onClick={() => setCreating(!creating)}
          className="swirl ml-auto flex h-6 w-6 items-center justify-center rounded-full text-sm leading-none font-bold text-white shadow-sm hover:brightness-110"
          title={t.newScenario}
        >
          ＋
        </button>
      </div>
      {creating && (
        <form onSubmit={submit} className="mx-3 mb-2 space-y-1.5 rounded-xl border border-brand-100 bg-sheet p-2 shadow-sm">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            placeholder={t.newScenarioPrompt}
            className="w-full rounded-md border border-slate-200 bg-paper px-2 py-1 text-[13px] focus:border-brand-500 focus:bg-sheet focus:outline-none"
          />
          <div className="flex justify-end gap-1 text-[11px]">
            <button type="button" onClick={() => setCreating(false)} className="rounded-full px-2 py-0.5 text-slate-500 hover:bg-slate-100">
              やめる
            </button>
            <button type="submit" className="rounded-full bg-ink px-2.5 py-0.5 text-paper hover:bg-slate-700">
              {t.newScenario}
            </button>
          </div>
        </form>
      )}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-sheet px-2 focus-within:border-brand-500">
          <span className="text-xs text-slate-400">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="さがす"
            className="min-w-0 flex-1 bg-transparent py-1 text-[12px] focus:outline-none"
          />
        </div>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-3">
        {summaries.length === 0 && (
          <li className="mx-2 rounded-xl border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
            {t.noScenarios}
            <br />
            ＋ から作るか、AIに頼んでください
          </li>
        )}
        {summaries.length > 0 && shown.length === 0 && <li className="px-3 py-2 text-xs text-slate-400">見つかりません</li>}
        {shown.map((s) => (
          <ScenarioItem key={s.id} summary={s} active={s.id === currentId} />
        ))}
      </ul>
      <div className="m-3 rounded-xl border border-slate-200 bg-sheet p-3 text-[11px] leading-relaxed text-slate-500">
        <div className="mb-1 flex items-center gap-1.5 font-bold text-ink">
          <span className="swirl h-2.5 w-2.5 rounded-full" />
          AIに頼む
        </div>
        Claude Code などに「〜するシナリオを作って」と頼むと、ここに増えていきます。AIの変更は右の「記録」で確かめられます。
      </div>
    </aside>
  );
}
