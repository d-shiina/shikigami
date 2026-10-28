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
import type { StepRunState } from "../store";

type StepNodeProps = NodeProps<Node<StepNodeData & { runState?: StepRunState; issueCount: number; selected: boolean }>>;

const RUN_STYLE: Record<StepRunState, string> = {
  running: "ring-2 ring-accent-500 animate-pulse",
  succeeded: "ring-2 ring-emerald-400",
  failed: "ring-2 ring-red-500",
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
  const control = data.step.type.startsWith("control.");
  return (
    <div
      style={{ width: NODE_W }}
      className={`rounded-lg border bg-white px-3 py-2 shadow-sm ${
        data.selected ? "border-brand-500 ring-2 ring-brand-100" : "border-slate-300"
      } ${data.step.disabled ? "border-dashed opacity-60" : ""} ${data.runState ? RUN_STYLE[data.runState] : ""}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            control ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600"
          }`}
        >
          {data.def?.label ?? data.step.type}
        </span>
        {data.issueCount > 0 && (
          <span className="ml-auto rounded-full bg-red-100 px-1.5 text-[10px] font-semibold text-red-700">
            ! {data.issueCount}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-sm font-medium">{data.step.name || summary(data) || data.step.type}</div>
      {data.step.name && summary(data) && <div className="truncate text-xs text-slate-500">{summary(data)}</div>}
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}

function SlotNode({ data }: NodeProps<Node<SlotNodeData & { selected: boolean }>>) {
  return (
    <div
      style={{ width: NODE_W, height: SLOT_H }}
      className={`flex items-center justify-center rounded-lg border-2 border-dashed text-xs ${
        data.selected ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-400"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-300" />
      {data.parentId ? `（${data.label}：空）ここをクリックして追加` : t.emptyScenario}
      <Handle type="source" position={Position.Bottom} className="!bg-slate-300" />
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
    markerEnd: { type: MarkerType.ArrowClosed },
    labelBgPadding: [4, 2],
  }));

  if (!scenario) {
    return <div className="flex h-full items-center justify-center text-slate-400">{t.noSelection}</div>;
  }

  return (
    <ReactFlow
      key={scenario.id}
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
      <Background gap={16} color="#e2e8f0" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
