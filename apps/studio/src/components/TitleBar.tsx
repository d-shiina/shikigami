// The window's title bar, right of the sidebar (which holds the workspace),
// read left to right like the rest of Studio: what is open, then what to do
// with it, ending with Run (the app's name, the search, the AI and the window
// buttons sit above, in the window's bar). The window holds one flow at a time, so the bar that names the
// window names the flow too, as an editor names its document. Everything
// left between controls is room to drag the window; double-click maximizes.
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { useReviewView } from "../lib/reviewView";
import type { Place } from "../store";
import { FlowActions, FlowTitle, type View } from "./Toolbar";

const PAGE_TITLE: Partial<Record<Place, () => string>> = {
  library: () => t.flows,
  flows: () => t.flows,
  review: () => t.awaitingReview,
  runs: () => t.runs.place,
  secrets: () => t.secrets,
  settings: () => t.shell.settings,
};

export function TitleBar({ view, onView }: { view: View; onView: (view: View) => void }) {
  const place = useStudio((s) => s.place);
  const hasFlow = useStudio((s) => s.flow !== null);
  // The flow places open a flow into the editor; the others are pages.
  const editing = (place === "flows" || place === "review") && hasFlow;
  const page = PAGE_TITLE[place]?.();
  // The review desk keeps its own view, starting on the AI's report.
  const reviewView = useReviewView((s) => s.view);
  const setReviewView = useReviewView((s) => s.setView);
  return (
    <header data-tauri-drag-region className="@container/title relative flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 bg-sheet px-3 select-none">
      {editing ? <FlowTitle /> : page && <span className="truncate text-[13px] font-bold">{page}</span>}
      <span data-tauri-drag-region className="min-w-4 flex-1 self-stretch" />
      {editing &&
        (place === "review" ? <FlowActions view={reviewView} onView={setReviewView} /> : <FlowActions view={view} onView={(v) => v !== "report" && onView(v)} />)}
    </header>
  );
}
