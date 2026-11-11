import { focusFirstSetting } from "../lib/focusSetting";
import { PARALLEL, SWITCH } from "../lib/stepTypes";
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import {
  frameAt,
  type JoinNodeData,
  layoutFlow,
  READ_ROOM,
  type SlotNodeData,
  START_ID,
  END_ID,
  type StepNodeData,
  WRITE_ROOM,
} from "../flow/layout";
import { isUnset, PERSON_CODES, todosByStep } from "../lib/todos";
import { useTodos } from "../lib/useTodos";
import { t } from "../lib/i18n";
import { useProjectMaybe } from "../project";
import { nodeForFile } from "../lib/fileDrop";
import { useFileDropTarget } from "./FileDrag";
import type { HistoryEntry, Flow } from "@spellsheet/schema";
import { dataLinks, INPUT_NODE, OUTPUT_NODE, outHandle } from "../lib/dataFlow";
import { focus } from "../lib/focus";
import { useTheme } from "../lib/theme";
import { CALL, innerHeight, unsetParams, knownVariables, TYPE_COLOR } from "../lib/nodeRows";
import { outline } from "../lib/outline";
import { keepSame } from "../lib/keepSame";
import {
  clockKey,
  callKey,
  diveChain,
  isActive,
  loopKey,
  selectedIds,
  type InsertAt,
  type StepRunState,
  touchedSteps,
  trailOf,
} from "../store";
import { trailLines } from "../lib/trail";
import { menuFor } from "../lib/contextMenu";
import { usePaneMenu, useSlotMenu, useStepMenu } from "./menus";
import { writesFrom } from "../lib/runValues";
import { summarize } from "../lib/review";
import { usePendingReview } from "./Timeline";
import { type CallView, MAX_INNER_LINES, MIN_READABLE_ZOOM, StepNode } from "./canvas/StepNode";
import {
  type BlockEdgeData,
  BranchLight,
  FrameLight,
  edgeTypes,
  TRAIL_STROKE,
  TRAIL_MARKER,
} from "./canvas/edges";
import {
  JoinNode,
  type JoinData,
  type TailData,
  SlotNode,
  type TerminalData,
  TerminalNode,
  type FrameRun,
  type FrameData,
  FrameNode,
} from "./canvas/otherNodes";
import { type RunValues, NO_RUN } from "./canvas/values";
import { READING } from "../lib/reading";
import { PROJECT_W, FocusOn, FollowInside, Follow, DiveBar } from "./canvas/viewport";

const nodeTypes = { step: StepNode, slot: SlotNode, frame: FrameNode, join: JoinNode, terminal: TerminalNode };

const NO_BREAKPOINTS: string[] = [];

const NO_TODOS: string[] = [];

const NO_STATES: Record<string, StepRunState> = {};

export function FlowCanvas() {
  const root = useStudio((s) => s.flow);
  const called = useStudio((s) => s.called);
  const dive = useStudio((s) => s.dive);
  const enterCall = useStudio((s) => s.enterCall);
  const projectW = useProjectMaybe((s) => (s.panelOpen ? PROJECT_W : 0), 0);
  // Entered calls show their flow here, read-only; edits stay with the open one.
  const chain = useMemo(() => diveChain(root, called, dive), [root, called, dive]);
  const path = useMemo(() => chain.map((level) => level.stepId), [chain]);
  const inside = chain.length > 0;
  const flow = inside ? chain.at(-1)!.flow : root;
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const range = useStudio((s) => s.range);
  const selectTo = useStudio((s) => s.selectTo);
  const selectBox = useStudio((s) => s.selectBox);
  // Where a Shift+drag box started, on the chart.
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  const picked = useMemo(() => new Set(selectedIds({ selection, range })), [selection, range]);
  const validation = useStudio((s) => s.validation);
  // The open flow's last run, until it is edited or run again.
  const run = useStudio(trailOf);
  const breakpoints = useStudio((s) => (flow ? s.breakpoints[flow.id] : undefined)) ?? NO_BREAKPOINTS;
  const select = useStudio((s) => s.select);
  const showFlowProps = useStudio((s) => s.showFlowProps);
  const addStep = useStudio((s) => s.addStep);
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  const stepMenu = useStepMenu();
  const slotMenu = useSlotMenu();
  const paneMenu = usePaneMenu();
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const setFollowRun = useStudio((s) => s.setFollowRun);
  const theme = useTheme().mode;
  const pending = usePendingReview();
  const reviewing = useStudio((s) => s.reviewing);
  const feedback = useStudio((s) => (s.flow ? s.timelines[s.flow.id]?.openFeedback : undefined));
  // What the person last asked the AI to fix, pinned to the steps it names.
  const notes = useMemo(
    () => new Map(feedback?.kind === "review" ? (feedback.steps ?? []).map((n) => [n.stepId, n.note] as const) : []),
    [feedback],
  );
  // On the review desk every unreviewed step is marked by what happened to it.
  const diffs = useMemo(() => summarize([...pending].reverse(), flow?.steps).steps, [pending, flow]);
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
    const walk = (list: NonNullable<Flow["steps"]>) => {
      for (const step of list) {
        if (step.type === CALL && step.id) {
          const target = typeof step.params?.flow === "string" ? step.params.flow : "";
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
    walk(flow?.steps ?? []);
    return map;
  }, [flow, called, unfolded, defs, path]);
  const extra = useMemo(
    () =>
      new Map(
        [...calls]
          .filter(([, c]) => c.unfolded)
          .map(([id, c]) => [id, innerHeight(c.lines.length + (c.hidden > 0 ? 1 : 0))] as const),
      ),
    [calls],
  );
  const foldedIds = useStudio((s) => (flow ? s.folded[flow.id] : undefined));
  const folded = useMemo(() => new Set(foldedIds ?? []), [foldedIds]);
  const layout = useMemo(() => layoutFlow(flow?.steps ?? [], defs, extra, folded), [flow, defs, extra, folded]);
  // A file dropped on the chart becomes the node that reads it: after the
  // node it is dropped on, into the empty block it is dropped on, or at the end.
  const fileDrop = useFileDropTarget("canvas", async (paths, el) => {
    if (inside) return;
    const id = el.closest(".react-flow__node")?.getAttribute("data-id");
    const hit = id ? layout.nodes.find((n) => n.id === id) : undefined;
    const specs = paths.flatMap((p) => nodeForFile(p, stepTypes) ?? []);
    if (specs.length === 0) return;
    if (hit?.data.kind === "step") select({ kind: "step", stepId: hit.data.step.id ?? hit.id });
    else if (hit?.data.kind === "slot") select({ kind: "slot", parentId: hit.data.parentId, block: hit.data.block });
    else select(null);
    // Each one goes after the one before it (the new node is selected).
    for (const spec of specs) await addStep(spec.type, spec.params);
  });
  // Points a run only passes through: the "+" at the end of a block, where a frame's columns meet.
  const tails = useMemo(
    // A wait's decision comes after its check: it is passed once the check is, not as soon as the wait starts.
    () =>
      new Set(
        layout.nodes
          .filter((n) => (n.data.kind === "slot" && n.data.tail) || (n.data.kind === "join" && !n.data.met && (!n.data.question || n.data.after)))
          .map((n) => n.id)
          .concat(END_ID),
      ),
    [layout],
  );
  // Steps whose failure the run goes on past (onError: continue, their own or the flow's).
  const continues = useMemo(() => {
    const flowDefault = flow?.settings?.onError;
    return new Set(
      layout.nodes.flatMap((n) => (n.data.kind === "step" && (n.data.step.onError ?? flowDefault) === "continue" ? [n.id] : [])),
    );
  }, [layout, flow]);
  // The block the pointer is in, from what it is on (see focus): a frame's own
  // head or a step inside it. A block's 「＋ ノード追加」 at its end shows then.
  const areaOf = useMemo(() => {
    const area = new Map<string, string | null>();
    for (const n of layout.nodes) {
      if (n.data.kind === "step") area.set(n.id, n.data.head ? n.id : n.data.parentId);
      else if (n.data.kind === "slot") area.set(n.id, n.data.parentId);
      else if (n.data.kind === "terminal") area.set(n.id, null);
    }
    return (focused: string) => area.get(focused);
  }, [layout]);
  // A node added on a line goes just before the step the line leads to. Not
  // where that would start another branch running at the same time.
  const insertBefore = useMemo(() => {
    const map = new Map<string, InsertAt>();
    const types = new Map(layout.nodes.flatMap((n) => (n.data.kind === "step" ? [[n.id, n.data.step.type] as const] : [])));
    for (const n of layout.nodes) {
      if (n.data.kind !== "step") continue;
      // Nor among a switch's cases: what goes there is a case (see the "+" beside them).
      const parentType = n.data.parentId ? types.get(n.data.parentId) : undefined;
      if (parentType === PARALLEL || (parentType === SWITCH && n.data.block === "cases")) continue;
      map.set(n.id, { parentId: n.data.parentId, block: n.data.block, index: n.data.index });
    }
    return map;
  }, [layout]);
  const [hoveredEdge, setHoveredEdgeNow] = useState<string | null>(null);
  // Leaving the line lets the pointer reach its "+" before it hides.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setHoveredEdge = useCallback((id: string | null) => {
    clearTimeout(hideTimer.current);
    if (id) setHoveredEdgeNow(id);
    else hideTimer.current = setTimeout(() => setHoveredEdgeNow(null), 250);
  }, []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const vars = useMemo(() => knownVariables(flow?.variables, flow?.steps ?? []), [flow]);

  // Errors only: a required setting still empty shows as "未設定" on its row instead.
  const issueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of inside ? [] : (validation?.issues ?? [])) {
      if (!issue.stepId || issue.severity !== "error" || PERSON_CODES.has(issue.code) || isUnset(issue)) continue;
      counts.set(issue.stepId, (counts.get(issue.stepId) ?? 0) + 1);
    }
    return counts;
  }, [validation, inside]);
  const todoList = useTodos();
  const todos = useMemo(() => (inside ? new Map<string, string[]>() : todosByStep(todoList)), [todoList, inside]);
  const states = inside ? (run?.inner[callKey(path)] ?? NO_STATES) : (run?.steps ?? NO_STATES);
  const isActiveRun = isActive(run);
  // What the flow takes in (shown on its start) and gives back (on its end).
  const terminalVars = useMemo(() => {
    const changes = run && !inside ? run.changes : [];
    const color = (v: { type?: string }) => TYPE_COLOR[v.type ?? "any"] ?? "var(--cat-other)";
    const all = flow?.variables ?? [];
    const takes = (d: string | undefined) => d === "input" || d === "inOut";
    const gives = (d: string | undefined) => d === "output" || d === "inOut";
    return {
      inputs: all.filter((v) => takes(v.direction)).map((v) => ({ name: v.name, color: color(v), values: writesFrom(changes, v.name, INPUT_NODE) })),
      // What it held at the end of the run.
      outputs: all
        .filter((v) => gives(v.direction))
        .map((v) => ({ name: v.name, color: color(v), values: run?.status === "running" ? [] : changes.filter((c) => c.variable === v.name).slice(-1) })),
    };
  }, [flow, run, inside]);

  // What a step shows of the run changes only when it starts again or sets a value: before
  // the values it read are all in (events come in order). The same object till then, so the
  // other steps are not redrawn for each event of the run.
  const runKept = useRef(new Map<string, { key: string; values: RunValues }>());
  const runCounts = useMemo(() => {
    const starts = new Map<string, number>();
    const own = new Map<string, number>();
    for (const start of run?.starts ?? []) starts.set(start.stepId, (starts.get(start.stepId) ?? 0) + 1);
    for (const change of run?.changes ?? []) if (change.stepId) own.set(change.stepId, (own.get(change.stepId) ?? 0) + 1);
    return { starts, own };
  }, [run?.starts, run?.changes]);
  const runValuesOf = (id: string): RunValues => {
    if (!run) return NO_RUN;
    const key = `${run.runId}:${runCounts.starts.get(id) ?? 0}:${runCounts.own.get(id) ?? 0}`;
    const kept = runKept.current.get(id);
    if (kept?.key === key) return kept.values;
    const values = { changes: run.changes, starts: run.starts };
    runKept.current.set(id, { key, values });
    return values;
  };

  // Frames first and beneath the lines, outer ones before the ones inside them.
  // The run is in the innermost running frames; those around them are only on its way.
  const runningFrames = layout.frames.filter((f) => states[f.id] === "running");
  const around = (f: (typeof runningFrames)[number]) =>
    runningFrames.some((g) => g !== f && g.x >= f.x && g.y >= f.y && g.x + g.width <= f.x + f.width && g.y + g.height <= f.y + f.height);
  const frameRun = new Map<string, FrameRun>(runningFrames.map((f) => [f.id, around(f) ? "around" : "here"]));
  const frames: Node[] = layout.frames.map((f) => ({
    id: `frame:${f.id}`,
    type: "frame",
    position: { x: f.x, y: f.y },
    data: { kind: f.kind, type: f.type, width: f.width, height: f.height, selected: !inside && picked.has(f.id), running: frameRun.get(f.id) } satisfies FrameData,
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -1,
  }));
  const nodes: Node[] = layout.nodes.map((n) => {
    if (n.data.kind === "join") {
      // A loop's foot shows how far the loop got in the run.
      const foot = !n.data.foot
        ? {}
        : {
            selected: !inside && picked.has(n.data.parentId),
            frameRun: frameRun.get(n.data.parentId),
            ...(run ? { rounds: { run: run.loops?.[loopKey(path, n.data.parentId)], state: states[n.data.parentId], stopped: !isActiveRun } } : {}),
          };
      return { ...n, data: { ...n.data, ...foot } satisfies JoinData, draggable: false, selectable: false, focusable: false };
    }
    if (n.data.kind === "terminal") {
      const data: TerminalData = { ...n.data, vars: n.data.end ? terminalVars.outputs : terminalVars.inputs };
      // Placed by its top centre: it is as wide as what it says.
      return { ...n, data, origin: [0.5, 0] as [number, number], draggable: false, selectable: false, focusable: false };
    }
    if (n.data.kind === "step") {
      const id = n.data.step.id ?? n.id;
      return {
        ...n,
        draggable: false,
        data: {
          ...n.data,
          runState: states[id],
          // Only a running node keeps time: the others stay as they were.
          clock: states[id] === "running" ? clockKey(path, id) : undefined,
          frameRun: frameRun.get(id),
          readOnly: inside || READING,
          breakpoint: breakpoints.includes(id),
          owner: flow?.id ?? "",
          pausedHere: run?.pause?.stepId === id && callKey(run.pause.callPath) === callKey(path),
          issueCount: issueCounts.get(id) ?? 0,
          unsetCount: inside ? 0 : unsetParams(n.data.step, n.data.def).length,
          todos: todos.get(id) ?? NO_TODOS,
          selected: !inside && picked.has(id),
          // The toolbar beside a node acts on the selected one only.
          primary: !inside && selection?.kind === "step" && selection.stepId === id,
          byAi: !inside && !reviewing && reviews.has(id),
          reviews: inside || reviewing ? [] : (reviews.get(id) ?? []),
          diff: !inside && reviewing ? diffs.get(id) : undefined,
          note: !inside && reviewing ? notes.get(id) : undefined,
          vars,
          // Values are recorded for the open flow's variables only.
          run: inside ? NO_RUN : runValuesOf(id),
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
        areaOf,
      } satisfies TailData,
    };
  });

  // Read chips stick out left of a step, write chips right of it.
  const bounds = { x: -READ_ROOM, y: 0, width: layout.width + READ_ROOM + WRITE_ROOM, height: layout.height };

  const selectedId = selection?.kind === "step" ? selection.stepId : null;
  const links = useMemo(
    () => dataLinks(flow?.steps ?? [], flow?.variables, defs, new Set(vars.keys())),
    [flow, defs, vars],
  );
  // The head of a frame and a case's tab show no setting rows, so no sockets to link to.
  const bare = new Set(layout.nodes.flatMap((n) => (n.data.kind === "step" && (n.data.head || n.data.tab) ? [n.id] : [])));
  // A value the flow takes in comes from its start, one it gives back goes to its end; a starting value of its own has no line.
  const inputNames = new Set(terminalVars.inputs.map((v) => v.name));
  const linkEdges: Edge[] = links
    .flatMap((l) => {
      if (l.from === INPUT_NODE && !inputNames.has(l.variable)) return [];
      return [{ ...l, from: l.from === INPUT_NODE ? START_ID : l.from, to: l.to === OUTPUT_NODE ? END_ID : l.to }];
    })
    .filter((l) => !bare.has(l.from) && !bare.has(l.to))
    .map((l) => ({
      id: `link:${l.from}:${l.variable}->${l.to}:${l.toHandle}`,
      source: l.from,
      sourceHandle: outHandle(l.variable),
      target: l.to,
      targetHandle: l.toHandle,
      type: "link",
      selectable: false,
      focusable: false,
      data: { variable: l.variable, color: TYPE_COLOR[vars.get(l.variable) ?? "any"] ?? "var(--cat-other)", from: l.from, to: l.to, selectedId },
      // Beneath the steps, so a lit link never takes a click meant for a step.
      zIndex: 0,
    }));

  // The lines the run took stay coloured after it ends, as the way it went.
  // A loop's decision runs as long as its loop does (a wait's only once its check is through, see `tails`).
  const trailStates = useMemo(() => {
    const out: Record<string, StepRunState> = { ...states };
    // The run started from the start; it reached the end when a line into it was passed (see `tails`).
    if (Object.keys(states).length > 0) out[START_ID] = "succeeded";
    for (const n of layout.nodes) {
      if (n.data.kind !== "join") continue;
      // A try's way into "失敗したとき" was taken when that block ran.
      const state = n.data.question && !n.data.after ? states[n.data.parentId] : n.data.failTo ? states[n.data.failTo] : undefined;
      if (state) out[n.id] = state;
      // A wait goes out only when its condition was met: when the wait succeeded, not each time its check ran.
      // Its decision was reached then too, even with nothing in its check to say so.
      if (n.data.met && states[n.data.parentId] === "succeeded") out[n.id] = out[`${n.id}:decide`] = "succeeded";
    }
    return out;
  }, [states, layout.nodes]);
  const taken = trailLines(layout.edges, trailStates, tails, continues);
  // A loop a break ended never answered "いいえ": it came out through the break.
  if (run) {
    for (const e of layout.edges) {
      if (e.railX === undefined || !e.owner) continue;
      const loop = run.loops?.[loopKey(path, e.owner)];
      if (loop?.ended && loop.leftEarly) taken.delete(e.id);
    }
  }
  // The line runs on through a hidden 「＋ ノード追加」 at a block's end, in the colour of the way out of it.
  for (const node of nodes) {
    const data = node.data as TailData;
    if (data.kind !== "slot" || !data.tail) continue;
    const out = layout.edges.find((e) => e.source === node.id);
    const trail = out && taken.get(out.id);
    if (trail) node.data = { ...data, trail };
  }
  // A loop's foot: the line through it in the colour of the way on from it.
  for (const node of nodes) {
    const data = node.data as JoinData;
    if (data.kind !== "join" || !data.foot) continue;
    const out = layout.edges.find((e) => e.source === node.id);
    const trail = out && taken.get(out.id);
    if (trail) node.data = { ...data, trail };
  }
  // Lines into a join end in it (or pass through); a loop's decision takes an arrow like a node.
  const plainJoins = new Set(layout.nodes.filter((n) => n.data.kind === "join" && !n.data.question).map((n) => n.id));
  const edges: Edge[] = layout.edges.map((e) => {
    const trail = taken.get(e.id);
    return {
      ...e,
      sourceHandle: "flow",
      targetHandle: "flow",
      type: "block",
      data: {
        detourX: e.detourX,
        fromDecide: e.fromDecide,
        intoDecide: e.intoDecide,
        railX: e.railX,
        exit: e.exit,
        answer: e.answer,
        half: e.half,
        failure: e.failure,
        bracket: e.bracket,
        owner: e.owner,
        selectedId,
        split: e.split,
        insert: READING || inside || reviewing || e.loop ? undefined : insertBefore.get(e.target),
        hovered: hoveredEdge === e.id,
        hover: setHoveredEdge,
      } satisfies BlockEdgeData,
      // A loop's line back runs only while its loop is pointed at (see BlockEdge), never on its own.
      animated: trail === "now",
      style: {
        stroke: trail ? TRAIL_STROKE[trail] : "var(--flow-edge)",
        strokeWidth: trail ? 2.5 : 1.5,
        ...(e.loop || e.thenFinally || trail === "now" ? { strokeDasharray: "5 4" } : {}),
      },
      // A plain colour: the marker id is built from it, so no var(). Lines meeting at a join end in its dot.
      markerEnd: (READING && !e.loop) || plainJoins.has(e.target) || e.target.startsWith("end:") ? undefined : { type: MarkerType.ArrowClosed, color: (trail ? TRAIL_MARKER[theme][trail] : undefined) ?? (theme === "dark" ? "#5a5e66" : "#a3a8b0") },
      // A taken line over the others where they share a stretch (a join, the way into a loop's body).
      zIndex: trail ? 1 : 0,
    };
  });
  if (!READING) edges.push(...linkEdges);
  // Only what changed is redrawn (see keepSame).
  const keptNodes = useRef(new Map<string, Node>());
  const keptEdges = useRef(new Map<string, Edge>());
  const chartNodes = keepSame(keptNodes.current, [...frames, ...nodes]);
  const chartEdges = keepSame(keptEdges.current, edges);

  if (!flow || !root) {
    return <div className="canvas-bg flex h-full flex-col items-center justify-center gap-3 text-slate-400">
        <img src="/mark.png" alt="" className="h-16 w-16 opacity-30 grayscale" />
        {t.noSelection}
      </div>;
  }

  return (
    <ReactFlow
      key={`${root.id}/${callKey(path)}`}
      className={`canvas-bg ${READING ? "flow-reading" : ""} ${fileDrop.over ? "outline-2 -outline-offset-8 outline-dashed outline-brand-500" : ""}`}
      colorMode={theme}
      nodes={chartNodes}
      edges={chartEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesConnectable={false}
      ref={wrapper}
      {...(inside || READING ? {} : fileDrop.attrs)}
      onInit={(flow) => {
        flowRef.current = flow;
        // Fit the chart, but never shrink it below reading size: a long
        // flow starts at its top and scrolls instead.
        const box = wrapper.current;
        if (!box) return;
        const pad = 64;
        const boxW = box.clientWidth - projectW;
        const fitW = (boxW - pad) / bounds.width;
        const fitH = (box.clientHeight - pad) / bounds.height;
        const zoom = Math.max(Math.min(fitW, fitH, 1), MIN_READABLE_ZOOM);
        const x = projectW + (zoom > fitW ? pad / 2 : (boxW - bounds.width * zoom) / 2);
        // Inside a call, clear of the bar that says where the chart is.
        const y = inside ? 104 : pad / 2;
        void flow.setViewport({ x: x - bounds.x * zoom, y: y - bounds.y * zoom, zoom });

      }}
      minZoom={0.2}
      // React Flow is MIT licensed; its corner credit is optional and sat over the work.
      proOptions={{ hideAttribution: true }}
      onNodeClick={(event, node) => {
        if (inside || node.type === "frame" || node.type === "join") return;
        // The start or end: the flow's own settings (its variables, what it takes and returns).
        if (node.type === "terminal") return showFlowProps();
        const data = node.data as StepNodeData | SlotNodeData;
        if (data.kind === "step") {
          const id = data.step.id ?? node.id;
          // Shift+click picks the nodes from the selected one to this one, to copy or remove them together.
          if (event.shiftKey) selectTo(id);
          else select({ kind: "step", stepId: id });
        } else {
          // An empty block is there to be filled: clicking it opens the palette for it.
          select({ kind: "slot", parentId: data.parentId, block: data.block });
          const box = (event.target as Element).closest(".react-flow__node")?.getBoundingClientRect();
          setPaletteOpen(true, null, box);
        }
      }}
      onPaneClick={() => select(null)}
      // Pointing anywhere inside a frame points at its step, as its head does: a branch
      // lights its ways out and a loop sends its line round wherever in it the pointer is.
      onPaneMouseMove={(event) => {
        // The pane hears moves over the nodes and lines on it too: those keep their own focus.
        if ((event.target as Element).closest(".react-flow__node, .react-flow__edge, .react-flow__edgelabel-renderer")) return;
        const at = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const frame = at ? frameAt(layout.frames, at.x, at.y) : null;
        if (frame) focus.set(frame.id);
        else if (layout.frames.some((f) => f.id === focus.get())) focus.set(null);
      }}
      onPaneMouseLeave={() => layout.frames.some((f) => f.id === focus.get()) && focus.set(null)}
      // Shift+drag draws a box (plain drag still moves the view): the nodes in it become the selection.
      selectionKeyCode="Shift"
      onSelectionStart={(event) => {
        // In chart coordinates: the view may scroll while the box is drawn.
        boxStart.current = inside || !flowRef.current ? null : flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      }}
      onSelectionEnd={(event) => {
        const start = boxStart.current;
        const rf = flowRef.current;
        boxStart.current = null;
        if (!start || !rf) return;
        const a = start;
        const b = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
        if (rect.width < 4 && rect.height < 4) return;
        const ids = rf
          .getIntersectingNodes(rect, true)
          .filter((n) => n.type === "step")
          .map((n) => (n.data as StepNodeData).step.id ?? n.id);
        if (ids.length > 0) selectBox(ids);
      }}
      onEdgeMouseEnter={(_, edge) => edge.type === "block" && setHoveredEdge(edge.id)}
      onEdgeMouseLeave={() => setHoveredEdge(null)}
      onNodeContextMenu={(event, node) =>
        menuFor(() => {
          const data = node.data as StepNodeData | SlotNodeData;
          if (node.type === "frame" || node.type === "join") return [];
          if (node.type === "terminal") return paneMenu({ inside, fit: () => void flowRef.current?.fitView({ padding: 0.1, maxZoom: 1, duration: 200 }) });
          if (data.kind === "slot") return inside ? [] : slotMenu(data.parentId, data.block);
          const id = data.step.id ?? node.id;
          const call = calls.get(id);
          return stepMenu(data.step, {
            owner: flow.id,
            readOnly: inside || READING,
            call: call && { key: call.key, canEnter: Boolean(call.callee), unfolded: call.unfolded },
          });
        })(event)
      }
      onPaneContextMenu={(event) =>
        menuFor(() =>
          paneMenu({
            inside,
            fit: () => void flowRef.current?.fitView({ padding: 0.1, maxZoom: 1, duration: 200 }),
          }),
        )(event as React.MouseEvent)
      }
      onNodeDoubleClick={(_, node) => {
        const data = node.data as StepNodeData | SlotNodeData;
        if (data.kind !== "step" || !data.step.id) return;
        if (calls.get(data.step.id)?.callee) enterCall(data.step.id);
        // The right pane already edits the selected node: a double-click puts the cursor in its first setting.
        else focusFirstSetting();
      }}
      // Double-clicking a call enters it; zooming there would only get in the way.
      zoomOnDoubleClick={false}
      // Dragging the view during a run means the person wants to look elsewhere.
      onMoveStart={(event) => event && run?.status === "running" && setFollowRun(false)}
      onNodeMouseEnter={(_, node) =>
        node.type === "step" || node.type === "terminal"
          ? focus.set(node.id)
          : (node.data as JoinNodeData).question
            ? focus.set((node.data as JoinNodeData).parentId)
            : undefined
      }
      // Off a node, the pointer is still in the frame around it (see onPaneMouseMove).
      onNodeMouseLeave={(event) => {
        const at = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        focus.set((at && frameAt(layout.frames, at.x, at.y)?.id) ?? null);
      }}
    >
      <Background gap={24} size={1.2} color={READING ? "var(--flow-read-dot)" : "var(--color-slate-200)"} />
      <BranchLight layout={layout} />
      <FrameLight layout={layout} />
      {inside ? <FollowInside path={callKey(path)} /> : <Follow />}
      {inside && (
        <Panel position="top-center">
          <DiveBar root={root} chain={chain} />
        </Panel>
      )}
      {!inside && reviewing && <FocusOn id={layout.nodes.find((n) => diffs.has(n.id))?.id} />}
      {/* The left of the chart holds the project and outline column, so the zoom sits in the free corner. */}
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}
