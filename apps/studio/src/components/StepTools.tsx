// Move, extract and delete for the selected step, shown beside it in both the
// flow chart and the procedure: actions on one step sit on that step.
import type { Step } from "@shikigami/schema";
import { useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { ExtractForm } from "./Inspector";

const STEP_TOOL = "grid h-6 w-6 place-items-center rounded-[3px] text-[13px] text-slate-600 hover:bg-slate-100 hover:text-ink";

/** Move, delete and extract, on the selected step itself: the pointer is already there. */
export function StepTools({ step }: { step: Step }) {
  const moveSelected = useStudio((s) => s.moveSelected);
  const removeSelected = useStudio((s) => s.removeSelected);
  const [extracting, setExtracting] = useState(false);
  return (
    <div className="relative">
      <div role="toolbar" aria-label={t.toolbar.stepTools} className="flex items-center gap-0.5 rounded-[3px] border border-slate-200 bg-sheet p-0.5 shadow-raised">
        <button type="button" title={`${t.moveUp} (Alt+↑)`} onClick={() => moveSelected(-1)} className={STEP_TOOL}>
          ↑
        </button>
        <button type="button" title={`${t.moveDown} (Alt+↓)`} onClick={() => moveSelected(1)} className={STEP_TOOL}>
          ↓
        </button>
        <span className="mx-0.5 h-4 w-px bg-slate-200" />
        <button
          type="button"
          title={t.shell.extractTitle}
          onClick={() => setExtracting(!extracting)}
          aria-expanded={extracting}
          className={`h-6 rounded-[3px] px-1.5 text-[11px] ${extracting ? "bg-slate-200 text-ink" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
        >
          {t.shell.extract}
        </button>
        <span className="mx-0.5 h-4 w-px bg-slate-200" />
        <button type="button" title={`${t.delete} (Delete)`} onClick={() => removeSelected()} className={`${STEP_TOOL} hover:bg-shu-50! hover:text-shu-600!`}>
          ✕
        </button>
      </div>
      {extracting && (
        <div className="nodrag nopan absolute top-full left-0 z-20 mt-1 rounded-[4px] border border-slate-200 bg-sheet shadow-lifted">
          <ExtractForm step={step} />
        </div>
      )}
    </div>
  );
}

