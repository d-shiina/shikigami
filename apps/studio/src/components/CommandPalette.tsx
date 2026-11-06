import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { blockName, stepLabel, t } from "../lib/i18n";
import { frequent, groupLabel, groups, loadRecent, type PaletteItem, paletteItems, remember, search, sectionOf } from "../lib/palette";
import { groupIcon, nodeIcon } from "../lib/nodeIcons";
import { insertPlace, type PaletteAnchor } from "../store";

/** Category colour, taken from the logo swirl. Used for node stripes too. */
export const CATEGORY_COLOR: Record<string, string> = {
  control: "var(--cat-control)",
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
  system: "var(--cat-windows)",
  // Presets are "変数に代入" steps underneath, so they share its colour.
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
      className="flex shrink-0 items-center justify-center rounded-[4px]"
      style={{ width: size, height: size, color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }}
    >
      <Icon size={Math.round(size * 0.55)} strokeWidth={1.9} aria-hidden={true} />
    </span>
  );
}

const WIDTH = 420;
const HEIGHT = 480;
const MARGIN = 12;
/** Shorter than this, the popover goes beside what it was opened from instead. */
const MIN_HEIGHT = 300;

/** A line of the list: a node, a group to open, or a heading. */
type Row = { item: PaletteItem; tagged: boolean } | { group: string; count: number } | { heading: string };
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

/** The selected node on the chart, when it is on screen (Ctrl+K opens beside it). */
function selectedAnchor(id: string | undefined): PaletteAnchor | null {
  if (!id) return null;
  const box = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  if (!box || box.bottom < 0 || box.top > window.innerHeight || box.right < 0 || box.left > window.innerWidth) return null;
  return box;
}

/**
 * Adding a node: a popover beside the "+", the empty block, the node or the
 * dock it was opened from (Ctrl+K: beside the selected node), so the chart
 * and the place the node goes stay in view. Typing searches every node, best
 * match first; without a query it shows the nodes used most, then the groups,
 * which open in place (← or Esc to go back).
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
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [recent, setRecent] = useState(loadRecent);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Spot>({ left: 0, top: 0, height: HEIGHT });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const items = useMemo(() => paletteItems(stepTypes), [stepTypes]);
  const all = useMemo(() => groups(items), [items]);
  const rows: Row[] = useMemo(() => {
    if (query.trim()) return search(items, query, recent).map((item) => ({ item, tagged: true }));
    if (group) return items.filter((i) => i.group === group).map((item) => ({ item, tagged: false }));
    const view = frequent(items, recent);
    const top = [...view.recent, ...view.common].slice(0, 6);
    const out: Row[] = [
      { heading: view.recent.length > 0 ? t.palette.recent : t.palette.common },
      ...top.map((item) => ({ item, tagged: true })),
    ];
    all.forEach(([g, count], i) => {
      const section = sectionOf(g);
      if (i === 0 || section !== sectionOf(all[i - 1]![0])) out.push({ heading: t.palette.sections[section] ?? section });
      out.push({ group: g, count });
    });
    return out;
  }, [items, all, query, group, recent]);
  const choices = rows.filter((r): r is Choice => !("heading" in r));

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
  }, [query, group]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const choose = (choice: Choice | undefined) => {
    if (!choice) return;
    if ("group" in choice) {
      setGroup(choice.group);
      input.current?.focus();
      return;
    }
    const item = choice.item;
    setRecent(remember(recent, item.key));
    // addStep reads where to add (the "+" it was opened from) before it awaits; closing clears that place.
    void addStep(item.type, item.params, item.name);
    setOpen(false);
  };
  const back = () => {
    setGroup(null);
    input.current?.focus();
  };

  const where = (() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d]));
    const spot = insertPlace(flow?.steps ?? [], selection, at);
    const name = (step: { name?: string | null; type: string }) => step.name || stepLabel(step.type, defs.get(step.type)?.label);
    if (spot.before) return t.palette.before(name(spot.before));
    if (spot.after) return t.palette.after(name(spot.after));
    if (spot.into) {
      const def = defs.get(spot.into.parent.type);
      const label = def?.blocks?.find((b) => b.name === spot.into!.block)?.label ?? spot.into.block;
      return t.palette.into(name(spot.into.parent), blockName(spot.into.parent.type, spot.into.block, label));
    }
    return t.palette.atEnd;
  })();

  let index = -1;
  return (
    // No dimming: the chart and the place the node goes stay in view. A click outside closes.
    <div className="fixed inset-0 z-50" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-label={t.addStep}
        style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: WIDTH, maxHeight: pos.height }}
        className="absolute flex flex-col overflow-hidden rounded-[4px] border border-slate-200 bg-sheet shadow-lifted"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-slate-200 px-3.5">
          {group && !query ? (
            <button
              type="button"
              onClick={back}
              title={t.palette.back}
              className="-ml-1 flex shrink-0 items-center gap-0.5 rounded-[3px] py-0.5 pr-1.5 pl-0.5 text-[13px] font-medium text-ink hover:bg-slate-100"
            >
              <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
              {groupLabel(group)}
            </button>
          ) : (
            <Search size={17} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
          )}
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              const current = choices[active];
              if (e.key === "Escape") {
                if (group && !query) back();
                else setOpen(false);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, choices.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (!query && e.key === "ArrowRight" && current && "group" in current) {
                e.preventDefault();
                choose(current);
              } else if (!query && group && (e.key === "ArrowLeft" || e.key === "Backspace")) {
                e.preventDefault();
                back();
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
        <ul ref={list} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5" aria-label={t.addStep}>
          {choices.length === 0 && <li className="px-3 py-4 text-sm text-slate-500">{t.palette.empty(query)}</li>}
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
            if ("group" in row) {
              return (
                <li key={`g:${row.group}`}>
                  <button {...common} className={`flex w-full items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-left text-[13px] ${on ? "bg-slate-100" : ""}`}>
                    <Tile icon={groupIcon(row.group)} group={row.group} size={24} />
                    <span className="flex-1 truncate font-medium text-ink">{groupLabel(row.group)}</span>
                    <span className="text-[11px] text-slate-500 tabular-nums">{row.count}</span>
                    <ChevronRight size={14} strokeWidth={1.75} className="text-slate-500" aria-hidden="true" />
                  </button>
                </li>
              );
            }
            const item = row.item;
            return (
              <li key={item.key}>
                <button {...common} className={`flex w-full items-center gap-3 rounded-[4px] px-2 py-2 text-left ${on ? "bg-slate-100" : ""}`}>
                  <Tile icon={nodeIcon(item.type, item.group)} group={item.group} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13px] leading-5 font-semibold text-ink">
                      <span className="truncate">{item.label}</span>
                      {item.keyword && <span className="rounded-[2px] bg-slate-100 px-1 font-mono text-[10px] leading-4 font-normal text-slate-600">{item.keyword}</span>}
                    </span>
                    <span className="block truncate text-xs leading-[18px] text-slate-500">{item.summary}</span>
                  </span>
                  {row.tagged && <span className="shrink-0 text-[11px] text-slate-500">{groupLabel(item.group)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-3.5 py-2 text-[11px]">
          <span className="min-w-0 truncate">
            <span className="text-slate-500">{t.palette.where}</span>
            <span className="ml-1.5 font-medium text-ink">{where}</span>
          </span>
          <span className="ml-auto shrink-0 text-slate-500">
            <kbd className="rounded-[2px] bg-slate-100 px-1">Enter</kbd> {t.palette.add}
          </span>
        </div>
      </div>
    </div>
  );
}
