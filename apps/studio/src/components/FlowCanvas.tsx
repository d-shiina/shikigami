import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
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
} from "@xyflow/react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStudio } from "../context";
import { type Direction, type FrameNodeData, layoutScenario, NODE_W, type SlotNodeData, SLOT_H, type StepNodeData } from "../flow/layout";
import { t } from "../lib/i18n";
import type { HistoryEntry, VariableDef } from "@shikigami/schema";
import { dataLinks, INPUT_NODE, inHandle, OUTPUT_NODE, outHandle } from "../lib/dataFlow";
import { actorLabel, describe } from "../lib/changes";
import { NODE_HEAD_H, NODE_PAD_B, nodeRows, knownVariables, ROW_H, type Row, TYPE_COLOR } from "../lib/nodeRows";
import { plain, sentence } from "../lib/sentence";
import { valueText, writesFrom } from "../lib/runValues";
import { revertBlocker, type StepRunState, touchedSteps, type VariableChange } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";
import { Sentence } from "./StoryView";
import { ActorMark, entryScope, usePendingReview } from "./Timeline";

type StepNodeProps = NodeProps<
  Node<StepNodeData & { runState?: StepRunState; issueCount: number; selected: boolean; byAi: boolean; reviews: HistoryEntry[]; vars: Map<string, string | undefined>; dir: Direction }>
>;

const MIN_READABLE_ZOOM = 0.85;

const RUN_STYLE: Record<StepRunState, string> = {
  running: "ring-2 ring-accent-500 animate-pulse",
  succeeded: "ring-2 ring-moegi-500/60",
  failed: "ring-2 ring-shu-500",
  skipped: "opacity-60",
};

/** 残す / 差し戻す for an unreviewed AI edit, floating beside its node. */
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

type DataEdgeData = {
  variable: string;
  color: string;
  writes: VariableChange[];
  from: string;
  to: string;
  selectedId: string | null;
};

/**
 * The step under the pointer. Kept outside React state so hovering only
 * re-renders the links: re-rendering the whole canvas mid-click swallowed
 * the click that selects a step.
 */
const hovered = (() => {
  let id: string | null = null;
  const listeners = new Set<() => void>();
  return {
    set(next: string | null) {
      if (next === id) return;
      id = next;
      for (const l of listeners) l();
    },
    get: () => id,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

/** A variable link. Hovering it shows the values that travelled along it in the last run. */
function DataEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<DataEdgeData>>) {
  const [hover, setHover] = useState(false);
  const hoveredStep = useSyncExternalStore(hovered.subscribe, hovered.get);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!data) return null;
  // Links of the step under the pointer (or else the selected one) light up.
  const focus = hoveredStep ?? data.selectedId;
  const lit = focus !== null && (data.from === focus || data.to === focus);
  const dim = focus !== null && !lit;
  const strong = hover || lit;
  const last = data.writes.at(-1);
  return (
    <>
      <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={12}
          style={{ stroke: data.color, strokeWidth: strong ? 2.5 : 1.25, opacity: strong ? 1 : dim ? 0.12 : 0.35 }}
        />
      </g>
      {last && !hover && lit && (
        <EdgeLabelRenderer>
          {/* The last value that travelled along this link, always visible after a run. */}
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, borderColor: data.color }}
            className="nodrag nopan pointer-events-none absolute max-w-[68px] truncate rounded-[3px] border bg-sheet px-1 font-mono text-[10px] leading-[16px] text-ink shadow-sm"
          >
            {valueText(last)}
            {data.writes.length > 1 && <span className="ml-1 text-slate-400">×{data.writes.length}</span>}
          </div>
        </EdgeLabelRenderer>
      )}
      {hover && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -110%) translate(${labelX}px, ${labelY}px)` }}
            className="pointer-events-none absolute z-50 max-w-[280px] rounded-[4px] border border-slate-200 bg-sheet px-2.5 py-1.5 text-[11px] shadow-lg"
          >
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: data.color }} />
              <span className="font-mono font-semibold">{data.variable}</span>
              {data.writes.length > 1 && <span className="text-slate-400">{data.writes.length}回変化</span>}
            </div>
            {last ? (
              <ul className="mt-1 space-y-0.5 font-mono">
                {data.writes.slice(-5).map((w) => (
                  <li key={w.seq} className={`truncate ${w === last ? "font-semibold text-ink" : "text-slate-500"}`}>
                    {w.iteration != null && <span className="mr-1 text-slate-400">[{w.iteration}]</span>}
                    {valueText(w)}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-0.5 text-slate-400">実行すると、ここに渡った値が出ます</div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { data: DataEdge };

function NodeRow({ row, vars }: { row: Row; vars: Map<string, string | undefined> }) {
  const typeColor = (name: string): string => TYPE_COLOR[vars.get(name) ?? "any"] ?? "#94a3b8";
  if (row.kind === "more") {
    return <div style={{ height: ROW_H }} className="flex items-center px-3 text-[10px] text-slate-400">…ほか {row.count} 項目</div>;
  }
  if (row.kind === "output") {
    return (
      <div style={{ height: ROW_H }} className="relative flex items-center justify-end gap-2 px-3 text-[12px]">
        <span className="text-slate-500">{row.label}</span>
        <span className="truncate font-mono font-semibold" style={{ color: typeColor(row.variable) }}>
          {row.variable}
        </span>
        <Socket side="out" id={outHandle(row.variable)} color={typeColor(row.variable)} title={`${row.variable} に書き込む`} />
      </div>
    );
  }
  return (
    <div style={{ height: ROW_H }} className="relative flex items-center gap-2 px-3 text-[12px]">
      {row.refs.length > 0 && <Socket side="in" id={inHandle(row.key)} color={typeColor(row.refs[0] ?? "")} title={`読む変数: ${row.refs.join(", ")}`} />}
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
        data.byAi ? "ai-border" : data.selected ? "border-brand-500 ring-4 ring-brand-100" : "border-slate-200"
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
      <div
        style={{ height: 24, background: `${color}1a` }}
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
            <NodeRow key={i} row={row} vars={data.vars} />
          ))}
        </div>
      )}
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

type IoNodeData = { kind: "io"; side: "input" | "output"; variables: VariableDef[] };

/** The scenario's own inputs (starting values) or returned outputs, like Blender's group input/output. */
function IoNode({ data }: NodeProps<Node<IoNodeData>>) {
  const input = data.side === "input";
  return (
    <div style={{ width: IO_W }} className="rounded-[4px] border border-slate-300 bg-sheet shadow-[0_1px_2px_rgba(15,27,42,.06),0_4px_12px_rgba(15,27,42,.05)]">
      <div style={{ height: 24 }} className="flex items-center gap-1.5 rounded-t-[3px] bg-ink px-3 text-[11px] font-bold text-paper">
        <span className="swirl h-2 w-2 rounded-full" />
        {input ? "シナリオ入力" : "シナリオ出力"}
      </div>
      <div style={{ paddingTop: 4, paddingBottom: NODE_PAD_B }}>
        {data.variables.map((v) => {
          const color = TYPE_COLOR[v.type ?? "any"] ?? TYPE_COLOR.any ?? "#94a3b8";
          const tag = input ? (v.direction === "input" || v.direction === "inOut" ? "入力" : "初期値") : "返す";
          return (
            <div key={v.name} style={{ height: ROW_H }} className={`relative flex items-center gap-2 px-3 text-[11px] ${input ? "justify-end" : ""}`}>
              {!input && <Socket side="in" id={inHandle(v.name)} color={color} title={`${v.name} を返す`} />}
              <span className="text-[10px] text-slate-400">{tag}</span>
              <span className="truncate font-mono font-semibold" style={{ color }}>
                {v.name}
              </span>
              {input && <Socket side="out" id={outHandle(v.name)} color={color} title={`${v.name} の${tag}`} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const IO_W = 180;
const IO_GAP = 72;

/** Shades for nested blocks, lightest outside. */
const FRAME_TINT = ["#eaf1f8", "#e2ebf5", "#d9e5f2"];

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

const nodeTypes = { step: StepNode, slot: SlotNode, io: IoNode, frame: FrameNode };

export function FlowCanvas() {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
  const select = useStudio((s) => s.select);
  const pending = usePendingReview();
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
          byAi: reviews.has(id),
          reviews: reviews.get(id) ?? [],
          vars,
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

  const declared = scenario?.variables ?? [];
  const returned = declared.filter((v) => v.direction === "output" || v.direction === "inOut");
  const links = useMemo(
    () => dataLinks(scenario?.steps ?? [], scenario?.variables, defs, new Set(vars.keys())),
    [scenario, defs, vars],
  );
  if (declared.length > 0) {
    nodes.push({
      id: INPUT_NODE,
      type: "io",
      draggable: false,
      selectable: false,
      position: { x: -IO_W - IO_GAP, y: 0 },
      data: { kind: "io", side: "input", variables: declared },
    });
  }
  if (returned.length > 0) {
    nodes.push({
      id: OUTPUT_NODE,
      type: "io",
      draggable: false,
      selectable: false,
      // Below the last step, so review buttons beside nodes never cover it.
      position: layout.direction === "horizontal" ? { x: layout.width + IO_GAP, y: 0 } : { x: layout.width + IO_GAP, y: layout.height + 16 },
      data: { kind: "io", side: "output", variables: returned },
    });
  }
  const bounds = {
    x: declared.length > 0 ? -IO_W - IO_GAP : 0,
    width: layout.width + (declared.length > 0 ? IO_W + IO_GAP : 0) + (returned.length > 0 ? IO_W + IO_GAP : 0),
  };

  // Links stay faint behind the chart; the selected step's own links light up.
  const selectedId = selection?.kind === "step" ? selection.stepId : null;
  const dataEdges: Edge[] = links.map((l) => {
    const color = TYPE_COLOR[vars.get(l.variable) ?? "any"] ?? "#94a3b8";
    const writes = run ? writesFrom(run.changes, l.variable, l.from) : [];
    return {
      id: `data:${l.from}:${l.variable}->${l.to}:${l.toHandle}`,
      source: l.from,
      sourceHandle: outHandle(l.variable),
      target: l.to,
      targetHandle: l.toHandle,
      type: "data",
      className: "data-link",
      selectable: false,
      focusable: false,
      data: { variable: l.variable, color, writes, from: l.from, to: l.to, selectedId },
      // Always beneath the steps, so a highlighted link never takes a click meant for a step.
      zIndex: 0,
    };
  });

  const edges: Edge[] = layout.edges.map((e) => ({
    ...e,
    sourceHandle: "flow",
    targetHandle: "flow",
    // Left to right, the frames carry the block names.
    label: layout.direction === "horizontal" ? undefined : e.label,
    type: "smoothstep",
    animated: e.loop,
    style: { stroke: "#5b6b80", strokeWidth: 2, ...(e.loop ? { strokeDasharray: "5 4" } : {}) },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#5b6b80" },
    labelBgPadding: [4, 2],
  }));
  edges.push(...dataEdges);

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
        const fitH = (box.clientHeight - pad) / layout.height;
        const zoom = Math.max(Math.min(fitW, fitH, 1), MIN_READABLE_ZOOM);
        const x = zoom > fitW ? pad / 2 : (box.clientWidth - bounds.width * zoom) / 2;
        const y = zoom > fitH || layout.direction === "horizontal" ? pad / 2 + 24 : (box.clientHeight - layout.height * zoom) / 2;
        void flow.setViewport({ x: x - bounds.x * zoom, y, zoom });
      }}
      minZoom={0.2}
      onNodeClick={(_, node) => {
        const data = node.data as StepNodeData | SlotNodeData | IoNodeData;
        if (data.kind === "io") return;
        if (data.kind === "step") select({ kind: "step", stepId: data.step.id ?? node.id });
        else select({ kind: "slot", parentId: data.parentId, block: data.block });
      }}
      onPaneClick={() => select(null)}
      onNodeMouseEnter={(_, node) => node.type === "step" && hovered.set(node.id)}
      onNodeMouseLeave={() => hovered.set(null)}
    >
      <Background gap={24} size={1.2} color="#c3cedb" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
