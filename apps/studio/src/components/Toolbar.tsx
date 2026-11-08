import { FolderOutput, PanelRight, Search } from "lucide-react";
import { useStudio } from "../context";
import { useProjectMaybe } from "../project";
import { t } from "../lib/i18n";
import type { ReviewView } from "../lib/reviewView";
import { authorIssues, unsetIssues } from "../lib/todos";
import { useTodos, useUnsetCount } from "../lib/useTodos";
import { RecordButton } from "./RecordButton";
import { RunStatus } from "./StatusBar";

function DockButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const { label, children, className, ...rest } = props;
  return (
    <button
      type="button"
      title={label}
      className={`grid h-8 min-w-8 place-items-center rounded-md px-2 text-sm text-slate-700 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
    <path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5Z" fill="currentColor" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
    <path d="m2.5 6.3 2.2 2.2 4.8-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export type View = "story" | "flow" | "variables";

/**
 * Flow chart, procedure or variables: three ways to read the same flow. On
 * the review desk the AI's report comes first, as one more way to read it.
 */
function ViewSwitch({ view, onChange }: { view: ReviewView; onChange: (view: ReviewView) => void }) {
  const place = useStudio((s) => s.place);
  const options: [ReviewView, string][] = [
    ...(place === "review" ? [["report", t.desk.reportView] as [ReviewView, string]] : []),
    ["flow", t.viewFlow],
    ["story", t.viewStory],
    ["variables", t.vars.table.view],
  ];
  return (
    <div className="flex h-7 items-center rounded-lg bg-slate-100 p-0.5 text-[12px]" role="radiogroup">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={view === key}
          onClick={() => onChange(key)}
          className={`h-6 rounded-md px-2.5 ${view === key ? "bg-sheet font-semibold text-ink shadow-sheet" : "text-slate-500 hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Opens the search over the chart (also Ctrl+F). */
export function SearchButton() {
  const setOpen = useStudio((s) => s.setSearchOpen);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={t.search.placeholder}
      aria-label={t.search.label}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-sheet/95 text-slate-600 shadow-raised backdrop-blur hover:text-ink"
    >
      <Search size={14} aria-hidden="true" />
    </button>
  );
}

/** Opens the outline, which unfolds from the canvas corner this button sits in. */
export function OutlineButton() {
  const setOpen = useStudio((s) => s.setOutlineOpen);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={t.outline.title}
      className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-sheet/95 px-2.5 text-[12px] text-slate-600 shadow-raised backdrop-blur hover:text-ink"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 2.5h10M3 6h8M3 9.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      {t.outline.toggle}
    </button>
  );
}

/**
 * The open flow in the title bar, after the workspace it is stored in:
 * its name, its revision (opens History) and whether it is sound (opens
 * Issues). The window holds one flow, so the window's bar names it.
 * Beside the name, the flow's folder (its input, settings, templates and
 * output) opens in Explorer: the flow is that folder.
 */
export function FlowTitle() {
  const flow = useStudio((s) => s.flow);
  const validation = useStudio((s) => s.validation);
  const setBottom = useStudio((s) => s.setBottom);
  const setHistoryOpen = useStudio((s) => s.setHistoryOpen);
  const published = useStudio((s) => s.published);
  const todos = useTodos().length;
  const unset = useUnsetCount();
  const open = useProjectMaybe((p) => p.open, null);
  if (!flow) return null;
  // A part to pick is counted as a to-do, not as an error.
  const errors = authorIssues(validation).length;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-[5em] truncate text-[13px] font-bold" title={flow.name}>
        {flow.name}
      </span>
      {open && (
        <button
          type="button"
          onClick={() => void open("", false)}
          title={t.project.openFolder}
          aria-label={t.project.openFolder}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-ink"
        >
          <FolderOutput size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
      {/* The revision opens how the flow got here: its record and versions. */}
      <button
        type="button"
        onClick={() => setHistoryOpen(true)}
        title={`${t.shell.historyTitle}（${t.revisionCount(flow.revision ?? 0)}）`}
        className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-100 px-1.5 text-[11px] text-slate-500 hover:bg-slate-200 hover:text-ink"
      >
        {t.revision}
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="m1.5 3 2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {/* What unattended runs execute; published from the history's versions. */}
      <button
        type="button"
        onClick={() => setHistoryOpen(true, "versions")}
        title={published ? t.publishedLabel(published.version, published.name) : t.publishedHint}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] ${
          published && !published.matchesCurrent
            ? "bg-shu-50 text-shu-600 hover:bg-shu-100"
            : published
              ? "bg-moegi-100 text-moegi-500 hover:bg-slate-200"
              : "text-slate-400 hover:bg-slate-100 hover:text-ink"
        }`}
      >
        {published ? t.publishedBadge(published.version) : t.notPublishedBadge}
      </button>
      <button
        type="button"
        onClick={() => setBottom("issues")}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium ${
          errors ? "bg-shu-50 text-shu-600 hover:bg-shu-100" : todos || unset ? "bg-amber-50 text-amber-700 hover:bg-amber-100" : "text-moegi-500 hover:bg-slate-100"
        }`}
        title={t.toolbar.issuesTitle}
      >
        {errors ? (
          <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-shu-500 text-[9px] font-bold text-white">!</span>
        ) : todos || unset ? (
          <span className="h-3 w-3 rounded-full border-[1.5px] border-dashed border-amber-600" />
        ) : (
          <CheckIcon />
        )}
        <span className="@max-[920px]/title:hidden">
          {[errors ? t.toolbar.errors(errors) : "", unset ? t.toolbar.unset(unset) : "", todos ? t.todos.chip(todos) : ""].filter(Boolean).join(" · ") || t.toolbar.valid}
        </span>
      </button>
      <span className="flex h-6 shrink-0 items-center rounded-md text-[12px] text-slate-500 @max-[920px]/title:hidden">
        <RunStatus />
      </span>
    </div>
  );
}

/**
 * What to do with the open flow, at the right of the title bar: how to
 * show it, then running it, the one filled button, at the very end.
 */
export function FlowActions({ view, onView }: { view: ReviewView; onView: (view: ReviewView) => void }) {
  const flow = useStudio((s) => s.flow);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
  const startRun = useStudio((s) => s.startRun);
  const stopRun = useStudio((s) => s.stopRun);
  const followRun = useStudio((s) => s.followRun);
  const setFollowRun = useStudio((s) => s.setFollowRun);
  const debug = useStudio((s) => s.debug);

  if (!flow) return null;
  const errors = validation?.issues.filter((i) => i.severity === "error").length ?? 0;
  const running = run?.status === "running" || run?.status === "paused";
  const paused = run?.status === "paused";

  return (
    <div className="flex shrink-0 items-center gap-2">
      <ViewSwitch view={view} onChange={onView} />
      <span className="mx-1 h-5 w-px bg-slate-200" />
      {running ? (
        <div className="flex h-7 items-center overflow-hidden rounded-lg border border-slate-300 bg-sheet text-[13px]">
          <span className="flex items-center gap-2 px-3 font-medium text-ink">
            <span className={`h-2 w-2 rounded-full ${paused ? (run?.pause?.reason === "error" ? "bg-shu-500" : "bg-mizu-500") : "bg-accent-500 animate-pulse"}`} />
            {paused ? t.status.paused : t.status.running}
          </span>
          {!paused && (
            <button
              type="button"
              onClick={() => void debug({ action: "pause" })}
              title={t.toolbar.pauseTitle}
              className="flex h-full items-center gap-1 border-l border-slate-300 px-2.5 text-[12px] text-slate-600 hover:bg-slate-50"
            >
              ❚❚ {t.runMsg.paused}
            </button>
          )}
          <button
            type="button"
            onClick={() => setFollowRun(!followRun)}
            title={followRun ? t.toolbar.followingTitle : t.toolbar.followTitle}
            className={`flex h-full items-center gap-1 border-l border-slate-300 px-2.5 text-[12px] ${followRun ? "bg-brand-50 font-semibold text-brand-700" : "text-slate-500 hover:bg-slate-50"}`}
          >
            {followRun ? "◉" : "○"} {t.toolbar.follow}
          </button>
          <button
            type="button"
            onClick={() => stopRun()}
            title={run?.stopping ? t.stopAgainTitle : `${t.stop} (Shift+F5)`}
            className="flex h-full items-center gap-1.5 border-l border-slate-300 px-3 font-semibold text-shu-600 hover:bg-shu-50"
          >
            <span className={`h-2.5 w-2.5 rounded-sm bg-shu-500 ${run?.stopping ? "animate-pulse" : ""}`} />
            {run?.stopping ? t.stopping : t.stop}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => startRun({ step: true })}
            disabled={errors > 0}
            title={t.toolbar.stepRunTitle}
            className="flex h-7 items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 disabled:text-slate-300"
          >
            <span className="@max-[920px]/title:hidden">{t.toolbar.stepRun}</span>
            <span className="hidden @max-[920px]/title:inline" aria-hidden="true">
              ⇥
            </span>
          </button>
          <button
            type="button"
            onClick={() => startRun()}
            disabled={errors > 0}
            title={errors > 0 ? (authorIssues(validation).length > 0 ? t.toolbar.fixErrors : unsetIssues(validation).length > 0 ? t.toolbar.fillUnset : t.todos.runBlocked) : `${t.run} (F5)`}
            className="group flex h-7 items-center gap-2 rounded-lg bg-primary pr-1.5 pl-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-400"
          >
            <PlayIcon />
            {t.run}
            <kbd className="rounded-sm bg-on-primary/15 px-1 font-sans text-[10px] font-normal opacity-80">F5</kbd>
          </button>
        </>
      )}
      <PaneToggle view={view} />
    </div>
  );
}

/**
 * Floating dock over the canvas, for the whole chart: add a step, record
 * steps, undo, redo.
 * What acts on one step sits on that step (StepTools on the chart).
 */
export function CanvasDock() {
  const flow = useStudio((s) => s.flow);
  const canUndo = useStudio((s) => s.canUndo);
  const canRedo = useStudio((s) => s.canRedo);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  const inside = useStudio((s) => s.dive.length > 0);

  // Inside a call the chart shows another flow: editing tools would act on the open one.
  if (!flow || inside) return null;

  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-lg whitespace-nowrap border border-slate-200 bg-sheet/95 p-1 shadow-raised backdrop-blur">
      <button
        type="button"
        onClick={(e) => setPaletteOpen(true, null, e.currentTarget.getBoundingClientRect())}
        className="flex items-center gap-2 rounded-md py-1.5 pr-2 pl-2.5 text-sm font-medium text-ink hover:bg-slate-100"
      >
        ＋ <span className="@max-[560px]:hidden">{t.addStep}</span>
        <kbd className="rounded-sm border border-slate-200 px-1 font-sans text-[10px] text-slate-500 @max-[560px]:hidden">{t.shortcut}</kbd>
      </button>
      <RecordButton />
      <span className="mx-1 h-5 w-px bg-slate-200" />
      <DockButton label={`${t.undo} (Ctrl+Z)`} onClick={() => undo()} disabled={!canUndo}>
        ↶
      </DockButton>
      <DockButton label={`${t.redo} (Ctrl+Y)`} onClick={() => redo()} disabled={!canRedo}>
        ↷
      </DockButton>
    </div>
  );
}

/**
 * Shows or closes the right pane, at the right end of the bar as Linear and VS
 * Code keep theirs. Picking a node opens the pane by itself; this keeps the
 * flow's settings open with nothing picked, or closes the pane for the room.
 * The 変数 table edits in place and has no pane, so it has no button.
 */
function PaneToggle({ view }: { view: ReviewView }) {
  const place = useStudio((s) => s.place);
  const open = useStudio((s) => s.inspectorOpen || s.selection?.kind === "step" || s.selection?.kind === "part");
  const setInspectorOpen = useStudio((s) => s.setInspectorOpen);
  const showFlowProps = useStudio((s) => s.showFlowProps);
  if ((place !== "flows" && place !== "review") || view === "variables" || view === "report") return null;
  return (
    <button
      type="button"
      onClick={() => (open ? setInspectorOpen(false) : showFlowProps())}
      aria-pressed={open}
      title={open ? t.shell.paneHide : t.shell.paneShow}
      aria-label={open ? t.shell.paneHide : t.shell.paneShow}
      className={`grid h-7 w-7 place-items-center rounded-md ${open ? "bg-slate-100 text-ink" : "text-slate-500 hover:bg-slate-100 hover:text-ink"}`}
    >
      <PanelRight size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
