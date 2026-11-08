// The run log (docs/design/run-log.md): the nodes the run went through, one
// row each, in the order they started, with how they ended and how long they
// took. Loops, branches, frames and sub-flow calls hold the rows run inside
// them; a loop splits them into its rounds. Lines a 「ログ出力」 node wrote
// are the flow's own words and read as such; lines SpellSheet wrote are
// quieter. Colour says only the state (ui-principles.md): green done, 朱
// failed, orange running, and the selection's blue.
import type { StepTypeDef } from "@shikigami/schema";
import {
  Check,
  ChevronRight,
  Copy,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CirclePause,
  CircleX,
  LoaderCircle,
  MessageSquareText,
  Play,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { nodeIcon } from "../lib/nodeIcons";
import {
  FLOW_LOG,
  holdsNodes,
  sinceText,
  spanText,
  type TraceFilter,
  type TraceLine,
  type TraceNode,
  type TraceRow,
  traceRows,
} from "../lib/runTrace";
import { plain, sentence, typeTitle } from "../lib/sentence";
import { callKey, diveChain, findStep, isActive, type RunState } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";

/** The time now, ticking while `live`, for the rows still running. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [live]);
  return live ? now : 0;
}

/** Where the run began and ended (or `now` while it runs), in ms since the epoch. */
export function runSpan(run: RunState, now: number): { start: number; end: number } {
  const first = run.logs.find((l) => l.mark === "start")?.at ?? run.trace.nodes[0]?.startedAt;
  const last = [...run.logs].reverse().find((l) => l.mark === "end")?.at;
  const start = first ? Date.parse(first) : now;
  const end = last ? Date.parse(last) : isActive(run) && now ? now : Math.max(start, ...run.trace.nodes.map((n) => Date.parse(n.endedAt ?? n.startedAt)));
  return { start, end: Math.max(end, start + 1) };
}

/** The log lines the tree shows: a node's failure is on the node itself. */
export function treeLines(run: RunState): TraceLine[] {
  return run.logs
    .filter((l) => !l.fromStep)
    .map((l) => ({ seq: l.seq, at: l.at, level: l.level, message: l.message, node: l.node ?? null, mark: l.mark }) as TraceLine & { mark?: string });
}

type Names = (node: { stepId: string; callPath: string[] }) => { title: string; name: string; def?: StepTypeDef; known: boolean; calls?: string };

/** How a node of the run is called on the chart (never its ID). */
function useNames(): Names {
  const flow = useStudio((s) => s.flow);
  const called = useStudio((s) => s.called);
  const stepTypes = useStudio((s) => s.stepTypes);
  // The run of another flow than the one open: its nodes are not on the chart.
  const here = useStudio((s) => !s.run?.flowId || s.run.flowId === s.flow?.id);
  return useMemo(() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
    return ({ stepId, callPath }) => {
      const chain = diveChain(flow, called, callPath);
      const owner = !here ? null : callPath.length === 0 ? flow : chain.length === callPath.length ? chain.at(-1)!.flow : null;
      const step = owner ? findStep(owner.steps ?? [], stepId) : null;
      if (!step) return { title: t.evidence.goneStep, name: "", known: false };
      const def = defs.get(step.type);
      const title = typeTitle(step, def);
      const name = step.name?.trim() || (title ? "" : plain(sentence(step, def)));
      // A call says which flow it runs.
      const target = step.type === "flow.call" ? (step.params as { flow?: unknown } | undefined)?.flow : undefined;
      const calls = typeof target === "string" ? called[target]?.name : undefined;
      return { title, name, def, known: true, calls };
    };
  }, [flow, called, stepTypes, here]);
}

function StateIcon({ node }: { node: Pick<TraceNode, "outcome" | "retrying" | "stopped"> & { paused?: boolean } }) {
  const cls = "shrink-0";
  if (node.stopped) return <CircleMinus size={14} className={`${cls} text-slate-400`} aria-label={t.runLog.stopped} />;
  if (node.paused) return <CirclePause size={14} className={`${cls} text-mizu-500`} aria-label={t.runLog.status.paused} />;
  if (node.retrying) return <RotateCw size={13} className={`${cls} text-accent-500`} aria-hidden="true" />;
  switch (node.outcome) {
    case undefined:
      return <LoaderCircle size={14} className={`${cls} text-accent-500 motion-safe:animate-spin`} aria-label={t.runLog.status.running} />;
    case "succeeded":
      return <CircleCheck size={14} className={`${cls} text-moegi-500`} aria-label={t.runLog.status.succeeded} />;
    case "failed":
      return <CircleX size={14} className={`${cls} text-shu-500`} aria-label={t.runLog.status.failed} />;
    case "skipped":
      return <CircleMinus size={14} className={`${cls} text-slate-400`} aria-label={t.runLog.skipped} />;
  }
}

/** When it ran within the whole run: a bar on a shared time axis. */
function Bar({ from, to, start, end, state }: { from: number; to: number; start: number; end: number; state: "running" | "failed" | "done" | "frame" }) {
  const total = end - start;
  const left = Math.min(100, Math.max(0, ((from - start) / total) * 100));
  const width = Math.max(0, Math.min(100 - left, ((to - from) / total) * 100));
  return (
    <span className="relative hidden h-1.5 w-24 shrink-0 rounded-full bg-slate-100 @[560px]:block" aria-hidden="true">
      <span
        className={`absolute inset-y-0 min-w-[3px] rounded-full ${state === "running" ? "bg-accent-500" : state === "failed" ? "bg-shu-500" : state === "frame" ? "bg-slate-300" : "bg-slate-400"}`}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
    </span>
  );
}

/** The guides down the left of the nested rows, like a file tree. */
function Guides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="relative w-4 shrink-0 self-stretch" aria-hidden="true">
          <span className="absolute inset-y-0 left-[7px] w-px bg-slate-200" />
        </span>
      ))}
    </>
  );
}

function Chevron({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="grid h-5 w-4 shrink-0 place-items-center rounded text-slate-400 hover:text-ink"
      aria-expanded={open}
      aria-label={open ? t.runLog.collapse : t.runLog.expand}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <ChevronRight size={13} className={`transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

function Row({
  since,
  depth,
  children,
  right,
  selected,
  tone,
  onClick,
  title,
}: {
  since: string;
  depth: number;
  children: ReactNode;
  right?: ReactNode;
  selected?: boolean;
  tone?: "error";
  onClick?: () => void;
  title?: string;
}) {
  return (
    <div
      className={`group relative flex min-h-[26px] items-center gap-1.5 pr-3 ${onClick ? "cursor-pointer" : ""} ${
        selected ? "bg-primary/[0.07]" : tone === "error" ? "bg-shu-500/[0.06]" : "hover:bg-slate-100/70"
      }`}
      onClick={onClick}
      title={title}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[2px] bg-primary" />}
      <span className="w-12 shrink-0 pr-1 text-right text-[11px] text-slate-400 tabular-nums">{since}</span>
      <Guides depth={depth} />
      {children}
      {right && <span className="ml-auto flex shrink-0 items-center gap-3 pl-3">{right}</span>}
    </div>
  );
}

function Took({ ms }: { ms: number | undefined }) {
  return (
    <span className="w-16 text-right text-[11px] text-slate-500 tabular-nums" title={t.runLog.took}>
      {ms === undefined ? "" : spanText(ms, t.runLog)}
    </span>
  );
}

export function RunLog({ filter }: { filter: TraceFilter }) {
  const run = useStudio((s) => s.run);
  const goToPlace = useStudio((s) => s.goToPlace);
  // The node picked on the chart; inside a called flow (read-only) the one brought up there.
  const selected = useStudio((s) =>
    s.selection?.kind === "step"
      ? `${callKey(s.dive)}#${s.selection.stepId}`
      : s.dive.length > 0 && s.reveal && (s.reveal.inside ?? "") === callKey(s.dive)
        ? `${callKey(s.dive)}#${s.reveal.stepId}`
        : null,
  );
  const names = useNames();
  const live = run ? isActive(run) : false;
  const now = useNow(live);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const box = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

  const lines = useMemo(() => (run ? treeLines(run) : []), [run]);
  const rows = useMemo(
    () => (run ? traceRows(run.trace.nodes, lines, (id, auto) => toggled[id] ?? auto, filter) : []),
    [run, lines, toggled, filter],
  );
  // Follow the newest row unless the person scrolled up to read.
  const count = rows.length;
  useEffect(() => {
    const el = box.current;
    if (el && stuck) el.scrollTop = el.scrollHeight;
  }, [count, stuck]);

  if (!run || (run.logs.length === 0 && run.trace.nodes.length === 0)) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div>
          <p className="text-[13px] font-medium text-slate-600">{t.runLog.empty}</p>
          <p className="mt-1 text-xs text-slate-500">{t.runLog.emptyHint}</p>
        </div>
      </div>
    );
  }
  const span = runSpan(run, now);
  const since = (at: string) => sinceText(Date.parse(at) - span.start);
  const toggle = (id: string, open: boolean) => setToggled((s) => ({ ...s, [id]: !open }));
  const pausedAt = run.pause ? `${callKey(run.pause.callPath)}#${run.pause.stepId}` : null;
  const byKey = new Map(run.trace.nodes.map((n) => [n.key, n] as const));

  const nodeRow = (row: Extract<TraceRow, { kind: "node" }>, i: number) => {
    const { node, depth } = row;
    const place = `${callKey(node.callPath)}#${node.stepId}`;
    const n = names(node);
    const id = `n${node.key}`;
    const open = rows[i + 1] !== undefined && rows[i + 1]!.depth > depth;
    const end = node.endedAt ? Date.parse(node.endedAt) : span.end;
    const took = node.durationMs ?? (live ? end - Date.parse(node.startedAt) : undefined);
    const go = n.known ? () => goToPlace({ path: node.callPath, stepId: node.stepId }) : undefined;
    const paused = pausedAt === place && node.outcome === undefined;
    const Icon = nodeIcon(node.stepType, n.def?.category ?? node.stepType.split(".")[0] ?? "other");
    const color = CATEGORY_COLOR[n.def?.category ?? node.stepType.split(".")[0] ?? "other"] ?? CATEGORY_COLOR.other;
    // A 「ログ出力」 node is its words: one row, written like the flow speaks.
    const said = node.stepType === FLOW_LOG ? lines.find((l) => l.node === node.key) : undefined;
    const ownError = node.error && row.problems.errors === 0 && !node.retrying;
    const sub = n.calls ?? "";
    const out: React.JSX.Element[] = [];
    out.push(
      <Row
        key={id}
        since={since(node.startedAt)}
        depth={depth}
        selected={selected === place}
        onClick={go}
        title={n.known ? `${t.evidence.showInFlow}: ${[n.title, n.name].filter(Boolean).join(" ")}` : undefined}
        right={
          <>
            {node.attempt > 1 && (
              <span className="rounded bg-slate-100 px-1.5 text-[10px] leading-4 text-slate-600">
                {node.outcome === undefined ? t.runLog.retrying(node.attempt) : node.outcome === "succeeded" ? t.runLog.retried(node.attempt) : t.runLog.retrying(node.attempt)}
              </span>
            )}
            {!open && row.problems.warnings > 0 && (
              <span className="flex items-center gap-0.5 text-[11px] text-amber-700">
                <TriangleAlert size={12} aria-hidden="true" />
                {row.problems.warnings}
              </span>
            )}
            {!said && <Bar
              from={Date.parse(node.startedAt)}
              to={end}
              start={span.start}
              end={span.end}
              // What holds other nodes spans them: its colour would only repeat theirs.
              state={holdsNodes(node.stepType) ? "frame" : node.outcome === undefined ? "running" : node.outcome === "failed" && !node.retrying ? "failed" : "done"}
            />}
            {!said && <Took ms={took} />}
          </>
        }
      >
        {row.children > 0 && !said && holdsNodes(node.stepType) ? <Chevron open={open} onToggle={() => toggle(id, open)} /> : <span className="w-4 shrink-0" />}
        {said ? (
          <>
            {said.level === "warn" ? (
              <TriangleAlert size={14} className="shrink-0 text-amber-600" aria-hidden="true" />
            ) : said.level === "error" ? (
              <CircleAlert size={14} className="shrink-0 text-shu-500" aria-hidden="true" />
            ) : (
              <MessageSquareText size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
            )}
            <span
              className={`min-w-0 truncate text-[13px] ${said.level === "warn" ? "text-amber-700" : said.level === "error" ? "text-shu-600" : "text-ink"}`}
              title={`${t.runLog.flowLog}${n.name ? `（${n.name}）` : ""}\n${said.message}`}
            >
              {said.message}
            </span>
          </>
        ) : (
          <>
            <StateIcon node={{ ...node, paused }} />
            <Icon size={14} strokeWidth={1.75} className="shrink-0" style={{ color }} aria-hidden="true" />
            <span className="flex min-w-0 items-baseline gap-1.5 truncate">
              <button
                type="button"
                disabled={!go}
                className="truncate text-left text-[13px] font-medium text-ink enabled:group-hover:underline enabled:group-hover:decoration-slate-300 enabled:group-hover:underline-offset-2 disabled:text-slate-500"
                onClick={(e) => {
                  e.stopPropagation();
                  go?.();
                }}
              >
                {n.title || n.name}
              </button>
              {n.title && n.name && <span className="truncate text-[13px] text-slate-600">{n.name}</span>}
              {sub && <span className="truncate text-xs text-slate-500">→ {sub}</span>}
            </span>
          </>
        )}
      </Row>,
    );
    if (ownError) {
      out.push(
        <Row key={`${id}e`} since="" depth={depth + 1} tone="error" onClick={go}>
          <span className="w-4 shrink-0" />
          <CircleAlert size={14} className="mt-[5px] shrink-0 self-start text-shu-500" aria-hidden="true" />
          <span className="min-w-0 py-1 text-[13px] leading-[18px] whitespace-pre-wrap text-shu-600">{node.error}</span>
        </Row>,
      );
    }
    return out;
  };

  return (
    <div className="@container relative h-full">
      <div
        ref={box}
        className="h-full overflow-y-auto py-1"
        onScroll={(e) => {
          const el = e.currentTarget;
          setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {rows.length === 0 && filter !== "all" && <p className="px-4 py-3 text-xs text-slate-500">{t.runLog.nothing[filter]}</p>}
        {rows.flatMap((row, i): React.JSX.Element[] => {
          if (row.kind === "node") {
            // Its words are on its own row.
            return nodeRow(row, i);
          }
          if (row.kind === "round") {
            const id = `n${row.parent}.${row.index}`;
            const open = rows[i + 1] !== undefined && rows[i + 1]!.depth > row.depth;
            const parent = byKey.get(row.parent);
            const end = row.endedAt ? Date.parse(row.endedAt) : span.end;
            return [
              <Row key={id} since={since(row.startedAt)} depth={row.depth} onClick={() => toggle(id, open)}
                right={
                  <>
                    {!open && row.problems.warnings > 0 && (
                      <span className="flex items-center gap-0.5 text-[11px] text-amber-700">
                        <TriangleAlert size={12} aria-hidden="true" />
                        {row.problems.warnings}
                      </span>
                    )}
                    <Bar from={Date.parse(row.startedAt)} to={end} start={span.start} end={span.end} state="frame" />
                    <Took ms={end - Date.parse(row.startedAt)} />
                  </>
                }
              >
                <Chevron open={open} onToggle={() => toggle(id, open)} />
                <StateIcon node={{ outcome: row.outcome }} />
                <span className="text-xs font-medium text-slate-600">{t.runLog.round(row.index + 1, parent?.stepType === "control.forEach")}</span>
              </Row>,
            ];
          }
          const line = row.line as TraceLine & { mark?: string };
          // A 「ログ出力」 node's line is drawn on the node's row.
          if (line.node !== null && byKey.get(line.node)?.stepType === FLOW_LOG) return [];
          if (line.mark === "start" || line.mark === "end") {
            const text = line.message.replace(/^[▶■]\s*/, "");
            return [
              <Row
                key={`l${line.seq}${line.mark}`}
                since={since(line.at)}
                depth={row.depth}
                right={
                  line.mark === "start" ? (
                    <span className="text-[11px] text-slate-500 tabular-nums">{t.runLog.startedAt(clockOf(line.at))}</span>
                  ) : (
                    <Took ms={span.end - span.start} />
                  )
                }
              >
                <span className="w-4 shrink-0" />
                {line.mark === "start" ? (
                  <Play size={13} className="shrink-0 text-slate-500" aria-hidden="true" />
                ) : (
                  <StateIcon node={{ outcome: run.status === "succeeded" ? "succeeded" : run.status === "cancelled" ? "skipped" : "failed" }} />
                )}
                <span className={`truncate text-xs ${line.mark === "end" ? "font-medium text-ink" : "text-slate-600"}`}>
                  {line.mark === "end" ? `${t.runLog.status[run.status] ?? text}` : text}
                </span>
              </Row>,
            ];
          }
          const warn = line.level === "warn";
          const error = line.level === "error";
          return [
            <Row key={`l${line.seq}${line.message}`} since={since(line.at)} depth={row.depth} tone={error ? "error" : undefined} title={t.runLog.systemLog}>
              <span className="w-4 shrink-0" />
              {line.mark === "pause" ? (
                <CirclePause size={14} className="mt-[5px] shrink-0 self-start text-mizu-500" aria-hidden="true" />
              ) : warn ? (
                <TriangleAlert size={13} className="mt-[6px] shrink-0 self-start text-amber-600" aria-hidden="true" />
              ) : error ? (
                <CircleAlert size={13} className="mt-[6px] shrink-0 self-start text-shu-500" aria-hidden="true" />
              ) : (
                <span className="w-[13px] shrink-0" />
              )}
              <span
                className={`min-w-0 py-1 text-xs leading-[18px] whitespace-pre-wrap ${
                  error ? "text-shu-600" : warn ? "text-amber-700" : line.level === "debug" ? "text-slate-400" : "text-slate-600"
                }`}
              >
                {line.message.replace(/^(❚❚|▶)\s*/, "")}
              </span>
            </Row>,
          ];
        })}
      </div>
      {!stuck && (
        <button
          type="button"
          className="absolute right-4 bottom-3 rounded-md border border-slate-200 bg-sheet px-2 py-0.5 text-xs text-slate-600 shadow-node hover:text-ink"
          onClick={() => setStuck(true)}
        >
          ↓ {t.runLog.toLatest}
        </button>
      )}
    </div>
  );
}


/** The run as plain text, every row open: to paste into a chat or a report. */
function logText(run: RunState, names: Names): string {
  const span = runSpan(run, 0);
  const lines = treeLines(run);
  const byKey = new Map(run.trace.nodes.map((n) => [n.key, n] as const));
  const mark = { succeeded: "✓", failed: "×", skipped: "-" } as const;
  return traceRows(run.trace.nodes, lines, () => true)
    .map((row) => {
      const pad = "  ".repeat(row.depth);
      if (row.kind === "node") {
        const n = names(row.node);
        const said = row.node.stepType === FLOW_LOG ? lines.find((l) => l.node === row.node.key) : undefined;
        const what = said ? said.message : [n.title, n.name].filter(Boolean).join(" ");
        const took = row.node.durationMs !== undefined ? `  ${spanText(row.node.durationMs, t.runLog)}` : "";
        const head = `${sinceText(Date.parse(row.node.startedAt) - span.start).padStart(6)}  ${pad}${row.node.outcome ? mark[row.node.outcome] : "…"} ${what}${took}`;
        return row.node.error && row.problems.errors === 0 ? `${head}\n${"".padStart(8)}${pad}  ${row.node.error}` : head;
      }
      if (row.kind === "round") {
        return `${sinceText(Date.parse(row.startedAt) - span.start).padStart(6)}  ${pad}${t.runLog.round(row.index + 1, byKey.get(row.parent)?.stepType === "control.forEach")}`;
      }
      if (row.line.node !== null && byKey.get(row.line.node)?.stepType === FLOW_LOG) return null;
      return `${sinceText(Date.parse(row.line.at) - span.start).padStart(6)}  ${pad}${row.line.message}`;
    })
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** Beside the log tab: how the run is going, which lines to show, and copying them. */
export function RunLogBar({ filter, onFilter }: { filter: TraceFilter; onFilter: (f: TraceFilter) => void }) {
  const run = useStudio((s) => s.run);
  const names = useNames();
  const [copied, setCopied] = useState(false);
  if (!run) return null;
  const problems = countProblems(run);
  const filters: TraceFilter[] = ["all", "flow", "problems"];
  return (
    <>
      <span className="flex-1" />
      <div role="radiogroup" className="mr-1 flex shrink-0 items-center rounded-md bg-slate-100 p-0.5">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={filter === f}
            title={t.runLog.filterHints[f]}
            onClick={() => onFilter(f)}
            className={`flex h-5 items-center gap-1 rounded px-2 text-[11px] whitespace-nowrap ${filter === f ? "bg-sheet font-medium text-ink shadow-node" : "text-slate-500 hover:text-ink"}`}
          >
            {t.runLog.filters[f]}
            {f === "problems" && problems > 0 && <span className={filter === f ? "text-shu-600" : ""}>{problems}</span>}
          </button>
        ))}
      </div>
      <button
        type="button"
        title={copied ? t.runLog.copied : t.runLog.copy}
        aria-label={t.runLog.copy}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(logText(run, names));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Nothing to say: the button stays as it is.
          }
        }}
      >
        {copied ? <Check size={14} className="text-moegi-500" /> : <Copy size={14} />}
      </button>
    </>
  );
}

/** Errors and warnings of the run, each once: a failure counts at the node it began in. */
export function countProblems(run: RunState): number {
  const failedInside = new Set(run.trace.nodes.filter((n) => n.error && !n.retrying && n.parent !== null).map((n) => n.parent));
  const failures = run.trace.nodes.filter((n) => n.error && !n.retrying && !failedInside.has(n.key)).length;
  const lines = run.logs.filter((l) => !l.fromStep && !l.mark && (l.level === "error" || l.level === "warn")).length;
  return failures + lines;
}

/** A time of day as the clock shows it: 08:30:00. */
function clockOf(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
