import { ArrowLeft, CircleCheck, CircleDashed, Ellipsis, FolderOutput, History, Locate, LocateFixed, Pause, Redo2, Files, Send, Settings2, StepForward, Undo2, type LucideIcon } from "lucide-react";
import { openMenu } from "../lib/contextMenu";
import { FlowSwitch } from "./FlowSwitch";

const CHIP = "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px]";
import { useStudio } from "../context";
import { useProjectMaybe } from "../project";
import { t } from "../lib/i18n";
import type { ReviewView } from "../lib/reviewView";
import { authorIssues, unsetIssues } from "../lib/todos";
import { useRunGateSync } from "../lib/runGate";
import { useTodos, useUnsetCount } from "../lib/useTodos";
import { useFlowBusy } from "../lib/useFlowBusy";
import { RunStatus } from "./StatusBar";

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

export type View = "story" | "chart" | "variables" | "result";

/**
 * The sheet or its chart: the two ways to read a flow. On the review desk
 * the AI's report comes first, as one more. The other ways to see it (the
 * board it is put together on, its variables, its last run) open from the
 * menu beside the switch, and the one that is open is named here after the
 * two, so the switch always says what is shown.
 */
function ViewSwitch({ view, onChange }: { view: ReviewView; onChange: (view: ReviewView) => void }) {
  const place = useStudio((s) => s.place);
  // Every way to see the flow is in the switch, so none of them has to be found in a menu.
  const options: [ReviewView, string][] = [
    ...(place === "review" ? [["report", t.desk.reportView] as [ReviewView, string]] : []),
    ["story", t.viewStory],
    ["chart", t.viewChart],
    ["variables", t.vars.table.view],
    // The runs of the flow as it is kept; on the review desk the AI's own trial run is in the report.
    ...(place === "flows" ? [["result", t.result.view] as [ReviewView, string]] : []),
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
  const place = useStudio((s) => s.place);
  const setPlace = useStudio((s) => s.setPlace);
  if (!flow) return null;
  // A part to pick is counted as a to-do, not as an error.
  const errors = authorIssues(validation).length;
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {/* Where it was opened from, as Linear's header starts with the team: back there in one click. */}
      <button
        type="button"
        onClick={() => setPlace("library")}
        className="shrink-0 rounded-md px-1 text-[13px] text-slate-500 hover:bg-slate-100 hover:text-ink @max-[760px]/title:hidden"
      >
        {t.flows}
      </button>
      <span className="shrink-0 text-[13px] text-slate-300 @max-[760px]/title:hidden" aria-hidden="true">
        /
      </span>
      <FlowSwitch />
      {/* On the review desk: said beside the flow's name, with the way back to the flow's own sheet next to it. */}
      {place === "review" && (
        <>
          <span className="shrink-0 rounded-md bg-shu-50 px-1.5 py-0.5 text-[11.5px] font-medium text-shu-600">{t.awaitingReview}</span>
          <button type="button" onClick={() => setPlace("flows")} className={`${CHIP} text-slate-600 hover:bg-slate-100 hover:text-ink`}>
            <ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
            {t.toolbar.backToSheet}
          </button>
        </>
      )}
      {/* What unattended runs execute; published from the history's versions. */}
      <button
        type="button"
        onClick={() => setHistoryOpen(true, "versions")}
        title={published ? t.publishedLabel(published.version, published.name) : t.publishedHint}
        className={`${CHIP} ${
          published && !published.matchesCurrent
            ? "text-shu-600 hover:bg-shu-50"
            : published
              ? "text-moegi-500 hover:bg-slate-100"
              : "text-slate-500 hover:bg-slate-100 hover:text-ink"
        }`}
      >
        {published ? <CircleCheck size={13} strokeWidth={1.75} aria-hidden="true" /> : <CircleDashed size={13} strokeWidth={1.75} aria-hidden="true" />}
        <span className="@max-[1080px]/title:hidden">{published ? t.publishedBadge(published.version) : t.notPublishedBadge}</span>
      </button>
      {/* Said only when there is something to do about it. */}
      {(errors > 0 || todos > 0 || unset > 0) && (
        <button
          type="button"
          onClick={() => setBottom("issues")}
          className={`${CHIP} font-medium ${
            errors ? "bg-shu-50 text-shu-600 hover:bg-shu-100" : todos || unset ? "bg-amber-50 text-amber-700 hover:bg-amber-100" : "text-moegi-500 hover:bg-slate-100"
          }`}
          title={[errors ? t.toolbar.errors(errors) : "", unset ? t.toolbar.unset(unset) : "", todos ? t.todos.chip(todos) : ""].filter(Boolean).join(" · ") || t.toolbar.issuesTitle}
        >
          {errors ? (
            <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-shu-500 text-[9px] font-bold text-white">!</span>
          ) : todos || unset ? (
            <span className="h-3 w-3 rounded-full border-[1.5px] border-dashed border-amber-600" />
          ) : (
            <CheckIcon />
          )}
          <span className="@max-[1080px]/title:hidden">
            {[errors ? t.toolbar.errors(errors) : "", unset ? t.toolbar.unset(unset) : "", todos ? t.todos.chip(todos) : ""].filter(Boolean).join(" · ") || t.toolbar.valid}
          </span>
          {/* Narrow: the count stays, the words go to the tooltip. */}
          <span className="hidden tabular-nums @max-[1080px]/title:inline">{errors + unset + todos}</span>
        </button>
      )}
      <span className="flex h-6 shrink-0 items-center rounded-md text-[12px] text-slate-500 @max-[1080px]/title:hidden">
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

  // A flow the AI is still making is not run by hand: half of it is not there yet.
  const aiBusy = useFlowBusy();
  // A file to put in place, a login to register: the run would only stop at the first of them.
  const todoBlocked = useRunGateSync(flow?.id);
  if (!flow) return null;
  const errors = validation?.issues.filter((i) => i.severity === "error").length ?? 0;
  // Nothing to run yet.
  const noSteps = (flow.steps ?? []).length === 0;
  const running = run?.status === "running" || run?.status === "paused";
  const paused = run?.status === "paused";

  return (
    <div className="flex shrink-0 items-center gap-2">
      <ViewSwitch view={view} onChange={onView} />
      {/* A narrow bar (the AI's column open beside a small window) keeps the tools in the menu instead. */}
      <div className="flex items-center @max-[1000px]/title:hidden">
        <Tools busy={aiBusy} />
        <More canRun={errors === 0 && !running && !aiBusy && !noSteps && !todoBlocked} busy={aiBusy} />
      </div>
      <div className="hidden items-center @max-[1000px]/title:flex">
        <More canRun={errors === 0 && !running && !aiBusy && !noSteps && !todoBlocked} busy={aiBusy} tools />
      </div>
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
              <Pause size={12} strokeWidth={2.25} aria-hidden="true" />
              {t.runMsg.paused}
            </button>
          )}
          <button
            type="button"
            onClick={() => setFollowRun(!followRun)}
            title={followRun ? t.toolbar.followingTitle : t.toolbar.followTitle}
            className={`flex h-full items-center gap-1 border-l border-slate-300 px-2.5 text-[12px] ${followRun ? "bg-brand-50 font-semibold text-brand-700" : "text-slate-500 hover:bg-slate-50"}`}
          >
            {followRun ? <LocateFixed size={13} aria-hidden="true" /> : <Locate size={13} aria-hidden="true" />}
            {t.toolbar.follow}
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
            onClick={() => startRun()}
            disabled={errors > 0 || aiBusy || noSteps || !!todoBlocked}
            title={aiBusy ? t.toolbar.aiBusy : noSteps ? t.sheetView.noSteps : errors > 0 ? (authorIssues(validation).length > 0 ? t.toolbar.fixErrors : unsetIssues(validation).length > 0 ? t.toolbar.fillUnset : t.todos.runBlocked) : todoBlocked ? todoBlocked : `${t.run} (F5)`}
            className="group flex h-7 items-center gap-2 rounded-lg bg-primary pr-1.5 pl-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-400"
          >
            <PlayIcon />
            {t.run}
            <kbd className="rounded-sm bg-on-primary/15 px-1 font-sans text-[10px] font-normal opacity-80">F5</kbd>
          </button>
        </>
      )}
    </div>
  );
}

/**
 * What belongs to the flow besides its steps, each one press away: its settings, how it got
 * here, its files, and handing it to someone. Icons, named on hover, so the bar stays short.
 */
type Tool = { label: string; short?: string; icon: LucideIcon; run: () => void; disabled?: boolean };

function useTools(busy: boolean): Tool[] {
  const flow = useStudio((s) => s.flow);
  const setHistoryOpen = useStudio((s) => s.setHistoryOpen);
  const openHandOff = useStudio((s) => s.openHandOff);
  const showFlowProps = useStudio((s) => s.showFlowProps);
  const setFiles = useProjectMaybe((p) => p.setPanelOpen, null);
  if (!flow) return [];
  return [
    { label: t.shell.flowSettings, short: t.toolbar.short.settings, icon: Settings2, run: showFlowProps },
    { label: t.revision, short: t.toolbar.short.history, icon: History, run: () => setHistoryOpen(true) },
    ...(setFiles ? [{ label: t.project.toggleTitle, short: t.toolbar.short.files, icon: Files, run: () => setFiles(true) }] : []),
    { label: t.handOff.open, short: t.toolbar.short.handOff, icon: Send, run: () => void openHandOff(flow.id), disabled: busy },
  ];
}

function Tools({ busy }: { busy: boolean }) {
  const tools = useTools(busy);
  if (tools.length === 0) return null;
  return (
    <>
      {tools.map(({ label, short, icon: Icon, run, disabled }) => (
        <button
          key={label}
          type="button"
          title={disabled ? t.toolbar.aiBusy : label}
          aria-label={label}
          disabled={disabled}
          onClick={run}
          className="flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-[12.5px] text-slate-600 enabled:hover:bg-slate-100 enabled:hover:text-ink disabled:text-slate-300"
        >
          <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
          {/* Wide enough: the words beside the picture, so nothing has to be hovered to be known. */}
          {short && <span className="hidden @min-[1240px]/title:inline">{short}</span>}
        </button>
      ))}
    </>
  );
}

/**
 * Everything else about the open flow, behind one button: the other ways to
 * see it, running it a step at a time, how it got here, its folder, and
 * handing it to someone.
 */
function More({ canRun, busy, tools = false }: { canRun: boolean; busy: boolean; tools?: boolean }) {
  const extra = useTools(busy);
  const flow = useStudio((s) => s.flow);
  const startRun = useStudio((s) => s.startRun);
  const canUndo = useStudio((s) => s.canUndo);
  const canRedo = useStudio((s) => s.canRedo);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const openFolder = useProjectMaybe((p) => p.open, null);
  if (!flow) return null;
  return (
    <button
      type="button"
      title={t.shell.more}
      aria-label={t.shell.more}
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        openMenu({ clientX: box.left, clientY: box.bottom + 4, preventDefault: () => {} }, [
          { label: t.undo, icon: Undo2, shortcut: "Ctrl+Z", disabled: !canUndo || busy, run: () => void undo() },
          { label: t.redo, icon: Redo2, shortcut: "Ctrl+Y", disabled: !canRedo || busy, run: () => void redo() },
          "-",
          { label: t.toolbar.stepRun, icon: StepForward, disabled: !canRun, run: () => void startRun({ step: true }) },
          "-",
          ...(tools ? extra : []),
          openFolder && { label: t.project.openFolder, icon: FolderOutput, run: () => void openFolder("", false) },
        ]);
      }}
      className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink"
    >
      <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

