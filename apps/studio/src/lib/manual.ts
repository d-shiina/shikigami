// The 手順書: a flow read as a procedure a person could follow, with the
// screens of the last run from Studio (docs/design/manual.md).
//
// The flow becomes chapters (its top-level parts), each chapter a list of
// screens with numbered operations, branches and loops as framed parts,
// and work with no screen (variables, logs) folded into one quiet line.
// This module only builds that outline; ManualView draws it and
// manualExport writes it as one HTML file.
import type { Flow, PublishedState, Step, StepTypeDef, VariableDef, VersionSummary } from "@shikigami/schema";
import { t } from "./i18n";
import { blockLabel } from "./keywords";
import { type Part, plain, readable, secretName, sentence } from "./sentence";
import { CALL, FOR_EACH, GROUP, IF, PARALLEL, REPEAT, SWITCH, TRY, WHILE } from "./stepTypes";

/** A rectangle in a picture's pixels. */
export type Rect = { x: number; y: number; width: number; height: number };

/** One picture of the last run (`manual.json`). */
export type ManualShot = {
  key: string;
  stepId: string;
  callPath?: string[];
  file: string;
  width: number;
  height: number;
  mark?: Rect;
  regions?: Rect[];
  title?: string;
  /** Equal for pictures of the same view (address and scroll place). */
  view?: string;
  /** 「作るときの画面」: taken when the node was tried alone, by a person or the AI. */
  draft?: "studio" | "ai";
};

/** A picture from a node tried alone (src-tauri `drafts`), by flow then node ID. */
export type DraftShot = Omit<ManualShot, "key" | "stepId" | "draft"> & { source: "studio" | "ai"; takenAt: number };
export type Drafts = Readonly<Record<string, Readonly<Record<string, DraftShot>>>>;

export type ManualManifest = {
  runId: string;
  revision: number;
  startedAt: string;
  durationMs: number;
  shots: ManualShot[];
  counts: Record<string, number>;
};

export type MaskBox = Rect & { kind: "blur" | "black" };
/** What the person hid on one node's picture (by shot key). */
export type Mask = { hidden: boolean; boxes: MaskBox[]; width: number; height: number };

/** An operation with its number in the chapter. */
export type ManualStep = {
  key: string;
  stepId: string;
  callPath: string[];
  number: number;
  /** What it does, in the flow's words (its name) or as a sentence. */
  text: string;
  /** How it does it, when `text` is the node's name. */
  how: Part[] | null;
  /** Times it ran in the last run; null without a run. */
  ran: number | null;
  /** Where it is in the scene's picture. */
  mark: Rect | null;
  /**
   * It presses, types into or picks the marked thing (a button, a field), so
   * the mark stays readable through the blur over values. A node that only
   * reads (getText of a customer's name) keeps its mark blurred.
   */
  operates: boolean;
  /** The node's description: said as a 「ポイント」 beside the step. */
  note: string | null;
  /** The login it enters, if any: said as a 「注意」 (the password is never shown). */
  login: string | null;
};

/** A screen and what is done on it. */
export type Scene = {
  kind: "scene";
  /** The picture (of the scene's first node that has one). */
  shot: ManualShot | null;
  /** 「受注システム」画面: the page's or window's title. */
  title: string | null;
  app: "browser" | "desktop";
  steps: ManualStep[];
  /** Waits and checks on the screen: said in place, not numbered. `at` is the step they come before. */
  waits: { at: number; text: string; mark: Rect | null }[];
};

export type ManualItem =
  | Scene
  | { kind: "action"; step: ManualStep }
  | { kind: "quiet"; texts: string[] }
  | { kind: "branch"; label: string; taken: boolean | null; items: ManualItem[] }
  | { kind: "loop"; label: string; times: number | null; items: ManualItem[] }
  | { kind: "group"; label: string; items: ManualItem[] };

export type Chapter = {
  number: number;
  title: string;
  /** 「2 と同時に進めます」 */
  alongside: number[];
  items: ManualItem[];
  screens: number;
  loops: boolean;
};

export type ManualDoc = {
  title: string;
  description: string;
  uses: string[];
  inputs: string[];
  outputs: string[];
  chapters: Chapter[];
  /** Screens with a picture, across the chapters. */
  pictures: number;
  /** Of those, 「作るときの画面」 (no run of the whole flow took them). */
  drafts: number;
  /** Screen operations that have no picture yet (not run since, or skipped). */
  missing: number;
};

/** Nodes that only wait for or look at something: not an operation a person counts. */
const WAITS = new Set(["browser.waitFor", "desktop.waitFor", "browser.isVisible", "desktop.isVisible"]);

const QUIET = new Set(["variable.set", "log.message", "flow.delay", "control.break", "control.continue"]);

/** When a node's picture is taken (crates/shikigami-runtime/src/screens.rs). */
export function screenMoment(type: string): "before" | "after" | null {
  const [adapter, action] = type.split(".");
  const before =
    adapter === "browser"
      ? ["click", "fill", "check", "select", "press", "hover", "upload", "download", "scroll"]
      : adapter === "desktop"
        ? ["click", "type", "setValue", "select", "selectMenu", "check", "hover", "drag", "mouseClick", "press", "scroll", "mouseScroll"]
        : [];
  const after =
    adapter === "browser"
      ? ["open", "navigate", "switchTab", "attach", "waitFor", "getText", "getTable", "getAttribute", "isVisible"]
      : adapter === "desktop"
        ? ["waitFor", "getValue", "getTable", "readText", "isVisible"]
        : [];
  if (action && before.includes(action)) return "before";
  if (action && after.includes(action)) return "after";
  return null;
}

const keyOf = (callPath: string[], stepId: string) => [...callPath, stepId].join("/");

/** Words a variable stands for: its description when it has a short one. */
function varWords(vars: VariableDef[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of vars) {
    const d = v.description?.trim();
    if (d && d.length <= 24 && !d.includes("\n")) map.set(v.name, d);
  }
  return map;
}

/** `order['注文番号']` → `orderの「注文番号」`, variable names → their descriptions. */
export function humanize(parts: Part[], words: ReadonlyMap<string, string>): Part[] {
  // Words can carry `{{ expr }}` holes too (a button named "{{ order['注文番号'] }} を出荷"): the holes become chips.
  const split = parts.flatMap((p): Part[] =>
    "text" in p && p.text.includes("{{")
      ? p.text
          .split(/(\{\{.*?\}\})/)
          .filter((piece) => piece !== "")
          .map((piece) => (piece.startsWith("{{") && piece.endsWith("}}") ? { code: readable(piece.slice(2, -2).trim()) } : { text: piece }))
      : [p],
  );
  return split.map((p) => {
    if (!("code" in p)) return p;
    let text = p.code.replace(/([\p{L}_][\p{L}\p{N}_]*)\[['"]([^'"]+)['"]\]/gu, (_, v: string, col: string) =>
      t.manual.column(words.get(v) ?? v, col),
    );
    text = text.replace(/[\p{L}_][\p{L}\p{N}_]*/gu, (name) => words.get(name) ?? name);
    return { code: text };
  });
}

type Ctx = {
  defs: ReadonlyMap<string, StepTypeDef>;
  shots: ReadonlyMap<string, ManualShot>;
  counts: Record<string, number> | null;
  subflows: ReadonlyMap<string, Flow>;
  /** The flow whose nodes are being read (a sub-flow inside its call). */
  flowId: string;
  drafts: Drafts;
  hidden: ReadonlySet<string>;
  words: Map<string, string>;
  /** Numbers operations within the chapter being built. */
  next: { n: number };
  missing: { n: number };
  depth: number;
};

const count = (ctx: Ctx, key: string): number | null => (ctx.counts ? (ctx.counts[key] ?? 0) : null);

function describe(step: Step, ctx: Ctx): { text: string; how: Part[] | null } {
  const parts = humanize(sentence(step, ctx.defs.get(step.type)), ctx.words);
  const name = step.name?.trim();
  if (name) return { text: name, how: parts };
  return { text: plain(parts), how: null };
}

function label(step: Step, ctx: Ctx): string {
  return step.name?.trim() || plain(humanize(sentence(step, ctx.defs.get(step.type)), ctx.words));
}

function manualStep(step: Step, callPath: string[], ctx: Ctx): ManualStep {
  const id = step.id ?? "";
  const key = keyOf(callPath, id);
  ctx.next.n += 1;
  return {
    key,
    stepId: id,
    callPath,
    number: ctx.next.n,
    ...describe(step, ctx),
    ran: count(ctx, key),
    mark: null,
    operates: screenMoment(step.type) === "before",
    note: step.description?.trim() || null,
    login: loginOf(step.params),
  };
}

/** The first saved login a node's settings refer to (`{ "secret": … }`). */
function loginOf(value: unknown): string | null {
  const name = secretName(value);
  if (name) return name;
  if (!value || typeof value !== "object") return null;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = loginOf(v);
    if (found) return found;
  }
  return null;
}

/** The ordered blocks of a step, with their labels. */
function blocks(step: Step, ctx: Ctx): { name: string; label: string; steps: Step[] }[] {
  const def = ctx.defs.get(step.type);
  const declared = def?.blocks?.map((b) => b.name) ?? [];
  const names = Object.keys(step.blocks ?? {}).sort(
    (a, b) => (declared.indexOf(a) + 1 || declared.length + 1) - (declared.indexOf(b) + 1 || declared.length + 1),
  );
  return names.map((name) => ({
    name,
    label: blockLabel(step, name, def?.blocks?.find((b) => b.name === name)?.label ?? name),
    steps: step.blocks?.[name] ?? [],
  }));
}

/** Ran in the last run: any node in the block ran (null without a run). */
function blockRan(steps: Step[], callPath: string[], ctx: Ctx): boolean | null {
  if (!ctx.counts || steps.length === 0) return null;
  return steps.some((s) => (count(ctx, keyOf(callPath, s.id ?? "")) ?? 0) > 0);
}

/** Times a loop's body ran: the most any of its own nodes ran. */
function loopTimes(steps: Step[], callPath: string[], ctx: Ctx): number | null {
  if (!ctx.counts) return null;
  return Math.max(0, ...steps.map((s) => count(ctx, keyOf(callPath, s.id ?? "")) ?? 0));
}

/** The items of a list of nodes: screens grouped, quiet work folded. */
function items(steps: Step[], callPath: string[], ctx: Ctx): ManualItem[] {
  const out: ManualItem[] = [];
  const last = () => out.at(-1);
  for (const step of steps) {
    if (step.disabled || !step.id) continue;
    const key = keyOf(callPath, step.id);
    const moment = screenMoment(step.type);
    if (moment) {
      const shot = ctx.shots.get(key) ?? draftShot(ctx, step.id, key);
      const app = step.type.startsWith("desktop.") ? "desktop" : "browser";
      const wait = WAITS.has(step.type);
      const entry = wait ? null : manualStep(step, callPath, ctx);
      const prev = last();
      const sameScreen =
        prev?.kind === "scene" &&
        prev.app === app &&
        (shot === null ||
          prev.shot === null ||
          // Marks are drawn on the scene's one picture: only pictures of
          // the same view (same address, same scroll place) share it.
          (prev.shot.title === shot.title &&
            prev.shot.width === shot.width &&
            prev.shot.height === shot.height &&
            prev.shot.view === shot.view));
      if (!shot && !wait && (count(ctx, key) ?? 1) > 0) ctx.missing.n += 1;
      if (entry) entry.mark = shot?.mark ?? null;
      if (sameScreen && prev?.kind === "scene") {
        if (!prev.shot && shot) {
          prev.shot = shot;
          prev.title = shot.title ?? null;
        }
        if (entry) prev.steps.push(entry);
        else prev.waits.push({ at: prev.steps.length, text: label(step, ctx), mark: shot?.mark ?? null });
      } else {
        out.push({ kind: "scene", shot, title: shot?.title ?? null, app, steps: entry ? [entry] : [], waits: entry ? [] : [{ at: 0, text: label(step, ctx), mark: shot?.mark ?? null }] });
      }
      continue;
    }
    if (QUIET.has(step.type)) {
      const prev = last();
      const text = label(step, ctx);
      if (prev?.kind === "quiet") prev.texts.push(text);
      else out.push({ kind: "quiet", texts: [text] });
      continue;
    }
    switch (step.type) {
      case IF:
      case SWITCH:
      case TRY: {
        const name = step.name?.trim();
        const p = (step.params ?? {}) as Record<string, unknown>;
        const condition = typeof p.condition === "string" ? plain(humanize([{ code: readable(p.condition) }], ctx.words)) : "";
        for (const block of blocks(step, ctx)) {
          if (block.steps.length === 0) continue;
          // A switch's cases are nodes of their own.
          if (step.type === SWITCH && block.name !== "default") {
            for (const c of block.steps) {
              if (c.disabled || !c.id) continue;
              const caseSteps = Object.values(c.blocks ?? {}).flat();
              out.push({
                kind: "branch",
                label: t.manual.whenCase(label(step, ctx), label(c, ctx)),
                taken: blockRan(caseSteps, callPath, ctx),
                items: items(caseSteps, callPath, ctx),
              });
            }
            continue;
          }
          const branchLabel =
            step.type === SWITCH
              ? t.manual.noneOfThese
              : step.type === TRY
                ? block.name === "try"
                  ? (name ?? t.manual.tryFirst)
                  : block.name === "catch"
                    ? t.manual.onFailure
                    : t.manual.atTheEnd
                : block.name === "then"
                  ? (name ?? t.manual.when(condition))
                  : name
                    ? t.manual.otherwise
                    : t.manual.whenNot(condition);
          out.push({ kind: "branch", label: branchLabel, taken: blockRan(block.steps, callPath, ctx), items: items(block.steps, callPath, ctx) });
        }
        break;
      }
      case FOR_EACH:
      case REPEAT:
      case WHILE: {
        const body = step.blocks?.body ?? [];
        out.push({ kind: "loop", label: label(step, ctx), times: loopTimes(body, callPath, ctx), items: items(body, callPath, ctx) });
        break;
      }
      case GROUP:
      case PARALLEL: {
        const inner = blocks(step, ctx).flatMap((b) => b.steps);
        if (step.type === PARALLEL) {
          for (const branch of inner) {
            if (branch.disabled || !branch.id) continue;
            out.push({ kind: "group", label: t.manual.alongside(label(branch, ctx)), items: items([branch], callPath, ctx) });
          }
        } else {
          out.push({ kind: "group", label: label(step, ctx), items: items(inner, callPath, ctx) });
        }
        break;
      }
      case CALL: {
        const called = ctx.subflows.get(String((step.params as Record<string, unknown> | undefined)?.flow ?? ""));
        if (called && ctx.depth < 4) {
          const inner = { ...ctx, flowId: called.id, depth: ctx.depth + 1, words: new Map([...ctx.words, ...varWords(called.variables ?? [])]) };
          out.push({ kind: "group", label: label(step, ctx), items: items(called.steps ?? [], [...callPath, step.id], inner) });
        } else {
          out.push({ kind: "action", step: manualStep(step, callPath, ctx) });
        }
        break;
      }
      default:
        out.push({ kind: "action", step: manualStep(step, callPath, ctx) });
    }
  }
  return out;
}

/** The picture taken when the node was tried alone, when the run has none. */
function draftShot(ctx: Ctx, stepId: string, key: string): ManualShot | null {
  const d = ctx.drafts[ctx.flowId]?.[stepId];
  if (!d || ctx.hidden.has(key)) return null;
  const { source, takenAt: _, ...shot } = d;
  return { ...shot, key, stepId, draft: source };
}

/** Nodes that are only quiet work: folded into the chapter beside them. */
const onlyQuiet = (steps: Step[]) => steps.every((s) => QUIET.has(s.type) || s.disabled);

const STRUCTURE = new Set([IF, SWITCH, TRY, FOR_EACH, REPEAT, WHILE, GROUP, CALL]);

/** Splits the top level into chapters: structured nodes each, plain runs together. */
function chapterParts(steps: Step[]): { steps: Step[]; parallel: boolean }[] {
  const parts: { steps: Step[]; parallel: boolean }[] = [];
  let run: Step[] = [];
  const flush = () => {
    if (run.length > 0) parts.push({ steps: run, parallel: false });
    run = [];
  };
  for (const step of steps) {
    if (step.disabled) continue;
    if (step.type === PARALLEL) {
      flush();
      const branches = Object.values(step.blocks ?? {}).flat().filter((b) => !b.disabled);
      for (const branch of branches) parts.push({ steps: [branch], parallel: true });
      // Marks the end of one parallel set.
      parts.push({ steps: [], parallel: false });
      continue;
    }
    if (STRUCTURE.has(step.type)) {
      flush();
      parts.push({ steps: [step], parallel: false });
      continue;
    }
    run.push(step);
  }
  flush();
  // Quiet-only parts join the part before (the next one, at the start).
  const merged: { steps: Step[]; parallel: boolean }[] = [];
  let carry: Step[] = [];
  for (const part of parts) {
    const real = [...merged].reverse().find((p) => p.steps.length > 0);
    if (part.steps.length > 0 && onlyQuiet(part.steps)) {
      if (real) real.steps.push(...part.steps);
      else carry.push(...part.steps);
      continue;
    }
    merged.push(part.steps.length > 0 && carry.length > 0 ? { ...part, steps: [...carry, ...part.steps] } : part);
    if (part.steps.length > 0) carry = [];
  }
  if (carry.length > 0) merged.push({ steps: carry, parallel: false });
  return merged;
}

function countScreens(list: ManualItem[]): { screens: number; loops: boolean } {
  let screens = 0;
  let loops = false;
  for (const item of list) {
    if (item.kind === "scene") screens += 1;
    if (item.kind === "loop") loops = true;
    if ("items" in item) {
      const inner = countScreens(item.items);
      screens += inner.screens;
      loops ||= inner.loops;
    }
  }
  return { screens, loops };
}

function chapterTitle(steps: Step[], ctx: Ctx): string {
  const main = steps.find((s) => !QUIET.has(s.type)) ?? steps[0];
  return main ? label(main, ctx) : "";
}

/** What the flow works with: sites and apps, files, logins (names only). */
function uses(flow: Flow, subflows: ReadonlyMap<string, Flow>): string[] {
  const found: string[] = [];
  const add = (text: string) => {
    if (text && !found.includes(text)) found.push(text);
  };
  const literal = (v: unknown) => (typeof v === "string" && v && !v.includes("{{") ? v : null);
  const walk = (steps: Step[], seen: Set<string>) => {
    for (const step of steps) {
      if (step.disabled) continue;
      const p = (step.params ?? {}) as Record<string, unknown>;
      const [adapter] = step.type.split(".");
      if (step.type === "browser.open") {
        const url = literal(p.url);
        let host: string | null = null;
        try {
          host = url ? new URL(url).host : null;
        } catch {
          host = null;
        }
        add(host ? t.manual.usesSite(host) : t.manual.usesBrowser);
        if (typeof p.session === "string") add(t.manual.usesLogin(p.session));
      }
      if (adapter === "desktop") {
        const target = p.target as Record<string, unknown> | undefined;
        const win = target?.window as Record<string, unknown> | undefined;
        const name = literal(win?.title) ?? literal(win?.process);
        if (name) add(t.manual.usesApp(name));
      }
      for (const key of ["path", "file", "workbook", "document", "source"]) {
        const value = literal(p[key]);
        if (value && /\.(xlsx|xlsm|xls|csv|docx|doc|pdf|txt)$/i.test(value) && (adapter === "excel" || adapter === "word" || adapter === "file" || adapter === "pdf")) {
          add(t.manual.usesFile(value.split(/[\\/]/).pop() ?? value));
        }
      }
      if (adapter === "mail") add(t.manual.usesMail);
      for (const value of Object.values(p)) {
        const secret = secretName(value);
        if (secret) add(t.manual.usesLogin(secret));
      }
      if (step.type === CALL) {
        const id = String(p.flow ?? "");
        const called = subflows.get(id);
        if (called && !seen.has(id)) walk(called.steps ?? [], new Set([...seen, id]));
      }
      for (const block of Object.values(step.blocks ?? {})) walk(block, seen);
    }
  };
  walk(flow.steps ?? [], new Set([flow.id]));
  return found;
}

const varText = (v: VariableDef) => v.description?.trim() || v.name;

/** The 手順書 of `flow`, with the pictures of `manifest` when there is one. */
export function buildManual(
  flow: Flow,
  defs: ReadonlyMap<string, StepTypeDef>,
  manifest: ManualManifest | null,
  subflows: ReadonlyMap<string, Flow> = new Map(),
  masks: Readonly<Record<string, Mask>> = {},
  drafts: Drafts = {},
): ManualDoc {
  const shots = new Map((manifest?.shots ?? []).filter((s) => !masks[s.key]?.hidden).map((s) => [s.key, s] as const));
  // A picture the person left out still counts as taken.
  const hidden = new Set((manifest?.shots ?? []).filter((s) => masks[s.key]?.hidden).map((s) => s.key));
  const missing = { n: 0 };
  const base: Omit<Ctx, "next"> = {
    defs,
    shots,
    counts: manifest?.counts ?? null,
    subflows,
    flowId: flow.id ?? "",
    drafts,
    hidden: new Set(Object.entries(masks).flatMap(([k, m]) => (m.hidden ? [k] : []))),
    words: varWords(flow.variables ?? []),
    missing,
    depth: 0,
  };
  const parts = chapterParts(flow.steps ?? []);
  const chapters: Chapter[] = [];
  let parallelSet: number[] = [];
  for (const part of parts) {
    if (part.steps.length === 0) {
      for (const n of parallelSet) {
        const chapter = chapters.find((c) => c.number === n);
        if (chapter) chapter.alongside = parallelSet.filter((m) => m !== n);
      }
      parallelSet = [];
      continue;
    }
    const ctx: Ctx = { ...base, next: { n: 0 } };
    // A chapter that is one group (and some quiet work) reads as the group itself.
    const main = part.steps.filter((s) => !QUIET.has(s.type));
    const steps =
      main.length === 1 && main[0]?.type === GROUP
        ? part.steps.flatMap((s) => (s.type === GROUP ? Object.values(s.blocks ?? {}).flat() : [s]))
        : part.steps;
    const list = items(steps, [], ctx);
    if (list.length === 0) continue;
    const number = chapters.length + 1;
    if (part.parallel) parallelSet.push(number);
    chapters.push({ number, title: chapterTitle(part.steps, ctx), alongside: [], items: list, ...countScreens(list) });
  }
  const pictures = chapters.reduce((n, c) => n + countPictures(c.items), 0);
  const vars = flow.variables ?? [];
  return {
    title: flow.name,
    description: flow.description ?? "",
    uses: uses(flow, subflows),
    inputs: vars.filter((v) => v.direction === "input" || v.direction === "inOut").map(varText),
    outputs: vars.filter((v) => v.direction === "output" || v.direction === "inOut").map(varText),
    chapters,
    pictures,
    drafts: chapters.reduce((n, c) => n + countPictures(c.items, true), 0),
    missing: Math.max(0, missing.n - hidden.size),
  };
}

function countPictures(list: ManualItem[], drafts = false): number {
  return list.reduce(
    (n, item) =>
      n + (item.kind === "scene" && item.shot && (!drafts || item.shot.draft) ? 1 : 0) + ("items" in item ? countPictures(item.items, drafts) : 0),
    0,
  );
}

/**
 * The values to blur on a picture (`regions`), less what the steps operate:
 * a button inside a table cell must stay readable, or the reader cannot see
 * what is pressed. A region that is the marked element itself (an input
 * field) stays blurred; a larger region around a mark is cut into the parts
 * around it.
 */
export function blurRegions(regions: Rect[] | undefined, marks: Rect[]): Rect[] {
  const area = (r: Rect) => r.width * r.height;
  const inside = (m: Rect, r: Rect) => m.x >= r.x - 2 && m.y >= r.y - 2 && m.x + m.width <= r.x + r.width + 2 && m.y + m.height <= r.y + r.height + 2;
  return (regions ?? []).flatMap((r) => {
    const m = marks.find((mark) => inside(mark, r) && area(mark) < area(r) * 0.7);
    if (!m) return [r];
    const top = Math.max(r.y, m.y);
    const bottom = Math.min(r.y + r.height, m.y + m.height);
    const parts: Rect[] = [
      { x: r.x, y: r.y, width: r.width, height: top - r.y },
      { x: r.x, y: bottom, width: r.width, height: r.y + r.height - bottom },
      { x: r.x, y: top, width: Math.max(r.x, m.x) - r.x, height: bottom - top },
      { x: Math.min(r.x + r.width, m.x + m.width), y: top, width: r.x + r.width - Math.min(r.x + r.width, m.x + m.width), height: bottom - top },
    ];
    return parts.filter((p) => p.width > 0 && p.height > 0);
  });
}

/**
 * The part of a picture to show: around the marked elements, wide enough
 * to see where they are, the whole picture when nothing is marked.
 */
export function cropOf(width: number, height: number, marks: Rect[]): Rect {
  if (marks.length === 0) return { x: 0, y: 0, width, height };
  let x0 = Math.min(...marks.map((m) => m.x)) - 80;
  let y0 = Math.min(...marks.map((m) => m.y)) - 70;
  let x1 = Math.max(...marks.map((m) => m.x + m.width)) + 60;
  let y1 = Math.max(...marks.map((m) => m.y + m.height)) + 60;
  const minWidth = Math.min(width, Math.max(640, width * 0.55));
  if (x1 - x0 < minWidth) {
    const c = (x0 + x1) / 2;
    x0 = c - minWidth / 2;
    x1 = c + minWidth / 2;
  }
  const minHeight = Math.min(height, (x1 - x0) * 0.45);
  if (y1 - y0 < minHeight) {
    const c = (y0 + y1) / 2;
    y0 = c - minHeight / 2;
    y1 = c + minHeight / 2;
  }
  const shift = (a: number, b: number, max: number): [number, number] => {
    if (a < 0) [a, b] = [0, b - a];
    if (b > max) [a, b] = [Math.max(0, a - (b - max)), max];
    return [a, b];
  };
  [x0, x1] = shift(x0, x1, width);
  [y0, y1] = shift(y0, y1, height);
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

/** Whether boxes drawn on a picture of another size may no longer fit. */
export const maskStale = (mask: Mask | undefined, shot: ManualShot): boolean =>
  !!mask && mask.boxes.length > 0 && (mask.width !== shot.width || mask.height !== shot.height);

/** A container (branch, loop, group) said as a heading on the page. */
export type Container = Extract<ManualItem, { kind: "branch" | "loop" | "group" }>;
export type Leaf = Exclude<ManualItem, Container>;

/** One thing on a page, at its depth inside branches and loops. */
export type PageBlock =
  | { kind: "item"; item: Leaf; depth: number }
  /** `continued`: the container started on an earlier page. */
  | { kind: "label"; item: Container; depth: number; continued: boolean };

/** One sheet of the 手順書. */
export type Page =
  | { kind: "cover"; number: number }
  | {
      kind: "body";
      number: number;
      chapter: Chapter;
      /** The chapter starts on this page (its heading is drawn). */
      first: boolean;
      blocks: PageBlock[];
      /** For the list of pages: the screen on it, else the chapter. */
      title: string;
      shot: ManualShot | null;
    };

const isContainer = (item: ManualItem): item is Container => item.kind === "branch" || item.kind === "loop" || item.kind === "group";

/** Where a scene's picture is marked: its numbered operations and what it waits for. */
export const sceneRects = (scene: Scene): Rect[] => [
  ...scene.steps.flatMap((s) => (s.mark ? [s.mark] : [])),
  ...scene.waits.flatMap((w) => (w.mark ? [w.mark] : [])),
];

/*
 * How tall things are on an A4 sheet (794 × 1123 CSS px), roughly, to put
 * as much on a sheet as fits. The sheet's own CSS keeps what is drawn there;
 * these only decide where a new sheet starts.
 */
const ROOM = 930;
const WIDTH = 698;
const FRAME_INSET = 30;
const HEIGHT = { heading: 92, continued: 34, label: 58, caption: 32, step: 62, note: 66, wait: 58, quiet: 34, gap: 22 };
const PICTURE_MAX = 567;

function stepHeight(step: ManualStep): number {
  return HEIGHT.step + (step.note ? HEIGHT.note : 0);
}

function blockHeight(block: PageBlock, pictures: boolean): number {
  if (block.kind === "label") return HEIGHT.label;
  const item = block.item;
  if (item.kind === "quiet") return HEIGHT.quiet;
  if (item.kind === "action") return stepHeight(item.step) + (item.step.login ? HEIGHT.note : 0);
  let h = HEIGHT.caption + HEIGHT.gap;
  if (pictures && item.shot) {
    const crop = cropOf(item.shot.width, item.shot.height, sceneRects(item));
    const width = WIDTH - block.depth * FRAME_INSET;
    h += Math.min(PICTURE_MAX, (width * crop.height) / Math.max(1, crop.width));
  }
  h += item.steps.reduce((n, step) => n + stepHeight(step), 0) + item.waits.length * HEIGHT.wait;
  if (item.steps.some((step) => step.login)) h += HEIGHT.note;
  return h;
}

/**
 * The 手順書 as sheets: a cover (what the flow does, contents, revisions),
 * then each chapter from a new sheet. A sheet takes screens until the next
 * one would not fit; a screen is never cut, and a heading is never left at
 * the foot of a sheet without what comes under it. A branch or loop that
 * goes on over a sheet is named again at the top of the next one.
 * `pictures: false` lays out the words-only export.
 */
export function pagesOf(doc: ManualDoc, pictures = true): Page[] {
  const pages: Page[] = [{ kind: "cover", number: 1 }];
  for (const chapter of doc.chapters) {
    const flat: { block: PageBlock; open: { item: Container; depth: number }[] }[] = [];
    const walk = (items: ManualItem[], depth: number, open: { item: Container; depth: number }[]) => {
      for (const item of items) {
        if (isContainer(item)) {
          flat.push({ block: { kind: "label", item, depth, continued: false }, open });
          walk(item.items, depth + 1, [...open, { item, depth }]);
        } else {
          flat.push({ block: { kind: "item", item, depth }, open });
        }
      }
    };
    walk(chapter.items, 0, []);
    let used = 0;
    let filled = false;
    const start = (first: boolean, open: { item: Container; depth: number }[]) => {
      const page: Extract<Page, { kind: "body" }> = {
        kind: "body",
        number: pages.length + 1,
        chapter,
        first,
        blocks: open.map((o) => ({ kind: "label", item: o.item, depth: o.depth, continued: true })),
        title: chapter.title,
        shot: null,
      };
      pages.push(page);
      used = (first ? HEIGHT.heading : HEIGHT.continued) + open.length * HEIGHT.label;
      filled = false;
      return page;
    };
    let current = start(true, []);
    flat.forEach(({ block, open }, i) => {
      const h = blockHeight(block, pictures);
      // A heading goes with the first thing under it.
      const next = flat[i + 1];
      const need = h + (block.kind === "label" && next ? blockHeight(next.block, pictures) : 0);
      if (filled && used + need > ROOM) current = start(false, open);
      current.blocks.push(block);
      used += h;
      if (block.kind === "item") filled = true;
      const shot = pictures && block.kind === "item" && block.item.kind === "scene" ? block.item.shot : null;
      if (shot && !current.shot && block.kind === "item" && block.item.kind === "scene") {
        current.shot = shot;
        current.title = block.item.title ?? chapter.title;
      }
    });
  }
  return pages;
}

/** A page's blocks as frames: each branch, loop or group holds what is inside it on that page. */
export type PageNode =
  | { kind: "frame"; label: Extract<PageBlock, { kind: "label" }>; children: PageNode[] }
  | { kind: "item"; block: Extract<PageBlock, { kind: "item" }> };

export function frameTree(blocks: PageBlock[]): PageNode[] {
  const root: PageNode[] = [];
  const stack: Extract<PageNode, { kind: "frame" }>[] = [];
  for (const block of blocks) {
    while (stack.length > 0 && (stack.at(-1)?.label.depth ?? -1) >= block.depth) stack.pop();
    const into = stack.at(-1)?.children ?? root;
    if (block.kind === "label") {
      const frame: Extract<PageNode, { kind: "frame" }> = { kind: "frame", label: block, children: [] };
      into.push(frame);
      stack.push(frame);
    } else {
      into.push({ kind: "item", block });
    }
  }
  return root;
}

/** What the cover says about the version: from the published version and the saved versions. */
export type Edition = {
  /** 「第 3 版」, or 「確定前」. */
  label: string;
  /** The day it was published, as words. */
  updated: string | null;
  /** The published version, when the flow has changed since it. */
  changedSince: number | null;
  /** Saved versions, newest first. */
  revisions: { label: string; date: string; text: string }[];
};

/** The cover's version: the published one (第 n 版) and the saved versions as the revision history. */
export function editionOf(published: PublishedState | null, versions: VersionSummary[], date: (iso: string) => string): Edition {
  return {
    label: published ? t.manual.editionOf(published.version) : t.manual.unpublished,
    updated: published ? date(published.publishedAt) : null,
    changedSince: published && !published.matchesCurrent ? published.version : null,
    revisions: [...versions]
      .sort((a, b) => b.number - a.number)
      .slice(0, 12)
      .map((v) => ({
        label: t.manual.editionOf(v.number),
        date: date(v.createdAt),
        // A version named only by its number (v3) has nothing more to say.
        text: v.note?.trim() || (/^v\d+$/.test(v.name.trim()) ? "" : v.name.trim()),
      })),
  };
}
