import { useStudio } from "../context";
import { t } from "../lib/i18n";

function DockButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const { label, children, className, ...rest } = props;
  return (
    <button
      type="button"
      title={label}
      className={`grid h-8 min-w-8 place-items-center rounded-full px-2 text-sm text-slate-700 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Scenario title, validation state and the run seal, in the top bar. */
export function ScenarioHeader() {
  const scenario = useStudio((s) => s.scenario);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
  const startRun = useStudio((s) => s.startRun);
  const stopRun = useStudio((s) => s.stopRun);

  if (!scenario) return <span className="flex-1" />;
  const errors = validation?.issues.filter((i) => i.severity === "error").length ?? 0;
  const running = run?.status === "running";

  return (
    <>
      <span className="text-slate-300">/</span>
      <div className="min-w-0 flex-1">
        <span className="truncate text-base font-bold">{scenario.name}</span>
        <span className="ml-2 text-xs text-slate-500">
          {t.revision} {scenario.revision}
        </span>
      </div>
      <span
        className={`flex items-center gap-1 text-xs ${errors ? "text-shu-600" : "text-moegi-500"}`}
        title={t.issues}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${errors ? "bg-shu-500" : "bg-moegi-500"}`} />
        {errors ? `エラー ${errors} 件` : "検証OK"}
      </span>
      {running ? (
        <button
          type="button"
          onClick={() => stopRun()}
          className="rounded-full border-2 border-shu-500 px-4 py-1 text-sm font-bold text-shu-600 hover:bg-shu-50"
        >
          ■ {t.stop}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => startRun()}
          disabled={errors > 0}
          title={errors > 0 ? "検証エラーを直すと実行できます" : undefined}
          className="warm rounded-full px-5 py-1 text-sm font-bold tracking-wider text-white shadow-[0_2px_8px_rgba(232,80,31,.35)] hover:brightness-105 disabled:bg-none disabled:bg-slate-300 disabled:shadow-none"
        >
          {t.run}
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
    <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-slate-200 bg-sheet/95 p-1 shadow-lg backdrop-blur">
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2 rounded-full bg-ink py-1.5 pr-2 pl-3 text-sm font-medium text-paper hover:bg-slate-700"
      >
        ＋ {t.addStep}
        <kbd className="rounded bg-white/15 px-1 font-sans text-[10px]">{t.shortcut}</kbd>
      </button>
      <span className="mx-1 h-5 w-px bg-slate-200" />
      <DockButton label={`${t.moveUp}`} onClick={() => moveSelected(-1)} disabled={!stepSelected}>
        ↑
      </DockButton>
      <DockButton label={`${t.moveDown}`} onClick={() => moveSelected(1)} disabled={!stepSelected}>
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
