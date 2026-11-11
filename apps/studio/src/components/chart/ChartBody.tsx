// The flow as a chart to read (see flow/chart.ts for what it shows and why).
// It is drawn on the sheet's paper (components/sheet/SheetView.tsx) in the sheet's own terms: a hairline down
// each column, a mark on it for each step and the step's name beside it.
import type { Step } from "@spellsheet/schema";
import {
  CircleX,
  Columns2,
  LogOut,
  Repeat,
  Split,
  StepForward,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useStudio } from "../../context";
import type { RunState } from "../../store/run";
import {
  type Band,
  CROSS,
  type Defs,
  FAIL_LANE,
  layoutChart,
  NEST,
  type Row,
  TILE_W,
} from "../../flow/chart";
import { chartWords, guardOutcome } from "../../lib/keywords";
import { groupIcon } from "../../lib/nodeIcons";
import { groupLabel } from "../../lib/palette";
import { plain, sentence } from "../../lib/sentence";
import { BREAK, CONTINUE, FAIL } from "../../lib/stepTypes";
import { CATEGORY_COLOR } from "../CommandPalette";

/** The paper's margin round the chart. */
const PAD = 40;
/** Between the paper's heading and the columns' names. */
const HEAD_GAP = 20;
/** A column's name over it. */
const LANE_HEAD = 40;
/** Between a column's name and its first row. */
const TOP = 20;
/** From a column's edge (and the bands round its rows) to its line. */
const LEAD = 14;
/** From the line to a row's words. */
const WORDS = 16;
/** Between places side by side in one column, and between columns. */
const COL_GAP = 28;
/** A corner of the line where it changes column. */
const TURN = 7;
/** Where the line meets a row: the middle of its first line of words. */
const mid = (row: Row) =>
  row.kind === "bar" ? row.h / 2 : Math.min(row.h, 28) / 2;

/** What a step is called on the chart: the name it was given, else what it does in a sentence. */
const title = (step: Step, defs: Defs): string =>
  (step.name ?? "").trim() || plain(sentence(step, defs.get(step.type)));

/** What an if asks: its name as a question, else its condition. */
function question(step: Step, defs: Defs): string {
  const said = (step.name ?? "").trim().replace(/[？?]$/, "");
  const cond = String(
    (step.params as Record<string, unknown> | undefined)?.condition ?? "",
  ).replace(/^\{\{\s*|\s*\}\}$/g, "");
  const text = said || cond || plain(sentence(step, defs.get(step.type)));
  return /[　-鿿]/.test(text) ? `${text}？` : `${text}?`;
}

/** What a column's steps work on: the sites and files they name. */
function targets(steps: Step[]): string[] {
  const found: string[] = [];
  for (const step of steps) {
    const p = (step.params ?? {}) as Record<string, unknown>;
    for (const value of [p.url, p.path]) {
      if (typeof value !== "string" || value.includes("{{")) continue;
      const name = /^https?:\/\//.test(value)
        ? value.replace(/^https?:\/\//, "").split("/")[0]!
        : value.split(/[\\/]/).at(-1)!;
      if (name && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

const STOP_ICON: Record<string, LucideIcon> = {
  [CONTINUE]: StepForward,
  [BREAK]: LogOut,
  [FAIL]: CircleX,
};
const BAND_ICON: Partial<Record<Band["kind"], LucideIcon>> = {
  loop: Repeat,
  when: Split,
  together: Columns2,
};

/**
 * The chart itself, as wide and as high as it is: what lies under a sheet's
 * heading when the sheet is read as a chart.
 */
/**
 * `numbers`: each step's number on the sheet, so a row here and a line there are found from one another.
 * `run`: the run that is going, or the last one: how far it got is said on the rows.
 */
export function ChartBody({ numbers, run }: { numbers?: ReadonlyMap<string, number>; run?: RunState | null }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const defs: Defs = useMemo(
    () => new Map(stepTypes.map((d) => [d.type, d] as const)),
    [stepTypes],
  );
  const chart = useMemo(
    () => layoutChart(flow?.steps ?? [], defs),
    [flow, defs],
  );
  if (!flow) return null;
  const words = chartWords();

  // Columns: each as wide as the places side by side in it, and the bands round them.
  const side = NEST * chart.nest;
  const place = LEAD + WORDS + TILE_W;
  const widths = chart.lanes.map(
    (l) => 2 * side + l.cols * place + (l.cols - 1) * COL_GAP,
  );
  const lefts: number[] = [];
  chart.lanes.forEach((_, i) =>
    lefts.push(i === 0 ? PAD : lefts[i - 1]! + widths[i - 1]! + COL_GAP),
  );
  /** The line a row is on. */
  const lineX = (r: { lane: number; off: number }) =>
    lefts[r.lane]! + side + LEAD + r.off * (place + COL_GAP);
  const top = HEAD_GAP + LANE_HEAD + TOP;
  const width = lefts.at(-1)! + widths.at(-1)! + PAD;
  const height = top + chart.height + PAD;
  const picked = selection?.kind === "step" ? selection.stepId : null;

  const bandBox = (b: Band) => {
    const inside = chart.rows.slice(b.first, b.end);
    const xs = inside
      .filter(
        (r) => r.lane !== chart.failLane || inside[0]!.lane === chart.failLane,
      )
      .map(lineX);
    const room = NEST * (b.inner + 1);
    const left = Math.min(...xs) - LEAD - room + NEST;
    return {
      left,
      width: Math.max(...xs) + WORDS + TILE_W + room - NEST - left,
      top: top + b.top,
      height: b.bottom - b.top,
    };
  };
  /** A bar: over the lines it reaches and its own. */
  const barBox = (row: Extract<Row, { kind: "bar" }>) => {
    const xs = [lineX(row), ...row.over.map((i) => lineX(chart.rows[i]!))];
    const left = Math.min(...xs) - 5;
    return { left, width: Math.max(...xs) + 5 - left };
  };
  const path = ({ from, to }: { from: number; to: number }): string => {
    const a = chart.rows[from]!;
    const b = chart.rows[to]!;
    // A bar is as wide as the lines it reaches: the line into or out of it runs straight.
    const under = a.kind === "bar" && b.kind !== "bar" ? barBox(a) : null;
    const x1 =
      under && lineX(b) >= under.left && lineX(b) <= under.left + under.width
        ? lineX(b)
        : lineX(a);
    const x2 = b.kind === "bar" ? x1 : lineX(b);
    const y1 = top + a.y + mid(a);
    const y2 = top + b.y + mid(b);
    if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;
    // Down its own column, then across just over the row it goes to.
    const across = top + b.y - CROSS / 2 - 2;
    const dir = x2 > x1 ? 1 : -1;
    return `M ${x1} ${y1} V ${across - TURN} Q ${x1} ${across} ${x1 + dir * TURN} ${across} H ${x2 - dir * TURN} Q ${x2} ${across} ${x2} ${across + TURN} V ${y2}`;
  };

  return (
    <div className="flow-chart-body relative" style={{ width, height }}>
      {/* The columns: what each is, over a hairline. */}
      {chart.lanes.map((lane, i) => {
        const fail = lane.key === FAIL_LANE;
        const Icon = fail
          ? TriangleAlert
          : lane.key
            ? groupIcon(lane.key)
            : null;
        const names = fail ? [] : targets(lane.steps);
        if (!lane.key) return null;
        return (
          <div
            key={lane.key}
            className="absolute flex items-center gap-2 border-b border-slate-200"
            style={{
              left: lefts[i],
              width: widths[i],
              top: HEAD_GAP,
              height: LANE_HEAD,
            }}
          >
            {Icon && (
              <Icon
                size={15}
                strokeWidth={1.75}
                aria-hidden="true"
                className="shrink-0"
                style={{
                  color: fail
                    ? "var(--color-shu-600)"
                    : (CATEGORY_COLOR[lane.key] ?? CATEGORY_COLOR.other),
                }}
              />
            )}
            <span
              className={`text-[13.5px] font-semibold whitespace-nowrap ${fail ? "text-shu-600" : "text-ink"}`}
            >
              {fail ? words.failed : groupLabel(lane.key)}
            </span>
            {names.length > 0 && (
              <span className="min-w-0 truncate font-mono text-[11px] text-slate-500">
                {names.slice(0, 2).join(" · ")}
                {names.length > 2 ? ` ${words.more(names.length - 2)}` : ""}
              </span>
            )}
          </div>
        );
      })}

      {/* The bands: what repeats, and what runs only sometimes. Outer ones first, so inner ones lie on them. */}
      {chart.bands.map((b, i) => (
        <div
          key={i}
          className={`flow-chart-band-${b.kind} absolute rounded-[10px]`}
          style={bandBox(b)}
        />
      ))}

      <svg
        className="pointer-events-none absolute inset-0"
        width={width}
        height={height}
        aria-hidden="true"
      >
        {chart.links.map((l) => (
          <path
            key={`${l.from}-${l.to}`}
            d={path(l)}
            fill="none"
            stroke="var(--chart-line)"
            strokeWidth={1.5}
          />
        ))}
        {/* A failure anywhere in these rows goes to the column beside them. */}
        {chart.brackets.map((b, i) => {
          const x = lefts[chart.failLane!]! - COL_GAP / 2;
          const to = chart.rows[b.to]!;
          const out = top + to.y + mid(to);
          return (
            <g
              key={i}
              fill="none"
              stroke="var(--color-shu-500)"
              strokeWidth={1.25}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path
                d={`M ${x - 6} ${top + b.top + 4} H ${x} V ${top + b.bottom - 4} H ${x - 6}`}
              />
              <path
                d={`M ${x} ${out} H ${lineX(to) - 8}`}
                strokeDasharray="3 4"
              />
            </g>
          );
        })}
      </svg>

      {chart.rows.map((row, i) =>
        row.kind === "bar" ? (
          <span
            key={i}
            className="absolute rounded-full bg-slate-400"
            style={{ ...barBox(row), top: top + row.y, height: row.h }}
          />
        ) : (
          <RowView
            key={i}
            row={row}
            defs={defs}
            x={lineX(row)}
            y={top + row.y}
            picked={picked}
            number={numbers ? (numbers.get(row.step.id ?? "") ?? null) : undefined}
            state={row.step.id ? run?.steps[row.step.id] : undefined}
            select={(stepId) => select({ kind: "step", stepId })}
          />
        ),
      )}
    </div>
  );
}

/** A row: its mark on the line at `x`, and its words beside it. */
function RowView({
  row,
  defs,
  x,
  y,
  picked,
  number,
  state,
  select,
}: {
  /** The step's number on the sheet; null where the sheet gives it none (the words still line up). */
  number?: number | null;
  state?: string;
  row: Exclude<Row, { kind: "bar" }>;
  defs: Defs;
  x: number;
  y: number;
  picked: string | null;
  select: (id: string) => void;
}) {
  const words = chartWords();
  const tip = plain(sentence(row.step, defs.get(row.step.type)));
  // The step the run is on is under the highlighter, as the one picked is.
  const on = (picked !== null && picked === row.step.id) || state === "running" ? "flow-chart-on" : "";
  const pick = () => row.step.id && select(row.step.id);
  // The mark is centred on the line; the words start WORDS past it.
  const at = {
    left: x - 8,
    top: y,
    height: row.h,
    maxWidth: 8 + WORDS + TILE_W,
  } as const;
  const base = "absolute z-10 flex items-center text-left";

  if (row.kind === "step") {
    return (
      <button
        type="button"
        title={tip}
        onClick={pick}
        style={at}
        className={base}
      >
        <span className="flex w-4 shrink-0 justify-center">
          <span
            className={`rounded-full ${state === "failed" ? "size-[9px] bg-shu-500" : state === "succeeded" ? "size-[7px] bg-moegi-600" : row.quiet ? "size-[7px] border-[1.5px] border-slate-400 bg-sheet" : "size-[7px] bg-slate-500"}`}
          />
        </span>
        <span
          style={{ marginLeft: WORDS - 8 }}
          className={`truncate ${row.quiet ? "text-[12.5px] text-slate-500" : "text-[13.5px] font-medium text-ink"}`}
        >
          {number !== undefined && <span className="mr-1.5 inline-block w-[18px] text-[11.5px] font-normal text-slate-400 tabular-nums">{number}</span>}
          <span className={on}>{title(row.step, defs)}</span>
        </span>
      </button>
    );
  }
  if (row.kind === "stop") {
    const Icon = STOP_ICON[row.step.type] ?? CircleX;
    const fail = row.step.type === FAIL;
    return (
      <span
        title={tip}
        style={at}
        className={`${base} ${fail ? "text-shu-600" : "text-slate-600"}`}
      >
        <span className="flex w-4 shrink-0 justify-center">
          <Icon
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className="rounded-full bg-sheet"
          />
        </span>
        <span
          style={{ marginLeft: WORDS - 8 }}
          className="truncate text-[12.5px] font-medium"
        >
          {fail ? title(row.step, defs) : guardOutcome(row.step)}
        </span>
      </span>
    );
  }
  if (row.kind === "guard") {
    const Out = STOP_ICON[row.stop.type] ?? CircleX;
    const fail = row.stop.type === FAIL;
    return (
      <button
        type="button"
        title={tip}
        onClick={pick}
        style={at}
        className={`${base} items-start`}
      >
        <span className="flex h-7 w-4 shrink-0 items-center justify-center">
          {/* A decision: a diamond on the line. */}
          <span className="size-[8px] rotate-45 border-[1.5px] border-slate-500 bg-sheet" />
        </span>
        <span
          style={{ marginLeft: WORDS - 8 }}
          className="flex min-w-0 flex-col"
        >
          <span
            className={`truncate text-[13.5px] leading-7 font-medium text-ink ${on}`}
          >
            {question(row.step, defs)}
          </span>
          {/* The answer that leaves the line here, and where it goes. The other answer is the line going on. */}
          <span
            className={`-mt-1 flex items-center gap-1.5 text-[12px] ${fail ? "text-shu-600" : "text-slate-500"}`}
          >
            <span className="rounded-full border border-slate-200 bg-sheet px-2 leading-[18px] font-medium text-slate-600">
              {row.block === "then" ? words.yes : words.no}
            </span>
            <Out
              size={13}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0"
            />
            <span className="truncate">
              {fail ? title(row.stop, defs) : guardOutcome(row.stop)}
            </span>
          </span>
        </span>
      </button>
    );
  }
  // Where a band starts: its name on its top edge, its sign on the line.
  const p = (row.step.params ?? {}) as Record<string, unknown>;
  const Icon = BAND_ICON[row.band];
  const text =
    row.band === "when"
      ? row.child
        ? title(row.child, defs)
        : row.block === "default"
          ? words.other
          : question(row.step, defs)
      : row.band === "always"
        ? words.always
        : row.band === "together"
          ? (row.step.name ?? "").trim() ||
            words.together(
              typeof p.maxConcurrency === "number"
                ? p.maxConcurrency
                : undefined,
            )
          : title(row.step, defs);
  const more =
    row.band === "when" && (row.block === "then" || row.block === "else")
      ? words.onlyWhen(row.block === "then" ? words.yes : words.no)
      : row.band === "loop" &&
          typeof p.concurrency === "number" &&
          p.concurrency > 1
        ? words.atOnce(p.concurrency)
        : "";
  return (
    <button
      type="button"
      title={tip}
      onClick={pick}
      style={{ left: x - 13, top: y, height: row.h }}
      className={`${base} gap-1.5 rounded-full border border-slate-200 bg-sheet pr-3 pl-[6px] text-[12px] whitespace-nowrap`}
    >
      <span className="flex w-[13px] shrink-0 justify-center">
        {Icon ? (
          <Icon
            size={13}
            strokeWidth={1.75}
            aria-hidden="true"
            className="text-slate-500"
          />
        ) : (
          <span className="size-[5px] rounded-full bg-slate-400" />
        )}
      </span>
      <span className={`font-medium text-ink ${on}`}>{text}</span>
      {more && <span className="text-slate-500">{more}</span>}
    </button>
  );
}
