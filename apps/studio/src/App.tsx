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
import { Rail } from "./components/Rail";
import { ReviewInbox, ReviewPanel, ReviewRail } from "./components/ReviewDesk";
import { RunPausePanel } from "./components/RunPausePanel";
import { ScenarioList, ScenarioRail } from "./components/ScenarioList";
import { SecretAskDialog } from "./components/SecretAskDialog";
import { SecretsPage } from "./components/SecretsPage";
import { SettingsPage } from "./components/SettingsPage";
import { StatusBar } from "./components/StatusBar";
import { StoryView } from "./components/StoryView";
import { TitleBar } from "./components/TitleBar";
import { CanvasDock, OutlineButton, type View } from "./components/Toolbar";
import { StudioContext, useStudio } from "./context";
import { agent, api, events } from "./lib/api";
import { t, useLocale } from "./lib/i18n";
import { type Fit, fit as fitPanels, RIGHT } from "./lib/fit";
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
const LIST_KEY = "shikigami.studio.list";

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
 * name and its actions are in the title bar. The scenario list and the review
 * desk both open scenarios into it.
 */
function Editor({ view, list, right }: { view: View; list: React.ReactNode; right: React.ReactNode | null }) {
  const hasScenario = useStudio((s) => s.scenario !== null);
  const outlineOpen = useStudio((s) => s.outlineOpen);
  return (
    <div className={`grid min-h-0 min-w-0 flex-1 ${right === null ? "grid-cols-[auto_minmax(0,1fr)]" : "grid-cols-[auto_minmax(0,1fr)_auto]"}`}>
      <div className="min-h-0">{list}</div>
      <main className="flex min-h-0 min-w-0 flex-col">
        <div className="@container relative min-h-0 flex-1">
          {view === "story" ? (
            <StoryView />
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
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-16">
            <CanvasDock />
          </div>
        </div>
        <RunPausePanel />
        <BottomPanel />
      </main>
      {right !== null && (
        <div className="min-h-0" style={{ width: RIGHT }}>
          {right}
        </div>
      )}
    </div>
  );
}

/**
 * The list column of a place. With room it is open (unless folded by hand);
 * without, it is a strip whose » lays the list over the chart for a moment,
 * as narrow windows do in Linear and Notion. Opening a scenario closes it.
 */
function ListSlot({
  room,
  open,
  onOpen,
  full,
  strip,
}: {
  room: boolean;
  open: boolean;
  onOpen: () => void;
  full: (fold: () => void) => React.ReactNode;
  strip: (expand: () => void) => React.ReactNode;
}) {
  const [peek, setPeek] = useState(false);
  const currentId = useStudio((s) => s.scenario?.id);
  useEffect(() => setPeek(false), [currentId, room]);
  // Fixed widths: a long scenario name must not widen the list into the chart.
  if (open && room) return <div className="h-full w-[248px]">{full(() => {})}</div>;
  return (
    <div className="relative h-full w-[44px]">
      {strip(() => (room ? onOpen() : setPeek(true)))}
      {peek && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setPeek(false)} />
          <div className="absolute inset-y-0 left-0 z-30 w-[248px] shadow-lifted">{full(() => setPeek(false))}</div>
        </>
      )}
    </div>
  );
}

function ScenariosPlace({ view, fit }: { view: View; fit: Fit }) {
  const [list, setList] = useRemembered<"open" | "closed">(LIST_KEY, "open", (raw) => (raw === "closed" ? "closed" : "open"));
  return (
    <Editor
      view={view}
      list={
        <ListSlot
          room={fit.list}
          open={list === "open"}
          onOpen={() => setList("open")}
          full={(close) => <ScenarioList onCollapse={list === "open" && fit.list ? () => setList("closed") : close} />}
          strip={(expand) => <ScenarioRail onExpand={expand} />}
        />
      }
      right={fit.right ? <Inspector /> : null}
    />
  );
}

/** The review desk: what waits, the chart with the AI's changes marked, and the verdict on the right. */
function ReviewPlace({ view, fit }: { view: View; fit: Fit }) {
  const hasScenario = useStudio((s) => s.scenario !== null);
  return (
    <Editor
      view={view}
      list={
        <ListSlot
          room={fit.list}
          open
          onOpen={() => {}}
          full={(close) => <ReviewInbox onCollapse={fit.list ? undefined : close} />}
          strip={(expand) => <ReviewRail onExpand={expand} />}
        />
      }
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
  const [view, setView] = useRemembered<View>(VIEW_KEY, "flow", (raw) => (raw === "story" ? "story" : "flow"));
  const agentOpen = useAgent((s) => s.open);
  const [width, measure] = useWidth();
  const hasScenario = useStudio((s) => s.scenario !== null);
  const fit = fitPanels(width, agentOpen, hasScenario);
  return (
    <div className="flex h-full flex-col">
      {/* The rail runs to the top edge: it is where you are, the title bar is what is open. */}
      <div className="flex min-h-0 flex-1">
        <Rail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TitleBar view={view} onView={setView} />
          <HumanBanner />
          <Banner />
          <div ref={measure} className="flex min-h-0 flex-1 overflow-hidden">
            {place === "scenarios" && <ScenariosPlace view={view} fit={fit} />}
            {place === "review" && <ReviewPlace view={view} fit={fit} />}
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
            <AgentPane width={fit.agent} />
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
