import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { FlowCanvas } from "./components/FlowCanvas";
import { IssuesPanel } from "./components/IssuesPanel";
import { PropertyPanel } from "./components/PropertyPanel";
import { RunLog } from "./components/RunLog";
import { ScenarioList } from "./components/ScenarioList";
import { Toolbar } from "./components/Toolbar";
import { VariablesPanel } from "./components/VariablesPanel";
import { StudioContext, useStudio } from "./context";
import { api, events } from "./lib/api";
import { t } from "./lib/i18n";
import { createStudioStore } from "./store";

type Tab = "properties" | "variables" | "issues";

function Banner() {
  const notice = useStudio((s) => s.notice);
  const error = useStudio((s) => s.error);
  const dismiss = useStudio((s) => s.dismiss);
  if (!notice && !error) return null;
  return (
    <div
      className={`flex items-center gap-2 px-4 py-1.5 text-sm ${error ? "bg-red-50 text-red-700" : "bg-brand-50 text-brand-700"}`}
    >
      <span>{error ?? notice}</span>
      <button type="button" className="ml-auto text-xs hover:underline" onClick={dismiss}>
        閉じる
      </button>
    </div>
  );
}

function SidePanel() {
  const [tab, setTab] = useState<Tab>("properties");
  const issueCount = useStudio((s) => s.validation?.issues.length ?? 0);
  const selection = useStudio((s) => s.selection);
  useEffect(() => {
    if (selection?.kind === "step") setTab("properties");
  }, [selection]);
  const tabs: [Tab, string][] = [
    ["properties", t.properties],
    ["variables", t.variables],
    ["issues", `${t.issues}${issueCount ? ` (${issueCount})` : ""}`],
  ];
  return (
    <aside className="flex h-full flex-col border-l border-slate-200 bg-white">
      <nav className="flex border-b border-slate-200">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 px-2 py-2 text-xs font-medium ${
              tab === key ? "border-b-2 border-brand-500 text-brand-700" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto">
        {tab === "properties" && <PropertyPanel />}
        {tab === "variables" && <VariablesPanel />}
        {tab === "issues" && <IssuesPanel />}
      </div>
    </aside>
  );
}

function Shell() {
  const hasScenario = useStudio((s) => s.scenario !== null);
  return (
    <div className="grid h-full grid-cols-[260px_1fr_340px] grid-rows-[auto_auto_1fr_200px]">
      <header className="col-span-3 flex items-center gap-3 bg-brand-700 px-4 py-2 text-white">
        <img src="/mark.png" alt="" className="h-7 w-7 rounded bg-white/90 p-0.5" />
        <span className="font-semibold">{t.appName}</span>
        <span className="text-xs text-white/60">MCP-native RPA</span>
      </header>
      <div className="col-span-3">
        <Banner />
      </div>
      <div className="row-span-2 min-h-0">
        <ScenarioList />
      </div>
      <main className="flex min-h-0 flex-col">
        <Toolbar />
        <div className="min-h-0 flex-1">
          <ReactFlowProvider>
            <FlowCanvas />
          </ReactFlowProvider>
        </div>
      </main>
      <div className="row-span-2 min-h-0">{hasScenario && <SidePanel />}</div>
      <div className="min-h-0">
        <RunLog />
      </div>
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
      <Shell />
    </StudioContext.Provider>
  );
}
