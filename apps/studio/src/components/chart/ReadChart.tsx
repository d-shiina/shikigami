// The flow as a chart to read (see flow/chart.ts for what it shows and why).
import type { Step } from "@spellsheet/schema";
import { CircleX, LogOut, Repeat, Rows2, StepForward, TriangleAlert, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { useStudio } from "../../context";
import { type Band, CROSS, type Defs, FAIL_LANE, layoutChart, NEST, ROW_GAP, type Row, TAG_H, TILE_W } from "../../flow/chart";
import { chartWords, guardOutcome } from "../../lib/keywords";
import { groupIcon, nodeIcon } from "../../lib/nodeIcons";
import { groupLabel, groupOf } from "../../lib/palette";
import { plain, sentence } from "../../lib/sentence";
import { BREAK, CONTINUE, FAIL } from "../../lib/stepTypes";
import { CATEGORY_COLOR } from "../CommandPalette";

/** Round the chart. */
const PAD = 28;
/** A column's name over it. */
const LANE_HEAD = 52;
/** Between a column's name and its first row. */
const TOP = 22;
/** Between the app columns and the column of what runs on failure. */
const FAIL_GAP = 20;
/** Between branches side by side in one column. */
const COL_GAP = 20;
/** A corner of the line where it changes column. */
const TURN = 8;

/** What a step is called on the chart: the name it was given, else what it does in a sentence. */
const title = (step: Step, defs: Defs): string => (step.name ?? "").trim() || plain(sentence(step, defs.get(step.type)));

/** What an if asks: its name as a question, else its condition. */
function question(step: Step, defs: Defs): string {
  const said = (step.name ?? "").trim().replace(/[？?]$/, "");
  const cond = String((step.params as Record<string, unknown> | undefined)?.condition ?? "").replace(/^\{\{\s*|\s*\}\}$/g, "");
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
      const name = /^https?:\/\//.test(value) ? value.replace(/^https?:\/\//, "").split("/")[0]! : value.split(/[\\/]/).at(-1)!;
      if (name && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

const STOP_ICON: Record<string, LucideIcon> = { [CONTINUE]: StepForward, [BREAK]: LogOut, [FAIL]: CircleX };

export function ReadChart() {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const defs: Defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const chart = useMemo(() => layoutChart(flow?.steps ?? [], defs), [flow, defs]);
  if (!flow) return null;
  const words = chartWords();

  // Columns: each as wide as its tiles (branches side by side) and the bands round them.
  const side = 12 + NEST * chart.nest;
  const widths = chart.lanes.map((l) => l.cols * TILE_W + (l.cols - 1) * COL_GAP + 2 * side);
  const lefts: number[] = [];
  chart.lanes.forEach((_, i) => lefts.push(i === 0 ? PAD : lefts[i - 1]! + widths[i - 1]! + (i === chart.failLane ? FAIL_GAP : 0)));
  const laneX = (i: number) => lefts[i]!;
  const centre = (r: { lane: number; off: number }) => laneX(r.lane) + widths[r.lane]! / 2 + r.off * (TILE_W + COL_GAP);
  const top = LANE_HEAD + TOP;
  const width = laneX(chart.lanes.length - 1) + widths.at(-1)! + PAD;
  const height = top + chart.height + PAD + 8;
  const picked = selection?.kind === "step" ? selection.stepId : null;

  const bandBox = (b: Band) => {
    const xs = chart.rows.slice(b.first, b.end).filter((r) => r.lane !== chart.failLane || chart.rows[b.first]!.lane === chart.failLane).map(centre);
    const room = TILE_W / 2 + NEST * (b.inner + 1);
    const left = Math.min(...xs) - room;
    return { left, width: Math.max(...xs) + room - left, top: top + b.top, height: b.bottom - b.top };
  };
  /** A bar: over the rows it reaches and its own place on the line. */
  const barBox = (row: Extract<Row, { kind: "bar" }>) => {
    const xs = [centre(row), ...row.over.map((i) => centre(chart.rows[i]!))];
    const left = Math.min(...xs) - 28;
    return { left, width: Math.max(...xs) + 28 - left };
  };
  const path = ({ from, to }: { from: number; to: number }): string => {
    const a = chart.rows[from]!;
    const b = chart.rows[to]!;
    // A bar is as wide as the rows it reaches: the line into or out of it runs straight.
    const under = a.kind === "bar" && b.kind !== "bar" ? barBox(a) : null;
    const x1 = under && centre(b) >= under.left + 8 && centre(b) <= under.left + under.width - 8 ? centre(b) : centre(a);
    const x2 = b.kind === "bar" ? x1 : centre(b);
    const y1 = top + a.y + a.h;
    const y2 = top + b.y;
    if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;
    // Down its own column, then across just over the row it goes to.
    const across = y2 - (ROW_GAP + CROSS) / 2;
    const dir = x2 > x1 ? 1 : -1;
    return `M ${x1} ${y1} V ${across - TURN} Q ${x1} ${across} ${x1 + dir * TURN} ${across} H ${x2 - dir * TURN} Q ${x2} ${across} ${x2} ${y2}`;
  };

  return (
    <div className="flow-chart absolute inset-0 overflow-auto">
      <div className="relative mx-auto" style={{ width, height }}>
        {/* The columns: what each is, and a hairline between them. */}
        {chart.lanes.map((lane, i) => {
          const fail = lane.key === FAIL_LANE;
          const Icon = fail ? TriangleAlert : lane.key ? groupIcon(lane.key) : null;
          const names = fail ? [] : targets(lane.steps);
          return (
            <div key={lane.key} className={`absolute top-0 bottom-0 ${fail ? "flow-chart-fail" : ""}`} style={{ left: laneX(i), width: widths[i] }}>
              {i > 0 && !fail && <span className="absolute top-3 bottom-3 left-0 w-px bg-[var(--flow-read-panel-line)]" />}
              {(lane.key || fail) && (
                <div className="sticky top-0 z-30 flex items-center justify-center gap-2 px-3" style={{ height: LANE_HEAD }}>
                  {Icon && (
                    <Icon
                      size={15}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      style={{ color: fail ? "var(--color-shu-600)" : (CATEGORY_COLOR[lane.key] ?? CATEGORY_COLOR.other) }}
                    />
                  )}
                  <span className={`text-[13px] font-semibold whitespace-nowrap ${fail ? "text-shu-600" : "text-ink"}`}>
                    {fail ? words.failed : groupLabel(lane.key)}
                  </span>
                  {names.length > 0 && (
                    <span className="min-w-0 truncate text-[11.5px] text-slate-500">
                      {names.slice(0, 2).join("、")}
                      {names.length > 2 ? ` ${words.more(names.length - 2)}` : ""}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* The bands: what repeats, and what runs only sometimes. Outer ones first, so inner ones lie on them. */}
        {chart.bands.map((b, i) => (
          <div key={i} className={`flow-chart-band flow-chart-band-${b.kind} absolute rounded-[12px] border`} style={bandBox(b)} />
        ))}

        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden="true">
          {chart.links.map((l) => (
            <path key={`${l.from}-${l.to}`} d={path(l)} fill="none" stroke="var(--flow-read-edge)" strokeWidth={1.5} />
          ))}
          {/* A failure anywhere in these rows goes to the column beside them. */}
          {chart.brackets.map((b, i) => {
            const x = laneX(chart.failLane!) - FAIL_GAP / 2;
            const to = chart.rows[b.to]!;
            const out = top + to.y + to.h / 2;
            return (
              <g key={i} fill="none" stroke="var(--color-shu-500)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d={`M ${x - 8} ${top + b.top} H ${x} V ${top + b.bottom} H ${x - 8}`} />
                <path d={`M ${x} ${out} H ${centre(to) - TILE_W / 2}`} strokeDasharray="4 4" />
              </g>
            );
          })}
        </svg>

        {chart.rows.map((row, i) =>
          row.kind === "bar" ? <span key={i} className="absolute z-10 rounded-full bg-[var(--flow-read-edge)]" style={{ ...barBox(row), top: top + row.y, height: row.h }} /> : null,
        )}
        {chart.rows.map((row, i) => (
          <RowView key={i} row={row} defs={defs} x={centre(row)} y={top + row.y} picked={picked} select={(stepId) => select({ kind: "step", stepId })} />
        ))}
      </div>
    </div>
  );
}

function RowView({ row, defs, x, y, picked, select }: { row: Row; defs: Defs; x: number; y: number; picked: string | null; select: (id: string) => void }) {
  const words = chartWords();
  const def = defs.get(row.step.type);
  const tip = plain(sentence(row.step, def));
  const on = picked !== null && picked === row.step.id;
  const pick = () => row.step.id && select(row.step.id);
  const at = { left: x, top: y, height: row.h } as const;
  const ring = on ? "ring-2 ring-brand-500" : "";

  if (row.kind === "bar") return null;
  if (row.kind === "step") {
    const group = def ? groupOf(def) : "other";
    const Icon = nodeIcon(row.step.type, group);
    const color = CATEGORY_COLOR[def?.category ?? ""] ?? CATEGORY_COLOR[group] ?? CATEGORY_COLOR.other;
    if (row.quiet) {
      // Work on nothing outside: a tag on the line.
      return (
        <button type="button" title={tip} onClick={pick} style={at} className={`flow-chart-tag absolute z-10 flex max-w-[236px] -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 text-[12px] text-slate-600 ${ring}`}>
          <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" style={{ color }} />
          <span className="truncate">{title(row.step, defs)}</span>
        </button>
      );
    }
    return (
      <button type="button" title={tip} onClick={pick} style={{ ...at, width: TILE_W }} className={`flow-chart-tile absolute z-10 flex -translate-x-1/2 items-center gap-2 rounded-[9px] border px-3 text-left text-[12.5px] text-ink ${ring}`}>
        <Icon size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0" style={{ color }} />
        <span className="truncate font-medium">{title(row.step, defs)}</span>
      </button>
    );
  }
  if (row.kind === "stop") return <WayOut step={row.step} style={{ ...at, transform: "translateX(-50%)" }} className="absolute z-10" label={row.step.type === FAIL ? title(row.step, defs) : guardOutcome(row.step)} tip={tip} />;
  if (row.kind === "guard") {
    const q = question(row.step, defs);
    const Out = STOP_ICON[row.stop.type] ?? CircleX;
    return (
      <button
        type="button"
        title={tip}
        onClick={pick}
        style={{ ...at, width: TILE_W }}
        className={`flow-answer absolute z-10 flex -translate-x-1/2 flex-col justify-center gap-0.5 rounded-[9px] border px-3 text-left text-ink ${ring}`}
      >
        <span className="truncate text-[12.5px] font-medium">{q}</span>
        {/* The answer that leaves the line here, and where it goes. The other answer is the line going on. */}
        <span className={`flex items-center gap-1.5 text-[12px] ${row.stop.type === FAIL ? "text-shu-600" : "text-slate-600"}`}>
          <span className="font-medium text-ink">{row.block === "then" ? words.yes : words.no}</span>
          <Out size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{row.stop.type === FAIL ? title(row.stop, defs) : guardOutcome(row.stop)}</span>
        </span>
      </button>
    );
  }
  // Where a band starts: its name, on the line.
  if (row.band === "when") {
    const answer = row.block === "then" ? words.onlyWhen(words.yes) : row.block === "else" ? words.onlyWhen(words.no) : "";
    const text = row.child ? title(row.child, defs) : row.block === "default" ? words.other : question(row.step, defs);
    return (
      <button type="button" title={tip} onClick={pick} style={at} className={`flow-answer absolute z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 text-[12px] whitespace-nowrap text-ink ${ring}`}>
        <span className="font-medium">{text}</span>
        {answer && <span className="text-slate-600">{answer}</span>}
      </button>
    );
  }
  const p = (row.step.params ?? {}) as Record<string, unknown>;
  const limit = typeof p.maxConcurrency === "number" ? p.maxConcurrency : undefined;
  const atOnce = row.band === "loop" && typeof p.concurrency === "number" && p.concurrency > 1 ? p.concurrency : 0;
  const text = row.band === "always" ? words.always : row.band === "together" ? (row.step.name ?? "").trim() || words.together(limit) : title(row.step, defs);
  return (
    <button type="button" title={tip} onClick={pick} style={at} className={`flow-chart-head absolute z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold whitespace-nowrap text-ink ${ring}`}>
      {row.band === "loop" && <Repeat size={13} strokeWidth={2} aria-hidden="true" className="text-slate-500" />}
      {row.band === "together" && <Rows2 size={13} strokeWidth={2} aria-hidden="true" className="rotate-90 text-slate-500" />}
      {text}
      {atOnce > 0 && <span className="font-normal text-slate-600">{words.atOnce(atOnce)}</span>}
    </button>
  );
}

/** Where the line ends: on to the next round, out of the loop, or failed. */
function WayOut({ step, label, tip, style, className = "" }: { step: Step; label: string; tip: string; style?: React.CSSProperties; className?: string }) {
  const Icon = STOP_ICON[step.type] ?? CircleX;
  const fail = step.type === FAIL;
  return (
    <span title={tip || undefined} style={{ height: TAG_H, ...style }} className={`flex items-center gap-1.5 rounded-full border px-2.5 text-[12px] whitespace-nowrap ${fail ? "flow-chart-failed" : "flow-chart-tag text-ink"} ${className}`}>
      <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </span>
  );
}
