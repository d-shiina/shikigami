// The lines of the flow chart: the flow between nodes (with the + to add a
// node), the light of a run along them, and the links of a variable.
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
  type Edge,
  Position,
  useStore,
} from "@xyflow/react";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../../context";
import { DECIDE_H, type Layout, TAIL_W } from "../../flow/layout";
import { t } from "../../lib/i18n";
import { useFocus, varFocus } from "../../lib/focus";
import type { InsertAt } from "../../store";
import type { LineTrail } from "../../lib/trail";
import { type Box, type Point, roundedPath, routeLink } from "../../lib/linkRoute";

export type LinkEdgeData = { variable: string; color: string; from: string; to: string; selectedId: string | null };

/**
 * Which node a value goes to: drawn only for the variable or step in focus
 * (hovered, or else the selected step), from the writer's output socket to
 * each reader's input socket. Hidden otherwise, so many variables never
 * become a web of lines.
 */
export function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<LinkEdgeData>>) {
  const hovered = useFocus();
  if (!data) return null;
  const focused = hovered ?? data.selectedId;
  const lit = focused !== null && (focused === data.from || focused === data.to || focused === varFocus(data.variable));
  if (!lit) return null;
  return <RoutedLink id={id} from={{ x: sourceX, y: sourceY }} to={{ x: targetX, y: targetY }} data={data} sourcePosition={sourcePosition} targetPosition={targetPosition} />;
}

/** A lit variable's line, round the nodes on the chart rather than behind them (see routeLink). */
export function RoutedLink({ id, from, to, data, sourcePosition, targetPosition }: { id: string; from: Point; to: Point; data: LinkEdgeData; sourcePosition: Position; targetPosition: Position }) {
  const lookup = useStore((s) => s.nodeLookup);
  const boxes: Box[] = [];
  let toTop: number | undefined;
  for (const n of lookup.values()) {
    if (n.type === "frame" || n.type === "join") continue;
    const box = { ...n.internals.positionAbsolute, width: n.measured.width ?? 0, height: n.measured.height ?? 0 };
    if (box.width === 0 || box.height === 0) continue;
    if (n.id === data.to) toTop = box.y;
    boxes.push(box);
  }
  // Before the nodes are measured: the plain curve.
  const path =
    toTop === undefined
      ? getBezierPath({ sourceX: from.x, sourceY: from.y, targetX: to.x, targetY: to.y, sourcePosition, targetPosition })[0]
      : roundedPath(routeLink(from, to, toTop, boxes));
  return <BaseEdge id={id} path={path} style={{ stroke: data.color, strokeWidth: 1.5 }} />;
}

/**
 * A step-to-step edge. Its block label ("受注一覧 の 1 件ずつ", "失敗したら") sits just
 * above the step it leads to, not halfway, where sibling edges share a line.
 */
export type BlockEdgeData = {
  /** A loop's line back: the x it runs up at. */
  detourX?: number;
  fromDecide?: boolean;
  intoDecide?: boolean;
  /** A loop's "いいえ": the x it runs down at. */
  railX?: number;
  /** A loop's "いいえ": when it leaves ("すべて終わったら"), beside the line into the foot. */
  exit?: string;
  /** A wait's line back: the answer it takes, on the line beside its decision. */
  answer?: string;
  half?: number;
  /** Into a try's "失敗したとき". */
  failure?: boolean;
  /** The loop it belongs to (see LayoutEdge). */
  owner?: string;
  /** The step picked in the chart: pointing at or picking a loop moves its line back. */
  selectedId?: string | null;
  /** Into a try's "失敗したとき": where its failures come from (see FAIL_X). */
  bracket?: { x: number; ticks: { x: number; y: number }[] };
  /** From the head of a frame into one of its columns. */
  split?: boolean;
  /** Where a node added on this line goes (just before the step it leads to); absent where nothing can be added. */
  insert?: InsertAt;
  /** The pointer is on the line or its "+". */
  hovered?: boolean;
  hover?: (id: string | null) => void;
};

/**
 * 「＋ ノード追加」: how every place a node can be added looks on the chart, on a
 * line between nodes as at the end of a block (see SlotNode), as wide as
 * TAIL_W. It shows where the pointer is (see SlotNode), so the chart stays
 * quiet; an empty block says it in full all the time instead.
 */
export const ADD_PILL =
  "flex h-[22px] shrink-0 items-center justify-center gap-1 rounded-md border border-dashed border-slate-400 bg-sheet text-[11.5px] leading-none whitespace-nowrap text-slate-600 hover:border-solid hover:border-primary hover:text-primary";

/** ADD_PILL while its place is the one picked (its palette is open). */
export const ADD_PILL_ON =
  "flex h-[22px] shrink-0 items-center justify-center gap-1 rounded-md border border-brand-500 bg-brand-50 text-[11.5px] leading-none whitespace-nowrap text-brand-600";

/** What an add button says: the same words everywhere (the toolbar's, an empty block's). */
export function AddLabel() {
  return (
    <>
      <Plus size={12} strokeWidth={2.25} aria-hidden="true" />
      {t.addStep}
    </>
  );
}

/**
 * The 「＋ ノード追加」 on a line between nodes: shown while the pointer is on
 * the line, it opens the node palette to add a node right there.
 */
export function InsertButton({ edgeId, data, x, y, inline }: { edgeId: string; data: BlockEdgeData; x?: number; y?: number; inline?: boolean }) {
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  if (!data.insert) return null;
  const at = data.insert;
  return (
    <button
      type="button"
      title={t.menu.addHere}
      onMouseEnter={() => data.hover?.(edgeId)}
      onMouseLeave={() => data.hover?.(null)}
      onFocus={() => data.hover?.(edgeId)}
      onBlur={() => data.hover?.(null)}
      onClick={(e) => {
        e.stopPropagation();
        setPaletteOpen(true, at, e.currentTarget.getBoundingClientRect());
      }}
      style={{ width: TAIL_W, ...(inline ? {} : { transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }) }}
      className={`nodrag nopan pointer-events-auto shadow-raised ${ADD_PILL} ${inline ? "ml-1" : "absolute"} ${
        data.hovered ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <AddLabel />
    </button>
  );
}

/** Nothing on the chart moves for someone who asked for less motion. */
export const reducedMotion = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Which of a branch's n ways out is lit now, while `on`: each in turn, as only one of them is taken. */
export const ALT_MS = 900;

export function useTurn(n: number, on: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on || reducedMotion()) return;
    // Tick on the turn's boundary, so every line and node that lights in turn changes together.
    let timer = 0;
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, ALT_MS - (Date.now() % ALT_MS) + 5);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [on]);
  if (!on || reducedMotion()) return null;
  return Math.floor(now / ALT_MS) % Math.max(n, 1);
}

/**
 * While an if or a switch is pointed at, the columns it does not take this turn
 * (their nodes and lines) are dimmed, in turn, so its ways out read as one or the other. Only while
 * pointed at: a branch that is picked to edit its settings stays still.
 * Done with a style sheet keyed on node ids, so nothing on the chart re-renders.
 */
export function BranchLight({ layout }: { layout: Layout }) {
  const pointed = useFocus();
  const owners = useMemo(() => {
    const out = new Map<string, number>();
    for (const e of layout.edges) if (e.owner && e.alt) out.set(e.owner, e.alt.n);
    return out;
  }, [layout]);
  const owner = pointed && owners.has(pointed) ? pointed : null;
  const turn = useTurn(owner ? owners.get(owner)! : 1, owner !== null);
  if (owner === null || turn === null) return null;
  const off = (places?: { owner: string; i: number }[]) => !!places?.some((p) => p.owner === owner && p.i !== turn);
  const nodes = layout.nodes.filter((n) => off(n.branches)).map((n) => n.id);
  const frames = layout.frames.filter((f) => off(f.branches)).map((f) => `frame:${f.id}`);
  const dim = new Set(nodes);
  // The lines among them, and the line down into each of them from the decision. Only dimmed:
  // a line's colour says where a run went (see TRAIL_STROKE), so pointing at one never recolours it.
  const edges = layout.edges
    .filter((e) => (dim.has(e.source) && dim.has(e.target)) || (e.owner === owner && e.alt !== undefined && e.alt.i !== turn))
    .map((e) => e.id);
  const selectors = [
    ...[...nodes, ...frames].map((id) => `.react-flow__node[data-id="${CSS.escape(id)}"]`),
    ...edges.map((id) => `[data-testid="rf__edge-${CSS.escape(id)}"]`),
  ];
  if (selectors.length === 0) return null;
  return <style>{`${selectors.join(",")}{opacity:.28;transition:opacity .25s}`}</style>;
}

/**
 * The frame of the step pointed at (at its head or anywhere inside it) shows it as one
 * piece: its edge and its head's darken together, as the head alone does on hover.
 */
export function FrameLight({ layout }: { layout: Layout }) {
  const pointed = useFocus();
  if (!pointed || !layout.frames.some((f) => f.id === pointed)) return null;
  const id = CSS.escape(pointed);
  const frame = CSS.escape(`frame:${pointed}`);
  return (
    <style>{`.react-flow__node[data-id="${frame}"] .flow-frame:not(.flow-frame-selected),.react-flow__node[data-id="${id}"] .flow-head-plain{border-color:var(--color-slate-400)}`}</style>
  );
}

export function BlockEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, style, markerEnd, data }: EdgeProps) {
  const edge = (data ?? {}) as BlockEdgeData;
  const detourX = edge.detourX;
  const r = 4;
  // Pointing at (or picking) a loop sends its line back round (a branch's ways out are lit in turn by BranchLight).
  const pointed = useFocus();
  const active = !!edge.owner && (pointed === edge.owner || edge.selectedId === edge.owner);
  const sideLabel = (x: number, y: number) =>
    label && (
      <EdgeLabelRenderer>
        <span
          style={{ transform: `translate(${x}px, ${y}px)` }}
          className="pointer-events-none absolute top-0 left-0 text-[11px] leading-4 whitespace-nowrap text-slate-500"
        >
          {label}
        </span>
      </EdgeLabelRenderer>
    );
  if (detourX !== undefined) {
    // A loop's line back, up the left of its frame: from the end of its body
    // into the side of its decision, or (a wait) from the side of its decision
    // back into the line that enters its block.
    const half = edge.half ?? 0;
    const start = edge.fromDecide
      ? `M ${sourceX - half} ${sourceY - DECIDE_H / 2} H ${detourX + r} Q ${detourX} ${sourceY - DECIDE_H / 2} ${detourX} ${sourceY - DECIDE_H / 2 - r}`
      : `M ${sourceX} ${sourceY} V ${sourceY + 14 - r} Q ${sourceX} ${sourceY + 14} ${sourceX - r} ${sourceY + 14} H ${detourX + r} Q ${detourX} ${sourceY + 14} ${detourX} ${sourceY + 14 - r}`;
    const turnY = edge.fromDecide ? sourceY - DECIDE_H / 2 : sourceY + 14;
    const end = edge.intoDecide
      ? `V ${targetY + DECIDE_H / 2 + r} Q ${detourX} ${targetY + DECIDE_H / 2} ${detourX + r} ${targetY + DECIDE_H / 2} H ${targetX - half}`
      : `V ${targetY - 28 + r} Q ${detourX} ${targetY - 28} ${detourX + r} ${targetY - 28} H ${targetX - r} Q ${targetX} ${targetY - 28} ${targetX} ${targetY - 28 + r} V ${targetY}`;
    return (
      <>
        <BaseEdge id={id} path={`${start} ${end}`} style={active ? { ...style, animation: "flow-round 0.7s linear infinite" } : style} markerEnd={markerEnd} />
        {edge.fromDecide && !edge.intoDecide
          ? // A wait: its answer on the line beside the decision, and what it does
            // over the line back in at the top, clear of the steps in between.
            sideLabel(detourX + 8, targetY - 28 - 18)
          : sideLabel(detourX + 8, turnY - 20)}
        {edge.answer && (
          <EdgeLabelRenderer>
            <span
              style={{ transform: `translate(${sourceX - half - 8}px, ${turnY - 9}px) translateX(-100%)` }}
              className="pointer-events-none absolute top-0 left-0 rounded-md border border-slate-200 bg-sheet px-2 text-[11.5px] leading-[18px] font-medium whitespace-nowrap text-ink"
            >
              {edge.answer}
            </span>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }
  if (edge.bracket) {
    // A try's way into "失敗したとき": from the side of each step of "実行"
    // (any of them can fail), down their right, and from the top across into it.
    const { x: bx, ticks } = edge.bracket;
    const top = ticks[0]?.y ?? sourceY;
    const bottom = ticks.at(-1)?.y ?? top;
    const parts = [
      ...ticks.map((t) => `M ${t.x} ${t.y} H ${bx}`),
      bottom > top ? `M ${bx} ${bottom} V ${top}` : "",
      `M ${bx} ${top} H ${targetX - r} Q ${targetX} ${top} ${targetX} ${top + r} V ${targetY}`,
    ];
    const failStyle = { ...style, strokeDasharray: "5 4" };
    return (
      <>
        <BaseEdge id={id} path={parts.filter(Boolean).join(" ")} style={failStyle} markerEnd={markerEnd} />
        {label && (
          <EdgeLabelRenderer>
            <div
              style={{ transform: `translate(-50%, -100%) translate(${targetX}px, ${targetY - 10}px)` }}
              className="pointer-events-none absolute flex items-center"
            >
              {edge.insert && <span style={{ width: TAIL_W }} className="ml-1 shrink-0" />}
              <span className="max-w-[300px] truncate rounded-md border border-[color-mix(in_srgb,var(--color-shu-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-shu-500)_7%,var(--color-sheet))] px-2 text-[11.5px] leading-[18px] font-medium text-shu-600">
                {label}
              </span>
              <InsertButton edgeId={id} data={edge} inline />
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }
  if (edge.railX !== undefined) {
    // A loop's "いいえ": out of the right of its decision, down the right of
    // its frame, and into its foot (「繰り返し終了」), where the line goes on.
    const x0 = sourceX + (edge.half ?? 0);
    const y0 = sourceY - DECIDE_H / 2;
    const rail = edge.railX;
    const lowY = targetY - 14;
    const path = [
      `M ${x0} ${y0} H ${rail - r} Q ${rail} ${y0} ${rail} ${y0 + r}`,
      `V ${lowY - r} Q ${rail} ${lowY} ${rail - r} ${lowY}`,
      `H ${targetX + r} Q ${targetX} ${lowY} ${targetX} ${lowY + r} V ${targetY}`,
    ].join(" ");
    return (
      <>
        <BaseEdge id={id} path={path} style={style} />
        <EdgeLabelRenderer>
          {/* The answer on the line just where it leaves the decision, as the "はい" going down. */}
          {label && <AnswerLabel x={x0 + 8} y={y0} text={label} from="left" />}
          {/* When it leaves, beside the line where it turns into the foot (as 「次の 1 件へ」 on the line back). */}
          {edge.exit && (
            <span
              style={{ transform: `translate(${rail - 8}px, ${lowY - 20}px) translateX(-100%)` }}
              className="pointer-events-none absolute top-0 left-0 text-[11px] leading-4 whitespace-nowrap text-slate-500"
            >
              {edge.exit}
            </span>
          )}
        </EdgeLabelRenderer>
      </>
    );
  }
  // Splits turn just below their step; joins turn just above the next step, so
  // branches of different lengths meet on one line instead of at staggered heights.
  const down = sourcePosition === Position.Bottom && targetY > sourceY;
  // Into a join (on a frame's bottom edge), the lines meet just above it.
  const intoJoin = target.startsWith("join:");
  const centerY = down && (label || edge.split) ? sourceY + 12 : down && Math.abs(sourceX - targetX) > 1 ? targetY - (intoJoin ? 12 : 16) : undefined;
  // The offset must not reach past the turn, or the line runs on below it and doubles back.
  const offset = centerY === undefined ? 20 : Math.max(0, Math.min(12, centerY - sourceY - 1));
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, centerY, offset, borderRadius: 4 });
  const straight = Math.abs(sourceX - targetX) <= 1;
  // An answer out of a decision ("はい", "いいえ"): on the line just after it leaves, not down by the next step.
  const answer = label && source.endsWith(":decide");
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        {answer ? (
          <>
            <AnswerLabel x={targetX} y={(straight || centerY === undefined ? sourceY : centerY) + 18} text={label} />
            <InsertButton edgeId={id} data={edge} x={targetX} y={straight ? (sourceY + targetY) / 2 + 6 : targetY - 8} />
          </>
        ) : label ? (
          // The "+" sits after the label; a spacer as wide on the other side keeps the label centred on the line.
          <div
            style={{ transform: `translate(-50%, -100%) translate(${targetX}px, ${targetY - 10}px)` }}
            className="pointer-events-none absolute flex items-center"
          >
            {edge.insert && <span style={{ width: TAIL_W }} className="ml-1 shrink-0" />}
            <span
              className={`max-w-[300px] truncate rounded-md border bg-sheet px-2 text-[11.5px] leading-[18px] font-medium border-slate-200 text-ink`}
            >
              {label}
            </span>
            <InsertButton edgeId={id} data={edge} inline />
          </div>
        ) : (
          // Halfway down a straight line; just under the turn where lines join.
          <InsertButton edgeId={id} data={edge} x={targetX} y={straight ? (sourceY + targetY) / 2 - 4 : targetY - 8} />
        )}
      </EdgeLabelRenderer>
    </>
  );
}

/**
 * The answer a line out of a decision takes ("はい", "いいえ"), on the line
 * just where it leaves the decision, the way a flowchart labels it. Above
 * every line, a run's coloured one too, so the line never crosses it.
 */
export function AnswerLabel({ x, y, text, from = "center" }: { x: number; y: number; text: React.ReactNode; from?: "center" | "left" }) {
  // Centred on the point, or (on a line going right) starting at it; above the lines, a run's too (see index.css).
  return (
    <span
      style={{ transform: `translate(${x}px, ${y}px) translate(${from === "center" ? "-50%" : "0"}, -50%)` }}
      className="pointer-events-none absolute top-0 left-0 flow-answer rounded-md border px-2 text-[11.5px] leading-[18px] font-medium whitespace-nowrap text-ink"
    >
      {text}
    </span>
  );
}

export const edgeTypes = { link: LinkEdge, block: BlockEdge };

export const TRAIL_STROKE: Record<LineTrail, string> = {
  done: "var(--color-moegi-500)",
  failed: "var(--color-shu-500)",
  now: "var(--color-accent-500)",
};

/** The same colours as plain values, for the arrow heads (see index.css). */
export const TRAIL_MARKER: Record<"light" | "dark", Record<LineTrail, string>> = {
  light: { done: "#2f8a4c", failed: "#e8501f", now: "#f5872a" },
  dark: { done: "#5cc27e", failed: "#f06a3c", now: "#f79a48" },
};
