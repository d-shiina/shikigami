import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FlowCanvas } from "./components/FlowCanvas";
import { IssuesPanel } from "./components/IssuesPanel";
import { PropertyPanel } from "./components/PropertyPanel";
import { RunLog } from "./components/RunLog";
import { OutlinePanel, OutlineToggle } from "./components/Outline";
import { ReviewInbox, ReviewPanel, useInbox } from "./components/ReviewDesk";
import { ScenarioList, ScenarioRail } from "./components/ScenarioList";
import { StoryView } from "./components/StoryView";
import { SecretAskBanner } from "./components/SecretAskBanner";
import { SecretsDialog } from "./components/SecretsDialog";
import { StatusBar } from "./components/StatusBar";
import { Timeline, usePendingReview } from "./components/Timeline";
import { CanvasDock, ScenarioHeader } from "./components/Toolbar";
import { VariablesPanel } from "./components/VariablesPanel";
import { VersionsPanel } from "./components/VersionsPanel";
import { WindowControls } from "./components/WindowControls";
import { StudioContext, useStudio } from "./context";
import { api, events } from "./lib/api";
import { t } from "./lib/i18n";
import { createStudioStore, type StudioState } from "./store";

type Tab = "review" | "timeline" | "versions" | "properties" | "variables" | "issues";

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
  const reviewing = useStudio((s) => s.reviewing);
  const [tab, setTab] = useState<Tab>(reviewing ? "review" : "timeline");
  // The review desk opens on its own tab, and leaving it falls back to the record.
  useEffect(() => setTab(reviewing ? "review" : "timeline"), [reviewing]);
  const issueCount = useStudio((s) => s.validation?.issues.length ?? 0);
  const selection = useStudio((s) => s.selection);
  const pendingCount = usePendingReview().length;
  useEffect(() => {
    if (selection?.kind === "step" && !reviewing) setTab("properties");
  }, [selection, reviewing]);
  // New AI edits pull the review to the front.
  const lastPending = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount > lastPending.current && !reviewing) setTab("timeline");
    lastPending.current = pendingCount;
  }, [pendingCount]);
  const tabs: [Tab, string, number][] = [
    ...(reviewing ? [["review", "確認", pendingCount] as [Tab, string, number]] : []),
    ["timeline", t.timeline, reviewing ? 0 : pendingCount],
    ["versions", t.versions, 0],
    ["properties", t.inspect, 0],
    ["variables", t.variables, 0],
    ["issues", t.issues, issueCount],
  ];
  return (
    // A sheet laid over the edge of the desk.
    <aside className="relative z-[1] flex h-full flex-col border-l border-slate-200 bg-sheet shadow-[-2px_0_0_-1px_var(--color-sheet),-2px_0_0_0_var(--color-edge),-10px_0_18px_-14px_rgb(15_27_42/.35)]">
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
                className={`rounded-[3px] px-1.5 text-[10px] ${key === "timeline" || key === "review" ? "bg-shu-500 text-white" : "bg-slate-200 text-slate-600"}`}
              >
                {count}
              </span>
            )}
            {tab === key && <span className="swirl-line absolute inset-x-3 bottom-[-1px] h-[2px] rounded-full" />}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "review" && <ReviewPanel />}
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
const LIST_KEY = "shikigami.studio.list";

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
    <div className="absolute top-3 right-4 flex overflow-hidden rounded-[4px] border border-slate-300 bg-sheet text-xs shadow-sheet">
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
      className="flex h-8 items-center gap-1.5 rounded-[4px] px-2.5 text-[12px] text-slate-600 hover:bg-slate-100 hover:text-ink"
      title={t.secretsIntro}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
        <circle cx="5" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 8h6.5M12 8v2.5M14 8v2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      {t.secrets}
      {count > 0 && <span className="rounded-[3px] bg-slate-200 px-1.5 text-[10px]">{count}</span>}
    </button>
  );
}

/** Scenarios, or the AI edits waiting for review. */
function ModeSwitch() {
  const reviewing = useStudio((s) => s.reviewing);
  const setReviewing = useStudio((s) => s.setReviewing);
  const open = useStudio((s) => s.open);
  const currentId = useStudio((s) => s.scenario?.id);
  // Sent-back scenarios wait on the AI, not on the person.
  const inbox = useInbox().filter((i) => !i.waiting);
  const enterReview = () => {
    setReviewing(true);
    // Land on something to review rather than a scenario with nothing new.
    const first = inbox[0];
    if (first && !inbox.some((i) => i.scenarioId === currentId)) void open(first.scenarioId);
  };
  const tab = (on: boolean) =>
    `flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-[12px] font-semibold ${on ? "bg-sheet text-ink shadow-sheet" : "text-slate-500 hover:text-ink"}`;
  return (
    <div className="flex items-center gap-0.5 rounded-[4px] bg-slate-100 p-0.5">
      <button type="button" className={tab(!reviewing)} onClick={() => setReviewing(false)}>
        シナリオ
      </button>
      <button type="button" className={tab(reviewing)} onClick={enterReview}>
        確認待ち
        {inbox.length > 0 && <span className="rounded-[3px] bg-shu-500 px-1.5 text-[10px] leading-4 text-white">{inbox.length}</span>}
      </button>
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
  const reviewing = useStudio((s) => s.reviewing);
  const [listOpen, setListOpenState] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(LIST_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const setListOpen = (open: boolean) => {
    setListOpenState(open);
    try {
      globalThis.localStorage?.setItem(LIST_KEY, open ? "open" : "closed");
    } catch {
      // Only a remembered preference.
    }
  };
  return (
    <div className={`grid h-full grid-rows-[auto_auto_1fr_auto] ${listOpen || reviewing ? "grid-cols-[248px_minmax(0,1fr)_360px]" : "grid-cols-[44px_minmax(0,1fr)_360px]"}`}>
      {/* The window's title bar: drag anywhere that is not a control, double-click to maximize. */}
      <header data-tauri-drag-region className="relative col-span-3 flex h-12 items-center gap-3 bg-sheet px-4 select-none">
        <img data-tauri-drag-region src="/mark.png" alt="" className="h-6 w-6" draggable={false} />
        <span data-tauri-drag-region className="text-[15px] font-black tracking-wider">
          式神
        </span>
        <span data-tauri-drag-region className="-ml-1.5 text-[10px] font-medium tracking-[.2em] text-slate-400">
          STUDIO
        </span>
        <ModeSwitch />
        <ScenarioHeader />
        <span className="h-5 w-px bg-slate-200" />
        <SecretsButton />
        <WindowControls />
        <span className="swirl-line absolute inset-x-0 bottom-0 h-[2px] opacity-80" />
      </header>
      <div className="col-span-3">
        <HumanBanner />
        <SecretAskBanner />
        <Banner />
      </div>
      <div className="min-h-0">
        {reviewing ? (
          <ReviewInbox />
        ) : listOpen ? (
          <ScenarioList onCollapse={() => setListOpen(false)} />
        ) : (
          <ScenarioRail onExpand={() => setListOpen(true)} />
        )}
      </div>
      <main className="flex min-h-0 min-w-0 flex-col">
        <div className="@container relative min-h-0 flex-1">
          {view === "story" ? (
            <StoryView />
          ) : (
            <ReactFlowProvider>
              <FlowCanvas />
              {hasScenario && (
                <>
                  <OutlineToggle />
                  <OutlinePanel />
                </>
              )}
            </ReactFlowProvider>
          )}
          {hasScenario && <ViewToggle view={view} onChange={setView} />}
          {/* Clear of the zoom controls in the bottom-left corner. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-16">
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
      <StatusBar />
      <CommandPalette />
      <SecretsDialog />
    </div>
  );
}

/**
 * Moving around the flow chart without the mouse:
 * ↑↓ / j k / Tab — previous / next step (Alt+↑↓ moves the step itself),
 * Home / End — first / last, n / Shift+N — next / previous AI change,
 * Esc — clear the selection, o — the outline.
 */
function navigate(e: KeyboardEvent, state: StudioState) {
  if (!state.scenario || state.paletteOpen) return;
  // Buttons and links keep Tab for moving focus; the canvas and the page do not need it.
  const target = e.target as HTMLElement | null;
  const onControl = target?.closest("button, a, [role=tab]") && !target.closest(".react-flow");
  const key = e.key;
  const step = (delta: number) => {
    e.preventDefault();
    state.stepBy(delta);
  };
  if (e.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
    e.preventDefault();
    void state.moveSelected(key === "ArrowUp" ? -1 : 1);
  } else if (e.altKey) {
    return;
  } else if (key === "ArrowDown" || key === "j") step(1);
  else if (key === "ArrowUp" || key === "k") step(-1);
  else if (key === "Tab" && !onControl) step(e.shiftKey ? -1 : 1);
  else if (key === "Home") step(-Infinity);
  else if (key === "End") step(Infinity);
  else if (key === "n" || key === "N") {
    e.preventDefault();
    state.changeBy(e.shiftKey ? -1 : 1);
  } else if (key === "Escape" && state.selection) state.select(null);
  else if (key === "o") state.setOutlineOpen(!state.outlineOpen);
}

export function App() {
  const store = useMemo(() => createStudioStore(api), []);

  useEffect(() => {
    void store.getState().init();
    const unlisten = [
      events.onScenarioChanged((id) => void store.getState().onExternalChange(id)),
      events.onRunEvent((e) => store.getState().onRunEvent(e)),
      events.onSecretRequestsChanged(() => void store.getState().loadSecretRequests()),
    ];
    // Requests come from another process (the MCP server): re-read on refocus too.
    const onFocus = () => void store.getState().loadSecretRequests();
    window.addEventListener("focus", onFocus);
    // A new request flashes Studio in the taskbar: the user is likely in the AI's chat.
    const stopAttention = store.subscribe((s, prev) => {
      if (s.secretRequests.some((r) => !prev.secretRequests.some((p) => p.name === r.name))) {
        void getCurrentWindow()
          .requestUserAttention(UserAttentionType.Informational)
          .catch(() => {});
      }
    });
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "F5") {
        // Run, or stop with Shift, instead of reloading the window.
        e.preventDefault();
        const state = store.getState();
        if (e.shiftKey) {
          if (state.run?.status === "running") void state.stopRun();
        } else if (state.scenario && state.run?.status !== "running" && !state.validation?.issues.some((i) => i.severity === "error")) {
          void state.startRun();
        }
        return;
      }
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
      } else if (!mod) {
        navigate(e, store.getState());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
      stopAttention();
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
