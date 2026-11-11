// The flow as one sheet of paper: what it is for and what it works with at
// the top, then its work in order, in sentences, with the screens it touches
// in the margin. Read as a chart, the same paper keeps its heading and shows
// the chart (components/chart/ChartBody.tsx) under it.
import { ArrowDown, ArrowUp, Check, CircleCheck, CirclePause, CircleX, Clock, Download, EyeOff, FileInput, FileOutput, FileText, KeyRound, type LucideIcon, Play, Plus, Repeat, Settings2, Sparkles, Split, Trash2, TriangleAlert } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, manualApi, type ScheduleView } from "../../lib/api";
import { useStudio } from "../../context";
import { locale, t } from "../../lib/i18n";
import { buildManual, type Chapter, type Drafts, type ManualDoc, type ManualItem, type ManualManifest, type ManualShot, type ManualStep, type Mask, maskStale, type Scene, editionOf } from "../../lib/manual";
import { sceneMarks } from "../../lib/manualExport";
import { describeWhen } from "../../lib/schedule";
import { brief, type Part, paramShown, plain } from "../../lib/sentence";
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
import { useStepMenu } from "../menus";
import { ChartBody } from "../chart/ChartBody";
import { StepInspector } from "../inspector/StepInspector";
import { ExportDialog, MaskEditor, type Pictures, ShotFrame, WholeShot, day, madeLine, shotLine, usePictures, useSubflows } from "./pictures";
import { SheetHeading } from "../SheetHeading";
import { PAPER } from "./paper";

const CHIP = "mx-0.5 rounded-[4px] border border-slate-200 bg-paper px-1.5 py-px text-[13px] text-ink";

/** A value in a sentence that is written out in full: pressed, it is changed where it stands. */
function Entry({ shown, value, onChange }: { shown: string; value: string | number; onChange: (next: string | number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <button type="button" title={t.sheetView.change} onClick={() => setDraft(String(value))} className={`${CHIP} cursor-text leading-[1.45] hover:border-slate-400`}>
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
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
      style={{ width: `calc(${Math.max(4, [...draft].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1.1), 0))}ch + 16px)` }}
      className={`${CHIP} max-w-full border-primary! leading-[1.45] outline-none`}
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
          const words = (
            <>
              {cut.text}…<span className="ml-1.5 text-[12px] text-slate-500">{t.sheetView.chars(cut.length)}</span>
            </>
          );
          return onOpen ? (
            <button key={i} type="button" title={t.sheetView.openLong} onClick={onOpen} className={`${CHIP} leading-[1.45] hover:border-slate-400`}>
              {words}
            </button>
          ) : (
            <span key={i} className={CHIP}>
              {words}
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

function Value({ icon: Icon, children }: { icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-slate-200 bg-paper px-1.5 py-px text-[13px] text-ink">
      {Icon && <Icon size={12} strokeWidth={1.75} aria-hidden="true" className="text-slate-500" />}
      {children}
    </span>
  );
}

/** What the flow takes in, gives back, runs on and logs in with: only the rows it has something to say on. */
/** What a part of the sheet does, step by step, in the steps' own names. */
function texts(items: ManualItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "scene" ? item.steps.map((s) => s.text) : item.kind === "action" ? [item.step.text] : item.kind === "quiet" ? item.texts : item.kind === "stopped" ? [] : texts(item.items),
  );
}

function Facts({ doc, when }: { doc: ManualDoc; when: string[] }) {
  const w = t.sheetView;
  const failure = doc.chapters.filter((c) => c.role === "failure").flatMap((c) => texts(c.items));
  const rows: { icon: LucideIcon; label: string; values: string[]; plain: string[]; mark?: LucideIcon }[] = [
    { icon: FileInput, label: w.input, values: doc.uses.inputFiles, plain: doc.inputs },
    { icon: FileText, label: t.project.shelves.templates ?? "", values: doc.uses.templates, plain: [] },
    { icon: Settings2, label: t.project.shelves.config ?? "", values: doc.uses.config, plain: [] },
    { icon: FileOutput, label: w.output, values: doc.uses.outputFiles, plain: doc.outputs },
    { icon: Clock, label: w.schedule, values: when, plain: [] },
    { icon: KeyRound, label: w.secrets, values: doc.uses.logins, plain: [], mark: KeyRound },
    // What is done when the work fails is a part of the sheet (its last pages): said here in a line.
    { icon: TriangleAlert, label: w.onFailure, values: [], plain: failure },
  ].filter((r) => r.values.length + r.plain.length > 0);
  if (rows.length === 0) return null;
  return (
    <dl className="mt-6 grid grid-cols-[124px_minmax(0,1fr)] gap-x-4 gap-y-3 border-y border-slate-200 py-5 text-[14px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="flex items-center gap-2 self-start pt-px text-slate-500">
            <r.icon size={14} strokeWidth={1.75} aria-hidden="true" />
            {r.label}
          </dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-ink">
            {r.values.map((v) => (
              <Value key={v} icon={r.mark}>
                {v}
              </Value>
            ))}
            {r.plain.length > 0 && <span>{r.plain.join(t.sheetView.and)}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The last run, and the way to run again: said once, beside the heading. */
function LastRun({ manifest, running, onRun, onExport }: { manifest: ManualManifest | null; running: boolean; onRun: () => void; onExport: () => void }) {
  const w = t.sheetView;
  const at = manifest
    ? new Date(manifest.startedAt).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div className="text-[12.5px] leading-[1.7] text-slate-500">
      {at ? (
        <p className="flex items-center gap-1.5">
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-moegi-600" />
          <b className="font-semibold text-ink">{w.lastRun}</b>
          <span className="tabular-nums">{at}</span>
        </p>
      ) : (
        <p>{w.noRun}</p>
      )}
      <button type="button" disabled={running} onClick={onRun} className="mt-0.5 inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50">
        <Play size={12} strokeWidth={2} aria-hidden="true" />
        {w.run}
      </button>
      {/* The sheet as a file to hand to someone: the manual, with its pictures. */}
      <button type="button" onClick={onExport} className="mt-0.5 ml-4 inline-flex items-center gap-1 text-slate-600 hover:text-ink hover:underline">
        <Download size={12} strokeWidth={1.75} aria-hidden="true" />
        {t.manual.export}
      </button>
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
  const { entry, added } = change;
  const blocker = revertBlocker(entry, history);
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
          <button type="button" onClick={() => approve(entry.revision)} className="font-medium text-primary hover:underline">
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

/** The changes that wait on these steps, each in the margin. */
function ChangeNotes({ steps, ctx }: { steps: ManualStep[]; ctx: RowCtx }) {
  return (
    <>
      {steps.flatMap((step) =>
        step.callPath.length > 0
          ? []
          : (ctx.changes.get(step.stepId) ?? []).map((c) => (
              <Aside key={`${step.key}:${c.entry.revision}`}>
                <ChangeNote change={c} step={step} defs={ctx.defs} />
              </Aside>
            )),
      )}
    </>
  );
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

/** `notes`: false on a screen's steps, whose changes are said together before the screen's picture. */
function StepRow({ step, ctx, notes = true }: { step: ManualStep; ctx: RowCtx; notes?: boolean }) {
  const picked = ctx.picked === step.stepId;
  const onPick = ctx.onPick;
  const own = step.callPath.length === 0 ? ctx.stepOf(step.stepId) : undefined;
  const state = own ? ctx.run?.steps[step.stepId] : undefined;
  const error = ctx.run?.pause?.error ?? ctx.run?.failure;
  const failed = own && state === "failed" && error && (!error.stepId || error.stepId === step.stepId) ? errorLine(error, own) : null;
  return (
    <li className="scroll-my-24 py-2.5" data-step={own ? step.stepId : undefined} onContextMenu={own ? ctx.menu(step.stepId) : undefined}>
      {notes && <ChangeNotes steps={[step]} ctx={ctx} />}
      <div className="grid grid-cols-[28px_minmax(0,1fr)]">
      <span className="pt-[3px] text-[12px] text-slate-400 tabular-nums">{step.number}</span>
      <div className="min-w-0">
        <button type="button" onClick={() => onPick(step.stepId)} className={`text-left text-[15px] leading-[1.6] text-ink ${step.how ? "font-semibold" : ""}`}>
          {/* The step the run is on is under the highlighter, as the one picked is. */}
          <span className={picked || state === "running" ? "flow-chart-on" : ""}>{step.text}</span>
          {state && state !== "running" && state !== "skipped" && <RunMark state={state} />}
        </button>
        {failed && <p className="mt-0.5 text-[13px] leading-[1.7] text-shu-600">{failed}</p>}
        {step.how && plain(step.how) !== step.text && (
          <p className="mt-0.5 text-[14px] leading-[1.8] text-slate-700">
            <Words parts={step.how} step={own} onValue={(key, value) => ctx.onValue(step.stepId, key, value)} onOpen={() => (picked ? undefined : onPick(step.stepId))} />
          </p>
        )}
        {step.note && <p className="mt-1 text-[12.5px] leading-[1.7] text-slate-500">{step.note}</p>}
        {/* One level deeper: everything the step is set to, where it is said. A step of a called flow is changed in that flow. */}
        {picked && step.callPath.length === 0 && <Details stepId={step.stepId} ctx={ctx} />}
      </div>
      </div>
    </li>
  );
}

/** A screen's picture in the margin, with what it is under it. */
function Figure({ scene, pictures }: { scene: Scene; pictures: Pictures }) {
  const shot = scene.shot;
  if (!shot) return null;
  const mask = pictures.masks[shot.key];
  return (
    <figure className="group/fig">
      {/* The whole picture opens from the picture itself: there is no room on it for a button. */}
      <div
        role="button"
        tabIndex={0}
        title={t.manual.whole}
        onClick={() => pictures.onWhole(shot)}
        onKeyDown={(e) => e.key === "Enter" && pictures.onWhole(shot)}
        className="cursor-zoom-in overflow-hidden rounded-[4px] border border-slate-200"
      >
        <ShotFrame shot={shot} marks={sceneMarks(scene)} ctx={pictures} />
      </div>
      <figcaption className="mt-1.5 flex items-start gap-2 text-[12px] leading-[1.5] text-slate-500">
        <span className="min-w-0 flex-1">
          {t.manual.screenOf(scene.title, scene.app === "desktop")}
          {shot.draft && `（${t.manual.draft}）`}
          {maskStale(mask, shot) && <span className="block text-shu-600">{t.manual.maskStale}</span>}
        </span>
        <button
          type="button"
          title={t.manual.hideTitle}
          onClick={() => pictures.onMask(shot)}
          className="inline-flex shrink-0 items-center gap-1 text-slate-500 opacity-0 group-focus-within/fig:opacity-100 group-hover/fig:opacity-100 hover:text-ink"
        >
          <EyeOff size={12} strokeWidth={1.75} aria-hidden="true" />
          {t.manual.hide}
          {mask && mask.boxes.length > 0 ? ` ${mask.boxes.length}` : ""}
        </button>
      </figcaption>
    </figure>
  );
}

/** The width of the margin beside the words, and the room between the two. */
const MARGIN = "@[52rem]/paper:mr-[298px]";

/**
 * What goes with the words, in the margin beside them: hung from where it is
 * said, and stacked down the margin when the words beside it are short, so a
 * tall picture never pushes the next step down. On a narrow paper it lies
 * between the lines instead.
 */
function Aside({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 @[52rem]/paper:clear-right @[52rem]/paper:float-right @[52rem]/paper:mt-2.5 @[52rem]/paper:-mr-[298px] @[52rem]/paper:w-[250px]">{children}</div>;
}

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
      <>
        <ChangeNotes steps={item.steps} ctx={ctx} />
        {item.shot && (
          <Aside>
            <Figure scene={item} pictures={ctx.pictures} />
          </Aside>
        )}
        <ol>
          {[...item.steps, null].map((s, i) => (
            <li key={s?.key ?? "end"} className="contents">
              {item.waits
                .filter((x) => x.at === i)
                .map((x, k) => (
                  <p key={k} className="flex items-start gap-1.5 py-1 pl-7 text-[12.5px] leading-[1.7] text-slate-500">
                    <Clock size={12} strokeWidth={1.75} aria-hidden="true" className="mt-[5px] shrink-0" />
                    {x.text}
                  </p>
                ))}
              {s && (
                <ol>
                  <StepRow step={s} ctx={ctx} notes={false} />
                </ol>
              )}
            </li>
          ))}
        </ol>
      </>
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
        <p className="text-[13px] leading-[1.7] text-slate-500">
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
  const Icon = item.kind === "loop" ? Repeat : item.kind === "branch" ? Split : null;
  // The step the part is of opens from its name, on the part that comes first (not again on 「そうでないとき」).
  const head = item.of && (!item.block || !["else", "catch", "finally"].includes(item.block)) ? item.of : null;
  const more = item.kind === "loop" && item.times !== null ? t.manual.loopTimes(item.times) : item.kind === "branch" && item.taken !== null ? (item.taken ? t.manual.took : t.manual.notTaken) : null;
  return (
    <div className={`my-2 ml-[5px] border-l-2 pl-[21px] ${item.kind === "loop" ? "border-[var(--manual-loop-line)]" : "border-slate-200"}`}>
      {(item.label || more) && (
        <p className="flex flex-wrap items-center gap-x-2 py-1.5 text-[13px] text-slate-600">
          {Icon && <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-slate-500" />}
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
      <div className={item.kind === "branch" && item.taken === false ? "opacity-70" : ""}>
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
        <SheetHeading n={chapter.role ? undefined : chapter.number} size="chapter" aside={whole?.kind === "loop" && whole.times !== null ? t.manual.loopTimes(whole.times) : undefined}>
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
export function SheetView({ mode, onSheet }: { mode: "sheet" | "chart"; onSheet?: () => void }) {
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
  const revision = useStudio((s) => s.flow?.revision);
  const [manifest, setManifest] = useState<ManualManifest | null>(null);
  const [masks, setMasks] = useState<Record<string, Mask>>({});
  const [drafts, setDrafts] = useState<Drafts>({});
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [masking, setMasking] = useState<ManualShot | null>(null);
  const [whole, setWhole] = useState<ManualShot | null>(null);
  const [exporting, setExporting] = useState(false);
  const pending = usePendingReview();
  const run = useStudio(trailOf);
  const place = useStudio((s) => s.place);
  const approveAll = useStudio((s) => s.approveAll);
  const subflows = useSubflows(flow);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const flowId = flow?.id;
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

  const pictures: Pictures = { urls, want, masks, onWhole: setWhole, onMask: setMasking };
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

  return (
    <div ref={desk} className="flow-chart absolute inset-0 overflow-auto px-5 py-7" data-sheet={mode}>
      <div className="mx-auto flex w-fit max-w-full items-start gap-6">
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
        {/* As a chart the paper is as wide as the chart (so it cannot be measured against, and keeps the plain margins). */}
        <article className={`min-w-0 ${PAPER} ${chart ? "w-fit" : "@container/paper w-[980px] max-w-full"}`}>
          <header className={`flow-root px-10 pt-11 @[52rem]/paper:pr-7 @[52rem]/paper:pl-[72px]`}>
            <div className={MARGIN}>
              {!chart && (
                <Aside>
                  <LastRun manifest={manifest} running={running} onRun={() => void startRun()} onExport={() => setExporting(true)} />
                </Aside>
              )}
              <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.01em] text-ink">{doc.title}</h1>
              {doc.description && <p className="mt-2 text-[14px] leading-relaxed text-slate-600">{doc.description}</p>}
              <Facts doc={doc} when={when} />
            </div>
          </header>
          {chart ? (
            <ChartBody numbers={numbers} run={run} onOpen={onSheet} />
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
      </div>
      {/* What waits to be looked at, counted once at the foot of the desk; on the review desk its own foot says it. */}
      {place === "flows" && pending.length > 0 && (
        <div className="pointer-events-none sticky bottom-0 z-10 mt-6 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-4 rounded-[6px] bg-sheet py-2 pr-2 pl-4 text-[13px] text-ink shadow-[0_0_0_1px_var(--color-slate-300),0_8px_24px_-8px_rgb(16_24_40/0.25)]">
            <span className="flex items-center gap-2">
              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" className="text-primary" />
              {t.sheetView.waiting(pending.length)}
            </span>
            <button type="button" onClick={() => void approveAll()} className="rounded-[5px] bg-primary px-3 py-1.5 font-medium text-on-primary hover:bg-primary-hover">
              {t.approveAll}
            </button>
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
      {whole && <WholeShot shot={whole} url={urls[whole.file]} mask={masks[whole.key]} onClose={() => setWhole(null)} />}
    </div>
  );
}
