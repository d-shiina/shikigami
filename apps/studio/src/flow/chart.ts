// The flow as a chart to read, laid out from nothing but the flow itself.
//
// It answers what the sheet's sentences cannot at a glance: which app each
// piece of work touches and in what order, where work repeats, where it
// only sometimes runs, and where a failure goes. So it is drawn the way a
// business flow is drawn on paper: a column for each app, time running down,
// one row for each step, and one line through them.
//
// - A step is a mark on the line with its name beside it, in the column of
//   the app it works on. Work on nothing outside (a calculation, a log) is a
//   quieter mark where the line already is.
// - What repeats, and what runs only for one answer, is a band across the
//   columns it touches, named in words on the line where it starts. No lines
//   go back or round: the band and its words say it.
// - An if whose one side only stops (on to the next round, out of the loop,
//   failed) is its question on the line with that way out under it; the
//   other side is simply what follows on the line.
// - What runs when something fails stands in a column of its own, beside
//   the rows it covers.
// - What runs at the same time runs side by side: the line parts at a bar,
//   each branch goes down the column of its app (branches on the same app
//   stand beside each other in it), and they meet at a bar again, since what
//   follows waits for them all.
//
// Pure geometry: what each row says is the component's (components/chart).
import type { Step, StepTypeDef } from "@spellsheet/schema";
import { groupOf, isAppGroup } from "../lib/palette";
import { BREAK, CASE, CONTINUE, FAIL, GROUP, IF, LOOP_TYPES, PARALLEL, SWITCH, TRY } from "../lib/stepTypes";

export type Defs = ReadonlyMap<string, StepTypeDef>;

/** How wide a row's words may be. */
export const TILE_W = 216;
export const TILE_H = 28;
/** A tag (work on nothing outside), a band's name, a way out. */
export const TAG_H = 24;
/** The bar where the line parts into branches that run at the same time, and where they meet. */
export const BAR_H = 3;
/** A guard: its question, and under it the answer that leaves the line and where it goes. */
export const GUARD_H = 46;
export const ROW_GAP = 6;
/** More room over a row the line crosses columns to reach. */
export const CROSS = 10;
/** Under the last row of a band, inside it. */
const BAND_PAD = 8;
/** Round a band, between it and the rows before and after. */
const BAND_GAP = 8;
/** Beside a band, for each band inside it. */
export const NEST = 8;

const WAIT_UNTIL = "wait.until";
const STOPS: ReadonlySet<string> = new Set([BREAK, CONTINUE, FAIL]);
const stops = (step: Step | undefined): boolean => !!step && STOPS.has(step.type) && !step.disabled;

export type BandKind = "loop" | "when" | "always" | "group" | "together";
/** The column of what runs when something fails. */
export const FAIL_LANE = "@fail";

/** `cols`: how many branches run side by side in it at the most. */
export type Lane = { key: string; steps: Step[]; cols: number };

/** Where a row is: its column, and which of the places side by side in it (0 unless branches share the column). */
type Place = { lane: number; off: number; y: number; h: number };

export type Row = Place &
  (
    | /** A step: a tile in its app's column, or (`quiet`) a tag for work on nothing outside. */ { kind: "step"; step: Step; quiet: boolean }
    | /** A break, continue or fail: where the line ends. */ { kind: "stop"; step: Step }
    | /** An if whose `block` side only stops: the question, and that way out. */ { kind: "guard"; step: Step; block: string; stop: Step }
    | /** Where a band starts: its name, on the line. `block` is the side of an if or the block of a try it is. */ {
        kind: "head";
        step: Step;
        band: BandKind;
        block: string;
        child?: Step;
      }
    | /** Where branches that run at the same time part or meet: as wide as the rows `over` it reaches. */ { kind: "bar"; step: Step; over: number[] }
  );

export type Band = {
  kind: BandKind;
  step: Step;
  /** The rows in it, from `first` up to (not including) `end` in `rows`: it reaches across the columns they are in. */
  first: number;
  end: number;
  top: number;
  bottom: number;
  /** How many bands deep the deepest band inside it is. */
  inner: number;
};

/** A try's rows, and the first row of what runs when they fail. */
export type Bracket = { top: number; bottom: number; to: number };

export type Chart = {
  lanes: Lane[];
  /** The index of the failure column in `lanes`, when there is one. */
  failLane: number | null;
  rows: Row[];
  bands: Band[];
  /** From a row to the row after it, by index in `rows`. */
  links: { from: number; to: number }[];
  brackets: Bracket[];
  height: number;
  /** The deepest nesting of bands. */
  nest: number;
};

/** The app a step works on (a group of lib/palette), or null for work on nothing outside. */
export function appOf(step: Step, defs: Defs): string | null {
  const def = defs.get(step.type);
  if (!def) return null;
  const group = groupOf(def);
  return isAppGroup(group) ? group : null;
}

const blocksOf = (step: Step): [string, Step[]][] => Object.entries(step.blocks ?? {});

export function layoutChart(steps: Step[], defs: Defs): Chart {
  // The columns: each app, in the order the flow first touches it.
  const keys: string[] = [];
  let fails = false;
  const scan = (list: Step[]) => {
    for (const step of list) {
      if (step.disabled) continue;
      const app = appOf(step, defs);
      if (app && !keys.includes(app)) keys.push(app);
      for (const [name, inner] of blocksOf(step)) {
        if (step.type === TRY && name === "catch") fails ||= inner.some((c) => !c.disabled);
        else scan(inner);
      }
    }
  };
  scan(steps);
  if (keys.length === 0) keys.push("");
  const lanes: Lane[] = keys.map((key) => ({ key, steps: [], cols: 1 }));
  const failLane = fails ? lanes.length : null;
  if (fails) lanes.push({ key: FAIL_LANE, steps: [], cols: 1 });

  const rows: Row[] = [];
  const bands: Band[] = [];
  const links: { from: number; to: number }[] = [];
  const brackets: Bracket[] = [];
  let y = 0;
  let lane = 0;
  /** Inside what runs on failure: every row stays in that column. */
  let failing = false;
  /** The rows the line comes from into the next row. */
  let prev: number[] = [];
  let depth = 0;
  let nest = 0;

  const put = (row: Row): number => {
    const index = rows.length;
    // Room for the line to cross to another column over this row (not from a bar: it reaches over the column itself).
    if (prev.some((from) => rows[from]!.lane !== row.lane && rows[from]!.kind !== "bar")) {
      y += CROSS;
      row.y += CROSS;
    }
    rows.push(row);
    for (const from of prev) links.push({ from, to: index });
    prev = [index];
    y += row.h + ROW_GAP;
    return index;
  };
  /** The column the first row of `list` will be in. */
  const firstLane = (list: Step[]): number => {
    if (failing) return lane;
    const step = list.find((s) => !s.disabled);
    if (!step) return lane;
    const app = appOf(step, defs);
    if (app) return keys.indexOf(app);
    const blocks = step.blocks ?? {};
    if (step.type === IF) {
      // A guard is in the column of what follows it.
      const yes = blocks.then ?? [];
      const no = blocks.else ?? [];
      if (yes.length === 1 && stops(yes[0])) return firstLane(no);
      if (no.length === 1 && stops(no[0])) return firstLane(yes);
    }
    const inner = blocksOf(step).find(([name, l]) => l.length > 0 && !(step.type === TRY && name === "catch"));
    return inner ? firstLane(inner[1]) : lane;
  };
  const band = (kind: BandKind, step: Step, block: string, body: Step[], child?: Step) => {
    y += BAND_GAP;
    lane = firstLane(body);
    const first = rows.length;
    const head = put({ kind: "head", step, lane, off: 0, y, h: TAG_H, band: kind, block, ...(child ? { child } : {}) });
    const top = rows[head]!.y + TAG_H / 2;
    const mark = bands.length;
    depth += 1;
    nest = Math.max(nest, depth);
    walk(body);
    depth -= 1;
    // Every way through it stopped: what follows is still reached when it does not run (or runs again).
    if (prev.length === 0) prev = [head];
    const bottom = y - ROW_GAP + BAND_PAD;
    const inner = bands.slice(mark).reduce((n, b) => Math.max(n, b.inner + 1), 0);
    bands.splice(mark, 0, { kind, step, first, end: rows.length, top, bottom, inner });
    y = bottom + ROW_GAP + BAND_GAP;
  };
  const walk = (list: Step[]) => {
    for (const step of list) {
      if (step.disabled) continue;
      const blocks = step.blocks ?? {};
      if (step.type === TRY) {
        const top = y;
        walk(blocks.try ?? []);
        const tried = prev;
        const caught = blocks.catch ?? [];
        if (caught.length > 0 && failLane !== null && !failing) {
          const after = y;
          const back = lane;
          y = top;
          lane = failLane;
          prev = [];
          failing = true;
          const to = rows.length;
          walk(caught);
          failing = false;
          // Nothing to go to when every step of the catch is switched off.
          if (rows.length > to) brackets.push({ top, bottom: after - ROW_GAP, to });
          prev = [...tried, ...prev];
          y = Math.max(after, y);
          lane = back;
        } else if (caught.length > 0) {
          walk(caught);
        }
        if ((blocks.finally ?? []).length > 0) band("always", step, "finally", blocks.finally!);
        continue;
      }
      if (step.type === IF) {
        const yes = blocks.then ?? [];
        const no = blocks.else ?? [];
        const only = (l: Step[]) => l.length === 1 && stops(l[0]);
        const guard = only(yes) ? "then" : only(no) ? "else" : null;
        if (guard) {
          lane = firstLane(guard === "then" ? no : yes);
          put({ kind: "guard", step, lane, off: 0, y, h: GUARD_H, block: guard, stop: (guard === "then" ? yes : no)[0]! });
          walk(guard === "then" ? no : yes);
        } else {
          if (yes.length > 0) band("when", step, "then", yes);
          if (no.length > 0) band("when", step, "else", no);
        }
        continue;
      }
      if (step.type === SWITCH) {
        for (const child of blocks.cases ?? []) {
          if (child.type === CASE && !child.disabled) band("when", step, "cases", blocksOf(child).flatMap(([, l]) => l), child);
        }
        if ((blocks.default ?? []).length > 0) band("when", step, "default", blocks.default!);
        continue;
      }
      if (step.type === PARALLEL) {
        const branches = (blocks.branches ?? []).filter((b) => !b.disabled);
        y += BAND_GAP;
        put({ kind: "head", step, lane, off: 0, y, h: TAG_H, band: "together", block: "branches" });
        const fork = put({ kind: "bar", step, lane, off: 0, y, h: BAR_H, over: [] });
        const top = y;
        const home = lane;
        const strands: [number, number][] = [];
        const exits: number[] = [];
        const firsts: number[] = [];
        let bottom = y;
        for (const branch of branches) {
          y = top;
          lane = firstLane([branch]);
          prev = [fork];
          const start = rows.length;
          walk([branch]);
          if (rows.length > start) {
            strands.push([start, rows.length]);
            firsts.push(start);
          }
          exits.push(...prev.filter((i) => i !== fork));
          bottom = Math.max(bottom, y);
        }
        y = bottom;
        lane = home;
        prev = exits;
        put({ kind: "bar", step, lane, off: 0, y, h: BAR_H, over: exits });
        (rows[fork] as Extract<Row, { kind: "bar" }>).over = firsts;
        // Branches in the same column stand beside each other in it.
        lanes.forEach((l, index) => {
          const here = strands.filter(([a, b]) => rows.slice(a, b).some((r) => r.lane === index));
          if (here.length < 2) return;
          l.cols = Math.max(l.cols, here.length);
          here.forEach(([a, b], k) => {
            for (const r of rows.slice(a, b)) if (r.lane === index) r.off += k;
          });
        });
        continue;
      }
      if (LOOP_TYPES.has(step.type) || step.type === WAIT_UNTIL) {
        band("loop", step, "body", blocksOf(step).flatMap(([, l]) => l));
        continue;
      }
      const filled = blocksOf(step).filter(([, l]) => l.length > 0);
      if (filled.length > 0) {
        for (const [name, inner] of filled) band("group", step, step.type === GROUP ? "" : name, inner);
        continue;
      }
      if (stops(step)) {
        put({ kind: "stop", step, lane, off: 0, y, h: TAG_H });
        prev = [];
        continue;
      }
      const app = failing ? null : appOf(step, defs);
      if (app) lane = keys.indexOf(app);
      lanes[lane]!.steps.push(step);
      put({ kind: "step", step, lane, off: 0, y, h: app || failing ? TILE_H : TAG_H, quiet: !app && !failing });
    }
  };
  walk(steps);
  return { lanes, failLane, rows, bands, links, brackets, height: Math.max(0, y - ROW_GAP), nest };
}
