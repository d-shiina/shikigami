// The flow library: a page of its own (the "フロー" place), not a list
// kept beside the chart. Find, sort and filter by tag; make, import,
// duplicate and delete; pick one to open it in the editor.
import type { FlowSummary } from "@shikigami/schema";
import { BookOpen, CalendarClock, ChevronDown, ClipboardPaste, Copy, Download, ExternalLink, FolderOpen, FolderOutput, MessageSquareText, MoreHorizontal, MousePointerClick, SearchX, Send, Trash2, Upload, Workflow } from "lucide-react";
import { openAsk, useAgent, useAgentApi } from "../agent";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio, useStudioApi } from "../context";
import { relativeTime } from "../lib/changes";
import { copyText, menuFor, openMenu } from "../lib/contextMenu";
import { agent, api, type ScheduleView } from "../lib/api";
import { describeWhen } from "../lib/schedule";
import { BulkButton, ClearFilters, type Column, DataTable, FacetFilter, SearchBox, SelectionBar, useTableView, ViewMenu } from "./DataTable";
import { deleteFlowsAsk } from "../lib/ask";
import { t } from "../lib/i18n";
import { projectApi } from "../project";
import { fileToFlowFile } from "./HandOff";
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
 * The first screen of an empty workspace. Flows are made by asking the AI
 * (docs/design/ai-authoring.md, 人の手の役割), so the request box comes first;
 * the samples and an empty flow to build by hand are smaller ways in below.
 */
function FirstSteps({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  const agentStore = useAgentApi();
  const [text, setText] = useState("");
  const ask = () => {
    const request = text.trim();
    openAsk(agentStore, { fresh: null, draft: request });
    const a = agentStore.getState();
    // Not set up yet: the pane shows how, and the request waits in its box.
    if (request && a.info?.available) {
      a.setDraft(a.current, "");
      void a.sendIn(a.current, request, null).then((sent) => !sent && a.setDraft(a.current, request));
    }
    setText("");
  };
  const showSamples = () => document.getElementById("samples-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <section aria-label={t.firstSteps.title} className="rounded-lg border border-slate-200 bg-sheet p-5">
      <h2 className="text-[15px] font-semibold text-ink">{t.firstSteps.title}</h2>
      <p className="mt-1 text-[13px] text-slate-500">{t.firstSteps.lead}</p>
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              ask();
            }
          }}
          rows={3}
          aria-label={t.firstSteps.title}
          placeholder={t.firstSteps.placeholder}
          className="block w-full resize-none rounded-lg border border-slate-300 bg-sheet px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-slate-500 focus:border-brand-500 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="submit"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover"
          >
            <MessageSquareText size={14} strokeWidth={1.75} aria-hidden="true" />
            {t.firstSteps.withAi}
          </button>
          <span className="text-[12px] text-slate-500">{t.firstSteps.withAiBody}</span>
        </div>
      </form>
      <p className="mt-4 flex flex-wrap items-center gap-x-1 border-t border-slate-100 pt-3 text-[12px] text-slate-500">
        {t.firstSteps.otherWays}
        <button type="button" onClick={showSamples} className="flex items-center gap-1 text-brand-600 hover:underline">
          <BookOpen size={12} strokeWidth={1.75} aria-hidden="true" />
          {t.firstSteps.sample}
        </button>
        <span aria-hidden="true">・</span>
        <button type="button" onClick={onCreate} className="flex items-center gap-1 text-brand-600 hover:underline">
          <MousePointerClick size={12} strokeWidth={1.75} aria-hidden="true" />
          {t.firstSteps.byHand}
        </button>
        <span aria-hidden="true">・</span>
        <button type="button" onClick={onImport} className="flex items-center gap-1 text-brand-600 hover:underline">
          <Upload size={12} strokeWidth={1.75} aria-hidden="true" />
          {t.importFlow}
        </button>
      </p>
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
type Auto = "on" | "paused" | "none";

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
  const auto = (id: string): Auto => {
    const items = schedules.get(id) ?? [];
    return items.some((s) => s.enabled) ? "on" : items.length ? "paused" : "none";
  };
  return { status, schedules, auto };
}

const STATUS_ORDER: Status[] = ["published", "behind", "draft"];
const STATUS_DOT: Record<Status, string> = { published: "bg-moegi-500", behind: "bg-amber-500", draft: "bg-slate-400" };
const STATUS_PILL: Record<Status, string> = {
  published: "bg-moegi-100 text-moegi-600",
  behind: "bg-amber-50 text-amber-700",
  draft: "bg-slate-100 text-slate-600",
};
const AUTO_ORDER: Auto[] = ["on", "paused", "none"];
const AUTO_DOT: Record<Auto, string> = { on: "bg-brand-500", paused: "bg-slate-400", none: "bg-slate-200" };

const statusLabel = (s: Status) => (s === "published" ? t.list.statusPublished : s === "behind" ? t.list.statusBehind : t.list.statusDraft);
const autoLabel = (a: Auto) => (a === "on" ? t.list.autoOn : a === "paused" ? t.list.schedulePaused : t.list.autoNone);

function StatusPill({ status }: { status: Status | undefined }) {
  if (!status) return <span className="block h-5 w-14 animate-pulse rounded-full bg-slate-100" aria-hidden="true" />;
  return (
    <span
      className={`inline-flex h-5 max-w-full items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap ${STATUS_PILL[status]}`}
      title={status === "behind" ? t.publishedBehind : undefined}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
      <span className="truncate">{statusLabel(status)}</span>
    </span>
  );
}

function ScheduleCell({ items }: { items: ScheduleView[] | undefined }) {
  const on = (items ?? []).filter((s) => s.enabled);
  if (!items?.length) return <span className="block text-[12px] leading-5 text-slate-500">—</span>;
  if (on.length === 0) return <span className="block text-[12px] leading-5 text-slate-500">{t.list.schedulePaused}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5 text-slate-700" title={on.map((s) => `${s.name}：${describeWhen(s.when)}`).join("\n")}>
      <CalendarClock size={13} strokeWidth={1.75} className="shrink-0 text-brand-500" aria-hidden="true" />
      <span className="truncate">{describeWhen(on[0]!.when)}</span>
      {on.length > 1 && <span className="shrink-0 rounded bg-slate-100 px-1 text-[11px] text-slate-600 tabular-nums">+{on.length - 1}</span>}
    </span>
  );
}

function TagList({ tags }: { tags: string[] }) {
  return (
    <span className="flex min-w-0 gap-1 overflow-hidden">
      {tags.map((name) => (
        <span key={name} className="shrink-0 rounded-md border border-slate-200 px-1.5 text-[11.5px] leading-[18px] text-slate-600">
          {name}
        </span>
      ))}
    </span>
  );
}

export function FlowsPage() {
  // The AI pane has its own "paste"; the header does not say it twice.
  const agentOpen = useAgent((a) => a.open);
  const summaries = useStudio((s) => s.summaries);
  const setPasteOpen = useStudio((s) => s.setPasteOpen);
  const create = useStudio((s) => s.create);
  const receiveFile = useStudio((s) => s.receiveFile);
  const openHandOff = useStudio((s) => s.openHandOff);
  const setPlace = useStudio((s) => s.setPlace);
  const duplicate = useStudio((s) => s.duplicate);
  const remove = useStudio((s) => s.remove);
  const store = useStudioApi();
  const agentStore = useAgentApi();
  const open = useOpen();
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<Set<Status>>(new Set());
  const [autos, setAutos] = useState<Set<Auto>>(new Set());
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const { status, schedules, auto } = useFlowFacts(summaries);
  const l = t.list;

  const menu = (s: FlowSummary) =>
    [
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
      { label: t.handOff.open, icon: Send, run: () => void openHandOff(s.id) },
      { label: t.menu.copyId, icon: Copy, run: () => copyText(s.id) },
      "-",
      {
        label: `${t.delete}…`,
        icon: Trash2,
        danger: true,
        run: () => void deleteFlowsAsk([s.name]).then((yes) => {
          if (yes) void remove(s.id);
        }),
      },
    ] as const;

  const exportMany = async (ids: string[]) => {
    try {
      let last = "";
      for (const id of ids) last = await api.exportFlow(id);
      store.setState({ notice: ids.length === 1 ? `${t.exported}: ${last}` : l.exportedMany(ids.length), error: null });
    } catch (e) {
      store.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  // Each filter's counts are over the rows the other filters keep, as in Linear.
  const keep = (s: FlowSummary, skip?: "status" | "auto" | "tags") =>
    (skip === "status" || !statuses.size || statuses.has(status?.get(s.id) ?? "draft")) &&
    (skip === "auto" || !autos.size || autos.has(auto(s.id))) &&
    (skip === "tags" || !tags.size || (s.tags ?? []).some((x) => tags.has(x))) &&
    (!q || `${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(q));
  const rows = summaries.filter((s) => keep(s));
  const countBy = <V,>(skip: "status" | "auto" | "tags", of: (s: FlowSummary) => V[]) => {
    const n = new Map<V, number>();
    for (const s of summaries) if (keep(s, skip)) for (const v of of(s)) n.set(v, (n.get(v) ?? 0) + 1);
    return n;
  };
  const statusCount = countBy("status", (s) => [status?.get(s.id) ?? "draft"]);
  const autoCount = countBy("auto", (s) => [auto(s.id)]);
  const tagCount = countBy("tags", (s) => s.tags ?? []);
  const allTags = useMemo(() => [...new Set(summaries.flatMap((s) => s.tags ?? []))].sort((a, b) => a.localeCompare(b, "ja")), [summaries]);
  const filtered = statuses.size + autos.size + tags.size > 0;
  // Only the rows on screen are acted on: a filter can hide picked ones.
  const pickedIds = rows.map((s) => s.id).filter((id) => picked.has(id));

  const columns: Column<FlowSummary>[] = [
    {
      id: "name",
      header: t.name,
      sortValue: (s) => s.name,
      cell: (s) => (
        <span className="flex min-w-0 items-center gap-2">
          <Workflow size={14} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
          <span className="truncate font-medium text-ink" title={s.name}>
            <Marked text={s.name} query={q} />
          </span>
        </span>
      ),
    },
    {
      id: "description",
      header: t.versionField.description,
      width: "w-[240px]",
      hideBelow: 1000,
      cell: (s) => (
        <span className="block truncate text-[12.5px] text-slate-600" title={s.description || undefined}>
          {s.description ? <Marked text={s.description} query={q} /> : <span className="text-slate-500">—</span>}
        </span>
      ),
    },
    {
      id: "status",
      header: l.statusColumn,
      width: "w-[136px]",
      sortValue: (s) => STATUS_ORDER.indexOf(status?.get(s.id) ?? "draft"),
      group: (s) => {
        const st = status?.get(s.id) ?? "draft";
        return { key: st, order: STATUS_ORDER.indexOf(st), label: <StatusPill status={st} /> };
      },
      cell: (s) => <StatusPill status={status?.get(s.id)} />,
    },
    {
      id: "schedule",
      header: l.scheduleColumn,
      width: "w-[150px]",
      hideBelow: 720,
      sortValue: (s) => AUTO_ORDER.indexOf(auto(s.id)) * 100 - (schedules.get(s.id) ?? []).filter((x) => x.enabled).length,
      group: (s) => {
        const a = auto(s.id);
        return {
          key: a,
          order: AUTO_ORDER.indexOf(a),
          label: (
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${AUTO_DOT[a]}`} aria-hidden="true" />
              {autoLabel(a)}
            </span>
          ),
        };
      },
      cell: (s) => <ScheduleCell items={schedules.get(s.id)} />,
    },
    {
      id: "tags",
      header: t.versionField.tags,
      width: "w-[130px]",
      hideBelow: 1000,
      sortValue: (s) => (s.tags ?? []).join(","),
      cell: (s) => <TagList tags={s.tags ?? []} />,
    },
    {
      id: "steps",
      header: l.steps,
      width: "w-[80px]",
      align: "right",
      hideBelow: 1000,
      hiddenByDefault: true,
      sortValue: (s) => s.stepCount,
      cell: (s) => <span className="text-[12.5px] text-slate-600 tabular-nums">{s.stepCount}</span>,
    },
    {
      id: "updated",
      header: l.updatedColumn,
      width: "w-[100px]",
      sortValue: (s) => s.updatedAt ?? "",
      cell: (s) => (
        <span className="text-[12.5px] whitespace-nowrap text-slate-600" title={s.updatedAt ? new Date(s.updatedAt).toLocaleString("ja-JP") : undefined}>
          {s.updatedAt ? relativeTime(s.updatedAt) : "—"}
        </span>
      ),
    },
  ];
  const view = useTableView(columns, { storageKey: SORT_KEY, initialSort: { column: "updated", descending: true } });

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
    // What it holds and what this PC needs is shown before anything is imported.
    await receiveFile(await fileToFlowFile(file));
  };

  return (
    <div className="@container h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[1280px] px-6 pt-5 pb-3">
        {/* Making one, the filled button, is at the end; finding and narrowing are on the left. */}
        <div className="mb-3 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <SearchBox value={query} onChange={setQuery} placeholder={l.searchFlows} hits={rows.length} />
          {summaries.length > 0 && (
            <>
              <FacetFilter
                label={l.statusColumn}
                value={statuses}
                onChange={setStatuses}
                options={STATUS_ORDER.map((v) => ({ value: v, label: statusLabel(v), dot: STATUS_DOT[v], count: statusCount.get(v) ?? 0 }))}
              />
              <FacetFilter
                label={l.scheduleColumn}
                value={autos}
                onChange={setAutos}
                options={AUTO_ORDER.map((v) => ({ value: v, label: autoLabel(v), dot: AUTO_DOT[v], count: autoCount.get(v) ?? 0 }))}
              />
              {allTags.length > 0 && (
                <FacetFilter label={t.versionField.tags} value={tags} onChange={setTags} options={allTags.map((v) => ({ value: v, label: v, count: tagCount.get(v) ?? 0 }))} />
              )}
              {filtered && (
                <ClearFilters
                  onClear={() => {
                    setStatuses(new Set());
                    setAutos(new Set());
                    setTags(new Set());
                  }}
                />
              )}
            </>
          )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
          {summaries.length > 0 && <ViewMenu view={view} />}
          <input ref={picker} type="file" accept=".spx,.json,application/json" className="hidden" onChange={onPick} />
          {/* The one filled button makes a flow; its arrow holds the other ways in (Linear, GitHub). */}
          {/* With no flows yet, the request box below is the way in (one filled button a screen). */}
          <div className="flex shrink-0" hidden={creating || summaries.length === 0}>
            {/* Flows are made by asking the AI; an empty flow is under the arrow. */}
            <button
              type="button"
              title={l.newWithAi}
              onClick={() => openAsk(agentStore, { fresh: null })}
              className="flex h-7 items-center gap-1 rounded-l-lg bg-primary pr-2.5 pl-3 text-[13px] font-medium whitespace-nowrap text-on-primary hover:bg-primary-hover"
            >
              ＋ {t.newFlow}
            </button>
            <button
              type="button"
              aria-label={l.moreWaysIn}
              title={l.moreWaysIn}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openMenu({ clientX: r.right - 220, clientY: r.bottom + 4, preventDefault: () => {} }, [
                  { label: l.emptyFlow, icon: MousePointerClick, run: () => setCreating(true) },
                  { label: t.importFlow, icon: Upload, run: () => picker.current?.click() },
                  ...(agentOpen ? [] : [{ label: t.paste.title, icon: ClipboardPaste, run: () => setPasteOpen("new") }]),
                ]);
              }}
              className="grid h-7 w-7 place-items-center rounded-r-lg border-l border-white/25 bg-primary text-on-primary hover:bg-primary-hover"
            >
              <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          </div>
        </div>
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
          <FirstSteps onCreate={() => setCreating(true)} onImport={() => picker.current?.click()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              view={view}
              rows={rows}
              total={summaries.length}
              rowKey={(s) => s.id}
              onOpen={(s) => open(s.id)}
              selected={picked}
              onSelect={setPicked}
              empty={
                <span className="flex flex-col items-center gap-2">
                  <SearchX size={20} strokeWidth={1.5} className="text-slate-400" aria-hidden="true" />
                  {l.notFound}
                  {(filtered || q) && (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setStatuses(new Set());
                        setAutos(new Set());
                        setTags(new Set());
                      }}
                      className="rounded-md border border-slate-300 px-2 py-0.5 text-[12px] text-slate-700 hover:bg-slate-50"
                    >
                      {t.table.clearFilters}
                    </button>
                  )}
                </span>
              }
              actionsWidth={44}
              rowActions={(s) => (
                <button
                  type="button"
                  title={t.table.more}
                  aria-label={t.table.more}
                  className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-200 hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu({ clientX: r.right - 180, clientY: r.bottom + 4, preventDefault: () => {} }, menu(s));
                  }}
                >
                  <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              )}
              rowProps={(s) => ({ onContextMenu: menuFor(() => menu(s)) })}
            />
            <SelectionBar count={pickedIds.length} onClear={() => setPicked(new Set())}>
              <BulkButton icon={Download} label={t.list.exportPicked} onClick={() => exportMany(pickedIds)} />
              <BulkButton
                icon={Trash2}
                danger
                label={`${t.delete}…`}
                onClick={async () => {
                  const names = pickedIds.map((id) => summaries.find((s) => s.id === id)?.name ?? id);
                  if (!(await deleteFlowsAsk(names))) return;
                  for (const id of pickedIds) await remove(id);
                  setPicked(new Set());
                }}
              />
            </SelectionBar>
          </>
        )}
        <Samples />
      </div>
    </div>
  );
}
