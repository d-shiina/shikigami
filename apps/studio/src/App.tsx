import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FlowCanvas } from "./components/FlowCanvas";
import { IssuesPanel } from "./components/IssuesPanel";
import { PropertyPanel } from "./components/PropertyPanel";
import { RunLog } from "./components/RunLog";
import { ScenarioList } from "./components/ScenarioList";
import { StoryView } from "./components/StoryView";
import { Timeline, usePendingReview } from "./components/Timeline";
import { CanvasDock, ScenarioHeader } from "./components/Toolbar";
import { VariablesPanel } from "./components/VariablesPanel";
import { StudioContext, useStudio } from "./context";
import { api, events } from "./lib/api";
import { t } from "./lib/i18n";
import { createStudioStore } from "./store";

type Tab = "timeline" | "properties" | "variables" | "issues";

function Banner() {
  const notice = useStudio((s) => s.notice);
  const error = useStudio((s) => s.error);
  const dismiss = useStudio((s) => s.dismiss);
  if (!notice && !error) return null;
  return (
    <div
      className={`flex items-center gap-2 border-b px-4 py-1.5 text-sm ${
        error ? "border-shu-100 bg-shu-50 text-shu-600" : "border-slate-200 bg-sheet text-slate-700"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${error ? "bg-shu-500" : "swirl"}`} />
      <span>{error ?? notice}</span>
      <button type="button" className="ml-auto text-xs text-slate-500 hover:underline" onClick={dismiss}>
        閉じる
      </button>
    </div>
  );
}

function SidePanel() {
  const [tab, setTab] = useState<Tab>("timeline");
  const issueCount = useStudio((s) => s.validation?.issues.length ?? 0);
  const selection = useStudio((s) => s.selection);
  const pendingCount = usePendingReview().length;
  useEffect(() => {
    if (selection?.kind === "step") setTab("properties");
  }, [selection]);
  // New AI edits pull the review to the front.
  const lastPending = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount > lastPending.current) setTab("timeline");
    lastPending.current = pendingCount;
  }, [pendingCount]);
  const tabs: [Tab, string, number][] = [
    ["timeline", t.timeline, pendingCount],
    ["properties", t.inspect, 0],
    ["variables", t.variables, 0],
    ["issues", t.issues, issueCount],
  ];
  return (
    <aside className="flex h-full flex-col border-l border-slate-200 bg-sheet">
      <nav className="flex gap-1 px-3 pt-3">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${
              tab === key ? "bg-ink text-paper" : "text-slate-500 hover:bg-slate-100 hover:text-ink"
            }`}
          >
            {label}
            {count > 0 && (
              <span
                className={`rounded-full px-1 text-[10px] ${key === "timeline" ? "bg-shu-500 text-white" : tab === key ? "bg-white/20" : "bg-slate-200"}`}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto">
        {tab === "timeline" && <Timeline />}
        {tab === "properties" && <PropertyPanel />}
        {tab === "variables" && <VariablesPanel />}
        {tab === "issues" && <IssuesPanel />}
      </div>
    </aside>
  );
}

type View = "story" | "flow";
const VIEW_KEY = "shikigami.studio.view";

function loadView(): View {
  try {
    return globalThis.localStorage?.getItem(VIEW_KEY) === "flow" ? "flow" : "story";
  } catch {
    return "story";
  }
}

function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: [View, string][] = [
    ["story", t.viewStory],
    ["flow", t.viewFlow],
  ];
  return (
    <div className="absolute top-3 right-4 flex overflow-hidden rounded-full border border-slate-300 bg-sheet text-xs shadow-sm">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`px-3 py-1 ${view === key ? "bg-ink text-paper" : "text-slate-600 hover:bg-slate-100"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Shell() {
  const hasScenario = useStudio((s) => s.scenario !== null);
  const [view, setViewState] = useState<View>(loadView);
  const setView = (next: View) => {
    setViewState(next);
    try {
      globalThis.localStorage?.setItem(VIEW_KEY, next);
    } catch {
      // Only a remembered preference.
    }
  };
  const hasRun = useStudio((s) => s.run !== null);
  return (
    <div className="grid h-full grid-cols-[232px_1fr_360px] grid-rows-[auto_auto_1fr]">
      <header className="col-span-3 flex items-center gap-3 border-b border-slate-200 bg-sheet px-4 py-2">
        <img src="/mark.png" alt="" className="h-7 w-7" />
        <span className="font-serif text-lg font-bold tracking-wider">式神</span>
        <span className="-ml-1 text-xs font-medium tracking-[.2em] text-slate-500">STUDIO</span>
        <ScenarioHeader />
      </header>
      <div className="col-span-3">
        <Banner />
      </div>
      <div className="min-h-0">
        <ScenarioList />
      </div>
      <main className="flex min-h-0 flex-col">
        <div className="relative min-h-0 flex-1">
          {view === "story" ? (
            <StoryView />
          ) : (
            <ReactFlowProvider>
              <FlowCanvas />
            </ReactFlowProvider>
          )}
          {hasScenario && <ViewToggle view={view} onChange={setView} />}
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <CanvasDock />
          </div>
        </div>
        {hasRun && (
          <div className="h-44 min-h-0">
            <RunLog />
          </div>
        )}
      </main>
      <div className="min-h-0">{hasScenario && <SidePanel />}</div>
      <CommandPalette />
    </div>
  );
}

export function App() {
  const store = useMemo(() => createStudioStore(api), []);

  useEffect(() => {
    void store.getState().init();
    const unlisten = [
      events.onScenarioChanged((id) => void store.getState().onExternalChange(id)),
      events.onRunEvent((e) => store.getState().onRunEvent(e)),
    ];
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (store.getState().scenario) store.getState().setPaletteOpen(!store.getState().paletteOpen);
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        void store.getState().undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        void store.getState().redo();
      } else if (e.key === "Delete") {
        void store.getState().removeSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const p of unlisten) void p.then((off) => off());
    };
  }, [store]);

  return (
    <StudioContext.Provider value={store}>
      <ErrorBoundary>
        <Shell />
      </ErrorBoundary>
    </StudioContext.Provider>
  );
}
