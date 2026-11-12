// The flow as one sheet of paper: what it is for and what it works with at
// the top, then its work in order, in sentences, with the screens it touches
// in the margin. Read as a chart, the same paper keeps its heading and shows
// the chart (components/chart/ChartBody.tsx) under it.
import { useRunGate } from "../../lib/runGate";
import { ArrowDown, ArrowUp, Check, CircleCheck, CircleMinus, CirclePause, CircleX, ArrowRight, Download, EyeOff, FileSpreadsheet, FileText, Globe, History, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, manualApi, type ScheduleView } from "../../lib/api";
import { useStudio } from "../../context";
import { locale, t } from "../../lib/i18n";
import { buildManual, type Rect, type Chapter, type Drafts, type ManualDoc, type ManualItem, type ManualManifest, type ManualShot, type ManualStep, type Mask, maskStale, type Scene, editionOf } from "../../lib/manual";
import { type SceneMark, sceneMarks } from "../../lib/manualExport";
import { describeWhen } from "../../lib/schedule";
import type { FlowRun } from "../../lib/runResult";
import { brief, hasSentence, type Part, paramShown, plain, withoutSaveAs } from "../../lib/sentence";
import type { Flow, Step } from "@spellsheet/schema";
import { findStep, isActive, trailOf } from "../../store";
import type { RunState } from "../../store/run";
import { errorLine } from "../../lib/errorText";
import { revertBlocker, touchedSteps } from "../../store/history";
import { actorLabel, describe, formatValue, relativeTime } from "../../lib/changes";
import { extensionParamTitle } from "../../lib/extensions";
import { usePendingReview } from "../Timeline";
import type { HistoryEntry, PublishedState, StepTypeDef, VersionSummary } from "@spellsheet/schema";
import { menuFor } from "../../lib/contextMenu";
import { useFlowBusy } from "../../lib/useFlowBusy";
import { useStepMenu } from "../menus";
import { ChartBody } from "../chart/ChartBody";
import { StepInspector } from "../inspector/StepInspector";
import { ExportDialog, MaskEditor, type Pictures, ShotFrame, WholeShot, day, madeLine, shotLine, usePictures, useSubflows } from "./pictures";
import { SheetHeading } from "../SheetHeading";
import { Stripe } from "../Masthead";
import { PAPER } from "./paper";

// A value in a sentence: the words of the sentence, set apart by a dotted line under them (boxes made the sheet read as a form).
const CHIP = "mx-px border-b border-dotted border-[var(--sheet-value-line)] font-medium text-ink";

/** A value in a sentence that is written out in full: pressed, it is changed where it stands. */
function Entry({ shown, value, onChange }: { shown: string; value: string | number; onChange: (next: string | number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <button type="button" title={t.sheetView.change} onClick={(e) => {
        e.stopPropagation();
        setDraft(String(value));
      }} className={`${CHIP} cursor-text hover:border-solid hover:border-primary`}>
        {shown}
      </button>
    );
  }
  const done = (keep: boolean) => {
    const next = typeof value === "number" ? Number(draft) : draft;
    if (keep && draft.trim() !== "" && next !== value && !(typeof next === "number" && Number.isNaN(next))) onChange(next);
    setDraft(null);
  };
  return (
    <input
      autoFocus
      onClick={(e) => e.stopPropagation()}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
      style={{ width: `calc(${Math.max(4, [...draft].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1.1), 0))}ch + 16px)` }}
      className="mx-0.5 max-w-full rounded-[4px] border border-primary bg-paper px-1.5 py-px text-[14px] leading-[1.45] text-ink outline-none"
    />
  );
}

/** A sentence with the values it names set apart, as on a form. With `step`, the ones written out in full can be changed in place. */
function Words({ parts, step, onValue, onOpen }: { parts: Part[]; step?: Step; onValue?: (key: string, value: string | number) => void; onOpen?: () => void }) {
  return (
    <>
      {parts.map((p, i) => {
        if ("text" in p) return <span key={i}>{p.text}</span>;
        // A page of HTML or a long script is not read in a sentence: its first words, and the rest in the step's settings.
        const cut = brief(p.code);
        if (cut) {
          // What it works out to is said in the step's note (the AI writes one); the expression itself is in the step's settings.
          return onOpen ? (
            <button key={i} type="button" title={t.sheetView.openLong} onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }} className={`${CHIP} hover:border-solid hover:border-primary`}>
              {t.sheetView.worked}
            </button>
          ) : (
            <span key={i} className={CHIP}>
              {t.sheetView.worked}
            </span>
          );
        }
        const key = step && onValue ? paramShown(step, p.code) : null;
        if (key && step && onValue) return <Entry key={i} shown={p.code} value={step.params?.[key] as string | number} onChange={(v) => onValue(key, v)} />;
        return (
          <span key={i} className={CHIP}>
            {p.code}
          </span>
        );
      })}
    </>
  );
}

/** A value as a note in the margin gives it: a long one by its first words. */
function short(value: string): string {
  const cut = brief(value);
  return cut ? `${cut.text}… ${t.sheetView.chars(cut.length)}` : value;
}

/** What a part of the sheet does, step by step, in the steps' own names. */
function texts(items: ManualItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "scene" ? item.steps.map((s) => s.text) : item.kind === "action" ? [item.step.text] : item.kind === "quiet" ? item.texts : item.kind === "stopped" ? [] : texts(item.items),
  );
}

/** The numbered operations in these items. */
const countSteps = (items: ManualItem[]): number =>
  items.reduce((n, i) => n + (i.kind === "scene" ? i.steps.length : i.kind === "action" ? 1 : "items" in i ? countSteps(i.items) : 0), 0);

/** A file, a site or a value the flow takes in or gives back, as a small card. */
function Thing({ name, kind, out = false }: { name: string; kind: "file" | "site" | "value"; out?: boolean }) {
  const Icon = kind === "site" ? Globe : /\.(xlsx?|xlsm|csv)$/i.test(name) ? FileSpreadsheet : FileText;
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return (
    <li className={`flex min-w-0 items-center gap-2.5 rounded-[4px] border bg-sheet px-2.5 py-2 ${out ? "border-[var(--color-role-output)] shadow-[inset_3px_0_0_var(--color-role-output)]" : "border-slate-300"}`}>
      {kind !== "value" && <Icon size={18} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 ${Icon === FileSpreadsheet ? "text-moegi-600" : "text-slate-500"}`} />}
      <span className="min-w-0">
        <b className="block text-[13.5px] leading-[1.4] font-semibold break-words text-ink">{slash >= 0 ? name.slice(slash + 1) : name}</b>
        {slash >= 0 && <small className="block text-[11.5px] leading-[1.4] text-slate-500">{t.sheetView.inFolder(name.slice(0, slash))}</small>}
      </span>
    </li>
  );
}

/** The flow's last run from anywhere (Writer, Runner, a schedule), read again when one here ends. */
function useLatestRun(flowId: string | undefined): FlowRun | null {
  const ended = useStudio((s) => (s.run && s.run.flowId === flowId && !isActive(s.run) ? s.run.runId : null));
  const [latest, setLatest] = useState<FlowRun | null>(null);
  useEffect(() => {
    setLatest(null);
    if (!flowId) return;
    let live = true;
    let tries = 0;
    const load = () =>
      api.flowRuns(flowId).then(
        (list) => {
          if (!live) return;
          setLatest(list[0] ?? null);
          // The record is written just after the run's last event.
          if (ended && !list.some((r) => r.runId === ended) && ++tries < 10) setTimeout(load, 300);
        },
        () => live && setLatest(null),
      );
    void load();
    return () => {
      live = false;
    };
  }, [flowId, ended]);
  return latest;
}

/**
 * The head of the sheet, as a company's procedure document has one: what it is
 * and its particulars in a ruled table, what goes in and what comes out with the
 * work between them, then what else it runs on. Only what the flow has is drawn.
 */
/** `short`: over the chart, which draws what the flow works with itself: only what it is and its particulars. */
function Head({ doc, when, edition, manifest, latest, actions, short = false }: { doc: ManualDoc; when: string[]; edition: { label: string; updated: string | null }; manifest: ManualManifest | null; latest: FlowRun | null; actions: React.ReactNode; short?: boolean }) {
  const w = t.sheetView;
  const failure = doc.chapters.filter((c) => c.role === "failure").flatMap((c) => texts(c.items));
  const work = doc.chapters.filter((c) => !c.role);
  const steps = doc.chapters.reduce((n, c) => n + countSteps(c.items), 0);
  // The last run from anywhere (Writer, Runner, a schedule), failed ones too; else the run the pictures came from.
  const ranWhen = latest?.startedAt ?? manifest?.startedAt ?? null;
  const ranAt = ranWhen ? new Date(ranWhen).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const ranStatus = latest?.status ?? (manifest ? "succeeded" : null);
  const particulars: [string, React.ReactNode][] = [
    [w.edition, edition.label],
    ...(edition.updated ? ([[w.updated, edition.updated]] as [string, React.ReactNode][]) : []),
    [w.stepCount, steps],
    [
      w.lastRun,
      ranAt ? (
        <span className="inline-flex items-center gap-1.5">
          {ranStatus === "failed" ? (
            <CircleX size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-shu-600" />
          ) : ranStatus === "succeeded" ? (
            <CircleCheck size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-moegi-600" />
          ) : (
            <CircleMinus size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-slate-400" />
          )}
          <span className="tabular-nums">{ranAt}</span>
          {ranStatus && ranStatus !== "succeeded" && <span className={ranStatus === "failed" ? "text-shu-600" : "text-slate-500"}>{t.result.status[ranStatus] ?? ""}</span>}
        </span>
      ) : (
        w.notRun
      ),
    ],
  ];
  const ins = [...doc.uses.inputFiles.map((name) => ({ name, kind: "file" as const })), ...doc.uses.apps.map((name) => ({ name, kind: "site" as const })), ...doc.inputs.map((name) => ({ name, kind: "value" as const }))];
  const outs = [...doc.uses.outputFiles.map((name) => ({ name, kind: "file" as const })), ...doc.outputs.map((name) => ({ name, kind: "value" as const }))];
  const also = [
    { label: t.project.shelves.templates ?? "", text: doc.uses.templates.join(w.and) },
    { label: t.project.shelves.config ?? "", text: doc.uses.config.join(w.and) },
    { label: w.secrets, text: doc.uses.logins.join(w.and) },
    { label: w.schedule, text: when.join(w.and) },
    { label: w.onFailure, text: failure.join(w.and) },
  ].filter((r) => r.text !== "");
  const CAP = "mb-2 text-[11.5px] font-semibold tracking-[0.06em] text-slate-600";
  const arrow = <ArrowRight size={22} strokeWidth={1.5} aria-hidden="true" className="mx-auto hidden shrink-0 text-slate-400 @[52rem]/paper:block" />;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-5">
        <div className="min-w-0 flex-1 basis-[320px]">
          <p className="mb-1.5 text-[12px] font-bold tracking-[0.14em] text-[var(--manual-navy)]">{w.kind}</p>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-balance text-ink">{doc.title}</h1>
          {doc.description && <p className="mt-2 text-[14.5px] leading-relaxed text-slate-600">{doc.description}</p>}
        </div>
        <div className="shrink-0">
          <table className="border-collapse text-[12.5px]">
            <tbody>
              {particulars.map(([label, value]) => (
                <tr key={label}>
                  <th className="border border-slate-300 bg-paper px-3 py-1.5 text-left font-normal whitespace-nowrap text-slate-600">{label}</th>
                  <td className="border border-slate-300 px-3 py-1.5 text-ink">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {actions}
        </div>
      </div>
      {!short && (ins.length > 0 || outs.length > 0) && work.length > 0 && (
        <div className="mt-6 grid gap-x-4 gap-y-4 rounded-[4px] border border-slate-200 bg-paper px-5 py-4 @[52rem]/paper:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.1fr)_auto_minmax(0,1fr)] @[52rem]/paper:items-center">
          <div>
            <p className={CAP}>{w.input}</p>
            {ins.length > 0 ? (
              <ul className="space-y-1.5">
                {ins.map((x) => (
                  <Thing key={`${x.kind}:${x.name}`} {...x} />
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-slate-500">{w.nothing}</p>
            )}
          </div>
          {arrow}
          <div>
            <p className={CAP}>{w.does}</p>
            <ol className="space-y-1.5 text-[13.5px] leading-[1.5] text-ink">
              {work.slice(0, 5).map((c) => (
                <li key={c.number} className="grid grid-cols-[22px_minmax(0,1fr)] items-baseline">
                  <span className="grid size-[17px] place-items-center self-center rounded-full bg-[var(--manual-navy)] text-[10.5px] font-bold text-sheet tabular-nums">{c.number}</span>
                  {c.title}
                </li>
              ))}
              {work.length > 5 && <li className="pl-[22px] text-[12.5px] text-slate-500">{w.more(work.length - 5)}</li>}
            </ol>
          </div>
          {arrow}
          <div>
            <p className={CAP}>{w.output}</p>
            {outs.length > 0 ? (
              <ul className="space-y-1.5">
                {outs.map((x) => (
                  <Thing key={`${x.kind}:${x.name}`} {...x} out />
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-slate-500">{w.nothing}</p>
            )}
          </div>
        </div>
      )}
      {!short && also.length > 0 && (
        <dl className="mt-3 grid grid-cols-1 overflow-hidden rounded-[4px] border border-slate-200 text-[13px] @[52rem]/paper:grid-flow-col @[52rem]/paper:auto-cols-fr @[52rem]/paper:grid-cols-none">
          {also.map((r) => (
            <div key={r.label} className="border-t border-slate-200 px-4 py-2.5 first:border-t-0 @[52rem]/paper:border-t-0 @[52rem]/paper:border-l @[52rem]/paper:first:border-l-0">
              <dt className="mb-0.5 text-[11.5px] font-semibold tracking-[0.04em] text-slate-600">{r.label}</dt>
              <dd className="leading-[1.6] break-words text-ink">{r.text}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/** The ways on from the sheet's particulars: run it, write it out as a manual, read its past runs. */
/** `blocked`: why the flow cannot be run now (it is running, has errors, or the AI is still making it), as on the bar's run button. */
function LastRun({ blocked, empty, onRun, onExport, onHistory }: { blocked: string | null; empty: boolean; onRun: () => void; onExport: () => void; onHistory?: () => void }) {
  const w = t.sheetView;
  const link = "inline-flex items-center gap-1 text-slate-600 enabled:hover:text-ink enabled:hover:underline disabled:text-slate-400";
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] leading-[1.7]">
      <button type="button" disabled={blocked !== null} title={blocked || undefined} onClick={onRun} className="inline-flex items-center gap-1 font-medium text-primary enabled:hover:underline disabled:text-slate-400">
        <Play size={12} strokeWidth={2} aria-hidden="true" />
        {w.run}
      </button>
      {/* The sheet as a file to hand to someone: the manual, with its pictures. */}
      <button type="button" disabled={empty} title={empty ? t.sheetView.noSteps : undefined} onClick={onExport} className={link}>
        <Download size={12} strokeWidth={1.75} aria-hidden="true" />
        {t.manual.export}
      </button>
      {/* Every run of this flow, wherever it was started: its results and logs. */}
      {onHistory && (
        <button type="button" onClick={onHistory} className={link}>
          <History size={12} strokeWidth={1.75} aria-hidden="true" />
          {t.result.history}
        </button>
      )}
    </div>
  );
}

/** The flow's own steps said in these items. */
const stepIds = (items: ManualItem[]): string[] =>
  items.flatMap((i) => (i.kind === "scene" ? i.steps.map((x) => x.stepId) : i.kind === "action" ? [i.step.stepId] : "items" in i ? stepIds(i.items) : []));

/** A change that waits to be looked at, by the step it touched. */
type Change = { entry: HistoryEntry; added: boolean };

/**
 * In the margin beside a step someone else changed (the AI, a command): who
 * changed it and when, what was there before, and the two answers to it.
 * Nothing is drawn on the step itself: the sheet always shows the flow as it is now.
 */
function ChangeNote({ change, step, defs }: { change: Change; step: ManualStep; defs: ReadonlyMap<string, StepTypeDef> }) {
  const stepId = step.stepId;
  const type = useStudio((s) => findStep(s.flow?.steps ?? [], stepId)?.type ?? "");
  /** A setting as the step's form names it. */
  const named = (field: string) => t.paramNames.for[type]?.[field] ?? extensionParamTitle(type, field) ?? t.paramNames.labels[field] ?? field;
  const flow = useStudio((s) => s.flow);
  const history = useStudio((s) => s.history);
  const approve = useStudio((s) => s.approve);
  const revert = useStudio((s) => s.revert);
  // While the AI is still at work on the flow, its changes so far are not yet something to decide on.
  const busy = useFlowBusy();
  const { entry, added } = change;
  const blocker = busy ? t.sheetView.aiWorking : revertBlocker(entry, history);
  const diffs = added
    ? []
    : describe(entry, flow, defs)
        .filter((l) => l.stepId === stepId)
        .flatMap((l) => l.diffs);
  return (
    <div className="flex gap-2 text-[12.5px] leading-[1.7] text-slate-600" data-change={entry.revision}>
      <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" className="mt-[4px] shrink-0 text-primary" />
      <div className="min-w-0">
        <p>
          <span className="mr-1.5 text-slate-400 tabular-nums">{step.number}</span>
          <span className="text-ink">{t.story.by(actorLabel(entry), added)}</span>
          <span className="text-slate-400"> · {relativeTime(entry.at)}</span>
        </p>
        {entry.summary && <p>{entry.summary}</p>}
        {diffs.map((d) => (
          <p key={d.field} className="break-words">
            {named(d.field)}
            {t.sheetView.was}
            {d.before === undefined ? t.sheetView.nothing : short(formatValue(d.before))}
          </p>
        ))}
        <p className="mt-0.5 flex gap-3">
          <button type="button" disabled={busy} title={busy ? t.sheetView.aiWorking : undefined} onClick={() => approve(entry.revision)} className="font-medium text-primary enabled:hover:underline disabled:text-slate-400">
            {t.approve}
          </button>
          <button type="button" disabled={blocker !== null} title={blocker ?? undefined} onClick={() => void revert(entry)} className="text-slate-600 enabled:hover:text-shu-600 enabled:hover:underline disabled:text-slate-400">
            {t.revert}
          </button>
        </p>
      </div>
    </div>
  );
}

/** How a step of the run came out, after its name. */
function RunMark({ state }: { state: "succeeded" | "failed" | "paused" }) {
  const Icon = state === "succeeded" ? Check : state === "failed" ? CircleX : CirclePause;
  return <Icon size={14} strokeWidth={2} aria-hidden="true" className={`mb-[3px] ml-1.5 inline-block ${state === "succeeded" ? "text-moegi-600" : state === "failed" ? "text-shu-600" : "text-slate-500"}`} />;
}

/** One level deeper: everything the picked step is set to, where it is said, then what is done to the step as a whole. More is on the right button. */
function Details({ stepId, ctx }: { stepId: string; ctx: RowCtx }) {
  const act = "inline-flex items-center gap-1 hover:text-ink";
  return (
    <div className="mt-2.5 mb-1 border-y border-slate-200">
      <StepInspector />
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-200 px-4 py-2.5 text-[12.5px] text-slate-600">
        <button type="button" onClick={ctx.onAdd} className={act}>
          <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
          {t.sheetView.addBelow}
        </button>
        <button type="button" onClick={() => ctx.onMove(-1)} className={act}>
          <ArrowUp size={13} strokeWidth={1.75} aria-hidden="true" />
          {t.moveUp}
        </button>
        <button type="button" onClick={() => ctx.onMove(1)} className={act}>
          <ArrowDown size={13} strokeWidth={1.75} aria-hidden="true" />
          {t.moveDown}
        </button>
        <button type="button" onClick={() => ctx.onStop(stepId, true)} className={act}>
          <CirclePause size={13} strokeWidth={1.75} aria-hidden="true" />
          {t.sheetView.stop}
        </button>
        <button type="button" onClick={ctx.onRemove} className="inline-flex items-center gap-1 hover:text-shu-600">
          <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
          {t.delete}
        </button>
      </div>
    </div>
  );
}

/** A place with no step in it yet: the first one is added there. */
function AddHere({ parentId, block, ctx, first = false }: { parentId: string | null; block: string | null; ctx: RowCtx; first?: boolean }) {
  return (
    <button type="button" onClick={() => ctx.onAddIn(parentId, block)} className="my-1.5 inline-flex items-center gap-1 text-[13px] text-primary hover:underline">
      <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
      {first ? t.sheetView.addFirst : t.sheetView.addHere}
    </button>
  );
}

/** The room a step's picture takes beside its words, and the gap between the two. */
const PICTURE = "@[52rem]/paper:grid-cols-[28px_minmax(0,1fr)_320px]";

/**
 * A step's picture: cut close round what the step touches, so the place is read at the size of the margin
 * (a screen's whole width in 320px shows nothing). A wide thing (a table) keeps the width it has.
 */
function closeCrop(shot: ManualShot, mark: Rect): Rect {
  const width = Math.min(shot.width, Math.max(560, mark.width + 120));
  const height = Math.min(shot.height, Math.max(width * 0.5, mark.height + 90));
  const fit = (centre: number, size: number, max: number) => Math.round(Math.max(0, Math.min(max - size, centre - size / 2)));
  return { x: fit(mark.x + mark.width / 2, width, shot.width), y: fit(mark.y + mark.height / 2, height, shot.height), width: Math.round(width), height: Math.round(height) };
}

/**
 * One step: its number, what is done in one sentence, and beside it the place on the screen it is done at.
 * `scene`: the screen the step is on (its picture is cut to what this step touches).
 */
function StepRow({ step, ctx, scene }: { step: ManualStep; ctx: RowCtx; scene?: Scene }) {
  const picked = ctx.picked === step.stepId;
  const onPick = ctx.onPick;
  const own = step.callPath.length === 0 ? ctx.stepOf(step.stepId) : undefined;
  const state = own ? ctx.run?.steps[step.stepId] : undefined;
  const error = ctx.run?.pause?.error ?? ctx.run?.failure;
  const failed = own && state === "failed" && error && (!error.stepId || error.stepId === step.stepId) ? errorLine(error, own) : null;
  // Said as a sentence where the kind of step reads as one; a kind that would read as its settings in a row is said by the name it was given.
  const type = own?.type ?? "";
  const said = step.how && (hasSentence(type) || !own) ? withoutSaveAs(step.how) : null;
  const changes = step.callPath.length > 0 ? [] : (ctx.changes.get(step.stepId) ?? []);
  // The picture: where this step is done, or the whole screen for the first step of a screen none of whose steps has a place on it.
  const shot = scene?.shot ?? null;
  const wholeScreen = shot && !step.mark && scene!.steps[0] === step && scene!.steps.every((x) => !x.mark);
  const marks: SceneMark[] = step.mark ? [{ number: step.number, rect: step.mark, operates: step.operates }] : [];
  const pictured = shot && (step.mark || wholeScreen);
  return (
    <li className="scroll-my-24 border-t border-slate-100 py-3 first:border-t-0 @[52rem]/paper:-mr-[344px]" data-step={own ? step.stepId : undefined} onContextMenu={own ? ctx.menu(step.stepId) : undefined}>
      <div className={`grid grid-cols-[28px_minmax(0,1fr)] gap-y-2.5 ${PICTURE}`}>
        <span className="pt-[4px] text-[12.5px] text-slate-400 tabular-nums">{step.number}</span>
        <div className="min-w-0 @[52rem]/paper:pr-6">
          {/* The sentence opens the step; a value in it is changed where it stands. */}
          <p
            role="button"
            tabIndex={0}
            title={said && plain(said) !== step.text ? step.text : undefined}
            onClick={() => onPick(step.stepId)}
            onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onPick(step.stepId)}
            className="cursor-pointer text-[15.5px] leading-[1.75] text-ink"
          >
            {/* The step the run is on is under the highlighter, as the one picked is. */}
            <span className={picked || state === "running" ? "flow-chart-on" : ""}>
              {said ? <Words parts={said} step={own} onValue={(key, value) => ctx.onValue(step.stepId, key, value)} onOpen={() => (picked ? undefined : onPick(step.stepId))} /> : step.text}
            </span>
            {state && state !== "running" && state !== "skipped" && <RunMark state={state} />}
          </p>
          {failed && <p className="mt-0.5 text-[13px] leading-[1.7] text-shu-600">{failed}</p>}
          {step.note && <p className="mt-1 text-[13px] leading-[1.7] text-slate-600">{step.note}</p>}
          {/* One level deeper: everything the step is set to, where it is said. A step of a called flow is changed in that flow. */}
          {picked && step.callPath.length === 0 && <Details stepId={step.stepId} ctx={ctx} />}
        </div>
        {(pictured || changes.length > 0) && (
          <div className="col-span-2 space-y-2.5 pl-7 @[52rem]/paper:col-span-1 @[52rem]/paper:pl-0">
            {changes.map((c) => (
              <ChangeNote key={c.entry.revision} change={c} step={step} defs={ctx.defs} />
            ))}
            {pictured && <StepFigure scene={scene!} shot={shot} marks={marks} pictures={ctx.pictures} />}
          </div>
        )}
      </div>
    </li>
  );
}

/** Where a step is done, cut out of its screen: the whole screen opens from it, and what must not be shown is hidden from it. */
function StepFigure({ scene, shot, marks, pictures }: { scene: Scene; shot: ManualShot; marks: SceneMark[]; pictures: Pictures }) {
  const mask = pictures.masks[shot.key];
  const whole = () => pictures.onWhole(shot, sceneMarks(scene));
  return (
    <figure className="group/fig relative">
      <div role="button" tabIndex={0} title={`${t.manual.screenOf(scene.title, scene.app === "desktop")}${shot.draft ? `（${t.manual.draft}）` : ""}：${t.manual.whole}`} onClick={whole} onKeyDown={(e) => e.key === "Enter" && whole()} className="cursor-zoom-in overflow-hidden rounded-[3px] border border-slate-300">
        <ShotFrame shot={shot} marks={marks} ctx={pictures} crop={marks[0] ? closeCrop(shot, marks[0].rect) : undefined} bare />
      </div>
      {maskStale(mask, shot) && <p className="mt-1 text-[12px] leading-[1.5] text-shu-600">{t.manual.maskStale}</p>}
      <button
        type="button"
        title={t.manual.hideTitle}
        onClick={() => pictures.onMask(shot)}
        className="absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-[4px] bg-sheet px-1.5 py-0.5 text-[11.5px] text-slate-600 opacity-0 shadow-[0_0_0_1px_var(--color-slate-300)] group-focus-within/fig:opacity-100 group-hover/fig:opacity-100 hover:text-ink"
      >
        <EyeOff size={12} strokeWidth={1.75} aria-hidden="true" />
        {t.manual.hide}
        {mask && mask.boxes.length > 0 ? ` ${mask.boxes.length}` : ""}
      </button>
    </figure>
  );
}

/** The width of the margin beside the words, and the room between the two. */
const MARGIN = "@[52rem]/paper:mr-[344px]";

type RowCtx = {
  pictures: Pictures;
  picked: string | null;
  onPick: (stepId: string) => void;
  /** The flow's own step (not one of a called flow). */
  stepOf: (id: string) => Step | undefined;
  onValue: (stepId: string, key: string, value: string | number) => void;
  /** The run of this flow that is going, or the last one of the flow as it is now. */
  run: RunState | null;
  /** What waits to be looked at, by step. */
  changes: ReadonlyMap<string, Change[]>;
  defs: ReadonlyMap<string, StepTypeDef>;
  /** Switches a step off, or on again. */
  onStop: (stepId: string, stop: boolean) => void;
  /** A new step under the picked one, and the picked one taken out. */
  onAdd: () => void;
  onRemove: () => void;
  /** The picked step, one place up or down among its neighbours. */
  onMove: (delta: -1 | 1) => void;
  /** A first step into a place that has none (the flow itself: null). */
  onAddIn: (parentId: string | null, block: string | null) => void;
  /** The right button on a step: everything else that is done to it. */
  menu: (stepId: string) => React.MouseEventHandler;
};

function Item({ item, ctx }: { item: ManualItem; ctx: RowCtx }) {
  if (item.kind === "scene") {
    return (
      <ol>
        {[...item.steps, null].map((st, i) => (
          <Fragment key={st?.key ?? "end"}>
            {/* What the flow waits for or looks at on the screen: said in place, not numbered. */}
            {item.waits
              .filter((x) => x.at === i)
              .map((x, k) => {
                // A screen the flow only waits on has no numbered step to carry its picture: the first wait carries it.
                const shot = item.steps.length === 0 && k === 0 ? item.shot : null;
                if (!shot) {
                  return (
                    <li key={k} className="py-1.5 pl-7 text-[13px] leading-[1.7] text-slate-600">
                      {x.text}
                    </li>
                  );
                }
                return (
                  <li key={k} className="py-1.5 @[52rem]/paper:-mr-[344px]">
                    <div className={`grid grid-cols-[28px_minmax(0,1fr)] gap-y-2.5 ${PICTURE}`}>
                      <p className="col-start-2 min-w-0 text-[13px] leading-[1.7] text-slate-600 @[52rem]/paper:pr-6">{x.text}</p>
                      <div className="col-span-2 pl-7 @[52rem]/paper:col-span-1 @[52rem]/paper:pl-0">
                        <StepFigure scene={item} shot={shot} marks={x.mark ? [{ number: null, rect: x.mark }] : []} pictures={ctx.pictures} />
                      </div>
                    </div>
                  </li>
                );
              })}
            {st && <StepRow step={st} ctx={ctx} scene={item} />}
          </Fragment>
        ))}
      </ol>
    );
  }
  if (item.kind === "action") {
    return (
      <ol>
        <StepRow step={item.step} ctx={ctx} />
      </ol>
    );
  }
  if (item.kind === "stopped") {
    return (
      <p className="flex flex-wrap items-baseline gap-x-3 py-1.5 pl-7 text-[13px] leading-[1.7] text-slate-400" onContextMenu={ctx.menu(item.stepId)}>
        <span className="line-through">{item.text}</span>
        <span>{t.sheetView.stopped}</span>
        <button type="button" onClick={() => ctx.onStop(item.stepId, false)} className="font-medium text-primary hover:underline">
          {t.sheetView.start}
        </button>
      </p>
    );
  }
  if (item.kind === "quiet") {
    // Small steps of the work itself (a value kept, a line logged): said in one line, each opened like any step.
    const open = item.ids.find((id) => id && id === ctx.picked);
    return (
      <div className="py-1.5 pl-7">
        <p className="text-[13px] leading-[1.7] text-slate-600">
          {item.texts.map((text, i) => {
            const id = item.ids[i];
            return (
              <Fragment key={i}>
                {i > 0 && t.sheetView.and}
                {id ? (
                  <button type="button" data-step={id} onClick={() => ctx.onPick(id)} onContextMenu={ctx.menu(id)} className="text-left hover:text-ink">
                    <span className={id === ctx.picked ? "flow-chart-on text-ink" : ""}>{text}</span>
                  </button>
                ) : (
                  text
                )}
              </Fragment>
            );
          })}
        </p>
        {open && <Details stepId={open} ctx={ctx} />}
      </div>
    );
  }
  // What repeats, what runs only sometimes and what belongs together: a rule down the side, named at its top.
  // The step the part is of opens from its name, on the part that comes first (not again on 「そうでないとき」).
  const head = item.of && (!item.block || !["else", "catch", "finally"].includes(item.block)) ? item.of : null;
  // Only what the last run did there: that it did not come this way is not something to read on every line.
  const more = item.kind === "loop" && item.times ? t.manual.loopTimes(item.times) : item.kind === "branch" && item.taken ? t.manual.took : null;
  return (
    <div className={`my-2 ml-[5px] border-l-2 pl-[21px] ${item.kind === "loop" ? "border-[var(--manual-loop-line)]" : "border-slate-200"}`}>
      {(item.label || more) && (
        <p className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-[13.5px] text-slate-700">
          {head ? (
            <button type="button" data-step={head} onClick={() => ctx.onPick(head)} onContextMenu={ctx.menu(head)} className="text-left font-medium hover:text-ink">
              <span className={head === ctx.picked ? "flow-chart-on text-ink" : ""}>{item.label}</span>
            </button>
          ) : (
            <span className="font-medium">{item.label}</span>
          )}
          {more && <span className="text-[12px] text-slate-400">{more}</span>}
        </p>
      )}
      {head && head === ctx.picked && <Details stepId={head} ctx={ctx} />}
      <div>
        {item.items.map((c, i) => (
          <Item key={i} item={c} ctx={ctx} />
        ))}
        {item.items.length === 0 && item.of && item.block && <AddHere parentId={item.of} block={item.block} ctx={ctx} />}
      </div>
    </div>
  );
}

function ChapterView({ chapter, ctx }: { chapter: Chapter; ctx: RowCtx }) {
  // A chapter that is one loop or one branch is named by it: its name is not said twice.
  const only = chapter.items.length === 1 ? chapter.items[0] : undefined;
  const whole = only && "items" in only && only.label === chapter.title ? only : null;
  const of = whole?.of && (!whole.block || !["else", "catch", "finally"].includes(whole.block)) ? whole.of : undefined;
  return (
    <section data-chapter={chapter.number} className="mt-10 scroll-mt-6">
      {/* Named by a step of the flow, the heading opens that step as its name would lower down. */}
      <h2 className="mb-2" data-step={of} onClick={of ? () => ctx.onPick(of) : undefined} onContextMenu={of ? ctx.menu(of) : undefined} style={of ? { cursor: "pointer" } : undefined}>
        <SheetHeading n={chapter.role ? undefined : chapter.number} size="chapter" aside={whole?.kind === "loop" && whole.times ? t.manual.loopTimes(whole.times) : undefined}>
          {chapter.title}
        </SheetHeading>
      </h2>
      {of && of === ctx.picked && <Details stepId={of} ctx={ctx} />}
      {(whole?.items ?? chapter.items).map((item, i) => (
        <Item key={i} item={item} ctx={ctx} />
      ))}
      {whole && whole.items.length === 0 && whole.of && whole.block && <AddHere parentId={whole.of} block={whole.block} ctx={ctx} />}
    </section>
  );
}

/** The sheet written out as a manual: read as the manual reads it (what is switched off left out), with the version it is of. */
function Export({
  flow,
  defs,
  manifest,
  subflows,
  masks,
  drafts,
  when,
  onClose,
}: {
  flow: Flow;
  defs: ReadonlyMap<string, StepTypeDef>;
  manifest: ManualManifest | null;
  subflows: ReadonlyMap<string, Flow>;
  masks: Record<string, Mask>;
  drafts: Drafts;
  when: string[];
  onClose: () => void;
}) {
  const [published, setPublished] = useState<PublishedState | null>(null);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  useEffect(() => {
    let live = true;
    void api.publishedState(flow.id).then((p) => live && setPublished(p)).catch(() => {});
    void api.listVersions(flow.id).then((v) => live && setVersions(v)).catch(() => {});
    return () => {
      live = false;
    };
  }, [flow.id]);
  const doc = useMemo(() => buildManual(flow, defs, manifest, subflows, masks, drafts), [flow, defs, manifest, subflows, masks, drafts]);
  return <ExportDialog doc={doc} flowId={flow.id} made={madeLine(manifest)} shotAt={shotLine(manifest, doc)} edition={editionOf(published, versions, day)} when={when} masks={masks} onClose={onClose} />;
}

/** The last request to show a step that was answered: one is answered once, whichever sheet is up. */
let revealed = 0;

/** `onSheet`: asked from the chart, to read a step where its settings open (the sheet). */
export function SheetView({ mode, onSheet, onHistory }: { mode: "sheet" | "chart"; onSheet?: () => void; onHistory?: () => void }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const startRun = useStudio((s) => s.startRun);
  const select = useStudio((s) => s.select);
  const updateStep = useStudio((s) => s.updateStep);
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  const removeSelected = useStudio((s) => s.removeSelected);
  const moveSelected = useStudio((s) => s.moveSelected);
  const stepMenu = useStepMenu();
  const selection = useStudio((s) => s.selection);
  const running = useStudio((s) => isActive(s.run));
  const testing = useStudio((s) => s.stepTest?.running ?? false);
  const errors = useStudio((s) => s.validation?.issues.some((i) => i.severity === "error") ?? false);
  const revision = useStudio((s) => s.flow?.revision);
  const published = useStudio((s) => s.published);
  const [manifest, setManifest] = useState<ManualManifest | null>(null);
  const [masks, setMasks] = useState<Record<string, Mask>>({});
  const [drafts, setDrafts] = useState<Drafts>({});
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [masking, setMasking] = useState<ManualShot | null>(null);
  const [whole, setWhole] = useState<{ shot: ManualShot; marks: SceneMark[] } | null>(null);
  const [exporting, setExporting] = useState(false);
  const pending = usePendingReview();
  const run = useStudio(trailOf);
  const place = useStudio((s) => s.place);
  const approveAll = useStudio((s) => s.approveAll);
  const aiBusy = useFlowBusy();
  const todo = useRunGate((g) => (g.flowId === flow?.id ? g.todo : null));
  const subflows = useSubflows(flow);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const flowId = flow?.id;
  const latest = useLatestRun(flowId);
  const desk = useRef<HTMLDivElement>(null);

  // Read again when the flow changes (a changed step loses its old picture),
  // when a run of it ends and when a step tried alone ends.
  useEffect(() => {
    if (!flowId || running || testing) return;
    let live = true;
    void manualApi
      .get(flowId)
      .then((m) => {
        if (!live) return;
        setManifest(m.manifest ?? null);
        setMasks(m.masks ?? {});
        setDrafts(m.drafts ?? {});
      })
      .catch(() => {});
    void api
      .listSchedules()
      .then((list) => live && setSchedules(list.schedules.filter((s) => s.flowId === flowId && s.enabled)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [flowId, running, testing, revision]);

  const { urls, want } = usePictures(flowId, manifest?.runId);
  const doc = useMemo(() => (flow ? buildManual(flow, defs, manifest, subflows, masks, drafts, { stopped: true }) : null), [flow, defs, manifest, subflows, masks, drafts]);
  // The step the run is on is kept in sight.
  const follow = useStudio((s) => s.followRun);
  const live = run && isActive(run) && follow ? run : null;
  const at = live ? [...live.starts].reverse().find((x) => live.steps[x.stepId] === "running" || live.steps[x.stepId] === "paused")?.stepId : undefined;
  useEffect(() => {
    if (at) desk.current?.querySelector(`[data-step="${at}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [at]);
  // A link to a step (a log line, a result, a variable's use) and a step the AI just added are brought
  // into sight. A step inside a called flow is shown by the call that holds it.
  const reveal = useStudio((s) => s.reveal);
  useEffect(() => {
    if (!reveal || !doc || reveal.seq === revealed) return;
    const at = (id: string) => desk.current?.querySelector(`[data-step="${CSS.escape(id)}"]`);
    const row = mode === "sheet" ? (at(reveal.stepId) ?? (reveal.inside ? at(reveal.inside.split("/")[0] ?? "") : null)) : null;
    // Not on the paper yet (the flow with the new step is still to come): looked for again when it is.
    if (mode === "sheet" && !row) return;
    revealed = reveal.seq;
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [reveal, doc, mode]);
  // The chapter being read: the last one whose heading has passed the top of the desk.
  const [reading, setReading] = useState(1);
  useEffect(() => {
    const el = desk.current;
    if (!el || mode !== "sheet") return;
    const see = () => {
      const top = el.getBoundingClientRect().top + 140;
      let at = 1;
      for (const h of el.querySelectorAll<HTMLElement>("[data-chapter]")) if (h.getBoundingClientRect().top <= top) at = Number(h.dataset.chapter);
      setReading(at);
    };
    see();
    el.addEventListener("scroll", see, { passive: true });
    return () => el.removeEventListener("scroll", see);
  }, [doc, mode]);
  const numbers = useMemo(() => {
    const map = new Map<string, number>();
    const walk = (items: ManualItem[]) => {
      for (const i of items) {
        if (i.kind === "scene") for (const x of i.steps) if (x.callPath.length === 0) map.set(x.stepId, x.number);
        if (i.kind === "action" && i.step.callPath.length === 0) map.set(i.step.stepId, i.step.number);
        if ("items" in i) walk(i.items);
      }
    };
    for (const c of doc?.chapters ?? []) walk(c.items);
    return map;
  }, [doc]);
  const changes = useMemo(() => {
    const map = new Map<string, Change[]>();
    for (const entry of pending) {
      const added = new Set((entry.ops ?? []).flatMap((op) => (op.op === "addStep" && op.step.id ? [op.step.id] : [])));
      for (const id of touchedSteps(entry)) map.set(id, [...(map.get(id) ?? []), { entry, added: added.has(id) }]);
    }
    return map;
  }, [pending]);
  if (!flow || !doc) return null;

  const pictures: Pictures = { urls, want, masks, onWhole: (shot, marks) => setWhole({ shot, marks }), onMask: setMasking };
  const ctx: RowCtx = {
    pictures,
    picked: selection?.kind === "step" ? selection.stepId : null,
    changes,
    defs,
    run,
    stepOf: (id) => findStep(flow.steps ?? [], id) ?? undefined,
    onValue: (stepId, key, value) => void updateStep(stepId, { params: { [key]: value } }),
    onStop: (stepId, stop) => void updateStep(stepId, { disabled: stop }),
    onAdd: () => setPaletteOpen(true),
    onRemove: () => void removeSelected(),
    menu: (stepId) =>
      menuFor(() => {
        const step = findStep(flow.steps ?? [], stepId);
        if (!step) return [];
        select({ kind: "step", stepId });
        return stepMenu(step, { owner: flow.id });
      }),
    // Pressed again, the step folds back.
    onPick: (stepId) => select(selection?.kind === "step" && selection.stepId === stepId ? null : { kind: "step", stepId }),
    onMove: (delta) => void moveSelected(delta),
    onAddIn: (parentId, block) => {
      select({ kind: "slot", parentId, block });
      setPaletteOpen(true);
    },
  };
  const when = schedules.map((s) => describeWhen(s.when));
  const chart = mode === "chart";
  const noSteps = (flow.steps ?? []).length === 0;

  return (
    <div ref={desk} className="flow-chart absolute inset-0 overflow-auto px-5 py-7" data-sheet={mode}>
      <div className="mx-auto flex w-fit max-w-full items-start gap-6">
        {/* As a chart the paper is as wide as the chart, and never narrower than the sheet (so it cannot be measured against, and keeps the plain margins). */}
        <article className={`${PAPER} ${chart ? "w-fit min-w-[min(980px,calc(100cqw-40px))]" : "@container/paper w-[980px] max-w-full min-w-0"}`}>
          <header className="relative px-10 pt-12 @[52rem]/paper:pr-7 @[52rem]/paper:pl-[72px]">
            <Stripe className="top-0 h-[4px]" />
            <Head
              doc={doc}
              when={when}
              edition={editionOf(published, [], day)}
              manifest={manifest}
              latest={latest}
              short={chart}
              actions={
                chart ? null : (
                  <LastRun blocked={running ? "" : aiBusy ? t.toolbar.aiBusy : noSteps ? t.sheetView.noSteps : errors ? t.todos.runBlocked : todo ? t.todos.runFirst(todo) : null} empty={noSteps} onRun={() => void startRun()} onExport={() => setExporting(true)} onHistory={onHistory} />
                )
              }
            />
          </header>
          {chart ? (
            noSteps ? (
              <p className="px-10 pt-2 pb-12 text-[13px] text-slate-500">{t.sheetView.noStepsChart}</p>
            ) : (
              <ChartBody numbers={numbers} run={run} onOpen={onSheet} />
            )
          ) : (
            <div className="flow-root px-10 pb-16 @[52rem]/paper:pr-7 @[52rem]/paper:pl-[72px]">
              <div className={MARGIN}>
                {doc.chapters.map((c) => (
                  <ChapterView key={c.number} chapter={c} ctx={ctx} />
                ))}
                {(flow.steps ?? []).length === 0 && <AddHere parentId={null} block={null} ctx={ctx} first />}
              </div>
            </div>
          )}
        </article>
        {/* The chapters stand on the right of the paper: the left of the work is where the AI is asked. */}
        {!chart && doc.chapters.length > 1 && (
          <nav className="sticky top-0 hidden w-[176px] shrink-0 pt-11 text-[12.5px] leading-[1.5] @[76rem]:block">
            {/* The chapters down a ruled line, as the paper rules its own head: the one being read is in ink, with the line under it drawn dark. */}
            <p className="mb-3 border-b border-slate-300 pb-2 text-[11.5px] font-medium tracking-[0.08em] text-slate-500">{t.manual.contents}</p>
            <ol className="border-l border-slate-300">
              {doc.chapters.map((c) => {
                const here = c.number === reading;
                return (
                  <li key={c.number}>
                    <button
                      type="button"
                      aria-current={here ? "true" : undefined}
                      onClick={() => desk.current?.querySelector(`[data-chapter="${c.number}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      className={`-ml-px grid w-full grid-cols-[20px_minmax(0,1fr)] border-l-2 py-[5px] pl-3 text-left ${here ? "border-ink font-medium text-ink" : "border-transparent text-slate-500 hover:text-ink"}`}
                    >
                      <span className={`tabular-nums ${here ? "" : "text-slate-400"}`}>{c.role ? "" : c.number}</span>
                      <span>
                        {c.title}
                        {/* Something in it waits to be looked at. */}
                        {stepIds(c.items).some((id) => changes.has(id)) && <span aria-hidden="true" className="ml-1.5 inline-block size-[6px] rounded-full bg-primary align-middle" />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
      </div>
      {/* What waits to be looked at, counted once at the foot of the desk; on the review desk its own foot says it. */}
      {place === "flows" && pending.length > 0 && (
        <div className="pointer-events-none sticky bottom-0 z-10 mt-6 flex justify-center">
          <div className={`pointer-events-auto flex items-center gap-4 rounded-[6px] bg-sheet py-2 pl-4 ${aiBusy ? "pr-4" : "pr-2"} text-[13px] text-ink shadow-[0_0_0_1px_var(--color-slate-300),0_8px_24px_-8px_rgb(16_24_40/0.25)]`}>
            <span className="flex items-center gap-2">
              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" className="text-primary" />
              {aiBusy ? t.sheetView.aiWorking : t.sheetView.waiting(pending.length)}
            </span>
            {/* Not while the AI is still making the flow: what is on the sheet is not all of it yet. */}
            {!aiBusy && (
              <button type="button" onClick={() => void approveAll()} className="rounded-[5px] bg-primary px-3 py-1.5 font-medium text-on-primary hover:bg-primary-hover">
                {t.approveAll}
              </button>
            )}
          </div>
        </div>
      )}
      {masking && (
        <MaskEditor
          shot={masking}
          url={urls[masking.file]}
          mask={masks[masking.key]}
          onCancel={() => setMasking(null)}
          onSave={(mask) => {
            const next = { ...masks, [masking.key]: mask };
            setMasks(next);
            void manualApi.saveMasks(flow.id, next).catch(() => {});
            setMasking(null);
          }}
        />
      )}
      {exporting && <Export flow={flow} defs={defs} manifest={manifest} subflows={subflows} masks={masks} drafts={drafts} when={when} onClose={() => setExporting(false)} />}
      {whole && <WholeShot shot={whole.shot} marks={whole.marks} url={urls[whole.shot.file]} mask={masks[whole.shot.key]} onClose={() => setWhole(null)} />}
    </div>
  );
}
