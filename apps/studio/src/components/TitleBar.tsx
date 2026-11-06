// The window's title bar, right of the sidebar (which holds the workspace),
// read left to right like the rest of Studio: what is open, then what to do
// with it, ending with Run, and the window buttons at the edge (the AI is
// opened from the sidebar). The window holds one flow at a time, so the bar that names the
// window names the flow too, as an editor names its document. Everything
// left between controls is room to drag the window; double-click maximizes.
import { PanelLeftOpen } from "lucide-react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import type { Place } from "../store";
import { FlowActions, FlowTitle, type View } from "./Toolbar";
import { WindowControls } from "./WindowControls";

const PAGE_TITLE: Partial<Record<Place, () => string>> = {
  library: () => t.flows,
  flows: () => t.flows,
  review: () => t.awaitingReview,
  secrets: () => t.secrets,
  settings: () => t.shell.settings,
};

export function TitleBar({ view, onView, onShowSidebar }: { view: View; onView: (view: View) => void; onShowSidebar?: () => void }) {
  const place = useStudio((s) => s.place);
  const hasFlow = useStudio((s) => s.flow !== null);
  // The flow places open a flow into the editor; the others are pages.
  const editing = (place === "flows" || place === "review") && hasFlow;
  const page = PAGE_TITLE[place]?.();
  return (
    <header data-tauri-drag-region className="@container/title relative flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 bg-sheet pl-3 select-none">
      {/* With the sidebar hidden, the way back to it sits where it was. */}
      {onShowSidebar && (
        <button
          type="button"
          onClick={onShowSidebar}
          title={`${t.list.expand} (Ctrl+B)`}
          className="-ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-100 hover:text-ink"
        >
          <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
      {editing ? <FlowTitle /> : page && <span className="truncate text-[13px] font-bold">{page}</span>}
      <span data-tauri-drag-region className="min-w-4 flex-1 self-stretch" />
      {editing && <FlowActions view={view} onView={onView} />}
      {editing && <span className="mx-1 h-5 w-px bg-slate-200" />}
      <WindowControls />
    </header>
  );
}
