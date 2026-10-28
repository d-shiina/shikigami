import {
  Background,
  BaseEdge,
  type EdgeProps,
  getBezierPath,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  NodeToolbar,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStudio } from "../context";
import { CHIP_ROOM, type Direction, type FrameNodeData, layoutScenario, NODE_W, type SlotNodeData, SLOT_H, type StepNodeData } from "../flow/layout";
import { t } from "../lib/i18n";
import type { HistoryEntry } from "@shikigami/schema";
import { dataLinks, INPUT_NODE, inHandle, OUTPUT_NODE, outHandle } from "../lib/dataFlow";
import { focus, useFocus, varFocus } from "../lib/focus";
import { useTheme } from "../lib/theme";
import { actorLabel, describe } from "../lib/changes";
import { NODE_HEAD_H, NODE_PAD_B, nodeRows, knownVariables, ROW_H, type Row, TYPE_COLOR } from "../lib/nodeRows";
import { plain, sentence } from "../lib/sentence";
import { revertBlocker, type StepRunState, type StepStart, touchedSteps, type VariableChange } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";
import { Sentence } from "./StoryView";
import { ChangeView, changeText } from "./ValueView";
import { valuesSeenBy } from "../lib/runValues";
import { type StepDiff, summarize } from "../lib/review";
import { ActorMark, entryScope, usePendingReview } from "./Timeline";

type StepNodeProps = NodeProps<
  Node<StepNodeData & { runState?: StepRunState; issueCount: number; selected: boolean; byAi: boolean; reviews: HistoryEntry[]; vars: Map<string, string | undefined>; run: RunValues; diff?: StepDiff; note?: string; dir: Direction }>
>;

const MIN_READABLE_ZOOM = 0.85;
/** Width of the outline panel plus its gap, from the canvas's left edge. */
const OUTLINE_W = 284;

const DIFF_STYLE: Record<StepDiff, { border: string; tag: string; label: string }> = {
  added: { border: "border-moegi-500", tag: "bg-moegi-500", label: "AIが追加" },
  changed: { border: "border-accent-500", tag: "bg-accent-500", label: "AIが変更" },
};

/** Which way the chart runs, for rows deciding whether to show chips. */
const DirContext = createContext<Direction>("horizontal");

const RUN_STYLE: Record<StepRunState, string> = {
  running: "ring-2 ring-accent-500 animate-pulse",
  succeeded: "ring-2 ring-moegi-500/60",
  failed: "ring-2 ring-shu-500",
  skipped: "opacity-60",
};

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
    <div title={scope.title} className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-sheet py-1 pr-1 pl-1.5 text-[11px] shadow-md">
      <ActorMark entry={entry} size={18} />
      <span className="text-slate-600">{actorLabel(entry)}の変更</span>
      <button type="button" onClick={() => approve(entry.revision)} className="rounded-full bg-ink px-2 py-0.5 text-paper hover:bg-slate-700">
        {t.approve}
        {scope.suffix}
      </button>
      <button
        type="button"
        onClick={() => revert(entry)}
        disabled={blocker !== null}
        title={blocker ?? scope.title}
        className="rounded-full border border-shu-500 px-2 py-0.5 text-shu-600 enabled:hover:bg-shu-50 disabled:border-slate-300 disabled:text-slate-400"
      >
        {t.revert}
        {scope.suffix}
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

/**
 * Where step-to-step flow enters and leaves a node. Left to right, it uses
 * the header's height on the side edges, clear of the variable sockets below.
 */
function FlowHandles({ dir, atHeader = true }: { dir: Direction; atHeader?: boolean }) {
  const across = dir === "horizontal";
  const style = across && atHeader ? { top: 12 } : undefined;
  return (
    <>
      <Handle id="flow" type="target" position={across ? Position.Left : Position.Top} style={style} className={FLOW_HANDLE} />
      <Handle id="flow" type="source" position={across ? Position.Right : Position.Bottom} style={style} className={FLOW_HANDLE} />
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

const edgeTypes = { link: LinkEdge };

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
      className={`pointer-events-none fixed z-50 max-w-[480px] -translate-x-1/2 ${below ? "" : "-translate-y-full"} rounded-[4px] border border-slate-200 bg-sheet px-2.5 py-1.5 text-[11px] shadow-lg`}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="font-mono font-semibold">{name}</span>
        <span className="text-slate-400">
          {side === "in" ? "このステップが受け取った値" : "このステップが書き込んだ値"}
          {many && `（${values.length}回実行）`}
        </span>
      </div>
      {values.length === 0 ? (
        <div className="mt-0.5 text-slate-400">実行すると、ここに値が出ます</div>
      ) : (
        <ol className="mt-1.5 space-y-1">
          {values.slice(0, MAX_RUNS).map((w, i) => (
            <li key={`${w.seq}-${i}`} className="flex items-start gap-2">
              {many && <span className="w-9 shrink-0 pt-1 text-[10px] text-slate-400">{i + 1}回目</span>}
              <div className="min-w-0 flex-1 rounded-[3px] border border-slate-100 bg-paper px-2 py-1">
                <ChangeView change={w} />
              </div>
            </li>
          ))}
          {values.length > MAX_RUNS && <li className="text-[10px] text-slate-400">…ほか {values.length - MAX_RUNS} 回</li>}
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
      className={`nodrag flex h-[20px] max-w-[72px] shrink-0 items-center gap-1 rounded-[3px] border bg-sheet px-1.5 font-mono text-[11px] leading-none shadow-sm ${
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
        <span className="truncate font-semibold">{name}</span>
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
  const across = useContext(DirContext) === "horizontal";
  if (row.kind === "more") {
    return <div style={{ height: ROW_H }} className="flex items-center px-3 text-[10px] text-slate-400">…ほか {row.count} 項目</div>;
  }
  if (row.kind === "output") {
    const color = typeColor(row.variable);
    const lit = focused === varFocus(row.variable);
    return (
      <div style={{ height: ROW_H, background: lit ? `color-mix(in srgb, ${color} 12%, transparent)` : undefined }} className="relative flex items-center justify-end gap-2 px-3 text-[12px]">
        <span className="text-slate-500">{row.label}</span>
        <span className="truncate font-mono font-semibold" style={{ color }}>
          {row.variable}
        </span>
        <Socket side="out" id={outHandle(row.variable)} color={color} title={`${row.variable} に書き込む`} />
        {across && (
          <Chips side="out" color={color}>
            <VarChip
              side="out"
              owner={stepId}
              name={row.variable}
              color={color}
              values={run.changes.filter((c) => c.variable === row.variable && c.stepId === stepId)}
            />
          </Chips>
        )}
      </div>
    );
  }
  const first = typeColor(row.refs[0] ?? "");
  const lit = row.refs.some((r) => focused === varFocus(r));
  return (
    <div style={{ height: ROW_H, background: lit ? `${first}1f` : undefined }} className="relative flex items-center gap-2 px-3 text-[12px]">
      {row.refs.length > 0 && <Socket side="in" id={inHandle(row.key)} color={first} title={`読む変数: ${row.refs.join(", ")}`} />}
      {across && row.refs.length > 0 && (
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
      className={`relative rounded-[4px] border bg-sheet shadow-[0_1px_2px_rgba(15,27,42,.06),0_4px_12px_rgba(15,27,42,.05)] ${
        data.diff
          ? `border-2 ${DIFF_STYLE[data.diff].border} ${data.selected ? "ring-4 ring-brand-100" : ""}`
          : data.byAi
            ? "ai-border"
            : data.selected
              ? "border-brand-500 ring-4 ring-brand-100"
              : "border-slate-200"
      } ${data.selected && data.byAi ? "ring-4 ring-brand-100" : ""} ${data.step.disabled ? "border-dashed opacity-60" : ""} ${
        data.runState ? RUN_STYLE[data.runState] : ""
      }`}
    >
      {latest && (
        <NodeToolbar isVisible position={data.dir === "horizontal" ? Position.Top : Position.Right} offset={12}>
          <ReviewToolbar entry={latest} />
        </NodeToolbar>
      )}
      <FlowHandles dir={data.dir} />
      {data.note && (
        <span
          title={data.note}
          className="absolute bottom-full left-1 z-10 mb-1 max-w-[95%] truncate rounded-[4px] border border-shu-500 bg-shu-50 px-2 text-[10px] leading-[18px] font-bold text-shu-600"
        >
          指摘：{data.note}
        </span>
      )}
      {data.diff && (
        <span className={`absolute -top-2.5 right-2 z-10 rounded-full px-2 text-[10px] leading-5 font-bold text-white ${DIFF_STYLE[data.diff].tag}`}>
          {DIFF_STYLE[data.diff].label}
        </span>
      )}
      <DirContext.Provider value={data.dir}>
      <div
        style={{ height: 24, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
        className="flex items-center gap-1.5 rounded-t-[3px] border-b border-slate-100 px-3"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-[12px] font-bold" style={{ color }}>
          {data.def?.label ?? data.step.type}
        </span>
        {data.step.name && <span className="truncate text-[12px] text-slate-500">{data.step.name}</span>}
        {data.byAi && (
          <span className="swirl ml-auto shrink-0 rounded-full px-1.5 text-[9px] font-bold text-white" title={t.unreviewed}>
            AI
          </span>
        )}
        {data.issueCount > 0 && (
          <span className={`${data.byAi ? "" : "ml-auto"} shrink-0 rounded-full bg-shu-100 px-1.5 text-[10px] font-semibold text-shu-600`}>
            ! {data.issueCount}
          </span>
        )}
      </div>
      <div style={{ height: NODE_HEAD_H - 24 }} className="flex items-center px-3 text-[14px]" title={plain(parts)}>
        <span className="truncate">
          <Sentence parts={parts} />
        </span>
      </div>
      {rows.length > 0 && (
        <div style={{ paddingBottom: NODE_PAD_B }} className="border-t border-dashed border-slate-200">
          {rows.map((row, i) => (
            <NodeRow key={i} row={row} vars={data.vars} run={data.run} stepId={data.step.id ?? ""} />
          ))}
        </div>
      )}
      </DirContext.Provider>
    </div>
  );
}

function SlotNode({ data }: NodeProps<Node<SlotNodeData & { selected: boolean; dir: Direction }>>) {
  return (
    <div
      style={{ width: NODE_W, height: SLOT_H }}
      className={`flex items-center justify-center rounded-[4px] border border-dashed text-xs ${
        data.selected ? "border-brand-500 bg-brand-50 text-brand-600" : "border-slate-300 text-slate-400"
      }`}
    >
      <FlowHandles dir={data.dir} atHeader={false} />
      {data.parentId ? `${data.label}：空（クリックして ${t.shortcut} で追加）` : t.emptyScenario}

    </div>
  );
}

/** Shades for nested blocks, lightest outside. */
const FRAME_TINT = ["var(--frame-0)", "var(--frame-1)", "var(--frame-2)"];

/** The box behind a step's block, labelled like the block ("条件が真", "要素ごとの処理"). */
function FrameNode({ data }: NodeProps<Node<FrameNodeData>>) {
  return (
    <div
      style={{ width: data.width, height: data.height, background: FRAME_TINT[data.depth % FRAME_TINT.length] }}
      className="pointer-events-none rounded-[6px] border border-slate-300/70"
    >
      <div className="flex items-center gap-1 px-2.5 pt-1 text-[11px] font-bold tracking-wide text-slate-500">
        {data.loop && <span className="text-[13px] leading-none text-brand-600">↻</span>}
        {data.label}
        {data.loop && <span className="font-normal text-slate-400">（くり返す）</span>}
      </div>
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
  return null;
}

const nodeTypes = { step: StepNode, slot: SlotNode, frame: FrameNode };

export function FlowCanvas() {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
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
  const layout = useMemo(() => layoutScenario(scenario?.steps ?? [], defs), [scenario, defs]);
  const vars = useMemo(() => knownVariables(scenario?.variables, scenario?.steps ?? []), [scenario]);

  const issueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of validation?.issues ?? []) {
      if (issue.stepId && issue.severity === "error") counts.set(issue.stepId, (counts.get(issue.stepId) ?? 0) + 1);
    }
    return counts;
  }, [validation]);

  const nodes: Node[] = layout.nodes.map((n) => {
    if (n.data.kind === "step") {
      const id = n.data.step.id ?? n.id;
      return {
        ...n,
        draggable: false,
        data: {
          ...n.data,
          dir: layout.direction,
          runState: run?.steps[id],
          issueCount: issueCounts.get(id) ?? 0,
          selected: selection?.kind === "step" && selection.stepId === id,
          byAi: !reviewing && reviews.has(id),
          reviews: reviewing ? [] : (reviews.get(id) ?? []),
          diff: reviewing ? diffs.get(id) : undefined,
          note: reviewing ? notes.get(id) : undefined,
          vars,
          run: run ? { changes: run.changes, starts: run.starts } : NO_RUN,
        },
      };
    }
    if (n.data.kind === "frame") {
      return { ...n, draggable: false, selectable: false, focusable: false, zIndex: -1 };
    }
    const slot = n.data;
    return {
      ...n,
      draggable: false,
      data: {
        ...slot,
        dir: layout.direction,
        selected: selection?.kind === "slot" && selection.parentId === slot.parentId && selection.block === slot.block,
      },
    };
  });

  // Read chips stick out left of the first step, write chips right of the last.
  const chips = layout.direction === "horizontal" ? CHIP_ROOM : 0;
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
    // Left to right, the frames carry the block names.
    label: layout.direction === "horizontal" ? undefined : e.label,
    type: "smoothstep",
    animated: e.loop,
    style: { stroke: "var(--flow-edge)", strokeWidth: 2, ...(e.loop ? { strokeDasharray: "5 4" } : {}) },
    // A plain colour: the marker id is built from it, so no var().
    markerEnd: { type: MarkerType.ArrowClosed, color: theme === "dark" ? "#8193a8" : "#5b6b80" },
    labelBgPadding: [4, 2],
  }));
  edges.push(...linkEdges);

  if (!scenario) {
    return <div className="canvas-bg flex h-full flex-col items-center justify-center gap-3 text-slate-400">
        <img src="/mark.png" alt="" className="h-16 w-16 opacity-30 grayscale" />
        {t.noSelection}
      </div>;
  }

  return (
    <ReactFlow
      key={scenario.id}
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
        // scenario starts at its beginning (left, or top) and scrolls instead.
        const box = wrapper.current;
        if (!box) return;
        const pad = 64;
        const fitW = (box.clientWidth - pad) / bounds.width;
        const fitH = (box.clientHeight - pad) / bounds.height;
        const zoom = Math.max(Math.min(fitW, fitH, 1), MIN_READABLE_ZOOM);
        const x = zoom > fitW ? pad / 2 : (box.clientWidth - bounds.width * zoom) / 2;
        const y = zoom > fitH || layout.direction === "horizontal" ? pad / 2 : (box.clientHeight - bounds.height * zoom) / 2;
        void flow.setViewport({ x: x - bounds.x * zoom, y: y - bounds.y * zoom, zoom });

      }}
      minZoom={0.2}
      onNodeClick={(_, node) => {
        const data = node.data as StepNodeData | SlotNodeData | FrameNodeData;
        if (data.kind === "frame") return;
        if (data.kind === "step") select({ kind: "step", stepId: data.step.id ?? node.id });
        else select({ kind: "slot", parentId: data.parentId, block: data.block });
      }}
      onPaneClick={() => select(null)}
      // Dragging the view during a run means the person wants to look elsewhere.
      onMoveStart={(event) => event && run?.status === "running" && setFollowRun(false)}
      onNodeMouseEnter={(_, node) => node.type === "step" && focus.set(node.id)}
      onNodeMouseLeave={() => focus.set(null)}
    >
      <Background gap={24} size={1.2} color="var(--color-slate-300)" />
      <Follow />
      {reviewing && <FocusOn id={layout.nodes.find((n) => diffs.has(n.id))?.id} />}
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
