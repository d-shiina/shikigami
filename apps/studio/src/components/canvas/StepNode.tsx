// The node of one step, and the head of a group (繰り返し・分岐) drawn as a
// frame around its steps.
import { CASE, IF, SWITCH } from "../../lib/stepTypes";
import { type Node, type NodeProps, NodeToolbar, Position } from "@xyflow/react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Minus,
  Pause,
  Plus,
  StickyNote,
  X,
} from "lucide-react";
import { useMemo } from "react";
import { useStudio } from "../../context";
import { CASE_H, HEAD_H, NODE_W, type StepNodeData } from "../../flow/layout";
import { headSummary } from "../../lib/keywords";
import { listToText } from "../../lib/listText";
import { nodeIcon } from "../../lib/nodeIcons";
import { t } from "../../lib/i18n";
import type { HistoryEntry, Flow, StepTypeDef } from "@spellsheet/schema";
import { actorLabel, describe } from "../../lib/changes";
import {
  CALL,
  CALL_BAR_H,
  INNER_LINE_H,
  INNER_PAD,
  innerHeight,
  NODE_HEAD_H,
  NODE_PAD_B,
  nodeRows,
} from "../../lib/nodeRows";
import { type OutlineItem, outline } from "../../lib/outline";
import { plain, sentence, typeTitle } from "../../lib/sentence";
import { AppTag } from "../AppTag";
import { revertBlocker, type StepRunState } from "../../store";
import { CATEGORY_COLOR } from "../CommandPalette";
import { StepTools } from "../StepTools";
import type { StepDiff } from "../../lib/review";
import { ActorMark, entryScope } from "../Timeline";
import { FlowHandles } from "./handles";
import { TERMINAL_NOTE, type FrameRun } from "./otherNodes";
import { RunBar, NodeStatus } from "./runStatus";
import { type RunValues, NodeRow } from "./values";

/** What a `flow.call` node shows about the flow it runs. */
export type CallView = {
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

export type StepNodeProps = NodeProps<
  Node<StepNodeData & { runState?: StepRunState; clock?: string; frameRun?: FrameRun; readOnly: boolean; breakpoint: boolean; owner: string; pausedHere: boolean; issueCount: number; unsetCount: number; todos: string[]; selected: boolean; primary: boolean; byAi: boolean; reviews: HistoryEntry[]; vars: Map<string, string | undefined>; run: RunValues; diff?: StepDiff; note?: string; call?: CallView; defs: Map<string, StepTypeDef> }>
>;

/** Lines an unfolded call lists before the rest fold into "…ほか n". */
export const MAX_INNER_LINES = 24;

export const MIN_READABLE_ZOOM = 0.85;

export const DIFF_STYLE: Record<StepDiff, { border: string; tag: string; label: () => string }> = {
  added: { border: "border-moegi-500", tag: "border-moegi-500 text-moegi-500", label: () => t.flow.aiAdded },
  changed: { border: "border-accent-500", tag: "border-accent-500 text-amber-700", label: () => t.flow.aiChanged },
};

/** Which way the chart runs, for rows deciding whether to show chips. */

export const RUN_STYLE: Record<StepRunState, string> = {
  // The step at work glows: the written formula doing its work, in the running orange.
  running:
    "!border-accent-500 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent-500)_16%,transparent),0_0_22px_4px_color-mix(in_srgb,var(--color-accent-500)_24%,transparent)]",
  succeeded: "",
  failed: "!border-shu-500 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-shu-500)_16%,transparent)]",
  skipped: "opacity-60",
  paused: "!border-mizu-500 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-mizu-500)_18%,transparent)]",
};

/** Click target left of a step's header: a red dot when the run pauses before it. */
export function BreakpointDot({ stepId, on, owner }: { stepId: string; on: boolean; owner: string }) {
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
export function ReviewToolbar({ entry }: { entry: HistoryEntry }) {
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

export const INNER_MARK: Record<StepRunState, React.ReactNode> = {
  running: <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-500" />,
  succeeded: <Check size={12} strokeWidth={2.25} className="text-moegi-600" />,
  paused: <Pause size={12} strokeWidth={2.25} className="text-mizu-500" />,
  failed: <X size={12} strokeWidth={2.25} className="text-shu-600" />,
  skipped: <Minus size={12} className="text-slate-400" />,
};

/**
 * Under a call's head: which flow it runs, and the buttons to unfold its
 * steps here or open it.
 */
export function CallBar({ call }: { call: CallView }) {
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
            <span className="flex items-center gap-0.5">
              {call.unfolded ? t.flow.fold : t.flow.unfold}
              {call.unfolded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </span>
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
            <span className="flex items-center gap-0.5">
              {t.flow.open}
              <ArrowUpRight size={12} />
            </span>
          </button>
        </span>
      )}
    </div>
  );
}

/** A call's steps, read-only, unfolded inside its node. */
export function InnerSteps({ call, defs }: { call: CallView; defs: Map<string, StepTypeDef> }) {
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
            {state && <span className="ml-auto flex shrink-0 items-center">{INNER_MARK[state]}</span>}
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

export function StepNode({ data }: StepNodeProps) {
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
        head ? (head.collapsed ? "rounded-lg" : "rounded-t-lg") : stack ? "flow-call-stack rounded-lg" : "rounded-lg"
      } ${
        data.diff
          ? DIFF_STYLE[data.diff].border
          : data.selected
            ? head && !head.collapsed
              ? "border-primary"
              : "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_16%,transparent)]"
            : data.byAi
              ? "border-brand-500"
              : head
                ? "flow-head-plain border-slate-300 hover:border-slate-400"
                : "border-slate-200 hover:border-slate-300"
      } ${data.step.disabled ? "border-dashed opacity-60" : ""} ${
        // An open frame glows as a whole (flow-frame-running): its head is only its top edge.
        data.runState === "running" && head && !head.collapsed ? `flow-edge-running-${data.frameRun ?? "here"}` : data.runState ? RUN_STYLE[data.runState] : ""
      }`}
      data-run={data.runState}
    >
      {!head && data.clock && <RunBar clock={data.clock} stepId={data.step.id ?? ""} />}
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
      {/* Still there once a run went through it, in the colour of the way it took. */}
      {!head && TERMINAL_NOTE[data.step.type] && !data.step.disabled && (!data.runState || data.runState === "succeeded") && (
        <span
          className={`pointer-events-none absolute top-full left-1/2 mt-1.5 -translate-x-1/2 text-[11px] whitespace-nowrap ${
            data.runState ? "font-medium text-moegi-600" : "text-slate-500"
          }`}
        >
          {TERMINAL_NOTE[data.step.type]!()}
        </span>
      )}
      {/* Read-only inside a call, but a run still stops there. */}
      <BreakpointDot stepId={data.step.id ?? ""} on={data.breakpoint} owner={data.owner} />
      {(data.runState === "paused" || (data.runState === "failed" && data.pausedHere)) && (
        <span
          className={`absolute top-full left-1 z-10 mt-1.5 flex items-center gap-1 rounded-lg px-2 text-[11px] leading-[20px] font-bold text-white shadow ${
            data.runState === "failed" ? "bg-shu-500" : "bg-mizu-500"
          }`}
        >
          {data.runState === "failed" ? <X size={12} strokeWidth={2.5} /> : <Pause size={12} strokeWidth={2.5} />}
          {data.runState === "failed" ? t.flow.stoppedHere : t.flow.pausedHere}
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
export function FrameHead({ data, Icon, title }: { data: StepNodeProps["data"]; Icon: ReturnType<typeof nodeIcon>; title: string }) {
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
export function CaseTab({ data }: { data: StepNodeProps["data"] }) {
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
