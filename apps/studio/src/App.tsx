import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { AgentContext, createAgentStore, useAgent } from "./agent";
import { AgentPane } from "./components/AgentPane";
import { BottomPanel } from "./components/BottomPanel";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FlowCanvas } from "./components/FlowCanvas";
import { HistoryDialog } from "./components/HistoryDialog";
import { Inspector } from "./components/Inspector";
import { OutlinePanel } from "./components/Outline";
import { ReviewInbox, ReviewPanel, ReviewRail } from "./components/ReviewDesk";
import { Resizer } from "./components/Resizer";
import { RunPausePanel } from "./components/RunPausePanel";
import { SecretAskDialog } from "./components/SecretAskDialog";
import { SecretsPage } from "./components/SecretsPage";
import { SettingsPage } from "./components/SettingsPage";
import { ScenariosPage } from "./components/ScenariosPage";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { StoryView } from "./components/StoryView";
import { VariablesView } from "./components/VariablesView";
import { TitleBar } from "./components/TitleBar";
import { CanvasDock, OutlineButton, type View } from "./components/Toolbar";
import { StudioContext, useStudio } from "./context";
import { agent, api, events } from "./lib/api";
import { t, useLocale } from "./lib/i18n";
import { CHART_MIN, DEFAULT_SIZES, type Fit, fit as fitPanels, LIMITS, readSizes, type Sizes } from "./lib/fit";
import { createStudioStore, isActive, type StudioState } from "./store";

/** Shown while a run waits for the person at the PC (manual login, MFA). */
function HumanBanner() {
  const human = useStudio((s) => s.human);
  if (!human) return null;
  return (
    <div className="flex items-center gap-2 border-b border-shu-100 bg-shu-50 px-4 py-2 text-sm font-medium text-shu-600">
      <span className="bg-shu-500 h-2 w-2 rounded-full" />
      <span>
        {t.waitingForYou}
        {t.colon}
        {human.message}
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
      <span className={`h-1.5 w-1.5 rounded-full ${error ? "bg-shu-500" : "bg-brand-500"}`} />
      <span>{error ?? notice}</span>
      <button type="button" className="ml-auto text-xs text-slate-500 hover:underline" onClick={dismiss}>
        {t.close}
      </button>
    </div>
  );
}

const VIEW_KEY = "shikigami.studio.view";
const SIDEBAR_KEY = "shikigami.studio.list";

function useRemembered<T extends string>(key: string, fallback: T, read: (raw: string | null) => T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return read(globalThis.localStorage?.getItem(key) ?? null);
    } catch {
      return fallback;
    }
  });
  const set = (next: T) => {
    setValue(next);
    try {
      globalThis.localStorage?.setItem(key, next);
    } catch {
      // Only a remembered preference.
    }
  };
  return [value, set];
}

const SIZES_KEY = "shikigami.studio.sizes";

/** Panel widths the person dragged to, remembered across launches. */
function useSizes(): [Sizes, (next: Sizes) => void] {
  const [sizes, setSizes] = useState<Sizes>(() => {
    try {
      return readSizes(globalThis.localStorage?.getItem(SIZES_KEY) ?? null);
    } catch {
      return DEFAULT_SIZES;
    }
  });
  const set = (next: Sizes) => {
    setSizes(next);
    try {
      globalThis.localStorage?.setItem(SIZES_KEY, JSON.stringify(next));
    } catch {
      // Only a remembered preference.
    }
  };
  return [sizes, set];
}

/** The grip on a panel's inner edge; the panel is positioned relative. */
type Grip = (panel: keyof Sizes) => React.ReactNode;

/** The width of an element, kept up to date as the window is resized. */
function useWidth(): [number, (el: HTMLElement | null) => void] {
  const [width, setWidth] = useState(() => globalThis.innerWidth ?? 1400);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [width, setEl];
}

/**
 * The editor: the open scenario's chart (or procedure), what the run did and
 * what is wrong underneath, and the inspector on the right. The scenario's
 * name and its actions are in the title bar. The sidebar and the review desk
 * both open scenarios into it.
 */
function Editor({
  view,
  onView,
  list,
  right,
  rightWidth,
  grip,
}: {
  view: View;
  onView: (view: View) => void;
  list?: React.ReactNode;
  right: React.ReactNode | null;
  rightWidth: number;
  grip: Grip;
}) {
  const hasScenario = useStudio((s) => s.scenario !== null);
  const outlineOpen = useStudio((s) => s.outlineOpen);
  return (
    <div className={`grid min-h-0 min-w-0 flex-1 ${right === null ? "grid-cols-[auto_minmax(0,1fr)]" : "grid-cols-[auto_minmax(0,1fr)_auto]"}`}>
      <div className="min-h-0">{list}</div>
      <main className="flex min-h-0 min-w-0 flex-col">
        <div className="@container relative min-h-0 flex-1">
          {view === "story" ? (
            <StoryView />
          ) : view === "variables" ? (
            <VariablesView onView={onView} />
          ) : (
            <ReactFlowProvider>
              <FlowCanvas />
              {hasScenario && <OutlinePanel />}
              {/* The outline unfolds from this corner, so its button sits there. */}
              {hasScenario && !outlineOpen && (
                <div className="absolute top-3 left-3 z-10">
                  <OutlineButton />
                </div>
              )}
            </ReactFlowProvider>
          )}
          {/* Clear of the zoom controls in the bottom-left corner. */}
          {view !== "variables" && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-16">
              <CanvasDock />
            </div>
          )}
        </div>
        <RunPausePanel />
        <BottomPanel />
      </main>
      {right !== null && (
        <div className="relative min-h-0" style={{ width: rightWidth }}>
          {right}
          {grip("right")}
        </div>
      )}
    </div>
  );
}

/**
 * Something that gives way when the window is narrow, laid over the chart for
 * a moment instead, as narrow windows do in Linear and Notion. Opening a
 * scenario, moving to another place, or clicking outside closes it.
 */
function Peek({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const key = useStudio((s) => `${s.place}:${s.scenario?.id}`);
  const [opened] = useState(key);
  useEffect(() => {
    if (key !== opened) onClose();
  }, [key, opened, onClose]);
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute inset-y-0 left-0 z-40 shadow-lifted">{children}</div>
    </>
  );
}

/** The review inbox: open with room, else a strip whose » lays it over the chart. */
function InboxSlot({ room, width, grip }: { room: boolean; width: number; grip: Grip }) {
  const [peek, setPeek] = useState(false);
  // Fixed widths: a long scenario name must not widen the list into the chart.
  if (room)
    return (
      <div className="relative h-full" style={{ width }}>
        <ReviewInbox />
        {grip("inbox")}
      </div>
    );
  return (
    <div className="relative h-full w-[44px]">
      <ReviewRail onExpand={() => setPeek(true)} />
      {peek && (
        <Peek onClose={() => setPeek(false)}>
          <div className="h-full" style={{ width }}>
            <ReviewInbox onCollapse={() => setPeek(false)} />
          </div>
        </Peek>
      )}
    </div>
  );
}

type PlaceProps = { view: View; onView: (view: View) => void; fit: Fit; sizes: Sizes; grip: Grip };

function ScenariosPlace({ view, onView, fit, sizes, grip }: PlaceProps) {
  return <Editor view={view} onView={onView} right={fit.right ? <Inspector /> : null} rightWidth={sizes.right} grip={grip} />;
}

/** The review desk: what waits, the chart with the AI's changes marked, and the verdict on the right. */
function ReviewPlace({ view, onView, fit, sizes, grip }: PlaceProps) {
  const hasScenario = useStudio((s) => s.scenario !== null);
  return (
    <Editor
      view={view}
      onView={onView}
      list={<InboxSlot room={fit.inbox} width={sizes.inbox} grip={grip} />}
      rightWidth={sizes.right}
      grip={grip}
      right={
        !fit.right || !hasScenario ? null : (
          <aside className="flex h-full min-h-0 flex-col border-l border-slate-200 bg-sheet">
            <div className="flex h-10 shrink-0 items-center border-b border-slate-200 px-4 text-[12px] font-semibold">{t.reviewTab}</div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ReviewPanel />
            </div>
          </aside>
        )
      }
    />
  );
}

function Shell() {
  const place = useStudio((s) => s.place);
  const [view, setView] = useRemembered<View>(VIEW_KEY, "flow", (raw) => (raw === "story" || raw === "variables" ? raw : "flow"));
  const [sidebar, setSidebar] = useRemembered<"open" | "closed">(SIDEBAR_KEY, "open", (raw) => (raw === "closed" ? "closed" : "open"));
  const [peek, setPeek] = useState(false);
  const agentOpen = useAgent((s) => s.open);
  const [width, measure] = useWidth();
  const hasScenario = useStudio((s) => s.scenario !== null);
  const editing = place === "scenarios" || place === "review";
  const shown = { agent: agentOpen, right: editing && hasScenario, inbox: place === "review" };
  const [sizes, setSizes] = useSizes();
  const fit = fitPanels(width, { ...shown, sidebar: sidebar === "open" }, sizes);
  // Whether the sidebar would fit if it were shown, whatever the person chose.
  const room = fitPanels(width, { ...shown, sidebar: true }, sizes).sidebar;
  // A panel can grow only into the chart's room above its minimum.
  const grip: Grip = (panel) => {
    const [min, max] = LIMITS[panel];
    const size = panel === "agent" ? fit.agent : sizes[panel];
    return (
      <Resizer
        edge={panel === "right" ? "left" : "right"}
        size={size}
        min={min}
        max={Math.max(size, Math.min(max, size + fit.chart - CHART_MIN))}
        onSize={(next) => setSizes({ ...sizes, [panel]: next })}
        onReset={() => setSizes({ ...sizes, [panel]: DEFAULT_SIZES[panel] })}
      />
    );
  };
  const showSidebar = sidebar === "open" && room;
  // Hidden by hand with room, it comes back; without room, it is laid over the chart.
  const toggleSidebar = () => {
    if (showSidebar) setSidebar("closed");
    else if (room) setSidebar("open");
    else setPeek(!peek);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="flex h-full flex-col">
      <div ref={measure} className="relative flex min-h-0 flex-1 overflow-hidden">
        {showSidebar && (
          <div className="relative flex">
            <Sidebar width={sizes.sidebar} onCollapse={() => setSidebar("closed")} />
            {grip("sidebar")}
          </div>
        )}
        {!showSidebar && peek && (
          <Peek onClose={() => setPeek(false)}>
            <Sidebar width={sizes.sidebar} onCollapse={() => setPeek(false)} />
          </Peek>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <TitleBar view={view} onView={setView} onShowSidebar={showSidebar ? undefined : toggleSidebar} />
          <HumanBanner />
          <Banner />
          <div className="flex min-h-0 flex-1">
            {/* The AI's chat, beside the sidebar it is opened from. */}
            {/* Kept mounted while closed, so an unsent draft survives (the pane draws nothing then). */}
            <div className="relative flex">
              <AgentPane width={fit.agent} />
              {fit.agent > 0 && grip("agent")}
            </div>
            {/* With nothing open, the editor has nothing to show: the library does. */}
            {(place === "library" || (place === "scenarios" && !hasScenario)) && (
              <div className="min-w-0 flex-1">
                <ScenariosPage />
              </div>
            )}
            {place === "scenarios" && hasScenario && <ScenariosPlace view={view} onView={setView} fit={fit} sizes={sizes} grip={grip} />}
            {place === "review" && <ReviewPlace view={view} onView={setView} fit={fit} sizes={sizes} grip={grip} />}
            {place === "secrets" && (
              <div className="min-w-0 flex-1">
                <SecretsPage />
              </div>
            )}
            {place === "settings" && (
              <div className="min-w-0 flex-1">
                <SettingsPage />
              </div>
            )}
          </div>
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <HistoryDialog />
      <SecretAskDialog />
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
  else if ((key === "Escape" || key === "Backspace") && state.dive.length > 0) state.leaveCalls(state.dive.length - 1);
  else if (key === "o") state.setOutlineOpen(!state.outlineOpen);
}

/**
 * F5 run / continue (Shift: stop), F10 step over, F11 step into (Shift:
 * out), F9 breakpoint on the selected step. F10 / F11 start a run that
 * pauses before its first step.
 */
function debugKey(e: KeyboardEvent, state: StudioState) {
  const run = state.run;
  const paused = run?.status === "paused";
  const runnable = state.scenario && !isActive(run) && !state.validation?.issues.some((i) => i.severity === "error");
  if (e.key === "F9") {
    if (state.selection?.kind === "step") state.toggleBreakpoint(state.selection.stepId);
  } else if (e.key === "F5") {
    if (e.shiftKey) {
      if (isActive(run)) void state.stopRun();
    } else if (paused) {
      void state.debug({ action: run.pause?.reason === "error" ? "retry" : "continue" });
    } else if (runnable) {
      void state.startRun();
    }
  } else if (paused && run.pause?.reason !== "error") {
    void state.debug({ action: e.key === "F10" ? "stepOver" : e.shiftKey ? "stepOut" : "stepInto" });
  } else if (runnable && !e.shiftKey) {
    void state.startRun({ step: true });
  }
}

export function App() {
  // A language switch redraws the whole shell; the stores (and the open scenario) stay.
  const { locale } = useLocale();
  const store = useMemo(() => createStudioStore(api), []);
  const agentStore = useMemo(() => createAgentStore(agent), []);

  useEffect(() => {
    void store.getState().init();
    const unlisten = [
      events.onScenarioChanged((id) => void store.getState().onExternalChange(id)),
      events.onRunEvent((e) => store.getState().onRunEvent(e)),
      events.onRunEvidence((e) => store.getState().onRunEvidence(e)),
      events.onSecretRequestsChanged(() => void store.getState().loadSecretRequests()),
      agent.onEvent((e) => agentStore.getState().onEvent(e)),
      agent.onLogin((e) => agentStore.getState().onLoginEvent(e)),
    ];
    void agentStore.getState().init();
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
      if (e.key === "F5" || e.key === "F9" || e.key === "F10" || e.key === "F11") {
        // Run and step like a debugger, instead of reloading the window.
        e.preventDefault();
        debugKey(e, store.getState());
        return;
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        agentStore.getState().setOpen(!agentStore.getState().open);
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
  }, [store, agentStore]);

  return (
    <StudioContext.Provider value={store}>
      <AgentContext.Provider value={agentStore}>
        <ErrorBoundary>
          <Shell key={locale} />
        </ErrorBoundary>
      </AgentContext.Provider>
    </StudioContext.Provider>
  );
}
