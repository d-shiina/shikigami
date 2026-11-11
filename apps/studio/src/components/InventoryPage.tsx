// 業務の棚卸し: what the AI heard about the person's work, on one sheet of
// paper. The AI fills it in while it interviews them (MCP save_work_inventory),
// so the sheet re-reads the file while it is open and grows beside the chat.
// The person reads the order, corrects a number where the AI misheard (the
// order is worked out again by Flow Core), writes it out for Excel, and has
// the AI build the first flow from a row.
import { AppWindow, ChevronDown, CircleCheck, ChevronRight, Clock, Download, Flag, Hourglass, type LucideIcon, MessageSquareText, Sparkles, Trash2, Users, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentApi } from "../agent";
import { useStudio } from "../context";
import { api, inventoryApi } from "../lib/api";
import { confirmAsk } from "../lib/ask";
import { relativeTime } from "../lib/changes";
import { locale, t } from "../lib/i18n";
import {
  buildRequest,
  chartPoint,
  type Frequency,
  type Group,
  hours,
  type InventorySummary,
  type InventoryView,
  type Level,
  oftenText,
  ordered,
  type Period,
  plain,
  consult,
  sendFresh,
  type TaskAssessment,
  type WorkTask,
  WORTH_MINUTES,
} from "../lib/inventory";
import { Highlight } from "./Highlight";
import { DESK, PAPER } from "./sheet/paper";
import { SheetHeading } from "./SheetHeading";

/** How often the open sheet looks for what the AI saved (it writes from another process). */
const POLL_MS = 1500;
const PICK_KEY = "spellsheet.studio.inventory";
const LEVELS: Level[] = ["high", "medium", "low"];
const PERIODS: Period[] = ["day", "week", "month", "quarter", "year"];

function remembered(): string | null {
  try {
    return globalThis.localStorage?.getItem(PICK_KEY) ?? null;
  } catch {
    return null;
  }
}
function remember(id: string | null) {
  try {
    if (id) globalThis.localStorage?.setItem(PICK_KEY, id);
    else globalThis.localStorage?.removeItem(PICK_KEY);
  } catch {
    // Only a remembered preference.
  }
}

/** The stock-takes and the one shown, kept fresh while the page is open. */
function useInventories() {
  const [list, setList] = useState<InventorySummary[] | null>(null);
  const [picked, setPicked] = useState<string | null>(remembered);
  const [view, setView] = useState<InventoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The one shown: the one picked while it exists, else the latest changed
  // (a new one the AI starts comes up by itself).
  const shownId = list ? (list.find((i) => i.id === picked)?.id ?? list[0]?.id ?? null) : null;
  const load = useCallback(async () => {
    try {
      const next = await inventoryApi.list();
      setList((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const stamp = list?.find((i) => i.id === shownId)?.updatedAt;
  useEffect(() => {
    if (!shownId) {
      setView(null);
      return;
    }
    let live = true;
    inventoryApi
      .get(shownId)
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [shownId, stamp]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);
  const pick = (id: string | null) => {
    setPicked(id);
    remember(id);
  };
  return { list, view: view && view.inventory.id === shownId ? view : null, setView, pick, load, error, setError };
}

export function InventoryPage() {
  const agent = useAgentApi();
  const { list, view, setView, pick, load, error, setError } = useInventories();
  const [notice, setNotice] = useState<{ text: string; path?: string } | null>(null);

  const start = () => {
    // The next one the AI makes is the newest: show it as it comes.
    pick(null);
    void consult(agent);
  };
  const change = async (patch: Parameters<typeof inventoryApi.change>[0]) => {
    try {
      setView(await inventoryApi.change(patch));
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (list === null) return <div className={`h-full ${DESK}`} />;
  const exportXlsx = async (id: string) => {
    try {
      const path = await inventoryApi.exportXlsx(id, locale === "en");
      setNotice({ text: t.inventory.exported(path), path });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async (id: string, title: string) => {
    const ok = await confirmAsk({ title: t.inventory.deleteTitle(title), body: t.inventory.deleteBody, confirm: t.inventory.delete, danger: true });
    if (!ok) return;
    try {
      await inventoryApi.remove(id);
      pick(null);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className={`@container h-full overflow-y-auto px-5 py-7 ${DESK}`}>
      <div className="mx-auto w-[980px] max-w-full">
        {list.length > 1 && <Others list={list} shown={view?.inventory.id ?? null} onPick={pick} />}
        {error && (
          <p role="alert" className="mb-3 text-[13px] leading-[1.7] text-shu-600">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] leading-[1.7] text-slate-600">
            <span className="min-w-0 break-all">{notice.text}</span>
            {notice.path && (
              <button type="button" onClick={() => void api.revealFile(notice.path ?? "")} className="font-medium text-primary hover:underline">
                {t.project.menu.reveal}
              </button>
            )}
            <button type="button" onClick={() => setNotice(null)} className="hover:text-ink hover:underline">
              {t.cancel}
            </button>
          </p>
        )}
        {list.length === 0 ? (
          <Empty onStart={start} />
        ) : view ? (
          <Sheet view={view} onChange={change} onContinue={() => void consult(agent, view.inventory)} onExport={() => void exportXlsx(view.inventory.id)} onRemove={() => void remove(view.inventory.id, view.inventory.title)} />
        ) : (
          <div className={`h-96 ${PAPER}`} />
        )}
      </div>
    </div>
  );
}

/** The other stock-takes, named on the desk above the paper; the one shown is underlined. */
function Others({ list, shown, onPick }: { list: InventorySummary[]; shown: string | null; onPick: (id: string) => void }) {
  return (
    <nav aria-label={t.inventory.others} className="mb-4 flex flex-wrap gap-x-5 gap-y-1 border-b border-slate-300 px-1 text-[13px]">
      {list.map((i) => (
        <button
          key={i.id}
          type="button"
          aria-current={i.id === shown ? "page" : undefined}
          onClick={() => onPick(i.id)}
          className={`-mb-px max-w-64 truncate border-b-2 pt-1 pb-2 ${i.id === shown ? "border-ink font-medium text-ink" : "border-transparent text-slate-500 hover:text-ink"}`}
        >
          {i.title}
        </button>
      ))}
    </nav>
  );
}

/** The paper's margins: the same as a flow's sheet. */
const PAD = "px-6 @[52rem]:px-[72px]";

/** No stock-take yet: what it is, and the one way to start. */
function Empty({ onStart }: { onStart: () => void }) {
  const i = t.inventory;
  return (
    <article className={`${PAPER} ${PAD} pt-11 pb-14`}>
      <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.01em] text-ink">{i.emptyTitle}</h1>
      <p className="mt-2 max-w-[680px] text-[14px] leading-relaxed text-slate-600">{i.emptyLead}</p>
      <ol className="mt-6 border-y border-slate-200 py-3">
        {i.emptySteps.map((step, n) => (
          <li key={step} className="grid grid-cols-[28px_minmax(0,1fr)] py-1.5 text-[15px] leading-[1.6] text-ink">
            <span className="pt-[3px] text-[12px] text-slate-400 tabular-nums">{n + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      <button type="button" onClick={onStart} className="mt-6 flex h-9 items-center gap-1.5 rounded-[5px] bg-primary px-4 text-[13.5px] font-medium text-on-primary hover:bg-primary-hover">
        <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
        {i.start}
      </button>
    </article>
  );
}

/** Which of the four groups a task is in: words only, the one to build first under the highlighter. */
function GroupTag({ group }: { group: Group }) {
  const text = t.inventory.groups[group];
  return <span className={`shrink-0 text-[12px] whitespace-nowrap ${group === "first" ? "font-medium text-ink" : "text-slate-500"}`}>{group === "first" ? <Highlight>{text}</Highlight> : text}</span>;
}

type Change = (patch: Parameters<typeof inventoryApi.change>[0]) => Promise<void>;

/** The stock-take on one sheet: who, the totals, the chart, and the work in the order to build it. */
function Sheet({ view, onChange, onContinue, onExport, onRemove }: { view: InventoryView; onChange: Change; onContinue: () => void; onExport: () => void; onRemove: () => void }) {
  const i = t.inventory;
  const inv = view.inventory;
  const rows = ordered(view);
  // The one to build now: the highest ranked task that has no flow yet.
  const next = rows.find((r) => r.task.id === view.assessment.next);
  const ranked = rows.filter((r) => r.score.rank != null).length;
  const agent = useAgentApi();
  const setPlace = useStudio((s) => s.setPlace);
  const build = (task: WorkTask) => {
    // The library shows the new flow being made, as for any request for a flow.
    // Without an AI to ask, the request waits in the AI pane and this sheet stays.
    if (agent.getState().info?.available) setPlace("library");
    sendFresh(agent, buildRequest(inv, task));
  };
  const setTask = (taskId: string, fields: Record<string, unknown>) => onChange({ id: inv.id, tasks: [{ id: taskId, ...fields }] });
  const madeBy = inv.createdBy?.name;
  const facts: [LucideIcon, string, React.ReactNode][] = [
    ...(inv.about ? [[Users, i.about, inv.about] as [LucideIcon, string, React.ReactNode]] : []),
    ...(inv.systems?.length ? [[AppWindow, i.systems, inv.systems.join("、")] as [LucideIcon, string, React.ReactNode]] : []),
    [Clock, i.monthly, <span className="tabular-nums">{i.hoursMonth(hours(view.assessment.monthlyMinutes))}</span>],
    [Hourglass, i.savable, <b className="font-semibold tabular-nums">{i.hoursMonth(hours(view.assessment.savableMinutes))}</b>],
    [
      Flag,
      i.next,
      next ? (
        <>
          <b className="font-semibold">{next.task.name}</b>
          <button type="button" onClick={() => build(next.task)} className={`${LINK} text-[13px]`}>
            <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
            {i.build}
          </button>
        </>
      ) : (
        <span className="text-slate-500">{ranked > 0 && view.assessment.built === ranked ? i.allBuilt : i.noNext}</span>
      ),
    ],
    ...(ranked > 0 ? [[Workflow, i.progress, <span className="tabular-nums">{i.progressValue(view.assessment.built, ranked)}</span>] as [LucideIcon, string, React.ReactNode]] : []),
  ];
  return (
    <article className={`@container ${PAPER} pt-11 pb-14`} data-inventory-sheet>
      <header className={PAD}>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.01em] text-ink">{inv.title}</h1>
            <p className="mt-2 flex flex-wrap gap-x-3 text-[12.5px] leading-[1.7] text-slate-500">
              <span className={inv.status === "done" ? "" : "font-medium text-ink"}>{inv.status === "done" ? i.done : i.interviewing}</span>
              <span>{i.updated(relativeTime(inv.updatedAt))}</span>
              {madeBy && <span>{i.madeBy(madeBy)}</span>}
            </p>
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-[12.5px] leading-[1.7]">
            <button type="button" onClick={onContinue} className={LINK}>
              <MessageSquareText size={13} strokeWidth={1.75} aria-hidden="true" />
              {i.continueAi}
            </button>
            <button type="button" onClick={onExport} className={QUIET}>
              <Download size={13} strokeWidth={1.75} aria-hidden="true" />
              {i.exportXlsx}
            </button>
            <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 text-slate-600 hover:text-shu-600 hover:underline">
              <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
              {i.delete}
            </button>
          </p>
        </div>
        <dl className="mt-6 grid grid-cols-1 gap-x-4 gap-y-3 border-y border-slate-200 py-5 text-[14px] @[40rem]:grid-cols-[224px_minmax(0,1fr)]">
          {facts.map(([Icon, label, value]) => (
            <div key={label} className="contents">
              <dt className="flex items-center gap-2 self-start pt-px text-slate-500">
                <Icon size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                {label}
              </dt>
              <dd className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      {rows.length > 0 && (
        <section className={`mt-10 ${PAD}`} aria-label={i.chartTitle}>
          <h2 className="mb-4">
            <SheetHeading n={1} size="chapter">
              {i.chartTitle}
            </SheetHeading>
          </h2>
          <Chart rows={rows} />
        </section>
      )}

      <section className={`mt-10 ${PAD}`}>
        <h2 className="mb-2">
          <SheetHeading n={rows.length > 0 ? 2 : 1} size="chapter" aside={i.editHint}>
            {i.list}
          </SheetHeading>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-slate-300 text-left text-[12px] whitespace-nowrap text-slate-500">
                <th className="w-10 py-2 pr-2 font-normal">{i.columns.rank}</th>
                <th className="py-2 pr-3 font-normal">{i.columns.work}</th>
                <th className="py-2 pr-3 font-normal">{i.columns.often}</th>
                <th className="py-2 pr-3 text-right font-normal">{i.columns.minutes}</th>
                <th className="py-2 pr-3 text-right font-normal">{i.columns.people}</th>
                <th className="py-2 pr-3 text-right font-normal">{i.columns.share}</th>
                <th className="py-2 pr-3 text-right font-normal">{i.columns.monthly}</th>
                <th className="py-2 pr-3 text-right font-normal">{i.columns.savable}</th>
                <th className="py-2 pr-3 font-normal">{i.columns.ease}</th>
                <th className="py-2 font-normal">{i.columns.flow}</th>
              </tr>
            </thead>
            {rows.map(({ task, score }) => (
              <Row key={task.id} task={task} score={score} onSet={(fields) => setTask(task.id, fields)} onBuild={() => build(task)} />
            ))}
          </table>
        </div>
        <p className="mt-5 text-[12px] leading-[1.7] text-slate-500">{i.formula}</p>
      </section>
    </article>
  );
}

const LINK = "inline-flex items-center gap-1 font-medium text-primary hover:underline";
const QUIET = "inline-flex items-center gap-1 text-slate-600 hover:text-ink hover:underline";

/** The tasks placed by ease (across) and the time they could save (up), in the four groups. */
function Chart({ rows }: { rows: { task: WorkTask; score: TaskAssessment }[] }) {
  const i = t.inventory;
  const W = 640;
  const H = 280;
  const left = 62;
  const bottom = 26;
  const pw = W - left - 8;
  const ph = H - bottom - 8;
  const most = Math.max(0, ...rows.map((r) => r.score.savableMinutes ?? 0));
  // Where the dots go; ones that would sit on each other are moved apart a little.
  const placed = useMemo(() => {
    const out: { id: string; x: number; y: number; label: string; name: string; group: Group }[] = [];
    for (const { task, score } of rows) {
      const p = chartPoint(task, score, most);
      if (!p) continue;
      let x = left + p.x * pw;
      const y = 8 + (1 - p.y) * ph;
      while (out.some((o) => Math.abs(o.x - x) < 20 && Math.abs(o.y - y) < 20)) x += 22;
      out.push({ id: task.id, x, y, label: score.rank ? String(score.rank) : "-", name: task.name, group: score.group });
    }
    return out;
  }, [rows, most, pw, ph]);
  const midX = left + 0.4 * pw;
  const midY = 8 + 0.5 * ph;
  const quad = (group: Group, x: number, y: number, anchor: "start" | "end") => (
    <text x={x} y={y} textAnchor={anchor} className={`text-[11.5px] ${group === "first" ? "fill-ink font-semibold" : "fill-slate-500"}`}>
      {i.groups[group]}
    </text>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[760px]" role="img" aria-label={i.chartTitle}>
        <rect x={midX} y={8} width={left + pw - midX} height={midY - 8} className="fill-(--sheet-marker)" opacity={0.45} />
        <rect x={left} y={8} width={pw} height={ph} fill="none" className="stroke-slate-300" />
        <line x1={midX} x2={midX} y1={8} y2={8 + ph} className="stroke-slate-300" strokeDasharray="3 3" />
        <line x1={left} x2={left + pw} y1={midY} y2={midY} className="stroke-slate-300" strokeDasharray="3 3" />
        <text x={left - 6} y={midY + 4} textAnchor="end" className="fill-slate-500 text-[10.5px]">
          {i.hours(hours(WORTH_MINUTES))}
        </text>
        {quad("split", left + 8, 24, "start")}
        {quad("first", left + pw - 8, 24, "end")}
        {quad("notNow", left + 8, 8 + ph - 8, "start")}
        {quad("later", left + pw - 8, 8 + ph - 8, "end")}
        <text x={left + pw / 2} y={H - 6} textAnchor="middle" className="fill-slate-600 text-[11.5px]">
          {`${i.chartX}（${i.chartLow} → ${i.chartHigh}）`}
        </text>
        <text x={12} y={8 + ph / 2} textAnchor="middle" transform={`rotate(-90 12 ${8 + ph / 2})`} className="fill-slate-600 text-[11.5px]">
          {i.chartY}
        </text>
        {placed.map((p) => (
          <g key={p.id}>
            <title>{`${p.label === "-" ? "" : `${p.label}. `}${p.name}`}</title>
            <circle cx={p.x} cy={p.y} r={10} className={p.group === "first" ? "fill-primary" : p.group === "notNow" ? "fill-slate-300" : "fill-slate-500"} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" className="fill-white text-[11px] font-semibold">
              {p.label}
            </text>
          </g>
        ))}
    </svg>
  );
}

/** One task: its numbers on a line (each can be corrected), its details under it. */
function Row({ task, score, onSet, onBuild }: { task: WorkTask; score: TaskAssessment; onSet: (fields: Record<string, unknown>) => void; onBuild: () => void }) {
  const i = t.inventory;
  const [open, setOpen] = useState(score.rank === 1);
  const summaries = useStudio((s) => s.summaries);
  const openFlow = useStudio((s) => s.open);
  const setPlace = useStudio((s) => s.setPlace);
  const flows = (task.flowIds ?? []).map((id) => ({ id, name: summaries.find((f) => f.id === id)?.name }));
  const missing = score.missing ?? [];
  const Fold = open ? ChevronDown : ChevronRight;
  return (
    <tbody className="border-b border-slate-200 align-top">
      <tr>
        <td className="py-2.5 pr-2 text-[12px] leading-[21px] text-slate-400 tabular-nums">{score.rank ?? ""}</td>
        <td className="py-2 pr-3">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-start gap-1 text-left">
            <Fold size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="font-semibold text-ink">{task.name}</span>
          </button>
          <div className="mt-1 ml-5 flex flex-wrap items-center gap-1.5">
            <GroupTag group={score.group} />
          </div>
        </td>
        <td className="whitespace-nowrap py-2 pr-3">
          <OftenCell value={task.frequency ?? null} onSave={(frequency) => onSet({ frequency })} />
        </td>
        <td className="whitespace-nowrap py-2 pr-3 text-right">
          <NumberCell value={task.minutes ?? null} shown={(v) => i.minutesValue(plain(v))} min={0} onSave={(minutes) => onSet({ minutes })} />
        </td>
        <td className="whitespace-nowrap py-2 pr-3 text-right">
          <NumberCell value={task.people ?? null} shown={(v) => i.peopleValue(v)} min={1} whole onSave={(people) => onSet({ people })} />
        </td>
        <td className="whitespace-nowrap py-2 pr-3 text-right">
          <NumberCell value={task.manualShare ?? null} shown={(v) => `${v}%`} min={0} max={100} whole onSave={(manualShare) => onSet({ manualShare })} />
        </td>
        <td className="whitespace-nowrap py-2.5 pr-3 text-right text-ink tabular-nums">{score.monthlyMinutes != null ? i.hours(hours(score.monthlyMinutes)) : <Unknown />}</td>
        <td className="whitespace-nowrap py-2.5 pr-3 text-right font-semibold text-ink tabular-nums">{score.savableMinutes != null ? i.hours(hours(score.savableMinutes)) : <Unknown />}</td>
        <td className="py-2 pr-3">
          <LevelCell value={task.ease ?? null} label={i.columns.ease} onSave={(ease) => onSet({ ease })} />
        </td>
        <td className="whitespace-nowrap py-2.5">
          {flows.length > 0 ? (
            <span className="inline-flex items-center gap-1 text-ink">
              <CircleCheck size={13} strokeWidth={1.75} aria-hidden="true" className="text-moegi-600" />
              {i.built}
            </span>
          ) : score.rank != null ? (
            <span className="text-slate-500">{i.notBuilt}</span>
          ) : null}
        </td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={9} className="pr-2 pb-4">
            <Details task={task} missing={missing} />
            <p className="mt-2.5 ml-5 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] leading-[1.7]">
              {score.group !== "notNow" && flows.length === 0 && (
                <button type="button" onClick={onBuild} className={LINK}>
                  <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
                  {i.build}
                </button>
              )}
              {flows.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setPlace("flows");
                    void openFlow(f.id);
                  }}
                  className={QUIET}
                >
                  <Workflow size={13} strokeWidth={1.75} aria-hidden="true" />
                  {i.openFlow(f.name ?? f.id)}
                </button>
              ))}
            </p>
          </td>
        </tr>
      )}
    </tbody>
  );
}

function Unknown() {
  return <span className="text-[12px] font-normal text-slate-400">{t.inventory.unknownValue}</span>;
}

/** What was heard about a task, the parts that were said. */
function Details({ task, missing }: { task: WorkTask; missing: string[] }) {
  const i = t.inventory;
  const list = (items: string[] | undefined) => (items?.length ? items.join("、") : null);
  const lines: [string, string | null | undefined][] = [
    [i.steps, task.steps?.length ? task.steps.map((s, n) => `${n + 1}. ${s}`).join("\n") : null],
    [i.usedSystems, list(task.systems)],
    [i.inputs, list(task.inputs)],
    [i.outputs, list(task.outputs)],
    [i.exceptions, task.exceptions],
    [i.easeReasons, list(task.easeReasons)],
    [i.errorImpact, task.errorImpact ? i.levels[task.errorImpact] : null],
    [i.nodes, list(task.stepTypes)],
    [i.plugins, list(task.plugins)],
    [i.notNow, task.notNow],
    [i.note, task.note],
    [i.missing, missing.length ? missing.map((m) => i.missingFields[m] ?? m).join("、") : null],
  ];
  return (
    <div className="ml-5 border-y border-slate-200 py-3 text-[13px] leading-[1.7]">
      {task.description && <p className="mb-2 text-[14px] leading-[1.8] text-slate-700">{task.description}</p>}
      <dl className="grid gap-x-4 gap-y-1.5 @[40rem]:grid-cols-[9rem_1fr]">
        {lines
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-slate-500">{label}</dt>
              <dd className="whitespace-pre-line text-ink">{value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

const CELL = "-mx-1 rounded-[3px] px-1 tabular-nums hover:bg-(--sheet-marker) focus-visible:bg-(--sheet-marker) focus-visible:outline-none";
const INPUT = "h-7 w-20 rounded-[4px] border border-primary bg-sheet px-1.5 text-right text-[13px] tabular-nums text-ink focus:outline-none";

/** A number that turns into a field on click; Enter or leaving it saves, Esc puts it back. */
function NumberCell({
  value,
  shown,
  min,
  max,
  whole,
  onSave,
}: {
  value: number | null;
  shown: (v: number) => string;
  min: number;
  max?: number;
  whole?: boolean;
  onSave: (v: number) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing !== null) ref.current?.select();
  }, [editing !== null]);
  const commit = () => {
    if (editing === null) return;
    const n = Number(editing);
    setEditing(null);
    if (editing.trim() === "" || !Number.isFinite(n) || n < min || (max !== undefined && n > max) || (whole && !Number.isInteger(n))) return;
    if (n !== value) onSave(n);
  };
  if (editing !== null)
    return (
      <input
        ref={ref}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={whole ? 1 : "any"}
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(null);
        }}
        className={INPUT}
      />
    );
  return (
    <button type="button" title={t.inventory.editHint} onClick={() => setEditing(value === null ? "" : String(value))} className={`${CELL} text-ink`}>
      {value === null ? <Unknown /> : shown(value)}
    </button>
  );
}

/** How often: times and a period, corrected together. */
function OftenCell({ value, onSave }: { value: Frequency | null; onSave: (f: Frequency) => void }) {
  const [editing, setEditing] = useState<{ times: string; per: Period } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const commit = (next = editing) => {
    if (!next) return;
    setEditing(null);
    const times = Number(next.times);
    if (!Number.isFinite(times) || times <= 0) return;
    if (value && times === value.times && next.per === value.per) return;
    onSave({ times, per: next.per });
  };
  if (editing)
    return (
      <span
        ref={box}
        className="flex items-center gap-1"
        onBlur={(e) => {
          if (!box.current?.contains(e.relatedTarget as Node | null)) commit();
        }}
      >
        <select
          value={editing.per}
          aria-label={t.inventory.columns.often}
          onChange={(e) => setEditing({ ...editing, per: e.target.value as Period })}
          className="h-7 rounded-[4px] border border-primary bg-sheet px-1 text-[13px] text-ink"
        >
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {t.inventory.periods[p]}
            </option>
          ))}
        </select>
        <input
          autoFocus
          type="number"
          min={0}
          step="any"
          value={editing.times}
          onChange={(e) => setEditing({ ...editing, times: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(null);
          }}
          className={`${INPUT} w-14`}
        />
      </span>
    );
  return (
    <button type="button" title={t.inventory.editHint} onClick={() => setEditing({ times: value ? String(value.times) : "1", per: value?.per ?? "month" })} className={`${CELL} text-left text-ink`}>
      {value ? oftenText(value) : <Unknown />}
    </button>
  );
}

function LevelCell({ value, label, onSave }: { value: Level | null; label: string; onSave: (l: Level) => void }) {
  return (
    <select
      value={value ?? ""}
      aria-label={label}
      title={t.inventory.editHint}
      onChange={(e) => e.target.value && onSave(e.target.value as Level)}
      className={`h-7 rounded-[4px] border border-transparent bg-transparent px-1 text-[13.5px] hover:border-slate-300 focus:border-primary focus:outline-none ${value ? "text-ink" : "text-slate-400"}`}
    >
      {!value && <option value="">{t.inventory.unknownValue}</option>}
      {LEVELS.map((l) => (
        <option key={l} value={l}>
          {t.inventory.levels[l]}
        </option>
      ))}
    </select>
  );
}

