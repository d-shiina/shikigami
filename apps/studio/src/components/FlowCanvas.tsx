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
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStudio } from "../context";
import { KEYWORD } from "../lib/keywords";
import { VarIcon } from "./VarIcon";
import { CHIP_ROOM, layoutScenario, NODE_W, type SlotNodeData, SLOT_H, type StepNodeData } from "../flow/layout";
import { stepLabel, t } from "../lib/i18n";
import type { HistoryEntry, Scenario, StepTypeDef } from "@shikigami/schema";
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
  knownVariables,
  ROW_H,
  type Row,
  TYPE_COLOR,
} from "../lib/nodeRows";
import { type OutlineItem, outline } from "../lib/outline";
import { plain, sentence } from "../lib/sentence";
import { callKey, diveChain, type DiveLevel, revertBlocker, type StepRunState, type StepStart, touchedSteps, type VariableChange } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";
import { Sentence } from "./StoryView";
import { ChangeView, changeText } from "./ValueView";
import { valuesSeenBy } from "../lib/runValues";
import { type StepDiff, summarize } from "../lib/review";
import { ActorMark, entryScope, usePendingReview } from "./Timeline";

/** What a `scenario.call` node shows about the scenario it runs. */
type CallView = {
  /** The call step itself. */
  stepId: string;
  /** `callKey` of the call step's path from the open scenario. */
  key: string;
  /** Id of the called scenario (empty when not chosen yet). */
  target: string;
  /** The called scenario, when it exists in this workspace. */
  callee?: Scenario;
  unfolded: boolean;
  /** Its steps in reading order, when unfolded (cut to MAX_INNER_LINES). */
  lines: OutlineItem[];
  hidden: number;
  /** How its steps went in the current run. */
  states: Record<string, StepRunState>;
};

type StepNodeProps = NodeProps<
  Node<StepNodeData & { runState?: StepRunState; readOnly: boolean; breakpoint: boolean; pausedHere: boolean; issueCount: number; selected: boolean; byAi: boolean; reviews: HistoryEntry[]; vars: Map<string, string | undefined>; run: RunValues; diff?: StepDiff; note?: string; call?: CallView; defs: Map<string, StepTypeDef> }>
>;

/** Lines an unfolded call lists before the rest fold into "…ほか n". */
const MAX_INNER_LINES = 24;

const MIN_READABLE_ZOOM = 0.85;
/** Width of the outline panel plus its gap, from the canvas's left edge. */
const OUTLINE_W = 284;

const DIFF_STYLE: Record<StepDiff, { border: string; tag: string; label: () => string }> = {
  added: { border: "border-moegi-500", tag: "bg-moegi-500", label: () => t.flow.aiAdded },
  changed: { border: "border-accent-500", tag: "bg-accent-500", label: () => t.flow.aiChanged },
};

/** Which way the chart runs, for rows deciding whether to show chips. */

const RUN_STYLE: Record<StepRunState, string> = {
  running: "ring-2 ring-accent-500 animate-pulse",
  succeeded: "ring-2 ring-moegi-500/60",
  failed: "ring-[3px] ring-shu-500 shadow-[0_0_0_9px_color-mix(in_srgb,var(--color-shu-500)_18%,transparent)]",
  skipped: "opacity-60",
  paused: "ring-[3px] ring-mizu-500 shadow-[0_0_0_9px_color-mix(in_srgb,var(--color-mizu-500)_18%,transparent)]",
};

/** Click target left of a step's header: a red dot when the run pauses before it. */
function BreakpointDot({ stepId, on }: { stepId: string; on: boolean }) {
  const toggle = useStudio((s) => s.toggleBreakpoint);
  return (
    <button
      type="button"
      title={on ? t.flow.breakpointOff : t.flow.breakpointOn}
      onClick={(e) => {
        e.stopPropagation();
        toggle(stepId);
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
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const blocker = revertBlocker(entry, history);
  const scope = entryScope(describe(entry, scenario, defs));
  return (
    <div title={scope.title} className="flex items-center gap-1.5 rounded-[3px] border border-slate-200 bg-sheet py-1 pr-1 pl-1.5 text-[11px] shadow-raised">
      <ActorMark entry={entry} size={18} />
      <span className="text-slate-600">{t.flow.changeBy(actorLabel(entry))}</span>
      <button type="button" onClick={() => approve(entry.revision)} className="rounded-[3px] bg-ink px-2 py-0.5 text-paper hover:bg-slate-700">
        {t.approve}
        {scope.suffix}
      </button>
      <button
        type="button"
        onClick={() => revert(entry)}
        disabled={blocker !== null}
        title={blocker ?? scope.title}
        className="rounded-[3px] border border-shu-500 px-2 py-0.5 text-shu-600 enabled:hover:bg-shu-50 disabled:border-slate-300 disabled:text-slate-400"
      >
        {t.revert}
        {scope.suffix}
      </button>
    </div>
  );
}

const STEP_TOOL = "grid h-6 w-6 place-items-center rounded-[3px] text-[13px] text-slate-600 hover:bg-slate-100 hover:text-ink";

/** Move and delete, on the selected step itself: the pointer is already there. */
function StepTools() {
  const moveSelected = useStudio((s) => s.moveSelected);
  const removeSelected = useStudio((s) => s.removeSelected);
  return (
    <div role="toolbar" aria-label={t.toolbar.stepTools} className="flex items-center gap-0.5 rounded-[3px] border border-slate-200 bg-sheet p-0.5 shadow-raised">
      <button type="button" title={`${t.moveUp} (Alt+↑)`} onClick={() => moveSelected(-1)} className={STEP_TOOL}>
        ↑
      </button>
      <button type="button" title={`${t.moveDown} (Alt+↓)`} onClick={() => moveSelected(1)} className={STEP_TOOL}>
        ↓
      </button>
      <span className="mx-0.5 h-4 w-px bg-slate-200" />
      <button type="button" title={`${t.delete} (Delete)`} onClick={() => removeSelected()} className={`${STEP_TOOL} hover:bg-shu-50! hover:text-shu-600!`}>
        ✕
      </button>
    </div>
  );
}

/** A variable socket on the node's edge, coloured by the variable's type. Links attach here. */
function Socket({ side, id, color, title }: { side: "in" | "out"; id: string; color: string; title: string }) {
  return (
    <Handle
      id={id}
      type={side === "in" ? "target" : "source"}
      position={side === "in" ? Position.Left : Position.Right}
      title={title}
      isConnectable={false}
      style={{ background: color, width: 11, height: 11, border: "2px solid white", boxShadow: "0 0 0 1px rgba(15,27,42,.25)" }}
    />
  );
}

const FLOW_HANDLE = "!border-0 !bg-slate-300";

/** Where step-to-step flow enters (top) and leaves (bottom) a node. */
function FlowHandles() {
  return (
    <>
      <Handle id="flow" type="target" position={Position.Top} className={FLOW_HANDLE} />
      <Handle id="flow" type="source" position={Position.Bottom} className={FLOW_HANDLE} />
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
  return <BaseEdge id={id} path={path} style={{ stroke: data.color, strokeWidth: 2.5 }} />;
}

/**
 * A step-to-step edge. Its block label ("forEach：…", "catch：…") sits just
 * above the step it leads to, not halfway, where sibling edges share a line.
 */
function BlockEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, style, markerEnd }: EdgeProps) {
  // Top to bottom, turn right below the source so the label has the run down to the step to itself.
  const centerY = label && sourcePosition === Position.Bottom ? sourceY + 12 : undefined;
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, centerY });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -100%) translate(${targetX}px, ${targetY - 10}px)` }}
            className="pointer-events-none absolute max-w-[300px] truncate rounded-[3px] bg-paper px-1.5 text-[11px] leading-4 text-slate-600"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { link: LinkEdge, block: BlockEdge };

type RunValues = { changes: VariableChange[]; starts: StepStart[] };
const NO_RUN: RunValues = { changes: [], starts: [] };
/** Chips shown per input before the rest fold into "+n". */
const MAX_CHIPS = 2;

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
      className={`pointer-events-none fixed z-50 max-w-[480px] -translate-x-1/2 ${below ? "" : "-translate-y-full"} rounded-[4px] border border-slate-200 bg-sheet px-2.5 py-1.5 text-[11px] shadow-lifted`}
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
              <div className="min-w-0 flex-1 rounded-[3px] border border-slate-100 bg-paper px-2 py-1">
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
 * A variable chip, like a Get / Set node in Unity's Visual Scripting: it sits
 * right beside the socket it feeds, so no line ever crosses the chart.
 * Hovering one lights every chip and row of the same variable.
 */
function VarChip({ name, color, values, side, owner }: { name: string; color: string; values: VariableChange[]; side: "in" | "out"; owner: string }) {
  const focused = useFocus() === varFocus(name);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const last = values.at(-1);
  return (
    <span
      className={`nodrag flex h-[20px] max-w-[80px] shrink-0 items-center gap-1 rounded-[3px] border bg-sheet px-1.5 font-mono text-[11px] leading-none shadow-sheet ${
        focused ? "ring-2 ring-offset-1" : ""
      }`}
      style={{ borderColor: color, color, ["--tw-ring-color" as string]: color }}
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
      {side === "out" && last ? (
        <span className="truncate text-ink">{changeText(last)}</span>
      ) : (
        <>
          <VarIcon size={10} />
          <span className="truncate font-semibold">{name}</span>
        </>
      )}
      {anchor && <ValuePopover name={name} color={color} values={values} side={side} anchor={anchor} />}
    </span>
  );
}

/** The chips beside a row and the short stub joining them to its socket. */
function Chips({ side, color, children }: { side: "in" | "out"; color: string; children: React.ReactNode }) {
  return (
    <div
      style={side === "in" ? { right: "calc(100% + 6px)" } : { left: "calc(100% + 6px)" }}
      className={`absolute top-1/2 flex -translate-y-1/2 items-center ${side === "in" ? "flex-row-reverse" : ""}`}
    >
      <span className="h-[2px] w-[10px] shrink-0" style={{ background: color }} />
      <span className={`flex items-center gap-[3px] ${side === "in" ? "flex-row-reverse" : ""}`}>{children}</span>
    </div>
  );
}

function NodeRow({ row, vars, run, stepId }: { row: Row; vars: Map<string, string | undefined>; run: RunValues; stepId: string }) {
  const focused = useFocus();
  const typeColor = (name: string): string => TYPE_COLOR[vars.get(name) ?? "any"] ?? "#94a3b8";
  if (row.kind === "more") {
    return <div style={{ height: ROW_H }} className="flex items-center px-3 text-[10px] text-slate-400">{t.flow.moreRows(row.count)}</div>;
  }
  if (row.kind === "output") {
    const color = typeColor(row.variable);
    const lit = focused === varFocus(row.variable);
    return (
      <div style={{ height: ROW_H, background: lit ? `color-mix(in srgb, ${color} 12%, transparent)` : undefined }} className="relative flex items-center justify-end gap-2 px-3 text-[12px]">
        <span className="text-slate-500">{row.label}</span>
        <span className="flex min-w-0 items-center gap-1 font-mono font-semibold" style={{ color }}>
          <VarIcon size={11} />
          <span className="truncate">{row.variable}</span>
        </span>
        <Socket side="out" id={outHandle(row.variable)} color={color} title={t.flow.writes(row.variable)} />
        <Chips side="out" color={color}>
          <VarChip
            side="out"
            owner={stepId}
            name={row.variable}
            color={color}
            values={run.changes.filter((c) => c.variable === row.variable && c.stepId === stepId)}
          />
        </Chips>
      </div>
    );
  }
  const first = typeColor(row.refs[0] ?? "");
  const lit = row.refs.some((r) => focused === varFocus(r));
  return (
    <div style={{ height: ROW_H, background: lit ? `color-mix(in srgb, ${first} 12%, transparent)` : undefined }} className="relative flex items-center gap-2 px-3 text-[12px]">
      {row.refs.length > 0 && <Socket side="in" id={inHandle(row.key)} color={first} title={t.flow.reads(row.refs.join(", "))} />}
      {row.refs.length > 0 && (
        <Chips side="in" color={first}>
          {row.refs.slice(0, MAX_CHIPS).map((r) => (
            <VarChip key={r} side="in" owner={stepId} name={r} color={typeColor(r)} values={valuesSeenBy(run.changes, run.starts, r, stepId)} />
          ))}
          {row.refs.length > MAX_CHIPS && (
            <span className="text-[10px] text-slate-400" title={row.refs.slice(MAX_CHIPS).join(", ")}>
              +{row.refs.length - MAX_CHIPS}
            </span>
          )}
        </Chips>
      )}
      <span className="w-16 shrink-0 truncate text-slate-500" title={row.key}>
        {row.label}
      </span>
      <span className="h-[20px] min-w-0 flex-1 truncate rounded bg-slate-100 px-1.5 leading-[20px] text-ink" title={row.value}>
        {row.value}
      </span>
    </div>
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
 * Under a call's head: which scenario it runs, and the buttons to unfold its
 * steps here or open it.
 */
function CallBar({ call }: { call: CallView }) {
  const toggle = useStudio((s) => s.toggleUnfolded);
  const open = useStudio((s) => s.open);
  const missing = call.target !== "" && !call.callee;
  const count = call.callee ? outline(call.callee.steps ?? [], new Map()).length : 0;
  const button = "nodrag nopan rounded-[3px] px-1.5 leading-[18px] text-[11px] font-medium";
  return (
    <div
      style={{ height: CALL_BAR_H }}
      title={call.callee ? t.callEnterHint : undefined}
      className="flex items-center gap-1.5 border-t border-slate-100 px-3 text-[11px]"
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
            className={`${button} bg-ink text-paper hover:bg-slate-700`}
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
      className="rounded-b-[3px] border-t border-slate-200 bg-paper px-2"
    >
      {call.lines.map((item) => {
        const def = defs.get(item.step.type);
        const color = CATEGORY_COLOR[def?.category ?? item.step.type.split(".")[0] ?? "other"] ?? CATEGORY_COLOR.other;
        const state = call.states[item.id];
        const text = item.step.name || plain(sentence(item.step, def));
        return (
          <div key={item.id} style={{ height: INNER_LINE_H, paddingLeft: item.depth * 12 }} className="flex items-center gap-1.5 text-[12px]" title={text}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
            {KEYWORD[item.step.type] && (
              <span className="shrink-0 font-mono text-[10px] font-bold" style={{ color }}>
                {KEYWORD[item.step.type]}
              </span>
            )}
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
  const category = data.def?.category ?? data.step.type.split(".")[0] ?? "other";
  const color = CATEGORY_COLOR[category] ?? CATEGORY_COLOR.other;
  const latest = data.reviews.at(-1);
  const known = useMemo(() => new Set(data.vars.keys()), [data.vars]);
  const rows = nodeRows(data.step, data.def, known);
  const parts = sentence(data.step, data.def);
  return (
    <div
      style={{ width: NODE_W }}
      // The selected step is lifted off the stack: two sheet edges and a deeper shadow.
      className={`group relative rounded-[4px] border bg-sheet transition-shadow ${data.selected ? "shadow-lifted" : "shadow-node hover:shadow-raised"} ${
        data.diff
          ? `border-2 ${DIFF_STYLE[data.diff].border}`
          : data.byAi
            ? "ai-border"
            : data.selected
              ? "border-brand-500"
              : "border-slate-300"
      } ${data.step.disabled ? "border-dashed opacity-60" : ""} ${
        data.runState ? RUN_STYLE[data.runState] : ""
      }`}
    >
      {(latest || (data.selected && !data.readOnly)) && (
        // At the top-right corner, clear of the flow line entering at the top centre.
        <NodeToolbar isVisible position={Position.Top} align="end" offset={8}>
          <div className="flex items-center gap-1.5">
            {latest && <ReviewToolbar entry={latest} />}
            {data.selected && !data.readOnly && <StepTools />}
          </div>
        </NodeToolbar>
      )}
      <FlowHandles />
      {!data.readOnly && <BreakpointDot stepId={data.step.id ?? ""} on={data.breakpoint} />}
      {(data.runState === "paused" || (data.runState === "failed" && data.pausedHere)) && (
        <span
          className={`absolute top-full left-1 z-10 mt-1.5 rounded-[4px] px-2 text-[11px] leading-[20px] font-bold text-white shadow ${
            data.runState === "failed" ? "bg-shu-500" : "bg-mizu-500"
          }`}
        >
          {data.runState === "failed" ? `✕ ${t.flow.stoppedHere}` : `❚❚ ${t.flow.pausedHere}`}
        </span>
      )}
      {data.note && (
        <span
          title={data.note}
          className="absolute bottom-full left-1 z-10 mb-1 max-w-[95%] truncate rounded-[4px] border border-shu-500 bg-shu-50 px-2 text-[10px] leading-[18px] font-bold text-shu-600"
        >
          {t.flow.note}
          {t.colon}
          {data.note}
        </span>
      )}
      {data.diff && (
        <span className={`absolute -top-2.5 right-2 z-10 rounded-[3px] px-2 text-[10px] leading-5 font-bold text-white ${DIFF_STYLE[data.diff].tag}`}>
          {DIFF_STYLE[data.diff].label()}
        </span>
      )}
      <div
        style={{ height: 24, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
        className="flex items-center gap-1.5 rounded-t-[3px] border-b border-slate-100 px-3"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        {KEYWORD[data.step.type] && (
          <span className="shrink-0 rounded-[3px] px-1 font-mono text-[11px] leading-4 font-bold text-white" style={{ background: color }}>
            {KEYWORD[data.step.type]}
          </span>
        )}
        {/* With a keyword the type is clear enough: make room for the name. */}
        {!(KEYWORD[data.step.type] && data.step.name) && (
          <span className="truncate text-[12px] font-bold" style={{ color }}>
            {stepLabel(data.step.type, data.def?.label)}
          </span>
        )}
        {data.step.name && <span className="truncate text-[12px] text-slate-500">{data.step.name}</span>}
        {data.byAi && (
          <span className="ml-auto bg-brand-500 shrink-0 rounded-[3px] px-1.5 text-[9px] font-bold text-white" title={t.unreviewed}>
            AI
          </span>
        )}
        {data.issueCount > 0 && (
          <span className={`${data.byAi ? "" : "ml-auto"} shrink-0 rounded-[3px] bg-shu-100 px-1.5 text-[10px] font-semibold text-shu-600`}>
            ! {data.issueCount}
          </span>
        )}
      </div>
      <div style={{ height: NODE_HEAD_H - 24 }} className="flex items-center px-3 text-[14px]" title={plain(parts)}>
        <span className="truncate">
          <Sentence parts={parts} />
        </span>
      </div>
      {data.call && <CallBar call={data.call} />}
      {rows.length > 0 && (
        <div style={{ paddingBottom: NODE_PAD_B }} className="border-t border-dashed border-slate-200">
          {rows.map((row, i) => (
            <NodeRow key={i} row={row} vars={data.vars} run={data.run} stepId={data.step.id ?? ""} />
          ))}
        </div>
      )}
      {data.call?.unfolded && <InnerSteps call={data.call} defs={data.defs} />}
    </div>
  );
}

function SlotNode({ data }: NodeProps<Node<SlotNodeData & { selected: boolean }>>) {
  return (
    <div
      style={{ width: NODE_W, height: SLOT_H }}
      className={`flex items-center justify-center rounded-[4px] border border-dashed text-xs ${
        data.selected ? "border-brand-500 bg-brand-50 text-brand-600" : "border-slate-300 text-slate-400"
      }`}
    >
      <FlowHandles />
      {/* The edge into the slot already carries the block's label. */}
      {data.parentId ? t.flow.emptySlot(t.shortcut) : t.emptyScenario}
    </div>
  );
}

/**
 * On the review desk, brings a step into view: the first one the AI changed,
 * then whichever change the reviewer picks.
 */
function FocusOn({ id }: { id: string | undefined }) {
  const flow = useReactFlow();
  useEffect(() => {
    if (!id) return;
    // After the canvas has measured its nodes and placed its starting view.
    const timer = setTimeout(() => void flow.fitView({ nodes: [{ id }], padding: 1.2, maxZoom: 1, minZoom: MIN_READABLE_ZOOM, duration: 300 }), 200);
    return () => clearTimeout(timer);
  }, [flow, id]);
  return null;
}

/** Pans just enough to bring a step into view (centring it), keeping a readable zoom. */
function useBringIntoView() {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // The outline covers the left edge of the chart while it is open.
  const covered = useStudio((s) => (s.outlineOpen ? OUTLINE_W : 0));
  return useCallback(
    (id: string) => {
      const node = flow.getInternalNode(id);
      if (!node) return;
      const { x, y } = node.internals.positionAbsolute;
      const w = node.measured.width ?? NODE_W;
      const h = node.measured.height ?? 80;
      const view = flow.getViewport();
      const margin = 48;
      const left = x * view.zoom + view.x;
      const top = y * view.zoom + view.y;
      const inside =
        left >= covered + margin && top >= margin && left + w * view.zoom <= width - margin && top + h * view.zoom <= height - margin;
      if (inside && view.zoom >= MIN_READABLE_ZOOM) return;
      const zoom = Math.max(view.zoom, MIN_READABLE_ZOOM);
      // Centre in the part of the canvas the outline leaves free.
      void flow.setCenter(x + w / 2 - covered / 2 / zoom, y + h / 2, { zoom, duration: 250 });
    },
    [flow, width, height, covered],
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
  const pausedAt = useStudio((s) => s.run?.pause?.stepId);
  useEffect(() => {
    if (paused === undefined || !pausedAt) return;
    const timer = setTimeout(() => bring.current(pausedAt), 120);
    return () => clearTimeout(timer);
  }, [paused, pausedAt]);
  return null;
}

/**
 * Where the chart is when it has entered calls: the open scenario, then each
 * called one, to click back up to; and a way to open the shown one for editing.
 */
function DiveBar({ root, chain }: { root: Scenario; chain: DiveLevel[] }) {
  const leave = useStudio((s) => s.leaveCalls);
  const open = useStudio((s) => s.open);
  const shown = chain.at(-1)!.scenario;
  const levels = [root, ...chain.map((level) => level.scenario)];
  return (
    // As wide as its words: a centred panel would otherwise only get half the canvas.
    <div className="flex w-max max-w-[min(760px,calc(100cqw-32px))] items-center gap-1 rounded-[4px] border border-slate-200 bg-sheet py-1 pr-1 pl-1 text-[12px] shadow-raised">
      <button
        type="button"
        title={t.diveUp}
        aria-label={t.diveUp}
        onClick={() => leave(chain.length - 1)}
        className="shrink-0 rounded-[3px] px-1.5 leading-[22px] text-slate-600 hover:bg-slate-100"
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
                className="truncate rounded-[3px] px-1 leading-[22px] text-brand-600 hover:bg-slate-100 hover:underline"
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
      <span title={t.diveReadOnly} className="ml-1 shrink-0 rounded-[3px] bg-slate-100 px-1.5 text-[11px] leading-[20px] text-slate-500">
        {t.diveViewOnly}
      </span>
      <button
        type="button"
        onClick={() => void open(shown.id)}
        title={t.diveOpen}
        className="ml-1 shrink-0 rounded-[3px] bg-ink px-2 leading-[22px] text-[11px] font-medium text-paper hover:bg-slate-700"
      >
        {t.diveOpenLabel} ↗
      </button>
    </div>
  );
}

const nodeTypes = { step: StepNode, slot: SlotNode };
const NO_BREAKPOINTS: string[] = [];
const NO_STATES: Record<string, StepRunState> = {};

export function FlowCanvas() {
  const root = useStudio((s) => s.scenario);
  const called = useStudio((s) => s.called);
  const dive = useStudio((s) => s.dive);
  const enterCall = useStudio((s) => s.enterCall);
  // Entered calls show their scenario here, read-only; edits stay with the open one.
  const chain = useMemo(() => diveChain(root, called, dive), [root, called, dive]);
  const path = useMemo(() => chain.map((level) => level.stepId), [chain]);
  const inside = chain.length > 0;
  const scenario = inside ? chain.at(-1)!.scenario : root;
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
  const breakpoints = useStudio((s) => (s.scenario ? s.breakpoints[s.scenario.id] : undefined)) ?? NO_BREAKPOINTS;
  const select = useStudio((s) => s.select);
  const setFollowRun = useStudio((s) => s.setFollowRun);
  const theme = useTheme().mode;
  const pending = usePendingReview();
  const reviewing = useStudio((s) => s.reviewing);
  const feedback = useStudio((s) => (s.scenario ? s.timelines[s.scenario.id]?.openFeedback : undefined));
  // What the person last asked the AI to fix, pinned to the steps it names.
  const notes = useMemo(
    () => new Map(feedback?.kind === "review" ? (feedback.steps ?? []).map((n) => [n.stepId, n.note] as const) : []),
    [feedback],
  );
  // On the review desk every unreviewed step is marked by what happened to it.
  const diffs = useMemo(() => summarize([...pending].reverse()).steps, [pending]);
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
    const walk = (list: NonNullable<Scenario["steps"]>) => {
      for (const step of list) {
        if (step.type === CALL && step.id) {
          const target = typeof step.params?.scenario === "string" ? step.params.scenario : "";
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
    walk(scenario?.steps ?? []);
    return map;
  }, [scenario, called, unfolded, defs, path]);
  const extra = useMemo(
    () =>
      new Map(
        [...calls]
          .filter(([, c]) => c.unfolded)
          .map(([id, c]) => [id, innerHeight(c.lines.length + (c.hidden > 0 ? 1 : 0))] as const),
      ),
    [calls],
  );
  const layout = useMemo(() => layoutScenario(scenario?.steps ?? [], defs, extra), [scenario, defs, extra]);
  const vars = useMemo(() => knownVariables(scenario?.variables, scenario?.steps ?? []), [scenario]);

  const issueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of inside ? [] : (validation?.issues ?? [])) {
      if (issue.stepId && issue.severity === "error") counts.set(issue.stepId, (counts.get(issue.stepId) ?? 0) + 1);
    }
    return counts;
  }, [validation, inside]);
  const states = inside ? (run?.inner[callKey(path)] ?? NO_STATES) : (run?.steps ?? NO_STATES);

  const nodes: Node[] = layout.nodes.map((n) => {
    if (n.data.kind === "step") {
      const id = n.data.step.id ?? n.id;
      return {
        ...n,
        draggable: false,
        data: {
          ...n.data,
          runState: states[id],
          readOnly: inside,
          breakpoint: !inside && breakpoints.includes(id),
          pausedHere: !inside && run?.pause?.stepId === id,
          issueCount: issueCounts.get(id) ?? 0,
          selected: !inside && selection?.kind === "step" && selection.stepId === id,
          byAi: !inside && !reviewing && reviews.has(id),
          reviews: inside || reviewing ? [] : (reviews.get(id) ?? []),
          diff: !inside && reviewing ? diffs.get(id) : undefined,
          note: !inside && reviewing ? notes.get(id) : undefined,
          vars,
          // Values are recorded for the open scenario's variables only.
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
  const chips = CHIP_ROOM;
  const bounds = { x: -chips, y: 0, width: layout.width + chips * 2, height: layout.height };

  const selectedId = selection?.kind === "step" ? selection.stepId : null;
  const links = useMemo(
    () => dataLinks(scenario?.steps ?? [], scenario?.variables, defs, new Set(vars.keys())),
    [scenario, defs, vars],
  );
  const linkEdges: Edge[] = links
    .filter((l) => l.from !== INPUT_NODE && l.to !== OUTPUT_NODE)
    .map((l) => ({
      id: `link:${l.from}:${l.variable}->${l.to}:${l.toHandle}`,
      source: l.from,
      sourceHandle: outHandle(l.variable),
      target: l.to,
      targetHandle: l.toHandle,
      type: "link",
      selectable: false,
      focusable: false,
      data: { variable: l.variable, color: TYPE_COLOR[vars.get(l.variable) ?? "any"] ?? "#94a3b8", from: l.from, to: l.to, selectedId },
      // Beneath the steps, so a lit link never takes a click meant for a step.
      zIndex: 0,
    }));

  const edges: Edge[] = layout.edges.map((e) => ({
    ...e,
    sourceHandle: "flow",
    targetHandle: "flow",
    type: "block",
    animated: e.loop,
    style: { stroke: "var(--flow-edge)", strokeWidth: 2, ...(e.loop ? { strokeDasharray: "5 4" } : {}) },
    // A plain colour: the marker id is built from it, so no var().
    markerEnd: { type: MarkerType.ArrowClosed, color: theme === "dark" ? "#8193a8" : "#5b6b80" },
  }));
  edges.push(...linkEdges);

  if (!scenario || !root) {
    return <div className="canvas-bg flex h-full flex-col items-center justify-center gap-3 text-slate-400">
        <img src="/mark.png" alt="" className="h-16 w-16 opacity-30 grayscale" />
        {t.noSelection}
      </div>;
  }

  return (
    <ReactFlow
      key={`${root.id}/${callKey(path)}`}
      className="canvas-bg"
      colorMode={theme}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesConnectable={false}
      ref={wrapper}
      onInit={(flow) => {
        // Fit the chart, but never shrink it below reading size: a long
        // scenario starts at its top and scrolls instead.
        const box = wrapper.current;
        if (!box) return;
        const pad = 64;
        const fitW = (box.clientWidth - pad) / bounds.width;
        const fitH = (box.clientHeight - pad) / bounds.height;
        const zoom = Math.max(Math.min(fitW, fitH, 1), MIN_READABLE_ZOOM);
        const x = zoom > fitW ? pad / 2 : (box.clientWidth - bounds.width * zoom) / 2;
        // Inside a call, clear of the bar that says where the chart is.
        const y = inside ? 104 : pad / 2;
        void flow.setViewport({ x: x - bounds.x * zoom, y: y - bounds.y * zoom, zoom });

      }}
      minZoom={0.2}
      onNodeClick={(_, node) => {
        if (inside) return;
        const data = node.data as StepNodeData | SlotNodeData;
        if (data.kind === "step") select({ kind: "step", stepId: data.step.id ?? node.id });
        else select({ kind: "slot", parentId: data.parentId, block: data.block });
      }}
      onPaneClick={() => select(null)}
      onNodeDoubleClick={(_, node) => {
        const data = node.data as StepNodeData | SlotNodeData;
        if (data.kind === "step" && data.step.id && calls.get(data.step.id)?.callee) enterCall(data.step.id);
      }}
      // Double-clicking a call enters it; zooming there would only get in the way.
      zoomOnDoubleClick={false}
      // Dragging the view during a run means the person wants to look elsewhere.
      onMoveStart={(event) => event && run?.status === "running" && setFollowRun(false)}
      onNodeMouseEnter={(_, node) => node.type === "step" && focus.set(node.id)}
      onNodeMouseLeave={() => focus.set(null)}
    >
      <Background gap={24} size={1.2} color="var(--color-slate-300)" />
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
