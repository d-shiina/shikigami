import {
  Background,
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
import { useMemo } from "react";
import { useStudio } from "../context";
import { layoutScenario, NODE_W, type SlotNodeData, SLOT_H, type StepNodeData } from "../flow/layout";
import { t } from "../lib/i18n";
import type { HistoryEntry } from "@shikigami/schema";
import { actorLabel } from "../lib/changes";
import { sentence } from "../lib/sentence";
import { revertBlocker, type StepRunState, touchedSteps } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";
import { Sentence } from "./StoryView";
import { ActorMark, usePendingReview } from "./Timeline";

type StepNodeProps = NodeProps<
  Node<StepNodeData & { runState?: StepRunState; issueCount: number; selected: boolean; byAi: boolean; reviews: HistoryEntry[] }>
>;

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
  const blocker = revertBlocker(entry, history);
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-sheet py-1 pr-1 pl-1.5 text-[11px] shadow-md">
      <ActorMark entry={entry} size={18} />
      <span className="text-slate-600">{actorLabel(entry)}の変更</span>
      <button type="button" onClick={() => approve(entry.revision)} className="rounded-full bg-ink px-2 py-0.5 text-paper hover:bg-slate-700">
        {t.approve}
      </button>
      <button
        type="button"
        onClick={() => revert(entry)}
        disabled={blocker !== null}
        title={blocker ?? undefined}
        className="rounded-full border border-shu-500 px-2 py-0.5 text-shu-600 enabled:hover:bg-shu-50 disabled:border-slate-300 disabled:text-slate-400"
      >
        {t.revert}
      </button>
    </div>
  );
}

function StepNode({ data }: StepNodeProps) {
  const category = data.def?.category ?? data.step.type.split(".")[0] ?? "other";
  const latest = data.reviews.at(-1);
  return (
    <div
      style={{ width: NODE_W }}
      className={`relative flex overflow-hidden rounded-xl border bg-sheet shadow-[0_1px_2px_rgba(15,27,42,.06),0_4px_12px_rgba(15,27,42,.05)] ${
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
      <Handle type="target" position={Position.Top} className="!border-0 !bg-slate-300" />
      <span className="my-2 ml-2 w-[5px] shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[category] ?? CATEGORY_COLOR.other }} />
      <div className="min-w-0 flex-1 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span
            className="truncate text-[10px] font-semibold tracking-wide"
            style={{ color: CATEGORY_COLOR[category] ?? CATEGORY_COLOR.other }}
          >
            {data.step.name ? `${data.step.name} · ` : ""}
            {data.def?.label ?? data.step.type}
          </span>
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
        <div className="mt-1 line-clamp-2 text-[13px] leading-snug">
          <Sentence parts={sentence(data.step, data.def)} />
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-slate-300" />
    </div>
  );
}

function SlotNode({ data }: NodeProps<Node<SlotNodeData & { selected: boolean }>>) {
  return (
    <div
      style={{ width: NODE_W, height: SLOT_H }}
      className={`flex items-center justify-center rounded-xl border border-dashed text-xs ${
        data.selected ? "border-brand-500 bg-brand-50 text-brand-600" : "border-slate-300 text-slate-400"
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
  // Oldest first, so the toolbar offers the newest unreviewed change.
  const reviews = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>();
    for (const entry of [...pending].reverse()) {
      for (const id of new Set(touchedSteps(entry))) map.set(id, [...(map.get(id) ?? []), entry]);
    }
    return map;
  }, [pending]);

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
          byAi: reviews.has(id),
          reviews: reviews.get(id) ?? [],
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
    markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
    labelBgPadding: [4, 2],
  }));

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
      <Background gap={24} size={1.2} color="#c3cedb" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
