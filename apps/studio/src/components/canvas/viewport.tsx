// Moving the view: bringing a node into view, following a run, and the bar
// that shows which called flow the chart has opened.
import { useReactFlow, useStore } from "@xyflow/react";
import { ArrowUp, ArrowUpRight, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useStudio } from "../../context";
import { ancestorsOf, NODE_W } from "../../flow/layout";
import { t } from "../../lib/i18n";
import { useProjectMaybe } from "../../project";
import type { Flow } from "@spellsheet/schema";
import { makeGlider } from "../../lib/glide";
import { callKey, type DiveLevel } from "../../store";
import { MIN_READABLE_ZOOM } from "./StepNode";
import { reducedMotion } from "./edges";

/** Width of the outline panel plus its gap, from the canvas's left edge. */
export const OUTLINE_W = 284;

/** The project panel over the left of the chart, with its margins. */
export const PROJECT_W = 288;

/** The selected node's tools beside it (↑ ↓ まとめる…), kept clear of the inspector. */
export const TOOLS_W = 200;

/** The dock floating over the bottom of the chart. */
export const DOCK_H = 72;

/**
 * On the review desk, brings a step into view: the first one the AI changed,
 * then whichever change the reviewer picks.
 */
export function FocusOn({ id }: { id: string | undefined }) {
  const rf = useReactFlow();
  useEffect(() => {
    if (!id) return;
    // After the canvas has measured its nodes and placed its starting view.
    const timer = setTimeout(() => void rf.fitView({ nodes: [{ id }], padding: 1.2, maxZoom: 1, minZoom: MIN_READABLE_ZOOM, duration: 300 }), 200);
    return () => clearTimeout(timer);
  }, [rf, id]);
  return null;
}

/** Pans just enough to bring a step into view (centring it), keeping a readable zoom. */
export function useBringIntoView() {
  const rf = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // The outline covers the left edge of the chart while it is open.
  const outlineW = useStudio((s) => (s.outlineOpen ? OUTLINE_W : 0));
  // So does the project panel, with the outline beside it.
  // With the project panel open, the outline sits under it in the same column.
  const projectCovers = useProjectMaybe((s) => s.panelOpen, false);
  const covered = projectCovers ? PROJECT_W : outlineW;
  const flow = useStudio((s) => s.flow);
  // One glide for the chart: a step that comes while it is on its way only moves where it goes.
  const glider = useMemo(() => makeGlider(() => rf.getViewport(), (view) => void rf.setViewport(view)), [rf]);
  useEffect(() => () => glider.stop(), [glider]);
  return useCallback(
    function bring(id: string, again = true) {
      // Inside a folded frame: the head of the outermost folded one shows where it is.
      const around = flow ? ancestorsOf(flow.steps ?? [], id) : [];
      const node = rf.getInternalNode(id) ?? around.map((a) => rf.getInternalNode(a)).find((n) => n && n.data.head && (n.data.head as { collapsed: boolean }).collapsed);
      // A frame just opened to show it: its nodes are on the chart a frame later.
      if (!node) {
        if (again) requestAnimationFrame(() => bring(id, false));
        return;
      }
      const { x, y } = node.internals.positionAbsolute;
      const w = node.measured.width ?? NODE_W;
      const h = node.measured.height ?? 80;
      // Judged from where a glide on its way ends up, so the next step there does not move it again.
      const view = glider.target() ?? rf.getViewport();
      const margin = 48;
      const left = x * view.zoom + view.x;
      const top = y * view.zoom + view.y;
      // Room on the right for the node's tools, and at the bottom for the dock.
      const inside =
        left >= covered + margin &&
        top >= margin &&
        left + w * view.zoom <= width - margin - TOOLS_W &&
        top + h * view.zoom <= height - margin - DOCK_H;
      if (inside && view.zoom >= MIN_READABLE_ZOOM) return;
      const zoom = Math.max(view.zoom, MIN_READABLE_ZOOM);
      // Centre in the part of the canvas the outline, the tools and the dock leave free.
      const cx = x + w / 2 + (TOOLS_W - covered) / 2 / zoom;
      const cy = y + h / 2 + DOCK_H / 2 / zoom;
      const to = { x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom };
      if (reducedMotion()) {
        glider.stop();
        void rf.setViewport(to);
      } else glider.to(to);
    },
    [rf, width, height, covered, flow, glider],
  );
}

/** Inside an entered call: keeps its running step in view while a run is followed. */
export function FollowInside({ path }: { path: string }) {
  const latest = useBringIntoView();
  const bring = useRef(latest);
  bring.current = latest;
  const running = useStudio((s) => (s.run?.status === "running" && s.followRun ? s.run.innerLatest[path] : undefined));
  useEffect(() => {
    if (running) bring.current(running);
  }, [running]);
  // A log line or a failure that leads to a node in here (`goToPlace`).
  const reveal = useStudio((s) => (s.reveal?.inside === path ? s.reveal : null));
  useEffect(() => {
    if (!reveal) return;
    // After the entered flow has been laid out.
    const timer = setTimeout(() => bring.current(reveal.stepId), 120);
    return () => clearTimeout(timer);
  }, [reveal]);
  // Where a run paused in here, once the pause panel has taken its room.
  const paused = useStudio((s) => (s.run?.status === "paused" && s.run.pause && callKey(s.run.pause.callPath) === path ? s.run.pause : undefined));
  useEffect(() => {
    if (!paused) return;
    const timer = setTimeout(() => bring.current(paused.stepId), 120);
    return () => clearTimeout(timer);
  }, [paused]);
  return null;
}

/** Follows keyboard / outline jumps, and the running step while a run is followed. */
export function Follow() {
  const latest = useBringIntoView();
  const bring = useRef(latest);
  bring.current = latest;
  const reveal = useStudio((s) => (s.reveal?.inside ? null : s.reveal));
  const running = useStudio((s) => (s.run?.status === "running" && s.followRun ? s.run.starts.at(-1)?.stepId : undefined));
  // Only a new request moves the view, not a resize or re-measure.
  useEffect(() => {
    if (reveal) bring.current(reveal.stepId);
  }, [reveal]);
  useEffect(() => {
    if (running) bring.current(running);
  }, [running]);
  // Where a run paused, once the pause panel has taken its room from the canvas.
  const paused = useStudio((s) => (s.run?.status === "paused" ? s.run.pause?.seq : undefined));
  const pausedAt = useStudio((s) => (s.run?.pause?.callPath.length === 0 ? s.run.pause.stepId : undefined));
  useEffect(() => {
    if (paused === undefined || !pausedAt) return;
    const timer = setTimeout(() => bring.current(pausedAt), 120);
    return () => clearTimeout(timer);
  }, [paused, pausedAt]);
  return null;
}

/**
 * Where the chart is when it has entered calls: the open flow, then each
 * called one, to click back up to; and a way to open the shown one for editing.
 */
export function DiveBar({ root, chain }: { root: Flow; chain: DiveLevel[] }) {
  const leave = useStudio((s) => s.leaveCalls);
  const open = useStudio((s) => s.open);
  const shown = chain.at(-1)!.flow;
  const levels = [root, ...chain.map((level) => level.flow)];
  return (
    // As wide as its words: a centred panel would otherwise only get half the canvas.
    <div className="flex w-max max-w-[min(760px,calc(100cqw-32px))] items-center gap-1 rounded-lg border border-slate-200 bg-sheet py-1 pr-1 pl-1 text-[12px] shadow-raised">
      <button
        type="button"
        title={t.diveUp}
        aria-label={t.diveUp}
        onClick={() => leave(chain.length - 1)}
        className="flex h-[22px] shrink-0 items-center rounded-md px-1.5 text-slate-600 hover:bg-slate-100"
      >
        <ArrowUp size={14} />
      </button>
      <nav aria-label="breadcrumb" className="flex min-w-0 items-center gap-1">
        {levels.map((level, depth) => (
          <span key={depth} className="flex max-w-[14em] min-w-0 items-center gap-1">
            {depth > 0 && <ChevronRight size={12} className="shrink-0 text-slate-400" />}
            {depth < chain.length ? (
              <button
                type="button"
                onClick={() => leave(depth)}
                className="truncate rounded-md px-1 leading-[22px] text-brand-600 hover:bg-slate-100 hover:underline"
              >
                {level.name}
              </button>
            ) : (
              <span aria-current="page" className="truncate px-1 font-semibold">
                {level.name}
              </span>
            )}
          </span>
        ))}
      </nav>
      <span title={t.diveReadOnly} className="ml-1 shrink-0 rounded-md bg-slate-100 px-1.5 text-[11px] leading-[20px] text-slate-500">
        {t.diveViewOnly}
      </span>
      <button
        type="button"
        onClick={() => void open(shown.id)}
        title={t.diveOpen}
        className="ml-1 flex shrink-0 items-center gap-0.5 rounded-md border border-slate-300 bg-sheet px-2 leading-[20px] text-[11px] font-medium text-ink hover:bg-slate-100"
      >
        {t.diveOpenLabel}
        <ArrowUpRight size={12} />
      </button>
    </div>
  );
}
