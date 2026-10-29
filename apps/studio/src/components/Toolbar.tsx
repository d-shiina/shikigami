import { useStudio } from "../context";
import { t } from "../lib/i18n";

function DockButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const { label, children, className, ...rest } = props;
  return (
    <button
      type="button"
      title={label}
      className={`grid h-8 min-w-8 place-items-center rounded-[3px] px-2 text-sm text-slate-700 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent ${className ?? ""}`}
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

export type View = "story" | "flow";

/** Flow chart or procedure: two ways to read the same scenario. */
function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: [View, string][] = [
    ["flow", t.viewFlow],
    ["story", t.viewStory],
  ];
  return (
    <div className="flex h-7 items-center rounded-[4px] bg-slate-100 p-0.5 text-[12px]" role="radiogroup">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={view === key}
          onClick={() => onChange(key)}
          className={`h-6 rounded-[3px] px-2.5 ${view === key ? "bg-sheet font-semibold text-ink shadow-sheet" : "text-slate-500 hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

<<<<<<< HEAD
/** Opens the outline, which unfolds from the canvas corner this button sits in. */
export function OutlineButton() {
=======
/** Opens the outline, which unfolds right below this button. */
function OutlineButton() {
  const open = useStudio((s) => s.outlineOpen);
>>>>>>> origin/claude/project-thread-jekwf7
  const setOpen = useStudio((s) => s.setOutlineOpen);
  return (
    <button
      type="button"
<<<<<<< HEAD
      onClick={() => setOpen(true)}
      title={t.outline.title}
      className="flex h-8 items-center gap-1.5 rounded-[4px] border border-slate-200 bg-sheet/95 px-2.5 text-[12px] text-slate-600 shadow-raised backdrop-blur hover:text-ink"
=======
      onClick={() => setOpen(!open)}
      title={t.outline.title}
      aria-pressed={open}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-[3px] px-2 text-[12px] ${open ? "bg-slate-200 text-ink" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
>>>>>>> origin/claude/project-thread-jekwf7
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 2.5h10M3 6h8M3 9.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
<<<<<<< HEAD
      {t.outline.toggle}
=======
      <span className="@max-[640px]/bar:hidden">{t.outline.toggle}</span>
>>>>>>> origin/claude/project-thread-jekwf7
    </button>
  );
}

/**
<<<<<<< HEAD
 * The open scenario in the title bar, after the workspace it is stored in:
 * its name, its revision (opens History) and whether it is sound (opens
 * Issues). The window holds one scenario, so the window's bar names it.
 */
export function ScenarioTitle() {
  const scenario = useStudio((s) => s.scenario);
  const validation = useStudio((s) => s.validation);
  const setBottom = useStudio((s) => s.setBottom);
  const setHistoryOpen = useStudio((s) => s.setHistoryOpen);
  if (!scenario) return null;
  const errors = validation?.issues.filter((i) => i.severity === "error").length ?? 0;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[13px] font-bold">{scenario.name}</span>
      {/* The revision opens how the scenario got here: its record and versions. */}
      <button
        type="button"
        onClick={() => setHistoryOpen(true)}
        title={t.shell.historyTitle}
        className="flex h-6 shrink-0 items-center gap-1 rounded-[3px] bg-slate-100 px-1.5 text-[11px] text-slate-500 hover:bg-slate-200 hover:text-ink"
      >
        <span className="@max-[760px]/title:hidden">{t.revision}</span> {scenario.revision}
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="m1.5 3 2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => setBottom("issues")}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-[12px] font-medium ${
          errors ? "bg-shu-50 text-shu-600 hover:bg-shu-100" : "text-moegi-500 hover:bg-slate-100"
        }`}
        title={t.toolbar.issuesTitle}
      >
        {errors ? <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-shu-500 text-[9px] font-bold text-white">!</span> : <CheckIcon />}
        <span className="@max-[760px]/title:hidden">{errors ? t.toolbar.errors(errors) : t.toolbar.valid}</span>
      </button>
    </div>
  );
}

/**
 * What to do with the open scenario, at the right of the title bar: how to
 * show it, then running it, the one filled button, at the very end.
 */
export function ScenarioActions({ view, onView }: { view: View; onView: (view: View) => void }) {
=======
 * The bar over the chart: everything here acts on the open scenario. Read left
 * to right it says which scenario, whether it is sound, how it is shown, and
 * ends with running it, the one filled button.
 */
export function ScenarioBar({ view, onView }: { view: View; onView: (view: View) => void }) {
>>>>>>> origin/claude/project-thread-jekwf7
  const scenario = useStudio((s) => s.scenario);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
  const startRun = useStudio((s) => s.startRun);
  const stopRun = useStudio((s) => s.stopRun);
  const followRun = useStudio((s) => s.followRun);
  const setFollowRun = useStudio((s) => s.setFollowRun);
  const debug = useStudio((s) => s.debug);
  const setBottom = useStudio((s) => s.setBottom);
  const setHistoryOpen = useStudio((s) => s.setHistoryOpen);

  if (!scenario) return null;
  const errors = validation?.issues.filter((i) => i.severity === "error").length ?? 0;
  const running = run?.status === "running" || run?.status === "paused";
  const paused = run?.status === "paused";

  return (
<<<<<<< HEAD
    <div className="flex shrink-0 items-center gap-2">
=======
    // A container: on a narrow chart the secondary labels give way, never the run button.
    <div className="@container/bar flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 bg-sheet pr-2 pl-2">
      {view === "flow" && <OutlineButton />}
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        <span className="truncate text-[14px] font-bold">{scenario.name}</span>
        {/* The revision opens how the scenario got here: its record and versions. */}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          title={t.shell.historyTitle}
          className="flex h-6 shrink-0 items-center gap-1 rounded-[3px] bg-slate-100 px-1.5 text-[11px] text-slate-500 hover:bg-slate-200 hover:text-ink"
        >
          <span className="@max-[640px]/bar:hidden">{t.revision}</span> {scenario.revision}
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <path d="m1.5 3 2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setBottom("issues")}
          className={`flex h-6 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-[12px] font-medium ${
            errors ? "bg-shu-50 text-shu-600 hover:bg-shu-100" : "text-moegi-500 hover:bg-slate-100"
          }`}
          title={t.toolbar.issuesTitle}
        >
          {errors ? <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-shu-500 text-[9px] font-bold text-white">!</span> : <CheckIcon />}
          <span className="@max-[640px]/bar:hidden">{errors ? t.toolbar.errors(errors) : t.toolbar.valid}</span>
        </button>
      </div>
>>>>>>> origin/claude/project-thread-jekwf7
      <ViewSwitch view={view} onChange={onView} />
      <span className="mx-1 h-5 w-px bg-slate-200" />
      {running ? (
        <div className="flex h-8 items-center overflow-hidden rounded-[4px] border border-slate-300 bg-sheet text-[13px]">
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
            title={`${t.stop} (Shift+F5)`}
            className="flex h-full items-center gap-1.5 border-l border-slate-300 px-3 font-semibold text-shu-600 hover:bg-shu-50"
          >
            <span className="h-2.5 w-2.5 rounded-[2px] bg-shu-500" />
            {t.stop}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => startRun({ step: true })}
            disabled={errors > 0}
            title={t.toolbar.stepRunTitle}
            className="flex h-8 items-center gap-1 rounded-[4px] border border-slate-300 px-2.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-50 disabled:text-slate-300"
          >
<<<<<<< HEAD
            <span className="@max-[640px]/title:hidden">{t.toolbar.stepRun}</span>
            <span className="hidden @max-[640px]/title:inline" aria-hidden="true">
=======
            <span className="@max-[520px]/bar:hidden">{t.toolbar.stepRun}</span>
            <span className="hidden @max-[520px]/bar:inline" aria-hidden="true">
>>>>>>> origin/claude/project-thread-jekwf7
              ⇥
            </span>
          </button>
          <button
            type="button"
            onClick={() => startRun()}
            disabled={errors > 0}
            title={errors > 0 ? t.toolbar.fixErrors : `${t.run} (F5)`}
            className="group flex h-8 items-center gap-2 rounded-[4px] bg-ink pr-1.5 pl-3 text-[13px] font-semibold text-paper shadow-[0_1px_2px_rgba(15,27,42,.3)] hover:bg-brand-700 disabled:bg-slate-300 disabled:shadow-none"
          >
            <span className="text-[#5fd08a] group-disabled:text-paper dark:text-moegi-100">
              <PlayIcon />
            </span>
            {t.run}
            <kbd className="rounded-[3px] bg-paper/15 px-1 font-sans text-[10px] font-normal text-paper/80">F5</kbd>
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Floating dock over the canvas, for the whole chart: add a step, undo, redo.
 * What acts on one step sits on that step (StepTools on the chart).
 */
export function CanvasDock() {
  const scenario = useStudio((s) => s.scenario);
  const canUndo = useStudio((s) => s.canUndo);
  const canRedo = useStudio((s) => s.canRedo);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  const inside = useStudio((s) => s.dive.length > 0);

  // Inside a call the chart shows another scenario: editing tools would act on the open one.
  if (!scenario || inside) return null;

  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-[4px] whitespace-nowrap border border-slate-200 bg-sheet/95 p-1 shadow-raised backdrop-blur">
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2 rounded-[3px] bg-ink py-1.5 pr-2 pl-3 text-sm font-medium text-paper hover:bg-slate-700"
      >
        ＋ <span className="@max-[560px]:hidden">{t.addStep}</span>
        <kbd className="rounded-[3px] bg-paper/15 px-1 font-sans text-[10px] @max-[560px]:hidden">{t.shortcut}</kbd>
      </button>
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
