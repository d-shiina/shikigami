import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useMemo } from "react";
import { useStudio } from "../context";
import { layoutScenario, NODE_W, type SlotNodeData, SLOT_H, type StepNodeData } from "../flow/layout";
import { t } from "../lib/i18n";
import { type StepRunState, touchedSteps } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";
import { usePendingReview } from "./Timeline";

type StepNodeProps = NodeProps<
  Node<StepNodeData & { runState?: StepRunState; issueCount: number; selected: boolean; byAi: boolean }>
>;

const RUN_STYLE: Record<StepRunState, string> = {
  running: "ring-2 ring-accent-500 animate-pulse",
  succeeded: "ring-2 ring-moegi-500/60",
  failed: "ring-2 ring-shu-500",
  skipped: "opacity-60",
};

function summary(data: StepNodeData): string {
  const p = data.step.params ?? {};
  const first = ["condition", "message", "items", "name", "count", "ms", "url", "selector"]
    .map((k) => p[k])
    .find((v) => v !== undefined && v !== "");
  return first === undefined ? "" : typeof first === "string" ? first : JSON.stringify(first);
}

function StepNode({ data }: StepNodeProps) {
  const category = data.def?.category ?? data.step.type.split(".")[0] ?? "other";
  return (
    <div
      style={{ width: NODE_W }}
      className={`relative flex overflow-hidden rounded-md border bg-sheet shadow-[0_1px_0_#e3d9c7,0_2px_6px_rgba(43,38,32,.06)] ${
        data.selected ? "border-ink ring-2 ring-ink/15" : "border-slate-200"
      } ${data.step.disabled ? "border-dashed opacity-60" : ""} ${data.runState ? RUN_STYLE[data.runState] : ""} ${
        data.byAi ? "outline-2 outline-offset-2 outline-shu-500/70 outline-dashed" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-slate-300" />
      <span className="w-1.5 shrink-0" style={{ background: CATEGORY_COLOR[category] ?? CATEGORY_COLOR.other }} />
      <div className="min-w-0 flex-1 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium tracking-wide text-slate-500">{data.def?.label ?? data.step.type}</span>
          {data.byAi && (
            <span className="swirl ml-auto rounded-full px-1.5 text-[9px] font-bold text-white" title={t.unreviewed}>
              AI
            </span>
          )}
          {data.issueCount > 0 && (
            <span className={`${data.byAi ? "" : "ml-auto"} rounded-full bg-shu-100 px-1.5 text-[10px] font-semibold text-shu-600`}>
              ! {data.issueCount}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-sm font-medium">{data.step.name || summary(data) || data.step.type}</div>
        {data.step.name && summary(data) && <div className="truncate font-mono text-[11px] text-slate-500">{summary(data)}</div>}
      </div>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-slate-300" />
    </div>
  );
}

function SlotNode({ data }: NodeProps<Node<SlotNodeData & { selected: boolean }>>) {
  return (
    <div
      style={{ width: NODE_W, height: SLOT_H }}
      className={`flex items-center justify-center rounded-md border border-dashed text-xs ${
        data.selected ? "border-ink bg-sheet text-ink" : "border-slate-300 text-slate-400"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-slate-300" />
      {data.parentId ? `${data.label}：空（クリックして ${t.shortcut} で追加）` : t.emptyScenario}
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-slate-300" />
    </div>
  );
}

const nodeTypes = { step: StepNode, slot: SlotNode };

export function FlowCanvas() {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
  const select = useStudio((s) => s.select);
  const pending = usePendingReview();
  const byAi = useMemo(() => new Set(pending.flatMap(touchedSteps)), [pending]);

  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const layout = useMemo(() => layoutScenario(scenario?.steps ?? [], defs), [scenario, defs]);

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
          byAi: byAi.has(id),
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

  const edges: Edge[] = layout.edges.map((e) => ({
    ...e,
    type: "smoothstep",
    animated: e.loop,
    style: e.loop ? { strokeDasharray: "4 4" } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#a29580" },
    labelBgPadding: [4, 2],
  }));

  if (!scenario) {
    return <div className="washi flex h-full flex-col items-center justify-center gap-3 text-slate-400">
        <img src="/mark.png" alt="" className="h-16 w-16 opacity-30 grayscale" />
        {t.noSelection}
      </div>;
  }

  return (
    <ReactFlow
      key={scenario.id}
      className="washi"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesConnectable={false}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.2}
      onNodeClick={(_, node) => {
        const data = node.data as StepNodeData | SlotNodeData;
        if (data.kind === "step") select({ kind: "step", stepId: data.step.id ?? node.id });
        else select({ kind: "slot", parentId: data.parentId, block: data.block });
      }}
      onPaneClick={() => select(null)}
    >
      <Background gap={24} size={1.2} color="#d8ccb6" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
