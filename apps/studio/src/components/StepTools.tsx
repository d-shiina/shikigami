// Move, extract and delete for the selected step, shown beside it in both the
// flow chart and the procedure: actions on one step sit on that step.
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { Step } from "@shikigami/schema";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { selectedIds } from "../store";
import { ExtractForm } from "./inspector/StepInspector";

const STEP_TOOL = "grid h-6 w-6 place-items-center rounded-md text-[13px] text-slate-600 hover:bg-slate-100 hover:text-ink";

/** Move, delete and extract, on the selected step itself: the pointer is already there. */
export function StepTools({ step }: { step: Step }) {
  const moveSelected = useStudio((s) => s.moveSelected);
  const removeSelected = useStudio((s) => s.removeSelected);
  const extracting = useStudio((s) => s.extractOpen);
  const setExtractOpen = useStudio((s) => s.setExtractOpen);
  // Several nodes picked with Shift+click: say how many, so the actions read as acting on all of them.
  const count = useStudio((s) => selectedIds(s).length);
  return (
    <div className="relative">
      <div role="toolbar" aria-label={t.toolbar.stepTools} className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-sheet p-0.5 shadow-raised">
        {count > 1 && (
          <>
            <span className="px-1.5 text-[11px] font-medium whitespace-nowrap text-primary" title={t.shell.pickedTitle}>
              {t.shell.pickedCount(count)}
            </span>
            <span className="mx-0.5 h-4 w-px bg-slate-200" />
          </>
        )}
        {count <= 1 && (
          <>
            <button type="button" title={`${t.moveUp} (Alt+↑)`} onClick={() => moveSelected(-1)} className={STEP_TOOL} aria-label={t.moveUp}>
              <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button type="button" title={`${t.moveDown} (Alt+↓)`} onClick={() => moveSelected(1)} className={STEP_TOOL} aria-label={t.moveDown}>
              <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <span className="mx-0.5 h-4 w-px bg-slate-200" />
          </>
        )}
        <button
          type="button"
          title={t.shell.extractTitle}
          onClick={() => setExtractOpen(!extracting)}
          aria-expanded={extracting}
          className={`h-6 rounded-md px-1.5 text-[11px] whitespace-nowrap ${extracting ? "bg-slate-200 text-ink" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
        >
          {t.shell.extract}
        </button>
        <span className="mx-0.5 h-4 w-px bg-slate-200" />
        <button type="button" title={`${t.delete} (Delete)`} onClick={() => removeSelected()} className={`${STEP_TOOL} hover:bg-shu-50! hover:text-shu-600!`} aria-label={t.delete}>
          <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {extracting && (
        <div className="nodrag nopan absolute top-full left-0 z-20 mt-1 rounded-lg border border-slate-200 bg-sheet shadow-lifted">
          <ExtractForm step={step} />
        </div>
      )}
    </div>
  );
}
