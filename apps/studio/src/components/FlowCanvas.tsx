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
import type { HistoryEntry } from "@shikigami/schema";
import { dataLinks, inHandle, outHandle } from "../lib/dataFlow";
import { hubLinks } from "../lib/varHub";
import { actorLabel, describe, formatValue } from "../lib/changes";
import { NODE_HEAD_H, NODE_PAD_B, nodeRows, knownVariables, ROW_H, type Row, TYPE_COLOR } from "../lib/nodeRows";
import { plain, sentence } from "../lib/sentence";
import { valueText } from "../lib/runValues";
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
  const lit = focus !== null && (data.from === focus || data.to === focus || focus === varFocus(data.variable));
  // With nothing in focus no links are drawn: a scenario with many
  // variables would otherwise be a web of lines.
  if (!lit) return null;
  const last = data.writes.at(-1);
  return (
    <>
      <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={12}
          style={{ stroke: data.color, strokeWidth: hover ? 3 : 2, opacity: 1 }}
        />
      </g>
      {last && !hover && (
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

type HubRow = { name: string; type: string; tag: string; value?: string };
type HubNodeData = { kind: "hub"; rows: HubRow[] };

const HUB_ID = "@variables";
const HUB_W = 220;
const HUB_ROW_H = 46;
const HUB_HEAD_H = 30;
const HUB_GAP = 120;
const writeHandle = (v: string) => `w:${v}`;
const readHandle = (v: string) => `r:${v}`;
/** Hover focus for a whole variable (its row in the box), as opposed to a step id. */
const varFocus = (v: string) => `var:${v}`;

/**
 * The variable box, a list down the left of the chart. Steps that write a
 * variable and steps that read it link to its row, shown only for the step
 * or variable under the pointer (or selected), so many variables never
 * turn into a web of lines.
 */
function HubNode({ data }: NodeProps<Node<HubNodeData>>) {
  return (
    <div style={{ width: HUB_W }} className="rounded-[6px] border border-slate-300 bg-sheet shadow-[0_1px_2px_rgba(15,27,42,.06),0_4px_12px_rgba(15,27,42,.05)]">
      <div style={{ height: HUB_HEAD_H }} className="flex items-center gap-1.5 rounded-t-[5px] bg-ink px-3 text-[12px] font-bold text-paper">
        <span className="swirl h-2.5 w-2.5 rounded-full" />
        変数
        <span className="ml-auto font-normal text-paper/60">{data.rows.length}</span>
      </div>
      {data.rows.map((r) => {
        const color = TYPE_COLOR[r.type] ?? "#94a3b8";
        const handle = { width: 10, height: 10, border: "2px solid white", boxShadow: "0 0 0 1px rgba(15,27,42,.25)", background: color };
        return (
          <div
            key={r.name}
            style={{ height: HUB_ROW_H }}
            className="relative flex flex-col justify-center border-t border-slate-100 px-3 hover:bg-brand-50"
            title={r.value}
            onMouseEnter={() => hovered.set(varFocus(r.name))}
            onMouseLeave={() => hovered.set(null)}
          >
            <div className="flex items-baseline gap-1.5">
              <span className="truncate font-mono text-[13px] font-bold" style={{ color }}>
                {r.name}
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-slate-400">{r.tag}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-slate-500">{r.value ?? "—"}</div>
            <Handle id={writeHandle(r.name)} type="target" position={Position.Right} isConnectable={false} style={{ ...handle, top: "35%" }} title={`${r.name} に書き込む`} />
            <Handle id={readHandle(r.name)} type="source" position={Position.Right} isConnectable={false} style={{ ...handle, top: "65%" }} title={`${r.name} を読む`} />
          </div>
        );
      })}
    </div>
  );
}

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

const nodeTypes = { step: StepNode, slot: SlotNode, hub: HubNode, frame: FrameNode };

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
  const links = useMemo(
    () => dataLinks(scenario?.steps ?? [], scenario?.variables, defs, new Set(vars.keys())),
    [scenario, defs, vars],
  );
  const hubItems = useMemo(() => hubLinks(scenario?.steps ?? [], links), [scenario, links]);

  const lastValue = (name: string) => {
    const last = run?.changes.filter((c) => c.variable === name).at(-1);
    if (last) return valueText(last);
    const def = declared.find((v) => v.name === name);
    return def?.default === undefined ? undefined : formatValue(def.default);
  };
  // Inputs first, then outputs, internal variables and loop elements.
  const GROUPS: [string, (d?: string) => boolean][] = [
    ["入力", (d) => d === "input" || d === "inOut"],
    ["出力", (d) => d === "output"],
    ["内部", (d) => d === "local"],
  ];
  const hubRows: HubRow[] = [];
  for (const [tag, match] of GROUPS) {
    for (const v of declared) if (match(v.direction ?? "local")) hubRows.push({ name: v.name, type: v.type ?? "any", tag, value: lastValue(v.name) });
  }
  for (const [name, type] of vars) {
    if (!declared.some((v) => v.name === name)) hubRows.push({ name, type: type ?? "any", tag: "要素", value: lastValue(name) });
  }
  if (hubRows.length > 0) {
    nodes.push({
      id: HUB_ID,
      type: "hub",
      draggable: false,
      selectable: false,
      position: { x: -HUB_W - HUB_GAP, y: 0 },
      data: { kind: "hub", rows: hubRows },
    });
  }
  const hubHeight = hubRows.length > 0 ? HUB_HEAD_H + hubRows.length * HUB_ROW_H : 0;
  const bounds = {
    x: hubRows.length > 0 ? -HUB_W - HUB_GAP : 0,
    width: layout.width + (hubRows.length > 0 ? HUB_W + HUB_GAP : 0),
    y: 0,
    height: Math.max(layout.height, hubHeight),
  };

  // Links stay faint behind the chart; the hovered or selected step's own links light up.
  const selectedId = selection?.kind === "step" ? selection.stepId : null;
  const dataEdges: Edge[] = hubItems.map((l) => {
    const color = TYPE_COLOR[vars.get(l.variable) ?? "any"] ?? "#94a3b8";
    const all = run?.changes.filter((c) => c.variable === l.variable) ?? [];
    const write = l.kind === "write";
    return {
      id: write ? `data:${l.step}:${l.variable}->hub` : `data:hub:${l.variable}->${l.step}:${l.handle}`,
      source: write ? l.step : HUB_ID,
      sourceHandle: write ? outHandle(l.variable) : readHandle(l.variable),
      target: write ? HUB_ID : l.step,
      targetHandle: write ? writeHandle(l.variable) : l.handle,
      type: "data",
      className: "data-link",
      selectable: false,
      focusable: false,
      data: {
        variable: l.variable,
        color,
        writes: write ? all.filter((c) => c.stepId === l.step) : all,
        from: write ? l.step : HUB_ID,
        to: write ? HUB_ID : l.step,
        selectedId,
      },
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
        const fitH = (box.clientHeight - pad) / bounds.height;
        const zoom = Math.max(Math.min(fitW, fitH, 1), MIN_READABLE_ZOOM);
        const x = zoom > fitW ? pad / 2 : (box.clientWidth - bounds.width * zoom) / 2;
        const y = zoom > fitH || layout.direction === "horizontal" ? pad / 2 : (box.clientHeight - bounds.height * zoom) / 2;
        void flow.setViewport({ x: x - bounds.x * zoom, y: y - bounds.y * zoom, zoom });
      }}
      minZoom={0.2}
      onNodeClick={(_, node) => {
        const data = node.data as StepNodeData | SlotNodeData | HubNodeData | FrameNodeData;
        if (data.kind === "hub" || data.kind === "frame") return;
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
