// The flow as a chart to read (see flow/chart.ts for what it shows and why).
// It is drawn on the sheet's paper (components/sheet/SheetView.tsx): a box for each step, in the column of
// the app it works on, and an arrow from each box to the next.
import type { Step } from "@spellsheet/schema";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleX,
  Columns2,
  FileInput,
  FileOutput,
  Globe,
  KeyRound,
  LogOut,
  Repeat,
  RotateCw,
  Split,
  StepForward,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useStudio } from "../../context";
import type { RunState } from "../../store/run";
import {
  type Band,
  type Defs,
  FACT_H,
  FACT_PAD,
  FAIL_LANE,
  layoutChart,
  NEST,
  type Row,
  TILE_H,
  TILE_W,
} from "../../flow/chart";
import { chartWords, guardOutcome } from "../../lib/keywords";
import { type Fact, systemFacts } from "../../lib/systemFacts";
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
/** Between places side by side in one column, and between columns. */
const COL_GAP = 36;
/** A corner of the line where it changes column. */
const TURN = 6;
/** The arrow's head, and the room over a box the line comes down into it. */
const HEAD = 5;
const DROP = 13;
/** Where the line leaves a row, and where it comes into one: a box's lower and upper edge, a bar's middle. */
const leave = (row: Row) => (row.kind === "bar" ? row.h / 2 : row.h);
const enter = (row: Row) => (row.kind === "bar" ? row.h / 2 : 0);

/** What a step is called on the chart: the name it was given, else what it does in a sentence. */
const title = (step: Step, defs: Defs): string =>
  (step.name ?? "").trim() || plain(sentence(step, defs.get(step.type)));

const FACT_ICON: Record<Fact["kind"], LucideIcon> = {
  connect: Globe,
  read: FileInput,
  write: FileOutput,
  secret: KeyRound,
  wait: Timer,
  retry: RotateCw,
  take: ArrowDownToLine,
  give: ArrowUpFromLine,
};

/** One thing the system does at a step: what kind, then the value, on a quiet line under the step's name. */
function FactLine({ fact, numbers }: { fact: Fact; numbers?: ReadonlyMap<string, number> }) {
  const words = chartWords();
  const Icon = FACT_ICON[fact.kind];
  const at = (ids: string[]) =>
    [...new Set(ids.map((id) => numbers?.get(id)).filter((n): n is number => n !== undefined))].sort((a, b) => a - b).join("・");
  const value = ((): string => {
    switch (fact.kind) {
      case "connect":
        return fact.host;
      case "read":
      case "write":
        return fact.path;
      case "secret":
        return fact.name;
      case "wait":
        return words.upTo(fact.seconds);
      case "retry":
        return words.attempts(fact.attempts);
      case "take": {
        const from = fact.from === null ? words.atStart : at([fact.from]) && words.fromStep(at([fact.from]));
        return from ? `${fact.variable}（${from}）` : fact.variable;
      }
      case "give": {
        const to = [at(fact.to) && words.toSteps(at(fact.to)), fact.out && words.flowOutput].filter(Boolean).join("、");
        return to ? `${fact.variable}（${to}）` : fact.variable;
      }
    }
  })();
  return (
    <span className="flex items-center gap-1 text-[11.5px] leading-none text-slate-500" style={{ height: FACT_H }} title={`${words.facts[fact.kind]} ${value}`}>
      <Icon size={11} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-slate-400" />
      <span className="shrink-0 text-slate-400">{words.facts[fact.kind]}</span>
      <span className="truncate">{value}</span>
    </span>
  );
}

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
 * `onOpen`: a row pressed is read on the sheet, where its settings open under its line.
 */
export function ChartBody({ numbers, run, onOpen }: { numbers?: ReadonlyMap<string, number>; run?: RunState | null; onOpen?: () => void }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const goTo = useStudio((s) => s.goTo);
  const defs: Defs = useMemo(
    () => new Map(stepTypes.map((d) => [d.type, d] as const)),
    [stepTypes],
  );
  // What the system does at each step, said under its row.
  const facts = useMemo(() => (flow ? systemFacts(flow, defs) : new Map<string, Fact[]>()), [flow, defs]);
  const chart = useMemo(() => layoutChart(flow?.steps ?? [], defs, (step) => facts.get(step.id ?? "")?.length ?? 0), [flow, defs, facts]);
  if (!flow) return null;
  const words = chartWords();

  // Columns: each as wide as the places side by side in it, and the bands round them.
  const side = NEST * chart.nest;
  const place = TILE_W;
  const widths = chart.lanes.map(
    (l) => 2 * side + l.cols * place + (l.cols - 1) * COL_GAP,
  );
  const lefts: number[] = [];
  chart.lanes.forEach((_, i) =>
    lefts.push(i === 0 ? PAD : lefts[i - 1]! + widths[i - 1]! + COL_GAP),
  );
  /** The line a row is on: down the middle of its box. */
  const lineX = (r: { lane: number; off: number }) =>
    lefts[r.lane]! + side + TILE_W / 2 + r.off * (place + COL_GAP);
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
    const left = Math.min(...xs) - TILE_W / 2 - room;
    return {
      left,
      width: Math.max(...xs) + TILE_W / 2 + room - left,
      top: top + b.top,
      height: b.bottom - b.top,
    };
  };
  /** A bar: over the lines it reaches and its own. */
  const barBox = (row: Extract<Row, { kind: "bar" }>) => {
    const xs = [lineX(row), ...row.over.map((i) => lineX(chart.rows[i]!))];
    const left = Math.min(...xs) - 36;
    return { left, width: Math.max(...xs) + 36 - left };
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
    const y1 = top + a.y + leave(a);
    const y2 = top + b.y + enter(b);
    if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;
    // Down its own column, then across just over the row it goes to.
    const across = top + b.y - DROP;
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
        {chart.links.map((l) => {
          const to = chart.rows[l.to]!;
          const x = to.kind === "bar" ? null : lineX(to);
          const y = top + to.y;
          return (
            <g key={`${l.from}-${l.to}`}>
              <path d={path(l)} fill="none" stroke="var(--chart-line)" strokeWidth={1.5} />
              {/* The arrow's head, on the box the line goes to. */}
              {x !== null && <path d={`M ${x - HEAD} ${y - HEAD - 1} L ${x} ${y} L ${x + HEAD} ${y - HEAD - 1}`} fill="none" stroke="var(--chart-line)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />}
            </g>
          );
        })}
        {/* A failure anywhere in these rows goes to the column beside them. */}
        {chart.brackets.map((b, i) => {
          const x = lefts[chart.failLane!]! - COL_GAP / 2;
          const to = chart.rows[b.to]!;
          const out = top + to.y + Math.min(to.h, TILE_H) / 2;
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
                d={`M ${x} ${out} H ${lineX(to) - TILE_W / 2}`}
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
            facts={facts.get(row.step.id ?? "")}
            numbers={numbers}
            state={row.step.id ? run?.steps[row.step.id] : undefined}
            select={(stepId) => {
              goTo(stepId);
              onOpen?.();
            }}
          />
        ),
      )}
    </div>
  );
}

/** A row: its box, with the line at `x` down its middle. */
function RowView({
  row,
  defs,
  x,
  y,
  picked,
  number,
  state,
  select,
  facts,
  numbers,
}: {
  /** The step's number on the sheet; null where the sheet gives it none (the words still line up). */
  number?: number | null;
  /** What the system does at the step, under its name. */
  facts?: Fact[];
  numbers?: ReadonlyMap<string, number>;
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
  const box = { left: x - TILE_W / 2, top: y, width: TILE_W, height: row.h } as const;
  const edge = state === "failed" ? "border-shu-500" : state === "succeeded" ? "border-moegi-600" : "border-slate-300";
  const NO = "mr-1.5 inline-block min-w-[16px] shrink-0 text-[11.5px] font-normal text-slate-400 tabular-nums";

  if (row.kind === "step") {
    return (
      <button
        type="button"
        title={tip}
        onClick={pick}
        style={box}
        className={`flow-chart-node absolute z-10 block rounded-[6px] border px-3 text-left ${edge} ${row.quiet ? "flow-chart-node-quiet" : ""}`}
      >
        <span className="flex items-center" style={{ height: TILE_H - 2 }}>
          {number != null && <span className={NO}>{number}</span>}
          <span className={`truncate ${row.quiet ? "text-[12.5px] text-slate-600" : "text-[13.5px] font-medium text-ink"}`}>
            <span className={on}>{title(row.step, defs)}</span>
          </span>
        </span>
        {facts && facts.length > 0 && (
          <span className="block" style={{ paddingBottom: FACT_PAD - 2 }}>
            {facts.map((fact, i) => (
              <FactLine key={i} fact={fact} numbers={numbers} />
            ))}
          </span>
        )}
      </button>
    );
  }
  if (row.kind === "stop") {
    const Icon = STOP_ICON[row.step.type] ?? CircleX;
    const fail = row.step.type === FAIL;
    return (
      <span
        title={tip}
        style={{ left: x, top: y, height: row.h }}
        className={`absolute z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-sheet px-3 text-[12.5px] font-medium whitespace-nowrap ${fail ? "border-shu-500 text-shu-600" : "border-slate-300 text-slate-600"}`}
      >
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        {fail ? title(row.step, defs) : guardOutcome(row.step)}
      </span>
    );
  }
  if (row.kind === "guard") {
    const Out = STOP_ICON[row.stop.type] ?? CircleX;
    const fail = row.stop.type === FAIL;
    return (
      <button type="button" title={tip} onClick={pick} style={box} className={`flow-chart-node absolute z-10 block rounded-[6px] border px-3 text-left ${edge}`}>
        <span className="flex items-center gap-2" style={{ height: TILE_H - 2 }}>
          {/* A decision: a diamond before its question. */}
          <span className="size-[8px] shrink-0 rotate-45 border-[1.5px] border-slate-500" />
          <span className={`truncate text-[13.5px] font-medium text-ink ${on}`}>{question(row.step, defs)}</span>
        </span>
        {/* The answer that leaves the line here, and where it goes. The other answer is the arrow going on. */}
        <span className={`flex items-center gap-1.5 text-[12px] ${fail ? "text-shu-600" : "text-slate-500"}`}>
          <span className="shrink-0 rounded-full border border-slate-200 px-2 leading-[16px] font-medium whitespace-nowrap text-slate-600">
            {row.block === "then" ? words.yes : words.no}
          </span>
          <Out size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{fail ? title(row.stop, defs) : guardOutcome(row.stop)}</span>
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
      style={{ left: x, top: y, height: row.h }}
      className="absolute z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-300 bg-sheet pr-3 pl-2 text-left text-[12px] whitespace-nowrap"
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
