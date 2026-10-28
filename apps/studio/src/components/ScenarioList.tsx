import type { ScenarioSummary } from "@shikigami/schema";
import { useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { relativeTime } from "../lib/changes";
import { t } from "../lib/i18n";

/** Picks a bundle or scenario file and asks what to do when it already exists. */
function ImportBox({ input }: { input: React.RefObject<HTMLInputElement | null> }) {
  const importFile = useStudio((s) => s.importFile);
  const pending = useStudio((s) => s.pendingImport);
  const cancelImport = useStudio((s) => s.cancelImport);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await importFile(await file.text());
  };

  return (
    <div className={pending ? "px-3 pb-2" : "hidden"}>
      <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={onPick} />
      {pending && (
        <div className="space-y-1.5 rounded border border-shu-100 bg-paper p-2 text-xs">
          <p>
            {t.importConflict}
            {pending.name && <span className="font-semibold">「{pending.name}」</span>}
          </p>
          <button
            type="button"
            onClick={() => void importFile(pending.contents, "update")}
            className="w-full rounded bg-ink px-2 py-1 text-paper hover:bg-slate-700"
          >
            {t.importUpdate}
          </button>
          <button
            type="button"
            onClick={() => void importFile(pending.contents, "copy")}
            className="w-full rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
          >
            {t.importCopy}
          </button>
          <button type="button" onClick={cancelImport} className="w-full text-slate-500 hover:underline">
            {t.cancel}
          </button>
        </div>
      )}
    </div>
  );
}

const OPEN_KEY = "shikigami.studio.closedGroups";
const SORT_KEY = "shikigami.studio.sort";
const NO_TAG = "タグなし";
const RECENT = 5;

type Sort = "updated" | "name";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Only a remembered preference.
  }
}

/** A small square with the name's first letter, so scenarios are told apart at a glance. */
function Monogram({ name, active }: { name: string; active: boolean }) {
  return (
    <span
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-[4px] text-[11px] font-bold ${
        active ? "swirl text-white" : "bg-brand-50 text-brand-700"
      }`}
    >
      {[...name.trim()][0] ?? "?"}
    </span>
  );
}

/** The search words in a name, marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[2px] bg-accent-500/25 text-inherit">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function ScenarioItem({ summary, active, query }: { summary: ScenarioSummary; active: boolean; query: string }) {
  const open = useStudio((s) => s.open);
  const duplicate = useStudio((s) => s.duplicate);
  const remove = useStudio((s) => s.remove);
  const [confirming, setConfirming] = useState(false);
  const detail = [summary.description, `${summary.stepCount} 手順`, summary.updatedAt && `${relativeTime(summary.updatedAt)}に更新`]
    .filter(Boolean)
    .join("\n");
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        title={detail}
        onClick={() => open(summary.id)}
        onKeyDown={(e) => e.key === "Enter" && open(summary.id)}
        className={`group relative flex h-8 cursor-pointer items-center gap-2 rounded-[4px] pr-1.5 pl-2 ${
          active ? "bg-brand-50 text-ink" : "text-slate-700 hover:bg-slate-100"
        }`}
      >
        {active && <span className="swirl absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full" />}
        <Monogram name={summary.name} active={active} />
        <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? "font-bold" : ""}`}>
          <Marked text={summary.name} query={query} />
        </span>
        <span className="shrink-0 text-[10px] text-slate-400 tabular-nums group-hover:hidden group-focus-within:hidden">
          {summary.updatedAt ? relativeTime(summary.updatedAt) : `版${summary.revision}`}
        </span>
        <span className="hidden shrink-0 gap-0.5 group-hover:flex group-focus-within:flex">
          <button
            type="button"
            title={t.duplicate}
            className="rounded-[4px] px-1 text-[10px] text-slate-500 hover:bg-sheet hover:text-ink"
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
            className={`rounded-[4px] px-1 text-[10px] ${confirming ? "bg-shu-600 text-white" : "text-slate-500 hover:bg-sheet hover:text-shu-600"}`}
            onClick={(e) => {
              e.stopPropagation();
              if (confirming) void remove(summary.id);
              setConfirming(!confirming);
            }}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? "削除する" : t.delete}
          </button>
        </span>
      </div>
    </li>
  );
}

/** A tag's scenarios under a header that folds them away. */
function Group({
  label,
  count,
  closed,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  closed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 rounded-[4px] px-1.5 pt-2 pb-1 text-left text-[11px] font-semibold text-slate-500 hover:text-ink"
      >
        <span className={`inline-block w-3 text-[9px] transition-transform ${closed ? "" : "rotate-90"}`}>▶</span>
        <span className="truncate">{label}</span>
        <span className="ml-auto font-normal text-slate-400">{count}</span>
      </button>
      {!closed && <ul className="space-y-px">{children}</ul>}
    </li>
  );
}

export function ScenarioList({ onCollapse }: { onCollapse: () => void }) {
  const summaries = useStudio((s) => s.summaries);
  const currentId = useStudio((s) => s.scenario?.id);
  const create = useStudio((s) => s.create);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState("");
  const [sort, setSortState] = useState<Sort>(() => load<Sort>(SORT_KEY, "updated"));
  const [closed, setClosed] = useState<string[]>(() => load<string[]>(OPEN_KEY, []));
  const picker = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  const setSort = (next: Sort) => {
    setSortState(next);
    save(SORT_KEY, next);
  };
  const toggle = (group: string) => {
    const next = closed.includes(group) ? closed.filter((g) => g !== group) : [...closed, group];
    setClosed(next);
    save(OPEN_KEY, next);
  };

  const sorted = useMemo(() => {
    const hits = q
      ? summaries.filter((s) => `${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(q))
      : summaries;
    return [...hits].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name, "ja") : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
  }, [summaries, q, sort]);

  // By first tag; untagged scenarios last. A search shows one flat list.
  const groups = useMemo(() => {
    const map = new Map<string, ScenarioSummary[]>();
    for (const s of sorted) {
      const tag = s.tags?.[0] ?? NO_TAG;
      map.set(tag, [...(map.get(tag) ?? []), s]);
    }
    return [...map].sort(([a], [b]) => (a === NO_TAG ? 1 : b === NO_TAG ? -1 : a.localeCompare(b, "ja")));
  }, [sorted]);
  const recent = useMemo(
    () => [...summaries].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, RECENT),
    [summaries],
  );
  const grouped = !q && (groups.length > 1 || summaries.length > 12);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await create(name.trim() || t.defaultScenarioName);
    setName("");
    setCreating(false);
  };

  return (
    <aside className="flex h-full flex-col border-r border-slate-200 bg-paper">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <span className="text-[12px] font-bold text-ink">{t.scenarios}</span>
        <span className="text-[11px] text-slate-400">{summaries.length}</span>
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setMenu(!menu)}
            className="flex h-6 items-center gap-1 rounded-[4px] bg-ink px-2 text-[11px] font-semibold text-paper hover:bg-brand-700"
          >
            ＋ 追加
          </button>
          {menu && (
            <div className="absolute top-full right-0 z-20 mt-1 w-44 overflow-hidden rounded-[4px] border border-slate-200 bg-sheet py-1 text-[12px] shadow-lifted">
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-slate-100"
                onClick={() => {
                  setMenu(false);
                  setCreating(true);
                }}
              >
                {t.newScenario}
              </button>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-slate-100"
                onClick={() => {
                  setMenu(false);
                  picker.current?.click();
                }}
              >
                {t.importScenario}
              </button>
              <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] leading-relaxed text-slate-400">
                Claude Code などのAIに「〜するシナリオを作って」と頼んでも増えます
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onCollapse}
          title="一覧をたたむ"
          className="grid h-6 w-6 place-items-center rounded-[4px] text-slate-400 hover:bg-slate-200 hover:text-ink"
        >
          «
        </button>
      </div>
      {creating && (
        <form onSubmit={submit} className="mx-3 mb-2 flex gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            onBlur={() => !name && setCreating(false)}
            placeholder={t.newScenarioPrompt}
            className="min-w-0 flex-1 rounded-[4px] border border-brand-500 bg-sheet px-2 py-1 text-[12px] focus:outline-none"
          />
          <button type="submit" className="rounded-[4px] bg-ink px-2 text-[11px] text-paper">
            作る
          </button>
        </form>
      )}
      <ImportBox input={picker} />
      <div className="flex items-center gap-1 px-3 pb-2">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[4px] border border-slate-200 bg-sheet px-2 focus-within:border-brand-500">
          <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-slate-400" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="検索"
            className="min-w-0 flex-1 bg-transparent text-[12px] focus:outline-none"
          />
          {q && <span className="shrink-0 text-[10px] text-slate-400">{sorted.length}件</span>}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          title="並び順"
          className="h-7 rounded-[4px] border border-slate-200 bg-sheet px-1 text-[11px] text-slate-600 focus:outline-none"
        >
          <option value="updated">更新順</option>
          <option value="name">名前順</option>
        </select>
      </div>
      <ul className="flex-1 overflow-y-auto px-2 pb-3">
        {summaries.length === 0 && (
          <li className="mx-1 rounded-[4px] border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
            {t.noScenarios}
            <br />
            ＋追加 から作るか、AIに頼んでください
          </li>
        )}
        {summaries.length > 0 && sorted.length === 0 && <li className="px-2 py-2 text-xs text-slate-400">見つかりません</li>}
        {grouped ? (
          <>
            <Group label="最近さわったもの" count={recent.length} closed={closed.includes("@recent")} onToggle={() => toggle("@recent")}>
              {recent.map((s) => (
                <ScenarioItem key={s.id} summary={s} active={s.id === currentId} query="" />
              ))}
            </Group>
            {groups.map(([tag, list]) => (
              <Group key={tag} label={tag} count={list.length} closed={closed.includes(tag)} onToggle={() => toggle(tag)}>
                {list.map((s) => (
                  <ScenarioItem key={s.id} summary={s} active={s.id === currentId} query="" />
                ))}
              </Group>
            ))}
          </>
        ) : (
          <li>
            <ul className="space-y-px">
              {sorted.map((s) => (
                <ScenarioItem key={s.id} summary={s} active={s.id === currentId} query={q} />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </aside>
  );
}

/** The folded list: a strip that opens it again. */
export function ScenarioRail({ onExpand }: { onExpand: () => void }) {
  const current = useStudio((s) => s.scenario?.name);
  return (
    <aside className="flex h-full flex-col items-center gap-2 border-r border-slate-200 bg-paper pt-3">
      <button
        type="button"
        onClick={onExpand}
        title="シナリオ一覧を開く"
        className="grid h-7 w-7 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-200 hover:text-ink"
      >
        »
      </button>
      {current && <Monogram name={current} active />}
    </aside>
  );
}
