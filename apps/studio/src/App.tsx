import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { setPartLookup } from "./lib/sentence";
import { activity, AgentContext, createAgentStore, useAgent } from "./agent";
import { AgentPane } from "./components/AgentPane";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { PickRequestCard } from "./components/PickRequestCard";
import { BottomPanel } from "./components/BottomPanel";
import { CommandPalette } from "./components/CommandPalette";
import { ContextMenu } from "./components/ContextMenu";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FlowCanvas } from "./components/FlowCanvas";
import { AiPasteDialog } from "./components/AiPasteDialog";
import { HistoryDialog } from "./components/HistoryDialog";
import { Inspector } from "./components/Inspector";
import { OutlinePanel } from "./components/Outline";
import { FileSheet } from "./components/FileSheet";
import { NodeEditor } from "./components/NodeEditor";
import { ProjectButton, ProjectPanel } from "./components/ProjectPanel";
import { FileDragLayer } from "./components/FileDrag";
import { ReviewInbox, ReviewPanel, ReviewRail } from "./components/ReviewDesk";
import { Resizer } from "./components/Resizer";
import { RunPausePanel } from "./components/RunPausePanel";
import { SecretAskDialog } from "./components/SecretAskDialog";
import { RunsPage } from "./components/RunsPage";
import { SecretsPage } from "./components/SecretsPage";
import { ExtensionsPage } from "./components/ExtensionsPage";
import { SettingsPage } from "./components/SettingsPage";
import { FlowsPage } from "./components/FlowsPage";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { StoryView } from "./components/StoryView";
import { VariablesView } from "./components/VariablesView";
import { TitleBar } from "./components/TitleBar";
import { CanvasDock, OutlineButton, type View } from "./components/Toolbar";
import { StudioContext, useStudio, useStudioApi } from "./context";
import { agent, api, events } from "./lib/api";
import { installContextMenu } from "./lib/contextMenu";
import { t, useLocale } from "./lib/i18n";
import { CHART_MIN, DEFAULT_SIZES, type Fit, fit as fitPanels, LIMITS, readSizes, type Sizes } from "./lib/fit";
import { lastAdded, shouldFollow, stepIds } from "./lib/followAi";
import { createProjectStore, ProjectContext, projectApi, useProject } from "./project";
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
  const store = useStudioApi();
  // A notice says something went as asked; it leaves by itself. Errors stay until closed.
  useEffect(() => {
    if (!notice || error) return;
    const timer = setTimeout(() => {
      if (store.getState().notice === notice) store.setState({ notice: null });
    }, 6000);
    return () => clearTimeout(timer);
  }, [notice, error, store]);
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
 * The editor: the open flow's chart (or procedure), what the run did and
 * what is wrong underneath, and the inspector on the right. The flow's
 * name and its actions are in the title bar. The sidebar and the review desk
 * both open flows into it.
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
  const hasFlow = useStudio((s) => s.flow !== null);
  const outlineOpen = useStudio((s) => s.outlineOpen);
  const projectOpen = useProject((s) => s.panelOpen);
  const outlineLeft = projectOpen ? 12 + 264 + 12 : 12;
  return (
    <div className={`relative grid min-h-0 min-w-0 flex-1 ${right === null ? "grid-cols-[auto_minmax(0,1fr)]" : "grid-cols-[auto_minmax(0,1fr)_auto]"}`}>
      {/* A node opened full size covers the chart and the right pane. */}
      <NodeEditor />
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
              {/* The flow's files float over the left of the chart; the outline sits beside them. */}
              {hasFlow && projectOpen && (
                <div className="absolute top-3 bottom-3 left-3 z-10">
                  <ProjectPanel />
                </div>
              )}
              {hasFlow && <OutlinePanel left={outlineLeft} />}
              {/* The outline unfolds from this corner, so its button sits there. */}
              {hasFlow && !outlineOpen && (
                <div className="absolute top-3 z-10 flex gap-2" style={{ left: outlineLeft }}>
                  {!projectOpen && <ProjectButton />}
                  <OutlineButton />
                </div>
              )}
            </ReactFlowProvider>
          )}
          <FileSheet />
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
 * flow, moving to another place, or clicking outside closes it.
 */
function Peek({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const key = useStudio((s) => `${s.place}:${s.flow?.id}`);
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
  // Fixed widths: a long flow name must not widen the list into the chart.
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

function FlowsPlace({ view, onView, fit, sizes, grip }: PlaceProps) {
  return <Editor view={view} onView={onView} right={fit.right ? <Inspector /> : null} rightWidth={sizes.right} grip={grip} />;
}

/** The review desk: what waits, the chart with the AI's changes marked, and the verdict on the right. */
function ReviewPlace({ view, onView, fit, sizes, grip }: PlaceProps) {
  const hasFlow = useStudio((s) => s.flow !== null);
  return (
    <Editor
      view={view}
      onView={onView}
      list={<InboxSlot room={fit.inbox} width={sizes.inbox} grip={grip} />}
      rightWidth={sizes.right}
      grip={grip}
      right={
        !fit.right || !hasFlow ? null : (
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
  const focusAgent = useAgent((s) => s.focus);
  const openId = useStudio((s) => s.flow?.id ?? null);
  const openName = useStudio((s) => s.flow?.name ?? "");
  // The AI pane follows the flow open in the editor; other conversations keep running.
  useEffect(() => {
    focusAgent(openId ? { id: openId, name: openName } : null);
  }, [focusAgent, openId, openName]);
  const [width, measure] = useWidth();
  const hasFlow = useStudio((s) => s.flow !== null);
  const editing = place === "flows" || place === "review";
  const shown = { agent: agentOpen, right: editing && hasFlow, inbox: place === "review" };
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
    <div className="flex h-full flex-col bg-frame">
      <div ref={measure} className="relative flex min-h-0 flex-1 overflow-hidden">
        {showSidebar && (
          <div className="relative flex">
            <Sidebar width={sizes.sidebar} onToggle={() => setSidebar("closed")} />
            {grip("sidebar")}
          </div>
        )}
        {/* Folded, the sidebar keeps its icons; its button unfolds it, or lays it over the chart without room. */}
        {!showSidebar && <Sidebar width={sizes.sidebar} onToggle={toggleSidebar} mini />}
        {!showSidebar && peek && (
          <Peek onClose={() => setPeek(false)}>
            <Sidebar width={sizes.sidebar} onToggle={() => setPeek(false)} />
          </Peek>
        )}
        {/* The work floats on the window's ground, framed and rounded, as in Linear. */}
        <div className="mt-1.5 mr-1.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-sheet">
          <TitleBar view={view} onView={setView} />
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
            {(place === "library" || (place === "flows" && !hasFlow)) && (
              <div className="min-w-0 flex-1">
                <FlowsPage />
              </div>
            )}
            {place === "flows" && hasFlow && <FlowsPlace view={view} onView={setView} fit={fit} sizes={sizes} grip={grip} />}
            {place === "review" && <ReviewPlace view={view} onView={setView} fit={fit} sizes={sizes} grip={grip} />}
            {place === "runs" && (
              <div className="min-w-0 flex-1">
                <RunsPage />
              </div>
            )}
            {place === "secrets" && (
              <div className="min-w-0 flex-1">
                <SecretsPage />
              </div>
            )}
            {place === "extensions" && (
              <div className="min-w-0 flex-1">
                <ExtensionsPage />
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
      <AiPasteDialog />
      <SecretAskDialog />
      <ApprovalDialog />
      <PickRequestCard />
      <ContextMenu />
      <FileDragLayer />
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
  if (!state.flow || state.paletteOpen) return;
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
  const runnable = state.flow && !isActive(run) && !state.validation?.issues.some((i) => i.severity === "error");
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
  // A language switch redraws the whole shell; the stores (and the open flow) stay.
  const { locale } = useLocale();
  const store = useMemo(() => createStudioStore(api), []);
  // Sentences name a node's part by its label (`{ part: "btnSave" }` → 部品「保存ボタン」).
  setPartLookup((name) => store.getState().flow?.parts?.[name]);
  const agentStore = useMemo(() => createAgentStore(agent), []);
  const projectStore = useMemo(() => createProjectStore(projectApi, { added: (n, folder) => t.project.added(n, folder), discard: () => t.project.sheet.discard }), []);

  useEffect(() => {
    void store.getState().init();
    // While the AI asked in the pane works, Studio follows it: a flow it
    // has just made opens, and the chart pans to the nodes it adds. Only
    // changes from outside count, so the person's own edits never move the view.
    const followChange = async (id: string) => {
      const before = store.getState();
      const known = before.summaries.some((s) => s.id === id);
      const shown = before.flow?.id === id ? stepIds(before.flow.steps ?? []) : null;
      await store.getState().onExternalChange(id);
      const now = store.getState();
      const working = activity(agentStore.getState());
      if (!working) return;
      // The pane and the status bar already say the AI is at work; a notice per edit is noise.
      if (now.notice === t.externalChange) store.setState({ notice: null });
      let opened = false;
      if (shouldFollow(id, known, working, now)) {
        await now.open(id);
        opened = store.getState().flow?.id === id;
        const name = store.getState().flow?.name;
        if (opened && name) store.setState({ notice: t.openedAiFlow(name) });
      }
      const after = store.getState();
      if (after.flow?.id !== id || (!opened && shown === null)) return;
      const stepId = lastAdded(opened ? null : shown, after.flow.steps ?? []);
      if (stepId) store.setState({ reveal: { stepId, seq: (after.reveal?.seq ?? 0) + 1 } });
    };
    const unlisten = [
      events.onFlowChanged((id) => void followChange(id)),
      events.onRunEvent((e) => store.getState().onRunEvent(e)),
      events.onRunEvidence((e) => store.getState().onRunEvidence(e)),
      events.onSecretRequestsChanged(() => void store.getState().loadSecretRequests()),
      events.onApprovalsChanged(() => void store.getState().loadApprovals()),
      events.onPickRequestsChanged(() => void store.getState().loadPickRequests()),
      agent.onEvent((e) => agentStore.getState().onEvent(e)),
      agent.onLogin((e) => agentStore.getState().onLoginEvent(e)),
      agent.onInstall((e) => agentStore.getState().onInstallEvent(e)),
    ];
    void agentStore.getState().init();
    // The files follow the open flow, and the watcher's word that its folder changed.
    void projectStore.getState().load(store.getState().flow?.id ?? null);
    const stopProject = store.subscribe((s, prev) => {
      if (s.flow?.id !== prev.flow?.id) void projectStore.getState().load(s.flow?.id ?? null);
    });
    unlisten.push(projectApi.onChanged((id) => void projectStore.getState().onChanged(id)));
    // Requests come from another process (the MCP server): re-read on refocus too.
    void store.getState().loadApprovals();
    void store.getState().loadPickRequests();
    const onFocus = () => {
      void store.getState().loadSecretRequests();
      void store.getState().loadApprovals();
      void store.getState().loadPickRequests();
    };
    window.addEventListener("focus", onFocus);
    // A new request flashes Studio in the taskbar: the user is likely in the AI's chat.
    const stopAttention = store.subscribe((s, prev) => {
      const asked =
        s.secretRequests.some((r) => !prev.secretRequests.some((p) => p.name === r.name)) ||
        s.approvals.some((r) => !prev.approvals.some((p) => p.id === r.id)) ||
        s.pickRequests.some((r) => !prev.pickRequests.some((p) => p.id === r.id));
      if (asked) {
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
        if (store.getState().flow) store.getState().setPaletteOpen(!store.getState().paletteOpen);
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
    // The browser's right-click menu (back, reload, print…) never shows.
    const stopMenu = installContextMenu();
    return () => {
      stopMenu();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
      stopAttention();
      stopProject();
      for (const p of unlisten) void p.then((off) => off());
    };
  }, [store, agentStore, projectStore]);

  return (
    <StudioContext.Provider value={store}>
      <AgentContext.Provider value={agentStore}>
        <ProjectContext.Provider value={projectStore}>
          <ErrorBoundary>
            <Shell key={locale} />
          </ErrorBoundary>
        </ProjectContext.Provider>
      </AgentContext.Provider>
    </StudioContext.Provider>
  );
}
