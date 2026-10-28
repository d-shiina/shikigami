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
import { useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { layoutScenario, NODE_W, type SlotNodeData, SLOT_H, type StepNodeData } from "../flow/layout";
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
  Node<StepNodeData & { runState?: StepRunState; issueCount: number; selected: boolean; byAi: boolean; reviews: HistoryEntry[]; vars: Map<string, string | undefined> }>
>;

const MIN_READABLE_ZOOM = 0.8;

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

type DataEdgeData = { variable: string; color: string; writes: VariableChange[]; lit: boolean; dim: boolean };

/** A variable link. Hovering it shows the values that travelled along it in the last run. */
function DataEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<DataEdgeData>>) {
  const [hover, setHover] = useState(false);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!data) return null;
  const strong = hover || data.lit;
  const last = data.writes.at(-1);
  return (
    <>
      <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={12}
          style={{ stroke: data.color, strokeWidth: strong ? 2.5 : 1.5, opacity: strong ? 1 : data.dim ? 0.15 : 0.45 }}
        />
      </g>
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
      <div style={{ height: ROW_H }} className="relative flex items-center justify-end gap-2 px-3 text-[11px]">
        <span className="text-slate-500">{row.label}</span>
        <span className="truncate font-mono font-semibold" style={{ color: typeColor(row.variable) }}>
          {row.variable}
        </span>
        <Socket side="out" id={outHandle(row.variable)} color={typeColor(row.variable)} title={`${row.variable} に書き込む`} />
      </div>
    );
  }
  return (
    <div style={{ height: ROW_H }} className="relative flex items-center gap-2 px-3 text-[11px]">
      {row.refs.length > 0 && <Socket side="in" id={inHandle(row.key)} color={typeColor(row.refs[0] ?? "")} title={`読む変数: ${row.refs.join(", ")}`} />}
      <span className="w-16 shrink-0 truncate text-slate-500" title={row.key}>
        {row.label}
      </span>
      <span className="h-[18px] min-w-0 flex-1 truncate rounded bg-slate-100 px-1.5 leading-[18px] text-ink" title={row.value}>
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
        <NodeToolbar isVisible position={Position.Right} offset={12}>
          <ReviewToolbar entry={latest} />
        </NodeToolbar>
      )}
      <Handle id="flow" type="target" position={Position.Top} className={FLOW_HANDLE} />
      <div
        style={{ height: 24, background: `${color}1a` }}
        className="flex items-center gap-1.5 rounded-t-[3px] border-b border-slate-100 px-3"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-[11px] font-bold" style={{ color }}>
          {data.def?.label ?? data.step.type}
        </span>
        {data.step.name && <span className="truncate text-[11px] text-slate-500">{data.step.name}</span>}
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
      <div style={{ height: NODE_HEAD_H - 24 }} className="flex items-center px-3 text-[12.5px]" title={plain(parts)}>
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
      <Handle id="flow" type="source" position={Position.Bottom} className={FLOW_HANDLE} />
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
      <Handle id="flow" type="target" position={Position.Top} className={FLOW_HANDLE} />
      {data.parentId ? `${data.label}：空（クリックして ${t.shortcut} で追加）` : t.emptyScenario}
      <Handle id="flow" type="source" position={Position.Bottom} className={FLOW_HANDLE} />
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

const nodeTypes = { step: StepNode, slot: SlotNode, io: IoNode };

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
          runState: run?.steps[id],
          issueCount: issueCounts.get(id) ?? 0,
          selected: selection?.kind === "step" && selection.stepId === id,
          byAi: reviews.has(id),
          reviews: reviews.get(id) ?? [],
          vars,
        },
      };
    }
    const slot = n.data;
    return {
      ...n,
      draggable: false,
      data: {
        ...slot,
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
      position: { x: layout.width + IO_GAP, y: layout.height + 16 },
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
    const lit = selectedId !== null && (l.from === selectedId || l.to === selectedId);
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
      data: { variable: l.variable, color, writes, lit, dim: selectedId !== null && !lit },
      zIndex: lit ? 1 : 0,
    };
  });

  const edges: Edge[] = layout.edges.map((e) => ({
    ...e,
    sourceHandle: "flow",
    targetHandle: "flow",
    type: "smoothstep",
    animated: e.loop,
    style: e.loop ? { strokeDasharray: "4 4" } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
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
        // scenario starts at its top and scrolls instead.
        const box = wrapper.current;
        if (!box) return;
        const pad = 64;
        const fit = Math.min((box.clientWidth - pad) / bounds.width, (box.clientHeight - pad) / layout.height, 1);
        const zoom = Math.max(fit, MIN_READABLE_ZOOM);
        const top = zoom > fit ? pad / 2 : (box.clientHeight - layout.height * zoom) / 2;
        void flow.setViewport({ x: (box.clientWidth - bounds.width * zoom) / 2 - bounds.x * zoom, y: top, zoom });
      }}
      minZoom={0.2}
      onNodeClick={(_, node) => {
        const data = node.data as StepNodeData | SlotNodeData | IoNodeData;
        if (data.kind === "io") return;
        if (data.kind === "step") select({ kind: "step", stepId: data.step.id ?? node.id });
        else select({ kind: "slot", parentId: data.parentId, block: data.block });
      }}
      onPaneClick={() => select(null)}
    >
      <Background gap={24} size={1.2} color="#c3cedb" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
