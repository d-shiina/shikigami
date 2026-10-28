import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppMenu } from "./components/AppMenu";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FlowCanvas } from "./components/FlowCanvas";
import { IssuesPanel } from "./components/IssuesPanel";
import { PropertyPanel } from "./components/PropertyPanel";
import { RunLog } from "./components/RunLog";
import { ScenarioList } from "./components/ScenarioList";
import { StoryView } from "./components/StoryView";
import { SecretsDialog } from "./components/SecretsDialog";
import { Timeline, usePendingReview } from "./components/Timeline";
import { CanvasDock, ScenarioHeader } from "./components/Toolbar";
import { VariablesPanel } from "./components/VariablesPanel";
import { VersionsPanel } from "./components/VersionsPanel";
import { StudioContext, useStudio } from "./context";
import { api, events } from "./lib/api";
import { t } from "./lib/i18n";
import { createStudioStore } from "./store";

type Tab = "timeline" | "versions" | "properties" | "variables" | "issues";

/** Shown while a run waits for the person at the PC (manual login, MFA). */
function HumanBanner() {
  const human = useStudio((s) => s.human);
  if (!human) return null;
  return (
    <div className="flex items-center gap-2 border-b border-shu-100 bg-shu-50 px-4 py-2 text-sm font-medium text-shu-600">
      <span className="swirl h-2 w-2 rounded-full" />
      <span>
        {t.waitingForYou}：{human.message}
      </span>
    </div>
  );
}

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
    ["versions", t.versions, 0],
    ["properties", t.inspect, 0],
    ["variables", t.variables, 0],
    ["issues", t.issues, issueCount],
  ];
  return (
    <aside className="flex h-full flex-col border-l border-slate-200 bg-sheet">
      <nav className="flex border-b border-slate-200 px-2">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`relative flex flex-1 items-center justify-center gap-1 py-2.5 text-xs font-medium ${
              tab === key ? "text-ink" : "text-slate-500 hover:text-ink"
            }`}
          >
            {label}
            {count > 0 && (
              <span
                className={`rounded-full px-1.5 text-[10px] ${key === "timeline" ? "bg-shu-500 text-white" : "bg-slate-200 text-slate-600"}`}
              >
                {count}
              </span>
            )}
            {tab === key && <span className="swirl-line absolute inset-x-3 bottom-[-1px] h-[2px] rounded-full" />}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto">
        {tab === "timeline" && <Timeline />}
        {tab === "versions" && <VersionsPanel />}
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
    return globalThis.localStorage?.getItem(VIEW_KEY) === "story" ? "story" : "flow";
  } catch {
    return "flow";
  }
}

function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: [View, string][] = [
    ["flow", t.viewFlow],
    ["story", t.viewStory],
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

function SecretsButton() {
  const setOpen = useStudio((s) => s.setSecretsOpen);
  const count = useStudio((s) => s.secrets.length);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-slate-600 hover:bg-slate-100"
      title={t.secretsIntro}
    >
      🔑 {t.secrets}
      {count > 0 && <span className="rounded-full bg-slate-200 px-1 text-[10px]">{count}</span>}
    </button>
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
      <header className="relative col-span-3 flex items-center gap-3 bg-sheet px-4 py-2">
        <img src="/mark.png" alt="" className="h-7 w-7" />
        <span className="text-lg font-black tracking-wider">式神</span>
        <span className="-ml-1 text-xs font-medium tracking-[.2em] text-slate-500">STUDIO</span>
        <ScenarioHeader />
        <AppMenu />
        <SecretsButton />
        <span className="swirl-line absolute inset-x-0 bottom-0 h-[2px] opacity-80" />
      </header>
      <div className="col-span-3">
        <HumanBanner />
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
      <SecretsDialog />
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
