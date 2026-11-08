import { CASE, IF, PARALLEL, SWITCH } from "../lib/stepTypes";
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { ChevronDown, ChevronRight, Plus, StickyNote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStudio } from "../context";
import {
  CASE_H,
  type FrameKind,
  HEAD_H,
  DECIDE_H,
  DECIDE_POINT,
  ancestorsOf,
  JOIN_SIZE,
  type JoinNodeData,
  layoutFlow,
  NODE_W,
  READ_ROOM,
  type SlotNodeData,
  SLOT_H,
  type StepNodeData,
  TAIL_SIZE,
  WRITE_ROOM,
} from "../flow/layout";
import { headSummary } from "../lib/keywords";
import { listToText } from "../lib/listText";
import { nodeIcon } from "../lib/nodeIcons";
import { isUnset, PERSON_CODES, todosByStep } from "../lib/todos";
import { useTodos } from "../lib/useTodos";
import { t } from "../lib/i18n";
import { useProjectMaybe } from "../project";
import { nodeForFile } from "../lib/fileDrop";
import { useFileDropTarget } from "./FileDrag";
import type { HistoryEntry, Flow, StepTypeDef } from "@shikigami/schema";
import { dataLinks, INPUT_NODE, inHandle, OUTPUT_NODE, outHandle } from "../lib/dataFlow";
import { focus, useFocus, varFocus } from "../lib/focus";
import { useTheme } from "../lib/theme";
import { actorLabel, describe } from "../lib/changes";
import {
  CALL,
  CALL_BAR_H,
  INNER_LINE_H,
  INNER_PAD,
  innerHeight,
  NODE_HEAD_H,
  NODE_PAD_B,
  nodeRows,
  rootOf,
  unsetParams,
  splitRefs,
  knownVariables,
  ROW_H,
  type Row,
  TYPE_COLOR,
} from "../lib/nodeRows";
import { type OutlineItem, outline } from "../lib/outline";
import { plain, sentence, typeTitle } from "../lib/sentence";
import { AppTag } from "./AppTag";
import { HoverPreview } from "./HoverPreview";
import { previewSource } from "../lib/preview";
import { callKey, diveChain, selectedIds, type DiveLevel, type InsertAt, revertBlocker, type StepRunState, type StepStart, touchedSteps, trailOf, type VariableChange } from "../store";
import { type LineTrail, trailLines } from "../lib/trail";
import { CATEGORY_COLOR } from "./CommandPalette";
import { ChangeView, changeText } from "./ValueView";
import { StepTools } from "./StepTools";
import { menuFor } from "../lib/contextMenu";
import { usePaneMenu, useSlotMenu, useStepMenu, useVariableMenu } from "./menus";
import { valuesSeenBy } from "../lib/runValues";
import { type StepDiff, summarize } from "../lib/review";
import { ActorMark, entryScope, usePendingReview } from "./Timeline";

/** What a `flow.call` node shows about the flow it runs. */
type CallView = {
  /** The call step itself. */
  stepId: string;
  /** `callKey` of the call step's path from the open flow. */
  key: string;
  /** Id of the called flow (empty when not chosen yet). */
  target: string;
  /** The called flow, when it exists in this workspace. */
  callee?: Flow;
  unfolded: boolean;
  /** Its steps in reading order, when unfolded (cut to MAX_INNER_LINES). */
  lines: OutlineItem[];
  hidden: number;
  /** How its steps went in the current run. */
  states: Record<string, StepRunState>;
};

type StepNodeProps = NodeProps<
  Node<StepNodeData & { runState?: StepRunState; readOnly: boolean; breakpoint: boolean; owner: string; pausedHere: boolean; issueCount: number; unsetCount: number; todos: string[]; selected: boolean; primary: boolean; byAi: boolean; reviews: HistoryEntry[]; vars: Map<string, string | undefined>; run: RunValues; diff?: StepDiff; note?: string; call?: CallView; defs: Map<string, StepTypeDef> }>
>;

/** Lines an unfolded call lists before the rest fold into "…ほか n". */
const MAX_INNER_LINES = 24;

const MIN_READABLE_ZOOM = 0.85;
/** Width of the outline panel plus its gap, from the canvas's left edge. */
const OUTLINE_W = 284;
/** The project panel over the left of the chart, with its margins. */
const PROJECT_W = 288;
/** The selected node's tools beside it (↑ ↓ まとめる…), kept clear of the inspector. */
const TOOLS_W = 200;
/** The dock floating over the bottom of the chart. */
const DOCK_H = 72;

const DIFF_STYLE: Record<StepDiff, { border: string; tag: string; label: () => string }> = {
  added: { border: "border-moegi-500", tag: "border-moegi-500 text-moegi-500", label: () => t.flow.aiAdded },
  changed: { border: "border-accent-500", tag: "border-accent-500 text-amber-700", label: () => t.flow.aiChanged },
};

/** Which way the chart runs, for rows deciding whether to show chips. */

const RUN_STYLE: Record<StepRunState, string> = {
  running: "!border-accent-500 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent-500)_16%,transparent)]",
  succeeded: "",
  failed: "!border-shu-500 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-shu-500)_16%,transparent)]",
  skipped: "opacity-60",
  paused: "!border-mizu-500 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-mizu-500)_18%,transparent)]",
};

/** Click target left of a step's header: a red dot when the run pauses before it. */
function BreakpointDot({ stepId, on, owner }: { stepId: string; on: boolean; owner: string }) {
  const toggle = useStudio((s) => s.toggleBreakpoint);
  return (
    <button
      type="button"
      title={on ? t.flow.breakpointOff : t.flow.breakpointOn}
      onClick={(e) => {
        e.stopPropagation();
        toggle(stepId, owner);
      }}
      className={`nodrag absolute -top-[7px] -left-[7px] z-10 h-[14px] w-[14px] rounded-full border-2 ${
        on ? "border-sheet bg-shu-500 shadow" : "border-transparent bg-transparent group-hover:border-shu-500/60 group-hover:bg-sheet"
      }`}
    />
  );
}

/** 残す / 取り消す for an unreviewed AI edit, floating beside its node. */
function ReviewToolbar({ entry }: { entry: HistoryEntry }) {
  const history = useStudio((s) => s.history);
  const approve = useStudio((s) => s.approve);
  const revert = useStudio((s) => s.revert);
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const blocker = revertBlocker(entry, history);
  const scope = entryScope(describe(entry, flow, defs));
  return (
    <div title={scope.title} className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-sheet py-1 pr-1 pl-1.5 text-[11px] shadow-raised">
      <ActorMark entry={entry} size={18} />
      <span className="text-slate-600">{t.flow.changeBy(actorLabel(entry))}</span>
      <button type="button" onClick={() => approve(entry.revision)} className="rounded-md bg-primary px-2 py-0.5 text-on-primary hover:bg-primary-hover">
        {t.approve}
        {scope.suffix}
      </button>
      <button
        type="button"
        onClick={() => revert(entry)}
        disabled={blocker !== null}
        title={blocker ?? scope.title}
        className="rounded-md border border-shu-500 px-2 py-0.5 text-shu-600 enabled:hover:bg-shu-50 disabled:border-slate-300 disabled:text-slate-400"
      >
        {t.revert}
        {scope.suffix}
      </button>
    </div>
  );
}

/**
 * A variable socket on the node's edge: a small hollow ring, filled with the
 * variable's type colour while its value is in focus. Links attach here.
 */
function Socket({ side, id, color, title, lit }: { side: "in" | "out"; id: string; color: string; title: string; lit: boolean }) {
  return (
    <Handle
      id={id}
      type={side === "in" ? "target" : "source"}
      position={side === "in" ? Position.Left : Position.Right}
      title={title}
      isConnectable={false}
      style={{
        width: 9,
        height: 9,
        background: lit ? color : "var(--color-sheet)",
        border: `1.5px solid ${lit ? color : "var(--color-slate-300)"}`,
      }}
    />
  );
}

// Flow handles only anchor the lines: nothing connects by hand, so they are not drawn.
const FLOW_HANDLE = "!h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent";

/** Where step-to-step flow enters (top) and leaves (bottom) a node; `x` from its left edge, else its middle. */
function FlowHandles({ x }: { x?: number }) {
  // `left` counts from inside the node's 1px border.
  const style = x === undefined ? undefined : { left: x - 1 };
  return (
    <>
      <Handle id="flow" type="target" position={Position.Top} className={FLOW_HANDLE} style={style} />
      <Handle id="flow" type="source" position={Position.Bottom} className={FLOW_HANDLE} style={style} />
    </>
  );
}

type LinkEdgeData = { variable: string; color: string; from: string; to: string; selectedId: string | null };

/**
 * Which node a value goes to: drawn only for the variable or step in focus
 * (hovered, or else the selected step), from the writer's output socket to
 * each reader's input socket. Hidden otherwise, so many variables never
 * become a web of lines.
 */
function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<LinkEdgeData>>) {
  const hovered = useFocus();
  if (!data) return null;
  const focused = hovered ?? data.selectedId;
  const lit = focused !== null && (focused === data.from || focused === data.to || focused === varFocus(data.variable));
  if (!lit) return null;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return <BaseEdge id={id} path={path} style={{ stroke: data.color, strokeWidth: 1.5 }} />;
}

/**
 * A step-to-step edge. Its block label ("受注一覧 の 1 件ずつ", "失敗したら") sits just
 * above the step it leads to, not halfway, where sibling edges share a line.
 */
type BlockEdgeData = {
  /** A loop's line back: the x it runs up at. */
  detourX?: number;
  fromDecide?: boolean;
  intoDecide?: boolean;
  /** A loop's "いいえ": the x it runs down at. */
  railX?: number;
  /** A wait's line back: the answer it takes, on the line beside its decision. */
  answer?: string;
  half?: number;
  /** Into a try's "失敗したとき". */
  failure?: boolean;
  /** From the head of a frame into one of its columns. */
  split?: boolean;
  /** Where a node added on this line goes (just before the step it leads to); absent where nothing can be added. */
  insert?: InsertAt;
  /** The pointer is on the line or its "+". */
  hovered?: boolean;
  hover?: (id: string | null) => void;
};

/**
 * The "+" on a line between nodes: shown while the pointer is on the line,
 * it opens the node palette to add a node right there.
 */
function InsertButton({ edgeId, data, x, y, inline }: { edgeId: string; data: BlockEdgeData; x?: number; y?: number; inline?: boolean }) {
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  if (!data.insert) return null;
  const at = data.insert;
  const button = (
    <button
      type="button"
      title={t.menu.addHere}
      aria-label={t.menu.addHere}
      onMouseEnter={() => data.hover?.(edgeId)}
      onMouseLeave={() => data.hover?.(null)}
      onClick={(e) => {
        e.stopPropagation();
        setPaletteOpen(true, at, e.currentTarget.getBoundingClientRect());
      }}
      style={inline ? undefined : { transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      className={`nodrag nopan pointer-events-auto flex h-[18px] w-[18px] items-center justify-center rounded-md border border-slate-300 bg-sheet text-slate-600 shadow-raised hover:border-primary hover:bg-primary hover:text-on-primary ${
        inline ? "ml-1 shrink-0" : "absolute"
      } ${data.hovered ? "opacity-100" : "pointer-events-none opacity-0"}`}
    >
      <Plus size={12} strokeWidth={2.25} aria-hidden="true" />
    </button>
  );
  return button;
}

function BlockEdge({ id, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, style, markerEnd, data }: EdgeProps) {
  const edge = (data ?? {}) as BlockEdgeData;
  const detourX = edge.detourX;
  const r = 4;
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
        <BaseEdge id={id} path={`${start} ${end}`} style={style} markerEnd={markerEnd} />
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
  if (edge.railX !== undefined) {
    // A loop's "いいえ": out of the right of its decision, down the right of
    // its frame, and into where the frame is left, on its bottom edge.
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
        {label && (
          // On the line, like the "はい" going down: the two answers read alike.
          <EdgeLabelRenderer>
            <span
              style={{ transform: `translate(${x0 + 12}px, ${y0 - 9}px)` }}
              className="pointer-events-none absolute top-0 left-0 rounded-md border border-slate-200 bg-sheet px-2 text-[11.5px] leading-[18px] font-medium whitespace-nowrap text-ink"
            >
              {label}
            </span>
          </EdgeLabelRenderer>
        )}
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
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        {label ? (
          // The "+" sits after the label; a spacer as wide on the other side keeps the label centred on the line.
          <div
            style={{ transform: `translate(-50%, -100%) translate(${targetX}px, ${targetY - 10}px)` }}
            className="pointer-events-none absolute flex items-center"
          >
            {edge.insert && <span className="ml-1 w-[18px] shrink-0" />}
            <span
              className={`max-w-[300px] truncate rounded-md border px-2 text-[11.5px] leading-[18px] font-medium ${
                edge.failure
                  ? "border-[color-mix(in_srgb,var(--color-shu-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-shu-500)_7%,var(--color-sheet))] text-shu-600"
                  : "border-slate-200 bg-sheet text-ink"
              }`}
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

const edgeTypes = { link: LinkEdge, block: BlockEdge };

/** Under a step the flow does not go on from: where it goes instead. */
const TERMINAL_NOTE: Record<string, (() => string) | undefined> = {
  "control.break": () => t.flow.breakNote,
  "control.continue": () => t.flow.continueNote,
  "control.fail": () => t.flow.failNote,
};

const TRAIL_STROKE: Record<LineTrail, string> = {
  done: "var(--color-moegi-500)",
  failed: "var(--color-shu-500)",
  now: "var(--color-accent-500)",
};
/** The same colours as plain values, for the arrow heads (see index.css). */
const TRAIL_MARKER: Record<"light" | "dark", Record<LineTrail, string>> = {
  light: { done: "#2f8a4c", failed: "#e8501f", now: "#f5872a" },
  dark: { done: "#5cc27e", failed: "#f06a3c", now: "#f79a48" },
};

type RunValues = { changes: VariableChange[]; starts: StepStart[] };
const NO_RUN: RunValues = { changes: [], starts: [] };
/** The values a chip's popover lists: the last few, newest last. */
const MAX_RUNS = 5;

/**
 * What this step saw (or wrote) for one variable, once per time it ran:
 * a single value for a plain step, one line per pass inside a loop.
 */
function ValuePopover({ name, color, values, side, anchor }: { name: string; color: string; values: VariableChange[]; side: "in" | "out"; anchor: DOMRect }) {
  const below = anchor.top < window.innerHeight / 2;
  const many = values.length > 1;
  return createPortal(
    <div
      // Above the chip, or below it when there is no room up top.
      style={{ left: anchor.left + anchor.width / 2, top: below ? anchor.bottom + 6 : anchor.top - 6 }}
      className={`pointer-events-none fixed z-50 max-w-[480px] -translate-x-1/2 ${below ? "" : "-translate-y-full"} rounded-lg border border-slate-200 bg-sheet px-2.5 py-1.5 text-[11px] shadow-lifted`}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="font-mono font-semibold">{name}</span>
        <span className="text-slate-400">
          {side === "in" ? t.flow.valuesIn : t.flow.valuesOut}
          {many && t.flow.runs(values.length)}
        </span>
      </div>
      {values.length === 0 ? (
        <div className="mt-0.5 text-slate-400">{t.flow.valuesEmpty}</div>
      ) : (
        <ol className="mt-1.5 space-y-1">
          {values.slice(0, MAX_RUNS).map((w, i) => (
            <li key={`${w.seq}-${i}`} className="flex items-start gap-2">
              {many && <span className="w-9 shrink-0 pt-1 text-[10px] text-slate-400">{t.flow.nth(i + 1)}</span>}
              <div className="min-w-0 flex-1 rounded-md border border-slate-100 bg-paper px-2 py-1">
                <ChangeView change={w} />
              </div>
            </li>
          ))}
          {values.length > MAX_RUNS && <li className="text-[10px] text-slate-400">{t.flow.moreRuns(values.length - MAX_RUNS)}</li>}
        </ol>
      )}
    </div>,
    document.body,
  );
}

/**
 * A variable as a small token inside a value ("今の行.金額"), the way Linear
 * shows a mention: a dot in the variable's type colour and its name. Hovering
 * lights every token of the same variable, draws where its value comes from,
 * and lists the values it had in the last run.
 */
function VarChip({ name, label, color, values, side, owner }: { name: string; label?: string; color: string; values: VariableChange[]; side: "in" | "out"; owner: string }) {
  const focused = useFocus() === varFocus(name);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const variableMenu = useVariableMenu();
  const last = values.at(-1);
  return (
    <span
      onContextMenu={menuFor(() => {
        setAnchor(null);
        return variableMenu(name);
      })}
      className={`nodrag inline-flex h-[20px] max-w-[150px] shrink-0 items-center gap-1.5 rounded-md border bg-sheet px-1.5 text-[11.5px] leading-none text-ink ${
        focused ? "" : "border-slate-200"
      }`}
      style={focused ? { borderColor: color, background: `color-mix(in srgb, ${color} 10%, var(--color-sheet))` } : undefined}
      onMouseEnter={(e) => {
        focus.set(varFocus(name));
        setAnchor(e.currentTarget.getBoundingClientRect());
      }}
      onMouseLeave={() => {
        // Back to the step the chip belongs to; leaving the step clears it.
        focus.set(owner);
        setAnchor(null);
      }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{side === "out" && last ? changeText(last) : (label ?? name)}</span>
      {anchor && <ValuePopover name={name} color={color} values={values} side={side} anchor={anchor} />}
    </span>
  );
}

/** A value's text with each `{{ variable… }}` hole as a token. */
function ValueText({ value, refs, color, run, stepId }: { value: string; refs: string[]; color: (name: string) => string; run: RunValues; stepId: string }) {
  const parts = value.split(/\{\{\s*(.*?)\s*\}\}/g);
  const holes = parts.filter((_, i) => i % 2 === 1).length;
  // An expression param (a condition, a list) names its variables without
  // holes: each variable in it, with its fields ("response.rows"), is a token.
  if (holes === 0 && refs.length > 0) {
    const pieces = splitRefs(value, refs);
    return (
      <>
        {pieces.map((piece, i) => {
          if (i % 2 === 0) return piece ? <span key={i} className="truncate">{piece}</span> : null;
          const root = rootOf(piece, refs) ?? piece;
          return <VarChip key={i} side="in" owner={stepId} name={root} label={piece} color={color(root)} values={valuesSeenBy(run.changes, run.starts, root, stepId)} />;
        })}
      </>
    );
  }
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part ? <span key={i} className="truncate">{part}</span> : null;
        const root = refs.find((r) => part === r || part.startsWith(`${r}.`) || part.startsWith(`${r}[`));
        if (!root) return <span key={i} className="truncate">{`{{ ${part} }}`}</span>;
        return <VarChip key={i} side="in" owner={stepId} name={root} label={part} color={color(root)} values={valuesSeenBy(run.changes, run.starts, root, stepId)} />;
      })}
    </>
  );
}

function NodeRow({ row, vars, run, stepId, sheet }: { row: Row; vars: Map<string, string | undefined>; run: RunValues; stepId: string; sheet?: string }) {
  const focused = useFocus();
  const parts = useStudio((s) => s.flow?.parts);
  const typeColor = (name: string): string => TYPE_COLOR[vars.get(name) ?? "any"] ?? "var(--cat-other)";
  if (row.kind === "more") {
    return <div style={{ height: ROW_H }} className="flex items-center px-3 text-[11px] text-slate-400">{t.flow.moreRows(row.count)}</div>;
  }
  if (row.kind === "output") {
    const color = typeColor(row.variable);
    const lit = focused === varFocus(row.variable);
    return (
      <div style={{ height: ROW_H }} className="relative flex items-center justify-end gap-2 px-3 text-[12px]">
        <span className="text-slate-500">{row.label}</span>
        <VarChip
          side="out"
          owner={stepId}
          name={row.variable}
          color={color}
          values={run.changes.filter((c) => c.variable === row.variable && c.stepId === stepId)}
        />
        <Socket side="out" id={outHandle(row.variable)} color={color} title={t.flow.writes(row.variable)} lit={lit} />
      </div>
    );
  }
  const first = typeColor(row.refs[0] ?? "");
  const lit = row.refs.some((r) => focused === varFocus(r));
  return (
    <div style={{ height: ROW_H }} className="relative flex items-center gap-2 px-3 text-[12.5px]">
      {row.refs.length > 0 && <Socket side="in" id={inHandle(row.key)} color={first} title={t.flow.reads(row.refs.join(", "))} lit={lit} />}
      <span className="w-[72px] shrink-0 truncate text-[12px] text-slate-500" title={row.key}>
        {row.label}
      </span>
      {row.unset ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-amber-700">
          <span className="h-[10px] w-[10px] shrink-0 rounded-full border-[1.5px] border-dashed border-amber-600" />
          {t.flow.unsetValue}
        </span>
      ) : row.file ? (
        <FileValue file={row.file} sheet={sheet} />
      ) : (
        <ParamValue row={row} parts={parts}>
          <ValueText value={row.value} refs={row.refs} color={typeColor} run={run} stepId={stepId} />
        </ParamValue>
      )}
    </div>
  );
}

/**
 * A setting's value on the node. Resting the pointer on it shows what it
 * names (a picture by its path, the picture of a part) or the whole text
 * when it is cut short; otherwise the tooltip has the text.
 */
function ParamValue({ row, parts, children }: { row: Extract<Row, { kind: "param" }>; parts: Flow["parts"]; children: React.ReactNode }) {
  const className = "flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-ink";
  // A node pointing at a named part shows the part's picture.
  const raw = row.raw && typeof row.raw === "object" && typeof (row.raw as { part?: unknown }).part === "string" ? (parts?.[(row.raw as { part: string }).part]?.target ?? row.raw) : row.raw;
  const source = previewSource(raw) ?? (row.full ? { kind: "text" as const, text: row.full } : null);
  if (!source) {
    return (
      <span className={className} title={row.value}>
        {children}
      </span>
    );
  }
  return (
    <HoverPreview source={source} className={className}>
      {children}
    </HoverPreview>
  );
}

const ROLE_VAR: Record<string, string> = {
  input: "var(--color-role-input)",
  config: "var(--color-role-config)",
  templates: "var(--color-role-templates)",
  output: "var(--color-role-output)",
};

/**
 * A path param naming a file of the flow's folder: tinted in its shelf's
 * colour, marked when Excel has it open (a write would fail), and opened in
 * its sheet or app on double-click.
 */
function FileValue({ file, sheet }: { file: NonNullable<Extract<Row, { kind: "param" }>["file"]>; sheet?: string }) {
  const color = ROLE_VAR[file.role] ?? "var(--color-slate-400)";
  const entry = useProjectMaybe((s) => s.files?.files.find((f) => f.path.toLowerCase() === file.path.toLowerCase()) ?? null, null);
  const known = useProjectMaybe((s) => s.files !== null, false);
  const openFile = useProjectMaybe((s) => s.openFile, null);
  const missing = known && !entry && file.role !== "output" && file.role !== "work" && !file.path.includes("{{");
  const source = previewSource(file.path, { sheet });
  return (
    <HoverPreview
      source={source}
      className="flex h-[20px] min-w-0 flex-1 items-center gap-1.5 leading-[20px] text-ink"
      title={source ? (entry?.inUse ? t.project.inUse : undefined) : entry?.inUse ? `${file.path} · ${t.project.inUse}` : file.path}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (entry && openFile) void openFile(file.path);
      }}
    >
      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color }} />
      <span className={`min-w-0 flex-1 truncate text-[12px] ${missing ? "text-shu-500 line-through decoration-1" : ""}`}>{file.path}</span>
      {entry?.inUse && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-shu-500" />}
    </HoverPreview>
  );
}

const INNER_MARK: Record<StepRunState, { text: string; className: string }> = {
  running: { text: "●", className: "text-accent-500 animate-pulse" },
  succeeded: { text: "✓", className: "text-moegi-600" },
  paused: { text: "❚❚", className: "text-mizu-500" },
  failed: { text: "✕", className: "text-shu-600" },
  skipped: { text: "–", className: "text-slate-400" },
};

/**
 * Under a call's head: which flow it runs, and the buttons to unfold its
 * steps here or open it.
 */
function CallBar({ call }: { call: CallView }) {
  const toggle = useStudio((s) => s.toggleUnfolded);
  const open = useStudio((s) => s.open);
  const missing = call.target !== "" && !call.callee;
  const count = call.callee ? outline(call.callee.steps ?? [], new Map()).length : 0;
  const button = "nodrag nopan rounded-md px-1.5 leading-[18px] text-[11px] font-medium";
  return (
    <div
      style={{ height: CALL_BAR_H }}
      title={call.callee ? t.callEnterHint : undefined}
      className="flex items-center gap-1.5 border-t border-slate-100 px-3 text-[11.5px]"
    >
      {call.target === "" ? (
        <span className="text-slate-400">{t.flow.chooseCallee}</span>
      ) : missing ? (
        <span className="truncate font-semibold text-shu-600">{t.flow.calleeMissing}</span>
      ) : (
        <span className="truncate text-slate-500">{t.flow.stepCount(count)}</span>
      )}
      {call.callee && (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={`${button} border border-slate-300 text-slate-600 hover:bg-slate-100`}
            aria-expanded={call.unfolded}
            onClick={(e) => {
              e.stopPropagation();
              toggle(call.key);
            }}
            data-call-toggle
          >
            {call.unfolded ? `${t.flow.fold} ▴` : `${t.flow.unfold} ▾`}
          </button>
          <button
            type="button"
            className={`${button} border border-slate-300 text-slate-600 hover:bg-slate-100`}
            title={t.flow.openCallee(call.callee.name)}
            onClick={(e) => {
              e.stopPropagation();
              void open(call.target);
            }}
          >
            {t.flow.open} ↗
          </button>
        </span>
      )}
    </div>
  );
}

/** A call's steps, read-only, unfolded inside its node. */
function InnerSteps({ call, defs }: { call: CallView; defs: Map<string, StepTypeDef> }) {
  const lines = call.lines.length + (call.hidden > 0 ? 1 : 0);
  return (
    <div
      style={{ height: innerHeight(lines), paddingTop: INNER_PAD, paddingBottom: INNER_PAD }}
      className="rounded-b-lg border-t border-slate-100 bg-slate-50 px-2"
    >
      {call.lines.map((item) => {
        const def = defs.get(item.step.type);
        const color = CATEGORY_COLOR[def?.category ?? item.step.type.split(".")[0] ?? "other"] ?? CATEGORY_COLOR.other;
        const state = call.states[item.id];
        const text = item.step.name || plain(sentence(item.step, def));
        return (
          <div key={item.id} style={{ height: INNER_LINE_H, paddingLeft: item.depth * 12 }} className="flex items-center gap-1.5 text-[12px]" title={text}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className={`truncate ${item.step.disabled ? "text-slate-400 line-through" : "text-slate-700"}`}>{text}</span>
            {state && <span className={`ml-auto shrink-0 text-[11px] ${INNER_MARK[state].className}`}>{INNER_MARK[state].text}</span>}
          </div>
        );
      })}
      {call.hidden > 0 && (
        <div style={{ height: INNER_LINE_H }} className="flex items-center text-[11px] text-slate-400">
          {t.flow.moreSteps(call.hidden)}
        </div>
      )}
    </div>
  );
}

function StepNode({ data }: StepNodeProps) {
  if (data.tab) return <CaseTab data={data} />;
  const category = data.def?.category ?? data.step.type.split(".")[0] ?? "other";
  const latest = data.reviews.at(-1);
  const known = useMemo(() => new Set(data.vars.keys()), [data.vars]);
  const rows = nodeRows(data.step, data.def, known);
  const title = typeTitle(data.step, data.def);
  const Icon = nodeIcon(data.step.type, category);
  const head = data.head;
  // A call holds a flow of its own: drawn as a stack of sheets.
  const stack = data.step.type === CALL;
  return (
    <div
      style={{ width: head?.width ?? NODE_W, height: head ? HEAD_H : undefined }}
      // Linear's cards: one hairline border and the faintest shadow. Colour only
      // says something: the selection (primary), an AI change (blue), a run state.
      // The head of a frame is the frame's top edge: no shadow, its border the frame's.
      className={`group relative border bg-sheet transition-[border-color,box-shadow] ${
        head ? (head.collapsed ? "rounded-lg shadow-node" : "rounded-t-lg") : stack ? "flow-call-stack rounded-lg" : "rounded-lg shadow-node"
      } ${
        data.diff
          ? DIFF_STYLE[data.diff].border
          : data.selected
            ? "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_16%,transparent)]"
            : data.byAi
              ? "border-brand-500"
              : head
                ? "border-slate-300 hover:border-slate-400"
                : "border-slate-200 hover:border-slate-300"
      } ${data.step.disabled ? "border-dashed opacity-60" : ""} ${data.runState ? RUN_STYLE[data.runState] : ""}`}
    >
      {(latest || (data.primary && !data.readOnly)) && (
        // Beside the step's head: the flow line runs through the top and bottom
        // centres, and variable chips sit beside the rows below the head.
        <NodeToolbar isVisible position={Position.Right} align="start" offset={8}>
          {/* The toolbar is a portal, but React still bubbles its clicks to the node:
              a click there would reselect the node alone and drop a Shift+click range. */}
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {latest && <ReviewToolbar entry={latest} />}
            {data.primary && !data.readOnly && <StepTools step={data.step} />}
          </div>
        </NodeToolbar>
      )}
      <FlowHandles x={head?.lineX} />
      {/* A break, continue or fail: no line goes on from it, so say where the flow goes instead. */}
      {!head && TERMINAL_NOTE[data.step.type] && !data.step.disabled && !data.runState && (
        <span className="pointer-events-none absolute top-full left-1/2 mt-1.5 -translate-x-1/2 text-[11px] whitespace-nowrap text-slate-500">
          {TERMINAL_NOTE[data.step.type]!()}
        </span>
      )}
      {/* Read-only inside a call, but a run still stops there. */}
      <BreakpointDot stepId={data.step.id ?? ""} on={data.breakpoint} owner={data.owner} />
      {(data.runState === "paused" || (data.runState === "failed" && data.pausedHere)) && (
        <span
          className={`absolute top-full left-1 z-10 mt-1.5 rounded-lg px-2 text-[11px] leading-[20px] font-bold text-white shadow ${
            data.runState === "failed" ? "bg-shu-500" : "bg-mizu-500"
          }`}
        >
          {data.runState === "failed" ? `✕ ${t.flow.stoppedHere}` : `❚❚ ${t.flow.pausedHere}`}
        </span>
      )}
      {data.note && (
        <span
          title={data.note}
          className="absolute bottom-full left-1 z-10 mb-1 max-w-[95%] truncate rounded-lg border border-shu-500 bg-shu-50 px-2 text-[10px] leading-[18px] font-bold text-shu-600"
        >
          {t.flow.note}
          {t.colon}
          {data.note}
        </span>
      )}
      {data.diff && (
        <span className={`absolute -top-2.5 right-2 z-10 rounded-md border bg-sheet px-1.5 text-[10.5px] leading-4 font-medium ${DIFF_STYLE[data.diff].tag}`}>
          {DIFF_STYLE[data.diff].label()}
        </span>
      )}
      {head ? (
        <FrameHead data={data} Icon={Icon} title={title} />
      ) : (
      <>
      <div style={{ height: NODE_HEAD_H }} className="flex items-center gap-2 px-3" title={plain(sentence(data.step, data.def))}>
        <Icon
          size={15}
          strokeWidth={1.75}
          className="shrink-0 text-slate-500"
          // In the colour of its group, as in the node palette.
          style={{ color: CATEGORY_COLOR[category] ?? CATEGORY_COLOR.other }}
          aria-hidden="true"
        />
        <span className="shrink-0 text-[12.5px] font-semibold whitespace-nowrap text-ink">{title}</span>
        {data.step.name ? (
          <span className="min-w-0 truncate text-[12px] text-slate-500">{data.step.name}</span>
        ) : (
          <AppTag def={data.def} title={title} />
        )}
        {data.step.description && (
          <StickyNote size={13} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-label={t.memo}>
            <title>{`${t.memo}${t.colon}${data.step.description}`}</title>
          </StickyNote>
        )}
        <NodeStatus data={data} />
      </div>
      {data.call && <CallBar call={data.call} />}
      {rows.length > 0 && (
        <div style={{ paddingBottom: NODE_PAD_B }} className="border-t border-slate-100 pt-0.5">
          {rows.map((row, i) => (
            <NodeRow key={i} row={row} vars={data.vars} run={data.run} stepId={data.step.id ?? ""} sheet={typeof data.step.params?.sheet === "string" ? data.step.params.sheet : undefined} />
          ))}
        </div>
      )}
      {data.call?.unfolded && <InnerSteps call={data.call} defs={data.defs} />}
      </>
      )}
    </div>
  );
}

/**
 * The head of a frame (a loop, if, try, group, …): what it is, its name and
 * condition on one line, and what can be added to it; it folds the frame.
 */
function FrameHead({ data, Icon, title }: { data: StepNodeProps["data"]; Icon: ReturnType<typeof nodeIcon>; title: string }) {
  const head = data.head!;
  const toggleFold = useStudio((s) => s.toggleFold);
  const select = useStudio((s) => s.select);
  const addStep = useStudio((s) => s.addStep);
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  const id = data.step.id ?? "";
  const branch = data.step.type === IF || data.step.type === SWITCH;
  // An if or a switch asks in its decision under the head, unless it is folded.
  const summary = branch && !head.collapsed ? "" : headSummary(data.step);
  const editable = !data.readOnly;
  const Fold = head.collapsed ? ChevronRight : ChevronDown;
  return (
    <div style={{ height: HEAD_H - 2 }} className="flex items-center gap-2 px-3" title={plain(sentence(data.step, data.def))}>
      <Icon size={15} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
      <span className="shrink-0 text-[12.5px] font-semibold whitespace-nowrap text-ink">{title}</span>
      {data.step.name && <span className="min-w-0 shrink truncate text-[12.5px] font-medium text-ink">{data.step.name}</span>}
      {summary && (
        <span className="min-w-0 shrink truncate rounded bg-slate-100 px-1.5 font-mono text-[11.5px] leading-[20px] text-ink">{summary}</span>
      )}
      {head.collapsed && <span className="shrink-0 text-[11.5px] whitespace-nowrap text-slate-500">{t.flow.inside(head.count)}</span>}
      <NodeStatus data={data} />
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {editable && head.addCase && !head.collapsed && (
          <button
            type="button"
            title={t.flow.addCase}
            onClick={(e) => {
              e.stopPropagation();
              select({ kind: "slot", parentId: id, block: "cases" });
              void addStep(CASE);
            }}
            className="nodrag flex h-[22px] items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-[11.5px] text-slate-600 hover:border-solid hover:border-primary hover:text-primary"
          >
            <Plus size={12} strokeWidth={2} aria-hidden="true" />
            {t.flow.case}
          </button>
        )}
        {editable && head.addFinally && !head.collapsed && (
          <button
            type="button"
            title={t.flow.addFinallyTitle}
            onClick={(e) => {
              e.stopPropagation();
              select({ kind: "slot", parentId: id, block: "finally" });
              setPaletteOpen(true, null, e.currentTarget.getBoundingClientRect());
            }}
            className="nodrag flex h-[22px] items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-[11.5px] text-slate-600 hover:border-solid hover:border-primary hover:text-primary"
          >
            <Plus size={12} strokeWidth={2} aria-hidden="true" />
            {t.flow.addFinally}
          </button>
        )}
        <button
          type="button"
          title={head.collapsed ? t.flow.unfoldFrame : t.flow.foldFrame}
          aria-label={head.collapsed ? t.flow.unfoldFrame : t.flow.foldFrame}
          aria-expanded={!head.collapsed}
          onClick={(e) => {
            e.stopPropagation();
            toggleFold(id, data.owner);
          }}
          className="nodrag flex h-[22px] w-[22px] items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink"
        >
          <Fold size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}

/** A case of a switch: the tab over its column, saying the values it matches. */
function CaseTab({ data }: { data: StepNodeProps["data"] }) {
  const p = (data.step.params ?? {}) as Record<string, unknown>;
  const values = listToText(p.values);
  const condition = typeof p.condition === "string" ? p.condition.replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, "$1") : "";
  const text = [values, condition].filter(Boolean).join(" ・ ") || t.flow.caseEmpty;
  return (
    <div style={{ width: NODE_W, height: CASE_H }} className="group relative flex items-center justify-center">
      <FlowHandles />
      <span
        title={plain(sentence(data.step, data.def))}
        className={`flex h-full max-w-full cursor-pointer items-center gap-1.5 rounded-md border bg-sheet px-2 text-[11.5px] font-medium text-ink ${
          data.selected
            ? "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_16%,transparent)]"
            : data.byAi
              ? "border-brand-500"
              : "border-slate-300 hover:border-slate-400"
        } ${data.runState ? RUN_STYLE[data.runState] : ""}`}
      >
        <span className="truncate">{text}</span>
        <NodeStatus data={data} />
      </span>
    </div>
  );
}

/** Where the columns of a frame meet again, on its bottom edge (a dot). A single column's line passes through; a loop's only lets its line out. */
function JoinNode({ data }: NodeProps<Node<JoinNodeData>>) {
  if (data.question) {
    // A loop's decision: where it asks whether to go round again.
    // A hexagon, the shape of a yes/no question, with the question inside;
    // its lines go in and out at its points.
    const w = data.width ?? 160;
    const h = DECIDE_H;
    const p = DECIDE_POINT;
    return (
      <div style={{ width: w, height: h }} title={data.question} className="relative flex items-center justify-center px-[22px]">
        <svg className="absolute inset-0 overflow-visible" width={w} height={h} aria-hidden="true">
          <polygon
            points={`0.75,${h / 2} ${p},0.75 ${w - p},0.75 ${w - 0.75},${h / 2} ${w - p},${h - 0.75} ${p},${h - 0.75}`}
            fill="var(--flow-decide-fill)"
            stroke="var(--flow-decide-line)"
            strokeWidth={1.25}
            strokeLinejoin="round"
          />
        </svg>
        <span className="relative truncate text-[12px] font-medium text-ink">{data.question}</span>
        <FlowHandles />
      </div>
    );
  }
  return (
    <div style={{ width: JOIN_SIZE, height: JOIN_SIZE }} className={`relative ${data.shown ? "rounded-full bg-[var(--flow-edge)]" : ""}`}>
      {/* A single line across the frame's edge: drawn through, so it does not break off there. */}
      {data.through && <span className="absolute inset-y-0 left-1/2 w-[1.5px] -translate-x-1/2 bg-[var(--flow-edge)]" />}
      <FlowHandles />
    </div>
  );
}

/** A small round mark and a word, the way Linear shows an issue's status. */
function StatusMark({ kind, text, title }: { kind: "done" | "running" | "paused" | "error" | "todo" | "ai"; text?: string; title?: string }) {
  const mark = {
    done: "bg-moegi-500",
    running: "bg-accent-500 animate-pulse",
    paused: "bg-mizu-500",
    error: "bg-shu-500",
    todo: "border-[1.5px] border-dashed border-amber-600",
    ai: "border-[1.5px] border-brand-500 bg-[conic-gradient(var(--color-brand-500)_180deg,transparent_0)]",
  }[kind];
  return (
    <span title={title} className="flex shrink-0 items-center gap-1 text-[11.5px] whitespace-nowrap text-slate-500">
      <span className={`h-[10px] w-[10px] shrink-0 rounded-full ${mark}`} />
      {text}
    </span>
  );
}

/** The right end of a node's head: how it ran, what is left to do, who changed it. */
function NodeStatus({ data }: { data: StepNodeProps["data"] }) {
  const marks: React.ReactNode[] = [];
  if (data.runState === "running") marks.push(<StatusMark key="run" kind="running" />);
  if (data.runState === "succeeded") marks.push(<StatusMark key="run" kind="done" title={t.flow.ranOk} />);
  if (data.runState === "paused") marks.push(<StatusMark key="run" kind="paused" />);
  if (data.runState === "failed") marks.push(<StatusMark key="run" kind="error" text={t.flow.ranFailed} />);
  if (data.byAi) marks.push(<StatusMark key="ai" kind="ai" text="AI" title={t.unreviewed} />);
  if (data.unsetCount > 0) marks.push(<StatusMark key="unset" kind="todo" text={t.flow.unset(data.unsetCount)} title={t.flow.unsetTitle} />);
  if (data.todos.length > 0) marks.push(<StatusMark key="todo" kind="todo" text={t.todos.badge} title={data.todos.join("\n")} />);
  if (data.issueCount > 0 && data.runState !== "failed") marks.push(<StatusMark key="issue" kind="error" text={String(data.issueCount)} title={t.flow.issues(data.issueCount)} />);
  if (marks.length === 0) return null;
  return <span className="ml-auto flex shrink-0 items-center gap-2 pl-1">{marks}</span>;
}

function SlotNode({ data }: NodeProps<Node<SlotNodeData & { selected: boolean }>>) {
  // An empty block, an empty flow, or the faint "+" under the last node: each adds a node there.
  if (data.tail) {
    // The end of a block with nodes: a small "+" on the line, inside the frame.
    const title = data.label ? t.flow.addAtBlockEnd(data.label) : t.menu.addHere;
    return (
      <div
        style={{ width: TAIL_SIZE, height: TAIL_SIZE }}
        title={title}
        aria-label={title}
        className={`flex cursor-pointer items-center justify-center rounded-lg border ${
          data.selected
            ? "border-brand-500 bg-brand-50 text-brand-600"
            : "border-dashed border-slate-300 bg-sheet text-slate-500 hover:border-solid hover:border-primary hover:text-primary"
        }`}
      >
        <FlowHandles />
        <Plus size={14} strokeWidth={2.25} aria-hidden="true" />
      </div>
    );
  }
  return (
    <div
      style={{ width: NODE_W, height: SLOT_H }}
      // The empty flow's block: Ctrl+K opens the palette under it, not over it.
      data-add-first={data.parentId === null || undefined}
      title={t.addStep}
      className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed text-[13px] ${
        data.selected
          ? "border-brand-500 bg-brand-50 text-brand-600"
          : data.end
            ? "border-slate-300 text-slate-500 opacity-75 hover:border-slate-500 hover:bg-sheet hover:text-ink hover:opacity-100"
            : "border-slate-400 bg-sheet/60 text-slate-600 hover:border-ink hover:bg-sheet hover:text-ink"
      }`}
    >
      {!data.end && <FlowHandles />}
      <Plus size={14} strokeWidth={2} aria-hidden="true" />
      {t.addStep}
    </div>
  );
}

type FrameData = { kind: FrameKind; type: string; width: number; height: number };

/**
 * The frame of a loop (if, try, …) around everything in its blocks, so the
 * nodes that run inside it read apart from the ones after it. Its head is
 * the step's own node over its top edge. A loop's frame is tinted, and
 * frames inside it tint deeper; the others are only a hairline.
 */
function FrameNode({ data }: NodeProps<Node<FrameData>>) {
  return (
    <div
      style={{ width: data.width, height: data.height }}
      className={`flow-frame pointer-events-none relative rounded-lg border ${data.kind === "loop" ? "flow-frame-loop" : ""}`}
    />
  );
}

/**
 * On the review desk, brings a step into view: the first one the AI changed,
 * then whichever change the reviewer picks.
 */
function FocusOn({ id }: { id: string | undefined }) {
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
function useBringIntoView() {
  const rf = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // The outline covers the left edge of the chart while it is open.
  const outlineW = useStudio((s) => (s.outlineOpen ? OUTLINE_W : 0));
  // So does the project panel, with the outline beside it.
  const covered = outlineW + useProjectMaybe((s) => (s.panelOpen ? PROJECT_W : 0), 0);
  const flow = useStudio((s) => s.flow);
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
      const view = rf.getViewport();
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
      void rf.setCenter(x + w / 2 + (TOOLS_W - covered) / 2 / zoom, y + h / 2 + DOCK_H / 2 / zoom, { zoom, duration: 250 });
    },
    [rf, width, height, covered, flow],
  );
}

/** Inside an entered call: keeps its running step in view while a run is followed. */
function FollowInside({ path }: { path: string }) {
  const latest = useBringIntoView();
  const bring = useRef(latest);
  bring.current = latest;
  const running = useStudio((s) => (s.run?.status === "running" && s.followRun ? s.run.innerLatest[path] : undefined));
  useEffect(() => {
    if (running) bring.current(running);
  }, [running]);
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
function Follow() {
  const latest = useBringIntoView();
  const bring = useRef(latest);
  bring.current = latest;
  const reveal = useStudio((s) => s.reveal);
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
function DiveBar({ root, chain }: { root: Flow; chain: DiveLevel[] }) {
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
        className="shrink-0 rounded-md px-1.5 leading-[22px] text-slate-600 hover:bg-slate-100"
      >
        ↑
      </button>
      <nav aria-label="breadcrumb" className="flex min-w-0 items-center gap-1">
        {levels.map((level, depth) => (
          <span key={depth} className="flex max-w-[14em] min-w-0 items-center gap-1">
            {depth > 0 && <span className="shrink-0 text-slate-400">›</span>}
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
        className="ml-1 shrink-0 rounded-md border border-slate-300 bg-sheet px-2 leading-[20px] text-[11px] font-medium text-ink hover:bg-slate-100"
      >
        {t.diveOpenLabel} ↗
      </button>
    </div>
  );
}

const nodeTypes = { step: StepNode, slot: SlotNode, frame: FrameNode, join: JoinNode };
const NO_BREAKPOINTS: string[] = [];
const NO_TODOS: string[] = [];
const NO_STATES: Record<string, StepRunState> = {};

export function FlowCanvas() {
  const root = useStudio((s) => s.flow);
  const called = useStudio((s) => s.called);
  const dive = useStudio((s) => s.dive);
  const enterCall = useStudio((s) => s.enterCall);
  const openEditor = useStudio((s) => s.openEditor);
  const projectW = useProjectMaybe((s) => (s.panelOpen ? PROJECT_W : 0), 0);
  // Entered calls show their flow here, read-only; edits stay with the open one.
  const chain = useMemo(() => diveChain(root, called, dive), [root, called, dive]);
  const path = useMemo(() => chain.map((level) => level.stepId), [chain]);
  const inside = chain.length > 0;
  const flow = inside ? chain.at(-1)!.flow : root;
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const range = useStudio((s) => s.range);
  const selectTo = useStudio((s) => s.selectTo);
  const selectBox = useStudio((s) => s.selectBox);
  // Where a Shift+drag box started, on the chart.
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  const picked = useMemo(() => new Set(selectedIds({ selection, range })), [selection, range]);
  const validation = useStudio((s) => s.validation);
  // The open flow's last run, until it is edited or run again.
  const run = useStudio(trailOf);
  const breakpoints = useStudio((s) => (flow ? s.breakpoints[flow.id] : undefined)) ?? NO_BREAKPOINTS;
  const select = useStudio((s) => s.select);
  const addStep = useStudio((s) => s.addStep);
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  const stepMenu = useStepMenu();
  const slotMenu = useSlotMenu();
  const paneMenu = usePaneMenu();
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const setFollowRun = useStudio((s) => s.setFollowRun);
  const theme = useTheme().mode;
  const pending = usePendingReview();
  const reviewing = useStudio((s) => s.reviewing);
  const feedback = useStudio((s) => (s.flow ? s.timelines[s.flow.id]?.openFeedback : undefined));
  // What the person last asked the AI to fix, pinned to the steps it names.
  const notes = useMemo(
    () => new Map(feedback?.kind === "review" ? (feedback.steps ?? []).map((n) => [n.stepId, n.note] as const) : []),
    [feedback],
  );
  // On the review desk every unreviewed step is marked by what happened to it.
  const diffs = useMemo(() => summarize([...pending].reverse(), flow?.steps).steps, [pending, flow]);
  // Oldest first, so the toolbar offers the newest unreviewed change.
  const reviews = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>();
    for (const entry of [...pending].reverse()) {
      for (const id of new Set(touchedSteps(entry))) map.set(id, [...(map.get(id) ?? []), entry]);
    }
    return map;
  }, [pending]);

  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const wrapper = useRef<HTMLDivElement>(null);
  const unfolded = useStudio((s) => s.unfolded);
  // What each call node shows, and the room its unfolded steps take.
  const calls = useMemo(() => {
    const map = new Map<string, Omit<CallView, "states">>();
    const walk = (list: NonNullable<Flow["steps"]>) => {
      for (const step of list) {
        if (step.type === CALL && step.id) {
          const target = typeof step.params?.flow === "string" ? step.params.flow : "";
          const callee = called[target];
          const key = callKey([...path, step.id]);
          const open = Boolean(unfolded[key] && callee);
          const all = open && callee ? outline(callee.steps ?? [], defs) : [];
          map.set(step.id, {
            stepId: step.id,
            key,
            target,
            callee,
            unfolded: open,
            lines: all.slice(0, MAX_INNER_LINES),
            hidden: Math.max(0, all.length - MAX_INNER_LINES),
          });
        }
        for (const children of Object.values(step.blocks ?? {})) walk(children);
      }
    };
    walk(flow?.steps ?? []);
    return map;
  }, [flow, called, unfolded, defs, path]);
  const extra = useMemo(
    () =>
      new Map(
        [...calls]
          .filter(([, c]) => c.unfolded)
          .map(([id, c]) => [id, innerHeight(c.lines.length + (c.hidden > 0 ? 1 : 0))] as const),
      ),
    [calls],
  );
  const foldedIds = useStudio((s) => (flow ? s.folded[flow.id] : undefined));
  const folded = useMemo(() => new Set(foldedIds ?? []), [foldedIds]);
  const layout = useMemo(() => layoutFlow(flow?.steps ?? [], defs, extra, folded), [flow, defs, extra, folded]);
  // A file dropped on the chart becomes the node that reads it: after the
  // node it is dropped on, into the empty block it is dropped on, or at the end.
  const fileDrop = useFileDropTarget("canvas", async (paths, el) => {
    if (inside) return;
    const id = el.closest(".react-flow__node")?.getAttribute("data-id");
    const hit = id ? layout.nodes.find((n) => n.id === id) : undefined;
    const specs = paths.flatMap((p) => nodeForFile(p, stepTypes) ?? []);
    if (specs.length === 0) return;
    if (hit?.data.kind === "step") select({ kind: "step", stepId: hit.data.step.id ?? hit.id });
    else if (hit?.data.kind === "slot") select({ kind: "slot", parentId: hit.data.parentId, block: hit.data.block });
    else select(null);
    // Each one goes after the one before it (the new node is selected).
    for (const spec of specs) await addStep(spec.type, spec.params);
  });
  // Points a run only passes through: the "+" at the end of a block, where a frame's columns meet.
  const tails = useMemo(
    () => new Set(layout.nodes.filter((n) => (n.data.kind === "slot" && n.data.tail) || (n.data.kind === "join" && !n.data.question)).map((n) => n.id)),
    [layout],
  );
  // Steps whose failure the run goes on past (onError: continue, their own or the flow's).
  const continues = useMemo(() => {
    const flowDefault = flow?.settings?.onError;
    return new Set(
      layout.nodes.flatMap((n) => (n.data.kind === "step" && (n.data.step.onError ?? flowDefault) === "continue" ? [n.id] : [])),
    );
  }, [layout, flow]);
  // A node added on a line goes just before the step the line leads to. Not
  // where that would start another branch running at the same time.
  const insertBefore = useMemo(() => {
    const map = new Map<string, InsertAt>();
    const types = new Map(layout.nodes.flatMap((n) => (n.data.kind === "step" ? [[n.id, n.data.step.type] as const] : [])));
    for (const n of layout.nodes) {
      if (n.data.kind !== "step") continue;
      // Nor among a switch's cases: what goes there is a case (see the "+" beside them).
      const parentType = n.data.parentId ? types.get(n.data.parentId) : undefined;
      if (parentType === PARALLEL || (parentType === SWITCH && n.data.block === "cases")) continue;
      map.set(n.id, { parentId: n.data.parentId, block: n.data.block, index: n.data.index });
    }
    return map;
  }, [layout]);
  const [hoveredEdge, setHoveredEdgeNow] = useState<string | null>(null);
  // Leaving the line lets the pointer reach its "+" before it hides.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setHoveredEdge = useCallback((id: string | null) => {
    clearTimeout(hideTimer.current);
    if (id) setHoveredEdgeNow(id);
    else hideTimer.current = setTimeout(() => setHoveredEdgeNow(null), 250);
  }, []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const vars = useMemo(() => knownVariables(flow?.variables, flow?.steps ?? []), [flow]);

  // Errors only: a required setting still empty shows as "未設定" on its row instead.
  const issueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of inside ? [] : (validation?.issues ?? [])) {
      if (!issue.stepId || issue.severity !== "error" || PERSON_CODES.has(issue.code) || isUnset(issue)) continue;
      counts.set(issue.stepId, (counts.get(issue.stepId) ?? 0) + 1);
    }
    return counts;
  }, [validation, inside]);
  const todoList = useTodos();
  const todos = useMemo(() => (inside ? new Map<string, string[]>() : todosByStep(todoList)), [todoList, inside]);
  const states = inside ? (run?.inner[callKey(path)] ?? NO_STATES) : (run?.steps ?? NO_STATES);

  // Frames first and beneath the lines, outer ones before the ones inside them.
  const frames: Node[] = layout.frames.map((f) => ({
    id: `frame:${f.id}`,
    type: "frame",
    position: { x: f.x, y: f.y },
    data: { kind: f.kind, type: f.type, width: f.width, height: f.height } satisfies FrameData,
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -1,
  }));
  const nodes: Node[] = layout.nodes.map((n) => {
    if (n.data.kind === "join") return { ...n, draggable: false, selectable: false, focusable: false };
    if (n.data.kind === "step") {
      const id = n.data.step.id ?? n.id;
      return {
        ...n,
        draggable: false,
        data: {
          ...n.data,
          runState: states[id],
          readOnly: inside,
          breakpoint: breakpoints.includes(id),
          owner: flow?.id ?? "",
          pausedHere: run?.pause?.stepId === id && callKey(run.pause.callPath) === callKey(path),
          issueCount: issueCounts.get(id) ?? 0,
          unsetCount: inside ? 0 : unsetParams(n.data.step, n.data.def).length,
          todos: todos.get(id) ?? NO_TODOS,
          selected: !inside && picked.has(id),
          // The toolbar beside a node acts on the selected one only.
          primary: !inside && selection?.kind === "step" && selection.stepId === id,
          byAi: !inside && !reviewing && reviews.has(id),
          reviews: inside || reviewing ? [] : (reviews.get(id) ?? []),
          diff: !inside && reviewing ? diffs.get(id) : undefined,
          note: !inside && reviewing ? notes.get(id) : undefined,
          vars,
          // Values are recorded for the open flow's variables only.
          run: run && !inside ? { changes: run.changes, starts: run.starts } : NO_RUN,
          defs,
          call: calls.has(id) ? { ...calls.get(id)!, states: run?.inner[calls.get(id)!.key] ?? NO_STATES } : undefined,
        },
      };
    }
    const slot = n.data;
    return {
      ...n,
      draggable: false,
      data: {
        ...slot,
        selected: !inside && selection?.kind === "slot" && selection.parentId === slot.parentId && selection.block === slot.block,
      },
    };
  });

  // Read chips stick out left of a step, write chips right of it.
  const bounds = { x: -READ_ROOM, y: 0, width: layout.width + READ_ROOM + WRITE_ROOM, height: layout.height };

  const selectedId = selection?.kind === "step" ? selection.stepId : null;
  const links = useMemo(
    () => dataLinks(flow?.steps ?? [], flow?.variables, defs, new Set(vars.keys())),
    [flow, defs, vars],
  );
  // The head of a frame and a case's tab show no setting rows, so no sockets to link to.
  const bare = new Set(layout.nodes.flatMap((n) => (n.data.kind === "step" && (n.data.head || n.data.tab) ? [n.id] : [])));
  const linkEdges: Edge[] = links
    .filter((l) => l.from !== INPUT_NODE && l.to !== OUTPUT_NODE && !bare.has(l.from) && !bare.has(l.to))
    .map((l) => ({
      id: `link:${l.from}:${l.variable}->${l.to}:${l.toHandle}`,
      source: l.from,
      sourceHandle: outHandle(l.variable),
      target: l.to,
      targetHandle: l.toHandle,
      type: "link",
      selectable: false,
      focusable: false,
      data: { variable: l.variable, color: TYPE_COLOR[vars.get(l.variable) ?? "any"] ?? "var(--cat-other)", from: l.from, to: l.to, selectedId },
      // Beneath the steps, so a lit link never takes a click meant for a step.
      zIndex: 0,
    }));

  // The lines the run took stay coloured after it ends, as the way it went.
  // A loop's decision runs as long as its loop does.
  const trailStates = useMemo(() => {
    const out: Record<string, StepRunState> = { ...states };
    for (const n of layout.nodes) {
      if (n.data.kind !== "join" || !n.data.question) continue;
      const state = states[n.data.parentId];
      if (state) out[n.id] = state;
    }
    return out;
  }, [states, layout.nodes]);
  const taken = trailLines(layout.edges, trailStates, tails, continues);
  // Lines into a join end in it (or pass through); a loop's decision takes an arrow like a node.
  const plainJoins = new Set(layout.nodes.filter((n) => n.data.kind === "join" && !n.data.question).map((n) => n.id));
  const edges: Edge[] = layout.edges.map((e) => {
    const trail = taken.get(e.id);
    return {
      ...e,
      sourceHandle: "flow",
      targetHandle: "flow",
      type: "block",
      data: {
        detourX: e.detourX,
        fromDecide: e.fromDecide,
        intoDecide: e.intoDecide,
        railX: e.railX,
        answer: e.answer,
        half: e.half,
        failure: e.failure,
        split: e.split,
        insert: inside || reviewing || e.loop ? undefined : insertBefore.get(e.target),
        hovered: hoveredEdge === e.id,
        hover: setHoveredEdge,
      } satisfies BlockEdgeData,
      animated: e.loop || trail === "now",
      style: {
        stroke: trail ? TRAIL_STROKE[trail] : "var(--flow-edge)",
        strokeWidth: trail ? 2.5 : 1.5,
        ...(e.loop || trail === "now" ? { strokeDasharray: "5 4" } : {}),
      },
      // A plain colour: the marker id is built from it, so no var(). Lines meeting at a join end in its dot.
      markerEnd: plainJoins.has(e.target) ? undefined : { type: MarkerType.ArrowClosed, color: (trail ? TRAIL_MARKER[theme][trail] : undefined) ?? (theme === "dark" ? "#5a5e66" : "#a3a8b0") },
      // A taken line over the others where they share a stretch (a join, the way into a loop's body).
      zIndex: trail ? 1 : 0,
    };
  });
  edges.push(...linkEdges);

  if (!flow || !root) {
    return <div className="canvas-bg flex h-full flex-col items-center justify-center gap-3 text-slate-400">
        <img src="/mark.png" alt="" className="h-16 w-16 opacity-30 grayscale" />
        {t.noSelection}
      </div>;
  }

  return (
    <ReactFlow
      key={`${root.id}/${callKey(path)}`}
      className={`canvas-bg ${fileDrop.over ? "outline-2 -outline-offset-8 outline-dashed outline-brand-500" : ""}`}
      colorMode={theme}
      nodes={[...frames, ...nodes]}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesConnectable={false}
      ref={wrapper}
      {...(inside ? {} : fileDrop.attrs)}
      onInit={(flow) => {
        flowRef.current = flow;
        // Fit the chart, but never shrink it below reading size: a long
        // flow starts at its top and scrolls instead.
        const box = wrapper.current;
        if (!box) return;
        const pad = 64;
        const boxW = box.clientWidth - projectW;
        const fitW = (boxW - pad) / bounds.width;
        const fitH = (box.clientHeight - pad) / bounds.height;
        const zoom = Math.max(Math.min(fitW, fitH, 1), MIN_READABLE_ZOOM);
        const x = projectW + (zoom > fitW ? pad / 2 : (boxW - bounds.width * zoom) / 2);
        // Inside a call, clear of the bar that says where the chart is.
        const y = inside ? 104 : pad / 2;
        void flow.setViewport({ x: x - bounds.x * zoom, y: y - bounds.y * zoom, zoom });

      }}
      minZoom={0.2}
      // React Flow is MIT licensed; its corner credit is optional and sat over the work.
      proOptions={{ hideAttribution: true }}
      onNodeClick={(event, node) => {
        if (inside || node.type === "frame" || node.type === "join") return;
        const data = node.data as StepNodeData | SlotNodeData;
        if (data.kind === "step") {
          const id = data.step.id ?? node.id;
          // Shift+click picks the nodes from the selected one to this one, to copy or remove them together.
          if (event.shiftKey) selectTo(id);
          else select({ kind: "step", stepId: id });
        } else {
          // An empty block is there to be filled: clicking it opens the palette for it.
          select({ kind: "slot", parentId: data.parentId, block: data.block });
          const box = (event.target as Element).closest(".react-flow__node")?.getBoundingClientRect();
          setPaletteOpen(true, null, box);
        }
      }}
      onPaneClick={() => select(null)}
      // Shift+drag draws a box (plain drag still moves the view): the nodes in it become the selection.
      selectionKeyCode="Shift"
      onSelectionStart={(event) => {
        // In chart coordinates: the view may scroll while the box is drawn.
        boxStart.current = inside || !flowRef.current ? null : flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      }}
      onSelectionEnd={(event) => {
        const start = boxStart.current;
        const rf = flowRef.current;
        boxStart.current = null;
        if (!start || !rf) return;
        const a = start;
        const b = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
        if (rect.width < 4 && rect.height < 4) return;
        const ids = rf
          .getIntersectingNodes(rect, true)
          .filter((n) => n.type === "step")
          .map((n) => (n.data as StepNodeData).step.id ?? n.id);
        if (ids.length > 0) selectBox(ids);
      }}
      onEdgeMouseEnter={(_, edge) => edge.type === "block" && setHoveredEdge(edge.id)}
      onEdgeMouseLeave={() => setHoveredEdge(null)}
      onNodeContextMenu={(event, node) =>
        menuFor(() => {
          const data = node.data as StepNodeData | SlotNodeData;
          if (node.type === "frame" || node.type === "join") return [];
          if (data.kind === "slot") return inside ? [] : slotMenu(data.parentId, data.block);
          const id = data.step.id ?? node.id;
          const call = calls.get(id);
          return stepMenu(data.step, {
            owner: flow.id,
            readOnly: inside,
            call: call && { key: call.key, canEnter: Boolean(call.callee), unfolded: call.unfolded },
          });
        })(event)
      }
      onPaneContextMenu={(event) =>
        menuFor(() =>
          paneMenu({
            inside,
            fit: () => void flowRef.current?.fitView({ padding: 0.1, maxZoom: 1, duration: 200 }),
          }),
        )(event as React.MouseEvent)
      }
      onNodeDoubleClick={(_, node) => {
        const data = node.data as StepNodeData | SlotNodeData;
        if (data.kind !== "step" || !data.step.id) return;
        if (calls.get(data.step.id)?.callee) enterCall(data.step.id);
        else openEditor(data.step.id);
      }}
      // Double-clicking a call enters it; zooming there would only get in the way.
      zoomOnDoubleClick={false}
      // Dragging the view during a run means the person wants to look elsewhere.
      onMoveStart={(event) => event && run?.status === "running" && setFollowRun(false)}
      onNodeMouseEnter={(_, node) => node.type === "step" && focus.set(node.id)}
      onNodeMouseLeave={() => focus.set(null)}
    >
      <Background gap={24} size={1.2} color="var(--color-slate-200)" />
      {inside ? <FollowInside path={callKey(path)} /> : <Follow />}
      {inside && (
        <Panel position="top-center">
          <DiveBar root={root} chain={chain} />
        </Panel>
      )}
      {!inside && reviewing && <FocusOn id={layout.nodes.find((n) => diffs.has(n.id))?.id} />}
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
