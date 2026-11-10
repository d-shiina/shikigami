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
  extensions: () => t.extensions.place,
};

export function TitleBar({ view, onView }: { view: View; onView: (view: View) => void }) {
  const place = useStudio((s) => s.place);
  const setPlace = useStudio((s) => s.setPlace);
  const hasFlow = useStudio((s) => s.flow !== null);
  // The flow places open a flow into the editor; the others are pages.
  const editing = (place === "flows" || place === "review") && hasFlow;
  const page = PAGE_TITLE[place]?.();
  // A new flow the AI is making is named in the bar as an open flow is, once it exists.
  const drafting = useStudio((s) => (place === "flows" && !hasFlow ? s.drafting : null));
  // The review desk keeps its own view, starting on the AI's report.
  const reviewView = useReviewView((s) => s.view);
  const setReviewView = useReviewView((s) => s.setView);
  return (
    <header data-tauri-drag-region className="@container/title relative flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 bg-sheet px-3 select-none">
      {editing ? (
        <FlowTitle />
      ) : drafting ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <button type="button" onClick={() => setPlace("library")} className="shrink-0 rounded-md px-1 text-[13px] text-slate-500 hover:bg-slate-100 hover:text-ink">
            {t.flows}
          </button>
          <span className="shrink-0 text-[13px] text-slate-300" aria-hidden="true">
            /
          </span>
          <span className="min-w-[5em] truncate px-0.5 text-[13px] font-semibold text-ink" title={drafting.request}>
            {drafting.title || t.agent.untitled}
          </span>
          <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700">{t.drafting.tag}</span>
        </div>
      ) : (
        page && <span className="truncate text-[13px] font-bold">{page}</span>
      )}
      <span data-tauri-drag-region className="min-w-4 flex-1 self-stretch" />
      {editing &&
        (place === "review" ? <FlowActions view={reviewView} onView={setReviewView} /> : <FlowActions view={view} onView={(v) => v !== "report" && onView(v)} />)}
    </header>
  );
}
