// The other nodes of the chart: where branches join (and a loop ends), the
// slot that adds a node, start and end, and the frame of a group.
import { READING } from "../../lib/reading";
import type { Node, NodeProps } from "@xyflow/react";
import { CornerDownLeft, Plus } from "lucide-react";
import {
  type FrameKind,
  DECIDE_H,
  DECIDE_POINT,
  FOOT_H,
  JOIN_SIZE,
  type JoinNodeData,
  NODE_W,
  type SlotNodeData,
  SLOT_H,
  START_ID,
  END_ID,
  TAIL_SIZE,
  TAIL_W,
  TERMINAL_H,
  type TerminalNodeData,
} from "../../flow/layout";
import { type LoopOutcome, loopEndLabel, loopRoundsText } from "../../lib/keywords";
import { t } from "../../lib/i18n";
import { inHandle, outHandle } from "../../lib/dataFlow";
import { useFocus, varFocus } from "../../lib/focus";
import type { LoopRun, StepRunState, VariableChange } from "../../store";
import type { LineTrail } from "../../lib/trail";
import { ADD_PILL, ADD_PILL_ON, AddLabel, TRAIL_STROKE } from "./edges";
import { Socket, FlowHandles } from "./handles";
import { VarChip } from "./values";

/** Where the columns of a frame meet again, on its bottom edge (a dot). A single column's line passes through; a loop's only lets its line out. */
export function JoinNode({ data }: NodeProps<Node<JoinData>>) {
  if (data.foot) return <LoopFoot data={data} />;
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

/** A join with what the run did there: a loop's foot shows how far the loop got. */
export type JoinData = JoinNodeData & {
  rounds?: { run: LoopRun | undefined; state: StepRunState | undefined; stopped: boolean };
  /** A loop's foot: its loop is picked (the whole frame is). */
  selected?: boolean;
  /** A loop's foot: the run's line through it. */
  trail?: LineTrail;
  /** A loop's foot: its frame is running (it is the frame's bottom edge). */
  frameRun?: FrameRun;
};

/** How a loop's rounds went: from its last round and how its step ended. */
export function loopOutcome(run: LoopRun, state: StepRunState | undefined, stopped: boolean): LoopOutcome {
  if (run.ended) return run.leftEarly ? "left" : "done";
  if (state === "failed") return "failed";
  return stopped ? "stopped" : "running";
}

export const OUTCOME_STYLE: Record<LoopOutcome, string> = {
  running: "text-accent-600",
  done: "text-moegi-600",
  left: "text-moegi-600",
  failed: "text-shu-600",
  stopped: "text-slate-500",
};

/**
 * A loop's foot (see FOOT_H): the band across the bottom of its frame that
 * says 「繰り返し終了」. Its "いいえ" comes down into it, and so does each
 * break inside the loop (pointing at one marks the foot); the line passes
 * through it on to the next step. A run leaves how far the loop got on it.
 */
export function LoopFoot({ data }: { data: JoinData }) {
  const foot = data.foot!;
  const pointed = useFocus();
  const marked = pointed !== null && foot.breaks.includes(pointed);
  const rounds = data.rounds;
  const how = rounds?.run ? loopOutcome(rounds.run, rounds.state, rounds.stopped) : null;
  return (
    <div
      style={{ width: foot.width, height: FOOT_H }}
      className={`flow-foot relative flex items-center gap-1.5 rounded-b-lg border px-3 text-[12px] transition-colors ${
        data.selected ? "flow-foot-selected" : marked ? "flow-foot-marked" : data.frameRun ? `flow-edge-running-${data.frameRun}` : ""
      }`}
    >
      <CornerDownLeft size={13} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
      <span className="font-medium whitespace-nowrap text-slate-600">{loopEndLabel()}</span>
      {/* The line runs through the band on to the next step. */}
      <span
        style={{ left: foot.lineX - 1, ...(data.trail ? { background: TRAIL_STROKE[data.trail], width: 2.5 } : {}) }}
        className="flow-foot-line absolute inset-y-0 w-[1.5px] -translate-x-1/2"
      />
      {/* While it runs over a list of known length, how far it got: the one loop whose progress is certain. */}
      {how === "running" && rounds?.run?.total ? (
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-lg bg-accent-500/15">
          <span
            style={{ width: `${Math.min(100, (rounds.run.round / rounds.run.total) * 100)}%` }}
            className="block h-full bg-accent-500 motion-safe:transition-[width] motion-safe:duration-300"
          />
        </span>
      ) : null}
      {rounds?.run && how && (
        <span className={`ml-auto font-medium whitespace-nowrap tabular-nums ${OUTCOME_STYLE[how]}`}>
          {loopRoundsText(foot.type, rounds.run.round, rounds.run.total, how)}
        </span>
      )}
      <FlowHandles x={foot.lineX} />
    </div>
  );
}

/** A tail's 「＋ ノード追加」: on the end of the flow always, at the end of a block while the pointer is in that block (see areaOf). */
export type TailData = SlotNodeData & { selected: boolean; areaOf?: (focused: string) => string | null | undefined; trail?: LineTrail };

export function SlotNode({ id, data }: NodeProps<Node<TailData>>) {
  // An empty block or an empty flow, or the 「＋ ノード追加」 under the last node of a block (or the flow): each adds a node there.
  const focused = useFocus();
  if (READING) {
    // To read: nothing is added here. The line runs through; an empty block says that it does nothing.
    const w = data.tail ? TAIL_W : NODE_W;
    const h = data.tail ? TAIL_SIZE : SLOT_H;
    return (
      <div style={{ width: w, height: h }} className="relative flex items-center justify-center">
        <FlowHandles />
        <svg aria-hidden="true" width={w} height={h} className="absolute inset-0 overflow-visible">
          <line x1={w / 2} x2={w / 2} y1={0} y2={h} stroke="var(--flow-edge)" strokeWidth={1.5} />
        </svg>
        {!data.tail && data.parentId !== null && <span className="relative rounded-md border border-slate-200 bg-sheet px-2 text-[11.5px] leading-[18px] text-slate-600">{t.flow.nothing}</span>}
      </div>
    );
  }
  if (data.tail) {
    // The end of a block with nodes: on the line, inside the frame. Hidden, the line runs on through.
    const title = data.label ? t.flow.addAtBlockEnd(data.label) : t.menu.addHere;
    const shown =
      data.selected || data.parentId === null || focused === id || (focused !== null && data.areaOf?.(focused) === data.parentId);
    return (
      <div style={{ width: TAIL_W, height: TAIL_SIZE }} title={title} className="group relative flex cursor-pointer items-center justify-center">
        <FlowHandles />
        <svg aria-hidden="true" width={TAIL_W} height={TAIL_SIZE} className="absolute inset-0 overflow-visible">
          <line
            x1={TAIL_W / 2}
            x2={TAIL_W / 2}
            y1={0}
            y2={TAIL_SIZE}
            stroke={data.trail ? TRAIL_STROKE[data.trail] : "var(--flow-edge)"}
            strokeWidth={data.trail ? 2.5 : 1.5}
          />
        </svg>
        <span
          style={{ width: TAIL_W }}
          className={`relative ${data.selected ? ADD_PILL_ON : ADD_PILL} ${shown ? "opacity-100" : "opacity-0 group-hover:opacity-100 in-focus-visible:opacity-100"}`}
        >
          <AddLabel />
        </span>
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
          : "border-slate-400 bg-sheet/60 text-slate-600 hover:border-ink hover:bg-sheet hover:text-ink"
      }`}
    >
      <FlowHandles />
      <Plus size={14} strokeWidth={2} aria-hidden="true" />
      {t.addStep}
    </div>
  );
}

/** Under a step the flow does not go on from: where it goes instead. */
export const TERMINAL_NOTE: Record<string, (() => string) | undefined> = {
  "control.break": () => t.flow.breakNote,
  "control.continue": () => t.flow.continueNote,
  "control.fail": () => t.flow.failNote,
};

/** The values a terminal shows: the flow's inputs on its start, its outputs on its end. */
export type TerminalVar = { name: string; color: string; values: VariableChange[] };

export type TerminalData = TerminalNodeData & { vars: TerminalVar[] };

/** Values shown on a terminal before the rest are counted. */
export const MAX_TERMINAL_VARS = 4;

/**
 * Where the flow starts or ends: a small rounded tag on the line, not a node
 * (nothing to select, run from or remove). The start lists the values the
 * flow takes in and the end the values it gives back, each with a socket, so
 * the lines of those values start and end there.
 */
export function TerminalNode({ data }: NodeProps<Node<TerminalData>>) {
  const shown = data.vars.slice(0, MAX_TERMINAL_VARS);
  const more = data.vars.length - shown.length;
  const focused = useFocus();
  const id = data.end ? END_ID : START_ID;
  const side = data.end ? "in" : "out";
  return (
    <div
      style={{ height: TERMINAL_H }}
      title={data.end ? t.flow.endTitle : t.flow.startTitle}
      className="flow-terminal relative flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-slate-300 bg-sheet px-3.5 text-[12.5px] text-ink shadow-sm hover:border-slate-400"
    >
      <FlowHandles />
      <span className="font-semibold tracking-wide">{data.end ? t.flow.end : t.flow.start}</span>
      {shown.length > 0 && (
        <>
          <span className="h-3.5 w-px bg-slate-200" aria-hidden="true" />
          <span className="text-[11.5px] text-slate-500">{data.end ? t.flow.gives : t.flow.takes}</span>
          {shown.map((v) => (
            <VarChip key={v.name} side={side} owner={id} name={v.name} color={v.color} values={v.values} what={data.end ? t.flow.valuesGiven : t.flow.valuesTaken} />
          ))}
          {more > 0 && <span className="text-[11.5px] text-slate-500">{t.flow.moreVars(more)}</span>}
        </>
      )}
      {data.vars.map((v) => (
        <Socket
          key={v.name}
          side={side}
          id={data.end ? inHandle(v.name) : outHandle(v.name)}
          color={v.color}
          title={data.end ? t.flow.reads(v.name) : t.flow.writes(v.name)}
          lit={focused === varFocus(v.name) || focused === id}
        />
      ))}
    </div>
  );
}

/** A running frame: the innermost one the run is in now ("here") glows; the ones around it only take its colour on their edge. */
export type FrameRun = "here" | "around";

export type FrameData = { kind: FrameKind; type: string; width: number; height: number; selected: boolean; running?: FrameRun };

/**
 * The frame of a loop (if, try, …) around everything in its blocks, so the
 * nodes that run inside it read apart from the ones after it. Its head is
 * the step's own node over its top edge. A loop's frame is tinted, and
 * frames inside it tint deeper; the others are only a hairline.
 */
export function FrameNode({ data }: NodeProps<Node<FrameData>>) {
  // Its head is its top edge: picking the step marks the whole frame, not just the head.
  return (
    <div
      style={{ width: data.width, height: data.height }}
      className={`flow-frame pointer-events-none relative rounded-lg border ${data.kind === "loop" ? "flow-frame-loop" : ""} ${
        data.selected ? "flow-frame-selected" : ""
      } ${data.running ? `flow-frame-running flow-frame-running-${data.running}` : ""}`}
    />
  );
}
