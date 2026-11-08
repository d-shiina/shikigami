// The flow library: a page of its own (the "フロー" place), not a list
// kept beside the chart. Find, sort and filter by tag; make, import,
// duplicate and delete; pick one to open it in the editor.
import type { FlowSummary } from "@shikigami/schema";
import { BookOpen, CalendarClock, ClipboardPaste, Copy, Download, ExternalLink, FolderOpen, FolderOutput, MessageSquareText, MousePointerClick, Trash2, Upload, Workflow } from "lucide-react";
import { useAgent, useAgentApi } from "../agent";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio, useStudioApi } from "../context";
import { relativeTime } from "../lib/changes";
import { copyText, menuFor } from "../lib/contextMenu";
import { agent, api, type ScheduleView } from "../lib/api";
import { describeWhen } from "../lib/schedule";
import { type Column, DataTable, FilterChips, SearchBox, SelectionBar } from "./DataTable";
import { t } from "../lib/i18n";
import { projectApi } from "../project";
import { SAMPLES, type Sample, tutorialUrl } from "../lib/samples";

const SORT_KEY = "shikigami.studio.flows.sort";

/** A small square with the name's first letter, so flows are told apart at a glance. */
export function Monogram({ name, active }: { name: string; active: boolean }) {
  return (
    <span
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-lg text-[11px] font-bold ${
        active ? "bg-slate-200 text-ink" : "bg-brand-50 text-brand-700"
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
      <mark className="rounded-sm bg-accent-100 text-ink">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** Opens a flow in the editor: what the library makes or picks is shown there. */
function useOpen() {
  const open = useStudio((s) => s.open);
  const setPlace = useStudio((s) => s.setPlace);
  return (id: string) => {
    setPlace("flows");
    void open(id);
  };
}

/** Asks what to do when an imported flow already exists. */
function ImportConflict() {
  const importFile = useStudio((s) => s.importFile);
  const setPlace = useStudio((s) => s.setPlace);
  const pending = useStudio((s) => s.pendingImport);
  const cancelImport = useStudio((s) => s.cancelImport);
  if (!pending) return null;
  const resolve = async (mode: "update" | "copy") => {
    if (await importFile(pending.contents, mode)) setPlace("flows");
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent-100 bg-accent-50 px-3 py-2 text-[13px]">
      <span className="min-w-0 flex-1">
        {t.importConflict}
        {pending.name && <span className="font-semibold">{t.quote(pending.name)}</span>}
      </span>
      <button type="button" onClick={cancelImport} className="h-7 px-2 text-slate-500 hover:text-ink">
        {t.cancel}
      </button>
      <button type="button" onClick={() => resolve("copy")} className="h-7 rounded-lg border border-slate-300 bg-sheet px-2.5 hover:bg-slate-50">
        {t.importCopy}
      </button>
      <button type="button" onClick={() => resolve("update")} className="h-7 rounded-lg bg-primary px-2.5 text-on-primary hover:bg-primary-hover">
        {t.importUpdate}
      </button>
    </div>
  );
}

/** Opens a tutorial's page in the browser; a failure is said in the status line. */
function useReadTutorial() {
  const store = useStudioApi();
  return (id?: Sample["id"]) =>
    void agent.openUrl(tutorialUrl(id)).catch((e: unknown) => store.setState({ error: e instanceof Error ? e.message : String(e) }));
}

/**
 * The first screen of an empty workspace: three equal ways in, so building
 * by hand is as plain a start as asking the AI.
 */
function FirstSteps({ onCreate }: { onCreate: () => void }) {
  const agentStore = useAgentApi();
  const askAi = () => {
    const a = agentStore.getState();
    a.newChat(null);
    a.setOpen(true);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-agent-input]")?.focus());
  };
  const showSamples = () => document.getElementById("samples-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const ways = [
    { icon: MousePointerClick, title: t.firstSteps.byHand, body: t.firstSteps.byHandBody, run: onCreate },
    { icon: MessageSquareText, title: t.firstSteps.withAi, body: t.firstSteps.withAiBody, run: askAi },
    { icon: BookOpen, title: t.firstSteps.sample, body: t.firstSteps.sampleBody, run: showSamples },
  ];
  return (
    <section aria-label={t.firstSteps.title} className="rounded-lg border border-slate-200 bg-sheet p-5">
      <h2 className="text-[15px] font-semibold text-ink">{t.firstSteps.title}</h2>
      <p className="mt-1 text-[13px] text-slate-500">{t.firstSteps.lead}</p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {ways.map(({ icon: Icon, title, body, run }) => (
          <button
            key={title}
            type="button"
            onClick={run}
            className="flex flex-col items-start gap-1.5 rounded-lg border border-slate-200 p-4 text-left hover:border-slate-300 hover:bg-slate-50"
          >
            <Icon size={18} strokeWidth={1.75} className="text-slate-500" aria-hidden="true" />
            <span className="text-[13px] font-semibold text-ink">{title}</span>
            <span className="text-[12px] leading-relaxed text-slate-500">{body}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** The tutorials, under the list: read the steps, or open the finished flow with its files. */
function Samples() {
  const importFile = useStudio((s) => s.importFile);
  const setPlace = useStudio((s) => s.setPlace);
  const read = useReadTutorial();
  const [busy, setBusy] = useState<string | null>(null);
  const open = async (sample: Sample) => {
    if (!sample.bundle || busy) return;
    setBusy(sample.id);
    try {
      // Opened before, it asks here whether to update it or keep a copy.
      if (await importFile(await sample.bundle())) setPlace("flows");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mt-6" aria-labelledby="samples-title">
      <div className="mb-1 flex items-baseline gap-2">
        <h2 id="samples-title" className="text-[13px] font-semibold text-ink">
          {t.samples.title}
        </h2>
        <span className="min-w-0 flex-1 truncate text-[12px] text-slate-500">{t.samples.lead}</span>
        <button type="button" onClick={() => read()} className="flex shrink-0 items-center gap-1 text-[12px] text-brand-600 hover:underline">
          {t.samples.all}
          <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <ul className="border-y border-slate-200">
        {SAMPLES.map((sample) => {
          const item = t.samples.items[sample.id] ?? { name: sample.id, uses: "" };
          return (
            <li key={sample.id} className="flex items-center gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0">
              <BookOpen size={16} strokeWidth={1.75} className="shrink-0 text-brand-600" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-ink">{item.name}</div>
                <div className="truncate text-[12px] text-slate-500">
                  {item.uses}
                  {!sample.bundle && t.paren(t.samples.needsSite)}
                </div>
              </div>
              <button type="button" onClick={() => read(sample.id)} className="flex h-7 shrink-0 items-center gap-1 px-2 text-[12px] text-slate-600 hover:text-ink">
                {t.samples.read}
                <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {sample.bundle && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void open(sample)}
                  className="h-7 shrink-0 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  {t.samples.open}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Status = "published" | "behind" | "draft";
type Filter = "all" | "published" | "draft" | "scheduled";

/**
 * What the table says beside each flow, loaded after the list: whether it is
 * published (and still the same), and the schedules that run it. Unknown
 * while loading; the page shows the rows meanwhile.
 */
function useFlowFacts(summaries: FlowSummary[]) {
  const [status, setStatus] = useState<Map<string, Status> | null>(null);
  const [schedules, setSchedules] = useState<Map<string, ScheduleView[]>>(new Map());
  useEffect(() => {
    let live = true;
    void Promise.all(
      summaries.map((s) =>
        api.publishedState(s.id).then(
          (p): [string, Status] => [s.id, !p ? "draft" : p.matchesCurrent ? "published" : "behind"],
          (): [string, Status] => [s.id, "draft"],
        ),
      ),
    ).then((pairs) => live && setStatus(new Map(pairs)));
    api
      .listSchedules()
      .then((list) => {
        if (!live) return;
        const by = new Map<string, ScheduleView[]>();
        for (const item of list.schedules) by.set(item.flowId, [...(by.get(item.flowId) ?? []), item]);
        setSchedules(by);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [summaries]);
  return { status, schedules };
}

const STATUS_DOT: Record<Status, string> = { published: "bg-moegi-500", behind: "bg-amber-500", draft: "bg-slate-300" };

function StatusCell({ status }: { status: Status | undefined }) {
  if (!status) return <span className="text-[12px] text-slate-500">…</span>;
  const l = t.list;
  return (
    <span className="flex items-center gap-1.5 text-[12px] leading-5 whitespace-nowrap text-slate-600" title={status === "behind" ? t.publishedBehind : undefined}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
      {status === "published" ? l.statusPublished : status === "behind" ? l.statusBehind : l.statusDraft}
    </span>
  );
}

function ScheduleCell({ items }: { items: ScheduleView[] | undefined }) {
  const on = (items ?? []).filter((s) => s.enabled);
  if (!items?.length) return <span className="block text-[12px] leading-5 text-slate-500">—</span>;
  if (on.length === 0) return <span className="block text-[12px] leading-5 text-slate-500">{t.list.schedulePaused}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1 text-[12px] leading-5 text-slate-600" title={on.map((s) => `${s.name}：${describeWhen(s.when)}`).join("\n")}>
      <CalendarClock size={13} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
      <span className="truncate">{describeWhen(on[0]!.when)}</span>
      {on.length > 1 && <span className="shrink-0 text-slate-500 tabular-nums">+{on.length - 1}</span>}
    </span>
  );
}

function RowActions({ summary }: { summary: FlowSummary }) {
  const duplicate = useStudio((s) => s.duplicate);
  const remove = useStudio((s) => s.remove);
  const setPlace = useStudio((s) => s.setPlace);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        title={t.duplicate}
        className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-200 hover:text-ink"
        onClick={(e) => {
          e.stopPropagation();
          setPlace("flows");
          void duplicate(summary.id);
        }}
      >
        <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        title={confirming ? t.list.confirmDelete : t.delete}
        className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] ${confirming ? "bg-shu-600 text-white" : "text-slate-500 hover:bg-shu-50 hover:text-shu-600"}`}
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
    </>
  );
}

/** The bulk actions over the picked flows: write them out, or delete them. */
function BulkActions({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const remove = useStudio((s) => s.remove);
  const store = useStudioApi();
  const [confirming, setConfirming] = useState(false);
  const button = "flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px]";
  return (
    <>
      <button
        type="button"
        className={`${button} text-slate-700 hover:bg-slate-200 hover:text-ink`}
        onClick={async () => {
          try {
            const paths = [];
            for (const id of ids) paths.push(await api.exportFlow(id));
            store.setState({ notice: t.list.exportedMany(paths.length), error: null });
          } catch (e) {
            store.setState({ error: e instanceof Error ? e.message : String(e) });
          }
        }}
      >
        <Download size={13} strokeWidth={1.75} aria-hidden="true" />
        {t.list.exportPicked}
      </button>
      <button
        type="button"
        className={`${button} ${confirming ? "bg-shu-600 text-white" : "text-slate-700 hover:bg-shu-50 hover:text-shu-600"}`}
        onBlur={() => setConfirming(false)}
        onClick={async () => {
          if (!confirming) return setConfirming(true);
          for (const id of ids) await remove(id);
          setConfirming(false);
          onDone();
        }}
      >
        <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
        {confirming ? t.list.confirmDeleteMany(ids.length) : t.delete}
      </button>
    </>
  );
}

export function FlowsPage() {
  // The AI pane has its own "paste"; the header does not say it twice.
  const agentOpen = useAgent((a) => a.open);
  const summaries = useStudio((s) => s.summaries);
  const setPasteOpen = useStudio((s) => s.setPasteOpen);
  const create = useStudio((s) => s.create);
  const importFile = useStudio((s) => s.importFile);
  const setPlace = useStudio((s) => s.setPlace);
  const duplicate = useStudio((s) => s.duplicate);
  const remove = useStudio((s) => s.remove);
  const open = useOpen();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string>("");
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const { status, schedules } = useFlowFacts(summaries);
  const l = t.list;

  const tags = useMemo(() => [...new Set(summaries.flatMap((s) => s.tags ?? []))].sort((a, b) => a.localeCompare(b, "ja")), [summaries]);
  const passes = (s: FlowSummary, f: Filter) => {
    const st = status?.get(s.id);
    if (f === "published") return st === "published" || st === "behind";
    if (f === "draft") return st === "draft";
    if (f === "scheduled") return (schedules.get(s.id) ?? []).some((x) => x.enabled);
    return true;
  };
  const matched = useMemo(
    () =>
      summaries.filter(
        (s) => (!tag || (s.tags ?? []).includes(tag)) && (!q || `${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(q)),
      ),
    [summaries, q, tag],
  );
  const rows = matched.filter((s) => passes(s, filter));
  // Rows that left the list (deleted, or filtered out) are no longer picked.
  const pickedIds = rows.map((s) => s.id).filter((id) => picked.has(id));

  const columns: Column<FlowSummary>[] = [
    {
      id: "name",
      header: t.name,
      sortValue: (s) => s.name,
      cell: (s) => (
        <>
          <div className="flex items-center gap-2">
            <Workflow size={14} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate text-[13px] leading-5 font-semibold">
              <Marked text={s.name} query={q} />
            </span>
          </div>
          {s.description && <div className="mt-0.5 line-clamp-1 pl-[22px] text-[12px] text-slate-500">{s.description}</div>}
        </>
      ),
    },
    {
      id: "status",
      header: l.statusColumn,
      width: "w-[120px]",
      sortValue: (s) => ["published", "behind", "draft"].indexOf(status?.get(s.id) ?? "draft"),
      cell: (s) => <StatusCell status={status?.get(s.id)} />,
    },
    {
      id: "schedule",
      header: l.scheduleColumn,
      width: "w-[156px]",
      hideBelow: 860,
      sortValue: (s) => (schedules.get(s.id) ?? []).filter((x) => x.enabled).length,
      cell: (s) => <ScheduleCell items={schedules.get(s.id)} />,
    },
    {
      id: "tags",
      header: t.versionField.tags,
      width: "w-[128px]",
      hideBelow: 1000,
      cell: (s) => (
        <div className="flex flex-wrap gap-1">
          {(s.tags ?? []).map((name) => (
            <span key={name} className="rounded-sm bg-slate-100 px-1.5 text-[11px] leading-5 text-slate-600">
              {name}
            </span>
          ))}
        </div>
      ),
    },
    {
      id: "steps",
      header: l.steps,
      width: "w-[84px]",
      align: "right",
      hideBelow: 720,
      sortValue: (s) => s.stepCount,
      cell: (s) => <span className="block text-[12px] leading-5 text-slate-500 tabular-nums">{s.stepCount}</span>,
    },
    {
      id: "updated",
      header: l.updatedColumn,
      width: "w-[104px]",
      sortValue: (s) => s.updatedAt ?? "",
      cell: (s) => <span className="block text-[12px] leading-5 whitespace-nowrap text-slate-500">{s.updatedAt ? relativeTime(s.updatedAt) : "—"}</span>,
    },
  ];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPlace("flows");
    await create(name.trim() || t.defaultFlowName);
    setName("");
    setCreating(false);
  };
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // A conflict is answered on this page, so only move to the editor once it is in.
    if (await importFile(await file.text())) setPlace("flows");
  };
  const count = (f: Filter) => matched.filter((s) => passes(s, f)).length;

  return (
    <div className="@container h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[1120px] px-6 py-5">
        {/* Read left to right: what this is, how to narrow it, then making one, the filled button, at the end. */}
        <div className="mb-3 flex items-center gap-2">
          {pickedIds.length > 0 ? (
            <SelectionBar count={pickedIds.length} onClear={() => setPicked(new Set())}>
              <BulkActions ids={pickedIds} onDone={() => setPicked(new Set())} />
            </SelectionBar>
          ) : (
            <>
              {/* The page's name is in the title bar; here only how many there are. */}
              <span className="text-[12px] whitespace-nowrap text-slate-500">{l.count(summaries.length)}</span>
              <SearchBox value={query} onChange={setQuery} placeholder={l.search} hits={rows.length} />
            </>
          )}
          <span className="flex-1" />
          <input ref={picker} type="file" accept=".json,application/json" className="hidden" onChange={onPick} />
          <button
            type="button"
            onClick={() => picker.current?.click()}
            className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-sheet px-3 text-[13px] text-slate-700 hover:bg-slate-50"
          >
            <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
            {t.importFlow}
          </button>
          <button
            type="button"
            onClick={() => setPasteOpen("new")}
            hidden={agentOpen}
            title={t.paste.lead}
            className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-sheet px-3 text-[13px] text-slate-700 hover:bg-slate-50"
          >
            <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />
            {t.paste.title}
          </button>
          {/* While naming a new flow, its form's "作成" is the one filled button. */}
          <button type="button" onClick={() => setCreating(true)} hidden={creating} className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-primary px-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover">
            ＋ {t.newFlow}
          </button>
        </div>
        {summaries.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <FilterChips
              label={l.statusColumn}
              value={filter}
              onChange={setFilter}
              chips={[
                { value: "all", label: l.all, count: count("all") },
                { value: "published", label: l.filterPublished, count: count("published") },
                { value: "draft", label: l.filterDraft, count: count("draft") },
                { value: "scheduled", label: l.filterScheduled, count: count("scheduled") },
              ]}
            />
            {tags.length > 0 && (
              <>
                <span className="h-4 w-px bg-slate-200" aria-hidden="true" />
                <FilterChips
                  label={t.versionField.tags}
                  value={tag}
                  onChange={setTag}
                  chips={[{ value: "", label: l.allTags }, ...tags.map((name) => ({ value: name, label: name }))]}
                />
              </>
            )}
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
              placeholder={t.newFlowPrompt}
              className="h-7 w-80 rounded-lg border border-brand-500 bg-sheet px-2 text-[13px] focus:outline-none"
            />
            <button type="submit" className="h-7 rounded-lg bg-primary px-3 text-[13px] text-on-primary">
              {l.create}
            </button>
          </form>
        )}
        {summaries.length === 0 ? (
          <FirstSteps onCreate={() => setCreating(true)} />
        ) : (
          <div className="border-b border-slate-200">
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(s) => s.id}
              onOpen={(s) => open(s.id)}
              selected={picked}
              onSelect={setPicked}
              initialSort={{ column: "updated", descending: true }}
              storageKey={SORT_KEY}
              empty={l.notFound}
              rowActions={(s) => <RowActions summary={s} />}
              rowProps={(s) => ({
                onContextMenu: menuFor(() => [
                  { label: t.menu.open, icon: FolderOpen, shortcut: "Enter", run: () => open(s.id) },
                  {
                    label: t.duplicate,
                    icon: Copy,
                    run: () => {
                      setPlace("flows");
                      void duplicate(s.id);
                    },
                  },
                  { label: t.menu.openFlowFolder, icon: FolderOutput, run: () => void projectApi.open(s.id, "", false).catch(() => {}) },
                  { label: t.menu.copyId, icon: Copy, run: () => copyText(s.id) },
                  "-",
                  { label: t.delete, icon: Trash2, danger: true, confirm: t.menu.confirmDelete, run: () => void remove(s.id) },
                ]),
              })}
            />
          </div>
        )}
        <Samples />
      </div>
    </div>
  );
}
