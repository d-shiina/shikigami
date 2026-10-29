// The scenario library: a page of its own (the "シナリオ" place), not a list
// kept beside the chart. Find, sort and filter by tag; make, import,
// duplicate and delete; pick one to open it in the editor.
import type { ScenarioSummary } from "@shikigami/schema";
import { Copy, Search, Trash2, Upload, Workflow } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { relativeTime } from "../lib/changes";
import { t } from "../lib/i18n";

const SORT_KEY = "shikigami.studio.sort";

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
export function Monogram({ name, active }: { name: string; active: boolean }) {
  return (
    <span
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-[4px] text-[11px] font-bold ${
        active ? "bg-ink text-paper" : "bg-brand-50 text-brand-700"
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
      <mark className="rounded-[2px] bg-accent-100 text-ink">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** Opens a scenario in the editor: what the library makes or picks is shown there. */
function useOpen() {
  const open = useStudio((s) => s.open);
  const setPlace = useStudio((s) => s.setPlace);
  return (id: string) => {
    setPlace("scenarios");
    void open(id);
  };
}

/** Asks what to do when an imported scenario already exists. */
function ImportConflict() {
  const importFile = useStudio((s) => s.importFile);
  const setPlace = useStudio((s) => s.setPlace);
  const pending = useStudio((s) => s.pendingImport);
  const cancelImport = useStudio((s) => s.cancelImport);
  if (!pending) return null;
  const resolve = async (mode: "update" | "copy") => {
    if (await importFile(pending.contents, mode)) setPlace("scenarios");
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[4px] border border-accent-100 bg-accent-50 px-3 py-2 text-[13px]">
      <span className="min-w-0 flex-1">
        {t.importConflict}
        {pending.name && <span className="font-semibold">{t.quote(pending.name)}</span>}
      </span>
      <button type="button" onClick={cancelImport} className="h-7 px-2 text-slate-500 hover:text-ink">
        {t.cancel}
      </button>
      <button type="button" onClick={() => resolve("copy")} className="h-7 rounded-[4px] border border-slate-300 bg-sheet px-2.5 hover:bg-slate-50">
        {t.importCopy}
      </button>
      <button type="button" onClick={() => resolve("update")} className="h-7 rounded-[4px] bg-ink px-2.5 text-paper hover:bg-brand-700">
        {t.importUpdate}
      </button>
    </div>
  );
}

function Row({ summary, query }: { summary: ScenarioSummary; query: string }) {
  const open = useOpen();
  const duplicate = useStudio((s) => s.duplicate);
  const remove = useStudio((s) => s.remove);
  const setPlace = useStudio((s) => s.setPlace);
  const [confirming, setConfirming] = useState(false);
  return (
    <tr
      tabIndex={0}
      onClick={() => open(summary.id)}
      onKeyDown={(e) => e.key === "Enter" && open(summary.id)}
      className="group cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
    >
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Workflow size={14} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate text-[13px] font-semibold">
            <Marked text={summary.name} query={query} />
          </span>
        </div>
        {summary.description && <div className="mt-0.5 line-clamp-1 pl-[22px] text-[12px] text-slate-500">{summary.description}</div>}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap gap-1">
          {(summary.tags ?? []).map((tag) => (
            <span key={tag} className="rounded-[2px] bg-slate-100 px-1.5 text-[11px] leading-5 text-slate-600">
              {tag}
            </span>
          ))}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right text-[12px] text-slate-500 tabular-nums">{summary.stepCount}</td>
      <td className="px-3 py-2.5 text-[12px] whitespace-nowrap text-slate-500">{summary.updatedAt ? relativeTime(summary.updatedAt) : "—"}</td>
      <td className="w-[1%] px-2 py-2.5 whitespace-nowrap">
        <span className="invisible flex justify-end gap-0.5 group-focus-within:visible group-hover:visible">
          <button
            type="button"
            title={t.duplicate}
            className="grid h-7 w-7 place-items-center rounded-[3px] text-slate-500 hover:bg-slate-200 hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              setPlace("scenarios");
              void duplicate(summary.id);
            }}
          >
            <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            title={confirming ? t.list.confirmDelete : t.delete}
            className={`flex h-7 items-center gap-1 rounded-[3px] px-1.5 text-[12px] ${confirming ? "bg-shu-600 text-white" : "text-slate-500 hover:bg-shu-50 hover:text-shu-600"}`}
            onClick={(e) => {
              e.stopPropagation();
              if (confirming) void remove(summary.id);
              setConfirming(!confirming);
            }}
            onBlur={() => setConfirming(false)}
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
            {confirming && t.list.confirmDelete}
          </button>
        </span>
      </td>
    </tr>
  );
}

export function ScenariosPage() {
  const summaries = useStudio((s) => s.summaries);
  const create = useStudio((s) => s.create);
  const importFile = useStudio((s) => s.importFile);
  const setPlace = useStudio((s) => s.setPlace);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [sort, setSortState] = useState<Sort>(() => load<Sort>(SORT_KEY, "updated"));
  const picker = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  const setSort = (next: Sort) => {
    setSortState(next);
    save(SORT_KEY, next);
  };
  const tags = useMemo(() => [...new Set(summaries.flatMap((s) => s.tags ?? []))].sort((a, b) => a.localeCompare(b, "ja")), [summaries]);
  const rows = useMemo(() => {
    const hits = summaries.filter(
      (s) =>
        (!tag || (s.tags ?? []).includes(tag)) &&
        (!q || `${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(q)),
    );
    return hits.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name, "ja") : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
  }, [summaries, q, tag, sort]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPlace("scenarios");
    await create(name.trim() || t.defaultScenarioName);
    setName("");
    setCreating(false);
  };
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // A conflict is answered on this page, so only move to the editor once it is in.
    if (await importFile(await file.text())) setPlace("scenarios");
  };

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[1040px] px-6 py-5">
        {/* Read left to right: what this is, how to narrow it, then making one, the filled button, at the end. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* The page's name is in the title bar; here only how many there are. */}
          <span className="text-[12px] text-slate-500">{t.list.count(summaries.length)}</span>
          <div className="ml-2 flex h-8 w-64 items-center gap-1.5 rounded-[4px] border border-slate-200 bg-sheet px-2 focus-within:border-brand-500">
            <Search size={14} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder={t.list.search}
              className="min-w-0 flex-1 bg-transparent text-[13px] focus:outline-none"
            />
            {q && <span className="shrink-0 text-[11px] text-slate-400">{t.list.count(rows.length)}</span>}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            title={t.list.sort}
            className="h-8 rounded-[4px] border border-slate-200 bg-sheet px-1.5 text-[12px] text-slate-600 focus:outline-none"
          >
            <option value="updated">{t.list.byUpdated}</option>
            <option value="name">{t.list.byName}</option>
          </select>
          <span className="flex-1" />
          <input ref={picker} type="file" accept=".json,application/json" className="hidden" onChange={onPick} />
          <button
            type="button"
            onClick={() => picker.current?.click()}
            className="flex h-8 items-center gap-1.5 rounded-[4px] border border-slate-300 bg-sheet px-3 text-[13px] text-slate-700 hover:bg-slate-50"
          >
            <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
            {t.importScenario}
          </button>
          <button type="button" onClick={() => setCreating(true)} className="flex h-8 items-center gap-1 rounded-[4px] bg-ink px-3 text-[13px] font-semibold text-paper hover:bg-brand-700">
            ＋ {t.newScenario}
          </button>
        </div>
        {tags.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1" role="radiogroup" aria-label={t.versionField.tags}>
            {[null, ...tags].map((value) => (
              <button
                key={value ?? "@all"}
                type="button"
                role="radio"
                aria-checked={tag === value}
                onClick={() => setTag(value)}
                className={`h-7 rounded-[4px] px-2.5 text-[12px] ${tag === value ? "bg-ink text-paper" : "bg-sheet text-slate-600 ring-1 ring-slate-200 hover:text-ink"}`}
              >
                {value ?? t.list.all}
              </button>
            ))}
          </div>
        )}
        <ImportConflict />
        {creating && (
          <form onSubmit={submit} className="mb-3 flex gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
              onBlur={() => !name && setCreating(false)}
              placeholder={t.newScenarioPrompt}
              className="h-8 w-80 rounded-[4px] border border-brand-500 bg-sheet px-2 text-[13px] focus:outline-none"
            />
            <button type="submit" className="h-8 rounded-[4px] bg-ink px-3 text-[13px] text-paper">
              {t.list.create}
            </button>
          </form>
        )}
        {summaries.length === 0 ? (
          <p className="rounded-[4px] border border-dashed border-slate-300 px-4 py-10 text-center text-[13px] text-slate-400">
            {t.noScenarios}
            <br />
            {t.list.askAiHint}
          </p>
        ) : (
          <div className="overflow-hidden rounded-[4px] border border-slate-200 bg-sheet shadow-sheet">
            <table className="w-full table-fixed border-collapse text-left">
              <colgroup>
                <col />
                <col className="w-[180px]" />
                <col className="w-[72px]" />
                <col className="w-[110px]" />
                <col className="w-[88px]" />
              </colgroup>
              <thead className="bg-slate-50 text-[11px] text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-3 py-2 font-semibold">{t.name}</th>
                  <th className="border-b border-slate-200 px-3 py-2 font-semibold">{t.versionField.tags}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-right font-semibold">{t.list.steps}</th>
                  <th className="border-b border-slate-200 px-3 py-2 font-semibold">{t.list.updatedColumn}</th>
                  <th className="border-b border-slate-200" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-[13px] text-slate-400">
                      {t.list.notFound}
                    </td>
                  </tr>
                ) : (
                  rows.map((s) => <Row key={s.id} summary={s} query={q} />)
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
