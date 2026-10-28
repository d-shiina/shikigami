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

/** Scenario title, validation state and the run control, in the top bar. */
export function ScenarioHeader() {
  const scenario = useStudio((s) => s.scenario);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
  const startRun = useStudio((s) => s.startRun);
  const stopRun = useStudio((s) => s.stopRun);
  const followRun = useStudio((s) => s.followRun);
  const setFollowRun = useStudio((s) => s.setFollowRun);
  const debug = useStudio((s) => s.debug);

  if (!scenario) return <span className="flex-1" />;
  const errors = validation?.issues.filter((i) => i.severity === "error").length ?? 0;
  const running = run?.status === "running" || run?.status === "paused";
  const paused = run?.status === "paused";

  return (
    <>
      <span className="h-5 w-px bg-slate-200" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[15px] font-bold">{scenario.name}</span>
        <span className="shrink-0 rounded-[4px] bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
          {t.revision} {scenario.revision}
        </span>
      </div>
      <span
        className={`flex h-7 items-center gap-1 rounded-[4px] px-2 text-[12px] font-medium ${
          errors ? "bg-shu-50 text-shu-600" : "text-moegi-500"
        }`}
        title={t.issues}
      >
        {errors ? <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-shu-500 text-[9px] font-bold text-white">!</span> : <CheckIcon />}
        {errors ? `エラー ${errors} 件` : "検証OK"}
      </span>
      {running ? (
        <div className="flex h-8 items-center overflow-hidden rounded-[4px] border border-slate-300 bg-sheet text-[13px]">
          <span className="flex items-center gap-2 px-3 font-medium text-ink">
            <span className={`h-2 w-2 rounded-full ${paused ? (run?.pause?.reason === "error" ? "bg-shu-500" : "bg-mizu-500") : "bg-accent-500 animate-pulse"}`} />
            {paused ? "一時停止中" : "実行中"}
          </span>
          {!paused && (
            <button
              type="button"
              onClick={() => void debug({ action: "pause" })}
              title="次の手順の前で一時停止する"
              className="flex h-full items-center gap-1 border-l border-slate-300 px-2.5 text-[12px] text-slate-600 hover:bg-slate-50"
            >
              ❚❚ 一時停止
            </button>
          )}
          <button
            type="button"
            onClick={() => setFollowRun(!followRun)}
            title={followRun ? "動いている手順を画面で追っています（画面を動かすと止まります）" : "動いている手順を画面で追う"}
            className={`flex h-full items-center gap-1 border-l border-slate-300 px-2.5 text-[12px] ${followRun ? "bg-brand-50 font-semibold text-brand-700" : "text-slate-500 hover:bg-slate-50"}`}
          >
            {followRun ? "◉" : "○"} 追う
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
        <button
          type="button"
          onClick={() => startRun()}
          disabled={errors > 0}
          title={errors > 0 ? "検証エラーを直すと実行できます" : `${t.run} (F5)`}
          className="group flex h-8 items-center gap-2 rounded-[4px] bg-ink pr-1.5 pl-3 text-[13px] font-semibold text-paper shadow-[0_1px_2px_rgba(15,27,42,.3)] hover:bg-brand-700 disabled:bg-slate-300 disabled:shadow-none"
        >
          <span className="text-[#5fd08a] group-disabled:text-paper dark:text-moegi-100">
            <PlayIcon />
          </span>
          {t.run}
          <kbd className="rounded-[3px] bg-paper/15 px-1 font-sans text-[10px] font-normal text-paper/80">F5</kbd>
        </button>
      )}
      {!running && (
        <button
          type="button"
          onClick={() => startRun({ step: true })}
          disabled={errors > 0}
          title="最初の手順の前で止めて、1手順ずつ実行する (F10)"
          className="flex h-8 items-center gap-1 rounded-[6px] border border-slate-300 px-2.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-50 disabled:text-slate-300"
        >
          ステップ実行
        </button>
      )}
    </>
  );
}

/** Floating dock over the canvas: summon, reorder, undo. */
export function CanvasDock() {
  const scenario = useStudio((s) => s.scenario);
  const selection = useStudio((s) => s.selection);
  const canUndo = useStudio((s) => s.canUndo);
  const canRedo = useStudio((s) => s.canRedo);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const moveSelected = useStudio((s) => s.moveSelected);
  const removeSelected = useStudio((s) => s.removeSelected);
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);

  if (!scenario) return null;
  const stepSelected = selection?.kind === "step";

  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-[4px] whitespace-nowrap border border-slate-200 bg-sheet/95 p-1 shadow-raised backdrop-blur">
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2 rounded-[3px] bg-ink py-1.5 pr-2 pl-3 text-sm font-medium text-paper hover:bg-slate-700"
      >
        ＋ <span className="@max-[560px]:hidden">{t.addStep}</span>
        <kbd className="rounded bg-paper/15 px-1 font-sans text-[10px] @max-[560px]:hidden">{t.shortcut}</kbd>
      </button>
      <span className="mx-1 h-5 w-px bg-slate-200" />
      <DockButton label={`${t.moveUp} (Alt+↑)`} onClick={() => moveSelected(-1)} disabled={!stepSelected}>
        ↑
      </DockButton>
      <DockButton label={`${t.moveDown} (Alt+↓)`} onClick={() => moveSelected(1)} disabled={!stepSelected}>
        ↓
      </DockButton>
      <DockButton label={`${t.delete} (Delete)`} onClick={() => removeSelected()} disabled={!stepSelected}>
        ✕
      </DockButton>
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
