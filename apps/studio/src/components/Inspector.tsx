import { X } from "lucide-react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { typeTitle } from "../lib/sentence";
import { findStep } from "../store";
import { PartInspector } from "./inspector/PartInspector";
import { StepInspector } from "./inspector/StepInspector";
import { Position } from "./StatusBar";
import { FlowInspector } from "./inspector/FlowInspector";

/**
 * The inspector: the properties of what is selected, and nothing else. A
 * step when one is selected, otherwise the flow. It is shown only while a node
 * or part is picked, or while the person keeps it open (the flow's settings). The path at the top says
 * which, and steps back up to the flow.
 */
export function Inspector() {
  const flow = useStudio((s) => s.flow);
  const selection = useStudio((s) => s.selection);
  const stepTypes = useStudio((s) => s.stepTypes);
  const showFlowProps = useStudio((s) => s.showFlowProps);
  const setInspectorOpen = useStudio((s) => s.setInspectorOpen);
  const place = useStudio((s) => s.place);
  if (!flow) return null;
  const step = selection?.kind === "step" ? findStep(flow.steps ?? [], selection.stepId) : undefined;
  const def = step ? stepTypes.find((d) => d.type === step.type) : undefined;
  const partName = selection?.kind === "part" ? selection.name : undefined;
  const part = partName ? flow.parts?.[partName] : undefined;
  return (
    <aside className="relative z-[1] flex h-full min-h-0 flex-col border-l border-slate-200 bg-sheet">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-200 px-4 text-[12px]">
        {partName ? (
          <>
            <button type="button" onClick={showFlowProps} className="shrink-0 text-slate-500 hover:text-ink hover:underline" title={t.shell.toFlow}>
              {t.shell.flow}
            </button>
            <span className="text-slate-400">›</span>
            <span className="text-slate-500">{t.parts.title}</span>
            <span className="text-slate-400">›</span>
            <span className="truncate font-semibold">{part?.label || partName}</span>
          </>
        ) : step ? (
          <>
            {/* The flow's name is in the title bar; here it is the way back to its properties. */}
            <button type="button" onClick={showFlowProps} className="shrink-0 text-slate-500 hover:text-ink hover:underline" title={t.shell.toFlow}>
              {t.shell.flow}
            </button>
            <span className="text-slate-400">›</span>
            <span className="truncate font-semibold">{step.name || typeTitle(step, def)}</span>
          </>
        ) : (
          <span className="font-semibold">{t.shell.flow}</span>
        )}
        {/* Where the selection is in the flow: "ノード 3 / 12". */}
        <span className="ml-auto flex h-full shrink-0 items-center text-[11px] text-slate-500">
          <Position />
        </span>
        {/* Closed, the pane gives the chart its room until a node is picked again. */}
        {place === "flows" && (
          <button
            type="button"
            onClick={() => setInspectorOpen(false)}
            title={t.shell.paneHide}
            aria-label={t.shell.paneHide}
            className="-mr-2 ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-ink"
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {partName ? <PartInspector name={partName} /> : step ? <StepInspector /> : <FlowInspector />}
      </div>
    </aside>
  );
}
