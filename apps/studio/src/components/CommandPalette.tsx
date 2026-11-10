import type { Step, StepTypeDef } from "@spellsheet/schema";
import { MessageSquareText, Plus, Search, Sparkles } from "lucide-react";
import { useAgentApi } from "../agent";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { blockName, stepLabel, t } from "../lib/i18n";
import { paramLabel } from "../lib/nodeRows";
import { bySection, frequentBySection, groupLabel, groups, loadRecent, nextAfter, type PaletteItem, paletteItems, remember, search, sectionOf } from "../lib/palette";
import { groupIcon, nodeIcon } from "../lib/nodeIcons";
import { insertPlace, type PaletteAnchor } from "../store";

/** Category colour, taken from the logo swirl. Used for node stripes too. */
export const CATEGORY_COLOR: Record<string, string> = {
  control: "var(--cat-control)",
  // A call is a control step underneath.
  subflow: "var(--cat-control)",
  variable: "var(--cat-variable)",
  log: "var(--cat-log)",
  flow: "var(--cat-flow)",
  browser: "var(--cat-browser)",
  windows: "var(--cat-windows)",
  office: "var(--cat-office)",
  excel: "var(--cat-office)",
  word: "var(--cat-office)",
  outlook: "var(--cat-office)",
  file: "var(--cat-file)",
  network: "var(--cat-browser)",
  database: "var(--cat-file)",
  system: "var(--cat-windows)",
  // Presets are "変数への代入" steps underneath, so they share its colour.
  text: "var(--cat-variable)",
  number: "var(--cat-variable)",
  date: "var(--cat-variable)",
  list: "var(--cat-variable)",
  other: "var(--cat-other)",
};

const color = (group: string) => CATEGORY_COLOR[group] ?? CATEGORY_COLOR.other;

/** A node's or group's icon on a tint of its colour. */
function Tile({ icon: Icon, group, size }: { icon: React.ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>; group: string; size: number }) {
  const c = color(group);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg"
      style={{ width: size, height: size, color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }}
    >
      <Icon size={Math.round(size * 0.55)} strokeWidth={1.9} aria-hidden={true} />
    </span>
  );
}

const WIDTH = 712;
const HEIGHT = 540;
const MARGIN = 12;
/** Shorter than this, the popover goes beside what it was opened from instead. */
const MIN_HEIGHT = 320;

/** A line of the list: a node, the "ask the AI" line, or a heading. */
/** `compact`: a short tile, two to a line (the flow-control nodes of the opening view, so they show without scrolling). */
type Row = { item: PaletteItem; tagged: boolean; compact?: boolean } | { ask: string } | { heading: string };
type Choice = Exclude<Row, { heading: string }>;

/**
 * Where the popover goes: below what it was opened from, or above it (as
 * from the dock), whichever has room, shortened to fit; beside it when
 * neither does. Never over it, so the place it adds to stays visible.
 * Opened from nothing: near the top of the window.
 */
type Spot = { left: number; top?: number; bottom?: number; height: number };

function place(anchor: PaletteAnchor | null): Spot {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fit = (room: number) => Math.min(HEIGHT, room);
  if (!anchor) return { left: Math.max(MARGIN, (vw - WIDTH) / 2), top: Math.max(MARGIN, Math.min(96, vh - HEIGHT - MARGIN)), height: fit(vh - 2 * MARGIN) };
  const left = Math.min(Math.max(MARGIN, anchor.left), vw - WIDTH - MARGIN);
  const below = vh - MARGIN - (anchor.bottom + 8);
  const above = anchor.top - 8 - MARGIN;
  if (below >= Math.min(HEIGHT, MIN_HEIGHT) && (below >= HEIGHT || below >= above)) return { left, top: anchor.bottom + 8, height: fit(below) };
  // Above: held by its bottom edge, so a short list still sits right over the anchor.
  if (above >= MIN_HEIGHT) return { left, bottom: vh - (anchor.top - 8), height: fit(above) };
  const height = fit(vh - 2 * MARGIN);
  const side = anchor.right + 8 + WIDTH <= vw - MARGIN ? anchor.right + 8 : Math.max(MARGIN, anchor.left - 8 - WIDTH);
  return { left: side, top: Math.min(Math.max(MARGIN, anchor.top), vh - MARGIN - height), height };
}

/** The selected node on the chart when it is on screen, else the "＋ ノード追加" of an empty flow (Ctrl+K opens beside it). */
function selectedAnchor(id: string | undefined): PaletteAnchor | null {
  const el = id ? document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) : document.querySelector("[data-add-first]");
  const box = el?.getBoundingClientRect();
  if (!box || box.bottom < 0 || box.top > window.innerHeight || box.right < 0 || box.left > window.innerWidth) return null;
  return box;
}

/** The step the end of the flow follows. */
const lastOf = (steps: readonly Step[]): Step | undefined => steps.at(-1);

/**
 * Adding a node: a popover beside the "+", the empty block, the node or the
 * dock it was opened from (Ctrl+K: beside the selected node), so the chart
 * and the place the node goes stay in view. The groups stay listed on the
 * left (like the activity tree of other RPA tools), the nodes of the chosen
 * one on the right under headings by what they are for, and the line under
 * the list says what the highlighted node does, what it needs and what it
 * gives. Typing searches every node, best match first; a group on the left
 * then narrows the results.
 */
export function CommandPalette() {
  const open = useStudio((s) => s.paletteOpen);
  const setOpen = useStudio((s) => s.setPaletteOpen);
  const stepTypes = useStudio((s) => s.stepTypes);
  const flow = useStudio((s) => s.flow);
  const selection = useStudio((s) => s.selection);
  const at = useStudio((s) => s.paletteAt);
  const anchor = useStudio((s) => s.paletteAnchor);
  const addStep = useStudio((s) => s.addStep);
  const setPlace = useStudio((s) => s.setPlace);
  const summaries = useStudio((s) => s.summaries);
  const agent = useAgentApi();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [recent, setRecent] = useState(loadRecent);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Spot>({ left: 0, top: 0, height: HEIGHT });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d])), [stepTypes]);
  const items = useMemo(() => paletteItems(stepTypes, summaries, flow?.id), [stepTypes, summaries, flow?.id]);
  const all = useMemo(() => groups(items), [items]);
  const spot = useMemo(() => insertPlace(flow?.steps ?? [], selection, at), [flow?.steps, selection, at]);
  const name = (step: { name?: string | null; type: string }) => step.name || stepLabel(step.type, defs.get(step.type)?.label);
  // What the new node follows: the step before it, or the block it goes into.
  const follows: { key: string; label: string } | undefined = (() => {
    const prev = spot.after ?? spot.prev ?? (!spot.before && !spot.into && !at && !selection ? lastOf(flow?.steps ?? []) : undefined);
    if (prev) return { key: prev.type, label: name(prev) };
    if (spot.into) return { key: `${spot.into.parent.type}:${spot.into.block}`, label: name(spot.into.parent) };
    return undefined;
  })();
  const found = useMemo(() => (query.trim() ? search(items, query, recent) : []), [items, query, recent]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const i of query.trim() ? found : items) c.set(i.group, (c.get(i.group) ?? 0) + 1);
    return c;
  }, [found, items, query]);

  const rows: Row[] = useMemo(() => {
    if (query.trim()) {
      // What no node does by name, the AI can be asked to build: the last choice, always there.
      if (group) return [...found.filter((i) => i.group === group).map((item) => ({ item, tagged: false })), { ask: query.trim() }];
      // Operations, the flow's own control and data handling under their own headings, never one mixed list.
      const out: Row[] = [];
      for (const [section, hits] of bySection(found)) out.push({ heading: t.palette.sections[section] ?? section }, ...hits.map((item) => ({ item, tagged: true })));
      return [...out, { ask: query.trim() }];
    }
    if (group) {
      const out: Row[] = [];
      let sub: string | undefined;
      for (const item of items.filter((i) => i.group === group)) {
        if (item.sub && item.sub !== sub) out.push({ heading: t.palette.subs[item.sub] ?? item.sub });
        sub = item.sub;
        out.push({ item, tagged: false });
      }
      return out;
    }
    const out: Row[] = [];
    const next = nextAfter(items, follows?.key);
    if (next.length > 0 && follows) out.push({ heading: t.palette.next(follows.label) }, ...next.map((item) => ({ item, tagged: true })));
    for (const [section, list] of frequentBySection(items, recent, new Set(next.map((i) => i.key)))) {
      out.push({ heading: t.palette.frequentHeads[section] ?? section }, ...list.map((item) => ({ item, tagged: section === "apps", compact: section !== "apps" })));
    }
    return out;
    // `follows` is derived from the place, which these cover.
  }, [items, found, query, group, recent, follows?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const choices = rows.filter((r): r is Choice => !("heading" in r));
  const rail: (string | null)[] = [null, ...all.map(([g]) => g)];

  useLayoutEffect(() => {
    if (!open) return;
    setPos(place(anchor ?? selectedAnchor(selection?.kind === "step" ? selection.stepId : undefined)));
    // Placed once per opening: adding moves the selection, but the popover is gone by then.
  }, [open, anchor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) {
      setQuery("");
      setGroup(null);
      setRecent(loadRecent());
      setActive(0);
      input.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    setActive(0);
    list.current?.scrollTo({ top: 0 });
  }, [query, group]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const choose = (choice: Choice | undefined) => {
    if (!choice) return;
    if ("ask" in choice) {
      // Handed to the AI chat as a draft, with the selected node as context: the person sends it.
      const a = agent.getState();
      a.setOpen(true);
      a.setDraft(a.current, choice.ask);
      setOpen(false);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-agent-input]")?.focus());
      return;
    }
    const item = choice.item;
    setRecent(remember(recent, item.key));
    // addStep reads where to add (the "+" it was opened from) before it awaits; closing clears that place.
    void addStep(item.type, item.params, item.name);
    setOpen(false);
  };
  const pick = (g: string | null) => {
    setGroup(g);
    input.current?.focus();
  };
  const step = (by: number) => {
    const at = rail.indexOf(group);
    pick(rail[Math.min(Math.max(at + by, 0), rail.length - 1)] ?? null);
  };

  const where = (() => {
    if (spot.before) return t.palette.before(name(spot.before));
    if (spot.after) return t.palette.after(name(spot.after));
    if (spot.into) {
      const def = defs.get(spot.into.parent.type);
      const label = def?.blocks?.find((b) => b.name === spot.into!.block)?.label ?? spot.into.block;
      return t.palette.into(name(spot.into.parent), blockName(spot.into.parent.type, spot.into.block, label));
    }
    return t.palette.atEnd;
  })();

  const current = choices[active];
  const searching = Boolean(query.trim());
  let index = -1;
  let section = "";
  return (
    // No dimming: the chart and the place the node goes stay in view. A click outside closes.
    <div className="fixed inset-0 z-50" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-label={t.addStep}
        style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: WIDTH, height: pos.height }}
        className="absolute flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-lifted"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-slate-200 px-3.5">
          <Search size={17} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              // A new search looks through every node; a group on the left can narrow it afterwards.
              if (!query.trim() && e.target.value.trim()) setGroup(null);
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") {
                if (query) setQuery("");
                else setOpen(false);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, choices.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (!query && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
                e.preventDefault();
                step(e.key === "ArrowRight" ? 1 : -1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(current);
              }
            }}
            placeholder={t.palette.placeholder}
            aria-label={t.palette.placeholder}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-slate-400"
          />
        </div>
        <div className="flex min-h-0 flex-1">
          <nav aria-label={t.palette.group} className="w-[208px] shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50/60 px-1.5 py-1.5">
            {rail.map((g) => {
              const on = g === group;
              const count = g === null ? (searching ? found.length : undefined) : counts.get(g) ?? 0;
              const s = g === null ? "" : sectionOf(g);
              const heading = g !== null && s !== section ? (t.palette.sections[s] ?? s) : null;
              if (g !== null) section = s;
              const empty = searching && count === 0;
              return (
                <div key={g ?? "*"}>
                  {heading && <div className="px-2 pt-2.5 pb-0.5 text-[11px] font-semibold tracking-wide text-slate-500">{heading}</div>}
                  <button
                    type="button"
                    aria-current={on || undefined}
                    disabled={empty}
                    onClick={() => pick(g)}
                    className={`flex h-[26px] w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] ${on ? "bg-sheet font-semibold text-ink shadow-sm ring-1 ring-slate-200" : "text-slate-700 hover:bg-slate-100"} ${empty ? "opacity-40" : ""}`}
                  >
                    {g === null ? (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-slate-500">
                        <Sparkles size={14} strokeWidth={1.9} aria-hidden={true} />
                      </span>
                    ) : (
                      <Tile icon={groupIcon(g)} group={g} size={20} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{g === null ? (searching ? t.palette.all : t.palette.frequent) : groupLabel(g)}</span>
                    {count !== undefined && <span className="text-[11px] font-normal text-slate-500 tabular-nums">{count}</span>}
                  </button>
                </div>
              );
            })}
            {/* Nodes this PC does not have yet: plugins, managed on their own page. */}
            <div className="sticky -bottom-1.5 mt-1.5 border-t border-slate-200 bg-slate-50 pt-1.5 pb-1.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPlace("extensions");
                }}
                className="flex h-[26px] w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-slate-500 hover:bg-slate-100 hover:text-ink"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <Plus size={14} strokeWidth={1.75} aria-hidden={true} />
                </span>
                <span className="min-w-0 flex-1 truncate">{t.extensions.addFromPalette}</span>
              </button>
            </div>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <ul ref={list} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5" aria-label={t.addStep}>
              {choices.length === 1 && "ask" in choices[0]! && <li className="px-3 pt-4 pb-2 text-sm text-slate-500">{t.palette.empty(query)}</li>}
              {rows.map((row) => {
                if ("heading" in row) {
                  return (
                    <li key={`h:${row.heading}`} className="px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-slate-500">
                      {row.heading}
                    </li>
                  );
                }
                const i = ++index;
                const on = i === active;
                const common = {
                  type: "button" as const,
                  "data-index": i,
                  onMouseMove: () => i !== active && setActive(i),
                  onClick: () => choose(row),
                };
                if ("ask" in row) {
                  return (
                    <li key="ask" className="mt-1 border-t border-slate-100 pt-1">
                      <button {...common} className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left ${on ? "bg-slate-100" : ""}`}>
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-slate-200 text-slate-500">
                          <MessageSquareText size={15} strokeWidth={1.75} aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] leading-5 font-semibold text-ink">{t.palette.askAi(row.ask)}</span>
                          <span className="block truncate text-xs leading-[18px] text-slate-500">{t.palette.askAiHint}</span>
                        </span>
                      </button>
                    </li>
                  );
                }
                const item = row.item;
                if (row.compact) {
                  return (
                    <li key={`${item.key}:${i}`} className="inline-block w-1/2 align-top">
                      <button {...common} title={item.summary} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left ${on ? "bg-slate-100" : ""}`}>
                        <Tile icon={nodeIcon(item.type, item.group)} group={item.group} size={24} />
                        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold text-ink">{item.label}</span>
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={`${item.key}:${i}`}>
                    <button {...common} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${on ? "bg-slate-100" : ""}`}>
                      <Tile icon={nodeIcon(item.type, item.group)} group={item.group} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] leading-5 font-semibold text-ink">{item.label}</span>
                        <span className="block truncate text-xs leading-[18px] text-slate-500">{item.summary}</span>
                      </span>
                      {row.tagged && <span className="shrink-0 rounded-sm bg-slate-100 px-1.5 text-[11px] leading-[18px] text-slate-600">{groupLabel(item.group)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {current && "item" in current && <Detail item={current.item} def={defs.get(current.item.type)} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-slate-200 px-3.5 py-2 text-[11px]">
          <span className="min-w-0 truncate">
            <span className="text-slate-500">{t.palette.where}</span>
            <span className="ml-1.5 font-medium text-ink">{where}</span>
          </span>
          <span className="ml-auto shrink-0 text-slate-500">{t.palette.hint}</span>
          <span className="shrink-0 text-slate-500">
            <kbd className="rounded-sm bg-slate-100 px-1">Enter</kbd> {t.palette.add}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The highlighted node, told in full: what it does (not cut short), the
 * settings it cannot do without, what it gives back and what goes inside
 * it, so choosing does not take adding it and opening it to find out.
 */
function Detail({ item, def }: { item: PaletteItem; def: StepTypeDef | undefined }) {
  const lines: [string, string][] = [];
  if (item.key.startsWith("preset:")) lines.push([t.palette.preset, t.palette.presetAs]);
  else if (item.key.startsWith("flow:")) {
    // The summary already is the shape when the flow has no description.
  } else if (def) {
    const schema = def.paramsSchema as { required?: string[] };
    const required = (schema.required ?? []).map((k) => paramLabel(k, def.type));
    if (def.blocks && def.blocks.length > 0) lines.push([t.palette.inside, def.blocks.map((b) => blockName(def.type, b.name, b.label)).join("・")]);
    else lines.push([t.palette.required, required.length > 0 ? required.join("・") : t.palette.noRequired]);
    if (def.hasOutput) lines.push([t.palette.output, t.palette.gives]);
  }
  return (
    <div className="h-[108px] shrink-0 overflow-hidden border-t border-slate-200 px-3.5 py-2" aria-live="polite">
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-semibold text-ink">{item.label}</span>
        <span className="shrink-0 text-[11px] text-slate-500">{groupLabel(item.group)}</span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs leading-[18px] text-slate-600">{item.summary}</p>
      {lines.map(([label, value]) => (
        <p key={label} className="mt-0.5 truncate text-[11px] leading-4 text-slate-500">
          <span className="mr-1.5 font-medium text-slate-600">{label}</span>
          {value}
        </p>
      ))}
    </div>
  );
}
