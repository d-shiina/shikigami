import { Clock, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { blockName, stepLabel, t } from "../lib/i18n";
import {
  FREQUENT,
  frequent,
  groupLabel,
  groups,
  loadRecent,
  type PaletteItem,
  paletteItems,
  remember,
  search,
  sectionOf,
} from "../lib/palette";
import { insertPlace } from "../store";

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

/** A list entry: an item, or a heading inside the list (frequent view). */
type Row = { item: PaletteItem } | { heading: string };

/**
 * Ctrl+K, the dock's "ノード追加", a "+" on the flow chart or an empty block:
 * summon a node by typing what you want instead of hunting a toolbox. It
 * opens on the nodes used most; the groups on the left follow what the
 * scenario works on (browser, Excel, files…); typing searches all of them,
 * best match first. The bottom line says where the node will go.
 */
export function CommandPalette() {
  const open = useStudio((s) => s.paletteOpen);
  const setOpen = useStudio((s) => s.setPaletteOpen);
  const stepTypes = useStudio((s) => s.stepTypes);
  const scenario = useStudio((s) => s.scenario);
  const selection = useStudio((s) => s.selection);
  const at = useStudio((s) => s.paletteAt);
  const addStep = useStudio((s) => s.addStep);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState(FREQUENT);
  const [recent, setRecent] = useState(loadRecent);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const items = useMemo(() => paletteItems(stepTypes), [stepTypes]);
  const all = useMemo(() => groups(items), [items]);
  const found = useMemo(() => (query.trim() ? search(items, query, recent) : null), [items, query, recent]);
  const nav: [string, number][] = useMemo(() => {
    if (!found) return all;
    const counts = new Map<string, number>();
    for (const i of found) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
    return all.map(([g]) => [g, counts.get(g) ?? 0]);
  }, [all, found]);
  const current = group === FREQUENT || all.some(([g]) => g === group) ? group : FREQUENT;
  const rows: Row[] = useMemo(() => {
    if (found) return found.map((item) => ({ item }));
    if (current !== FREQUENT) return items.filter((i) => i.group === current).map((item) => ({ item }));
    const view = frequent(items, recent);
    return [
      ...(view.recent.length > 0 ? [{ heading: t.palette.recent }, ...view.recent.map((item) => ({ item }))] : []),
      ...(view.common.length > 0 ? [{ heading: t.palette.common }, ...view.common.map((item) => ({ item }))] : []),
    ];
  }, [found, current, items, recent]);
  const choices = rows.flatMap((r) => ("item" in r ? [r.item] : []));
  /** Group tags help where groups mix: "クリック" is in the browser and in desktop apps. */
  const tagged = Boolean(found) || current === FREQUENT;

  useEffect(() => {
    if (open) {
      setQuery("");
      setGroup(FREQUENT);
      setRecent(loadRecent());
      setActive(0);
      input.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    setRecent(remember(recent, item.key));
    setOpen(false);
    void addStep(item.type, item.params, item.name);
  };
  const pick = (next: string) => {
    setQuery("");
    setGroup(next);
    setActive(0);
    input.current?.focus();
  };
  const order = [FREQUENT, ...all.map(([g]) => g)];
  const shiftGroup = (delta: number) => {
    const i = order.indexOf(current);
    pick(order[(i + delta + order.length) % order.length] ?? FREQUENT);
  };

  const where = (() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d]));
    const place = insertPlace(scenario?.steps ?? [], selection, at);
    const name = (step: { name?: string | null; type: string }) => step.name || stepLabel(step.type, defs.get(step.type)?.label);
    if (place.before) return t.palette.before(name(place.before));
    if (place.after) return t.palette.after(name(place.after));
    if (place.into) {
      const def = defs.get(place.into.parent.type);
      const label = def?.blocks?.find((b) => b.name === place.into!.block)?.label ?? place.into.block;
      return t.palette.into(name(place.into.parent), blockName(place.into.parent.type, place.into.block, label));
    }
    return t.palette.atEnd;
  })();

  let index = -1;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-[10vh] backdrop-blur-[1px]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label={t.addStep}
        className="flex h-[min(620px,78vh)] w-[min(800px,92vw)] flex-col overflow-hidden rounded-[4px] border border-slate-300 bg-sheet shadow-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-3">
          <Search size={18} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") setOpen(false);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, choices.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (!query && (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Tab")) {
                e.preventDefault();
                shiftGroup(e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(choices[active]);
              }
            }}
            placeholder={t.palette.placeholder}
            aria-label={t.palette.placeholder}
            className="flex-1 bg-transparent text-base outline-none placeholder:text-slate-400"
          />
          <kbd className="rounded-[2px] border border-slate-300 px-1 text-[10px] text-slate-500">Esc</kbd>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="w-[200px] shrink-0 overflow-y-auto border-r border-slate-200 bg-paper p-2">
            <NavButton on={!found && current === FREQUENT} onClick={() => pick(FREQUENT)}>
              <Clock size={14} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
              <span className="flex-1 truncate">{t.palette.frequent}</span>
            </NavButton>
            {nav.map(([g, count], i) => {
              const section = sectionOf(g);
              const heading = section !== sectionOf(nav[i - 1]?.[0] ?? "") || i === 0;
              return (
                <Fragment key={g}>
                  {heading && <div className="px-2.5 pt-3 pb-1 text-[11px] font-bold text-slate-500">{t.palette.sections[section]}</div>}
                  <NavButton on={!found && g === current} dim={Boolean(found) && count === 0} onClick={() => pick(g)}>
                    <span className="h-3.5 w-1 shrink-0 rounded-[1px]" style={{ background: color(g) }} />
                    <span className="flex-1 truncate">{groupLabel(g)}</span>
                    <span className="text-[11px] text-slate-500">{count}</span>
                  </NavButton>
                </Fragment>
              );
            })}
          </nav>
          <ul ref={list} className="min-w-0 flex-1 overflow-y-auto p-2" aria-label={t.addStep}>
            {choices.length === 0 && <li className="px-3 py-4 text-sm text-slate-500">{t.palette.empty(query)}</li>}
            {rows.map((row) => {
              if ("heading" in row) {
                return (
                  <li key={`h:${row.heading}`} className="px-3 pt-2 pb-1 text-[11px] font-bold text-slate-500">
                    {row.heading}
                  </li>
                );
              }
              const item = row.item;
              const i = ++index;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    data-index={i}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => choose(item)}
                    className={`flex w-full items-center gap-3 rounded-[3px] px-3 py-2 text-left ${i === active ? "bg-slate-100" : ""}`}
                  >
                    <span className="h-8 w-1 shrink-0 rounded-[1px]" style={{ background: color(item.group) }} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5 text-sm font-medium text-ink">
                        <span className="truncate">{item.label}</span>
                        {item.keyword && <span className="font-mono text-[11px] font-normal text-slate-500">{item.keyword}</span>}
                      </span>
                      <span className="block truncate text-xs text-slate-500">{item.summary}</span>
                    </span>
                    {tagged && (
                      <span className="shrink-0 rounded-[2px] border border-slate-200 px-1.5 text-[11px] leading-[18px] text-slate-600">
                        {groupLabel(item.group)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex items-center gap-3 border-t border-slate-200 bg-paper px-4 py-2 text-[11px] text-slate-600">
          <span className="min-w-0 truncate">
            <span className="text-slate-500">{t.palette.where}</span>
            <span className="ml-1.5 font-medium text-ink">{where}</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3 text-slate-500">
            <span>
              <kbd className="rounded-[2px] bg-slate-100 px-1">↑↓</kbd> {t.palette.choose}
            </span>
            <span>
              <kbd className="rounded-[2px] bg-slate-100 px-1">Enter</kbd> {t.palette.add}
            </span>
            {!query && (
              <span>
                <kbd className="rounded-[2px] bg-slate-100 px-1">←→</kbd> {t.palette.group}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function NavButton({ on, dim, onClick, children }: { on: boolean; dim?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on || undefined}
      className={`flex w-full items-center gap-2 rounded-[3px] px-2.5 py-1.5 text-left text-[13px] ${
        on ? "bg-sheet font-semibold text-ink shadow-sheet" : dim ? "text-slate-400 hover:bg-slate-100" : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}
