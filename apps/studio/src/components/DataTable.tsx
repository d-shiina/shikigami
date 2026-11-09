// The data table of the list pages (flows, secrets, variables, schedules,
// extensions), one look and one way of working everywhere, as in Linear,
// Notion and the shadcn/TanStack tables:
// - a framed table whose header band stays in view while the page scrolls;
// - a column header sorts by it; its right edge drags to resize it;
// - the toolbar narrows the rows (SearchBox, FacetFilter) and the "表示"
//   menu (ViewMenu) picks the columns, the row height and a grouping;
// - check boxes pick rows (Shift picks a range, Ctrl a single one) for the
//   floating SelectionBar's bulk actions;
// - a footer says how many rows are shown and picked.
// What the viewer chose (sort, columns, widths, row height, grouping) is
// remembered per table under its storageKey.
import { ArrowDown, ArrowUp, Check as CheckIcon, ChevronDown, ChevronRight, ChevronsUpDown, MoreHorizontal, PlusCircle, Search, SlidersHorizontal, X } from "lucide-react";
import {
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type MenuSpec, openMenu } from "../lib/contextMenu";
import { t } from "../lib/i18n";

export type Column<T> = {
  id: string;
  header: string;
  /** Tailwind width class for the column, as `w-[120px]` (the columns without one share the rest). */
  width?: string;
  align?: "left" | "right";
  /** Sortable when given: the value the column sorts by. */
  sortValue?: (row: T) => string | number;
  /** Hidden when the page is narrower than this (container width, px). */
  hideBelow?: 600 | 720 | 860 | 1000;
  /** Whether the "表示" menu can hide it; the first column always stays. */
  hideable?: boolean;
  /** Hidden until the viewer turns it on in the "表示" menu. */
  hiddenByDefault?: boolean;
  /** The rows can be grouped by this column: each row's group, in `order`. */
  group?: (row: T) => { key: string; label: ReactNode; order?: number };
  cell: (row: T) => ReactNode;
};

export type Sort = { column: string; descending: boolean };
export type Density = "comfortable" | "compact";

type Saved = { sort?: Sort | null; hidden?: string[]; widths?: Record<string, number>; density?: Density; groupBy?: string | null };

const HIDE: Record<NonNullable<Column<unknown>["hideBelow"]>, string> = {
  600: "hidden @min-[600px]:table-cell",
  720: "hidden @min-[720px]:table-cell",
  860: "hidden @min-[860px]:table-cell",
  1000: "hidden @min-[1000px]:table-cell",
};

const MIN_WIDTH = 56;

function compare(a: string | number, b: string | number): number {
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "ja");
}

/** `w-[120px]` → 120, `w-[22%]` → "22%": the column's starting width, which a drag then changes. */
function widthOf(cls: string | undefined): number | string | undefined {
  const m = cls?.match(/w-\[(\d+(?:\.\d+)?)(px|%)\]/);
  if (!m) return undefined;
  return m[2] === "px" ? Number(m[1]) : `${m[1]}%`;
}

function readSaved(key: string | undefined): Saved {
  try {
    const raw = key ? globalThis.localStorage?.getItem(key) : null;
    if (!raw) return {};
    const value = JSON.parse(raw) as Saved & Partial<Sort>;
    // Before the view was kept, only the sort was saved, as the object itself.
    if (typeof value.column === "string") return { sort: { column: value.column, descending: !!value.descending } };
    return value;
  } catch {
    return {};
  }
}

/**
 * The viewer's way of seeing one table. Make it in the page when its toolbar
 * has a `ViewMenu`, and give it to both; a table without one keeps its own.
 */
export function useTableView<T>(columns: Column<T>[], { storageKey, initialSort }: { storageKey?: string; initialSort?: Sort } = {}) {
  const [saved, setSaved] = useState<Saved>(() => readSaved(storageKey));
  const update = useCallback(
    (change: (s: Saved) => Saved) =>
      setSaved((s) => {
        const next = change(s);
        try {
          if (storageKey) globalThis.localStorage?.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Only a remembered preference.
        }
        return next;
      }),
    [storageKey],
  );
  // The defaults only matter until the viewer picks one.
  const defaults = columns
    .filter((c) => c.hiddenByDefault)
    .map((c) => c.id)
    .join("\n");
  const hidden = useMemo(() => new Set(saved.hidden ?? (defaults ? defaults.split("\n") : [])), [saved.hidden, defaults]);
  return {
    columns,
    sort: saved.sort === undefined ? (initialSort ?? null) : saved.sort,
    setSort: (sort: Sort) => update((s) => ({ ...s, sort })),
    hidden,
    toggleColumn: (id: string) =>
      update((s) => {
        const next = new Set(hidden);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { ...s, hidden: [...next] };
      }),
    widths: saved.widths ?? {},
    setWidth: (id: string, px: number) => update((s) => ({ ...s, widths: { ...s.widths, [id]: Math.max(MIN_WIDTH, Math.round(px)) } })),
    resetWidth: (id: string) =>
      update((s) => {
        const { [id]: _, ...widths } = s.widths ?? {};
        return { ...s, widths };
      }),
    resetWidths: () => update((s) => ({ ...s, widths: {} })),
    density: saved.density ?? "comfortable",
    setDensity: (density: Density) => update((s) => ({ ...s, density })),
    groupBy: saved.groupBy && columns.some((c) => c.id === saved.groupBy && c.group) ? saved.groupBy : null,
    setGroupBy: (groupBy: string | null) => update((s) => ({ ...s, groupBy })),
  };
}

export type TableView<T> = ReturnType<typeof useTableView<T>>;

/** A check box that can also show "some selected". `onPick` gets the click, for Shift and Ctrl. */
function Check({ checked, mixed, label, onPick }: { checked: boolean; mixed?: boolean; label: string; onPick: (e: MouseEvent) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={() => {}}
      onClick={(e) => {
        e.stopPropagation();
        onPick(e);
      }}
      className="h-3.5 w-3.5 cursor-pointer rounded-sm align-middle accent-[var(--color-primary)]"
    />
  );
}

/** The drag handle on a header's right edge; double-click puts the width back. */
function Resizer({ th, onResize, onReset, label }: { th: () => HTMLElement | null; onResize: (px: number) => void; onReset: () => void; label: string }) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      onPointerDown={(e) => {
        const cell = th();
        if (!cell) return;
        e.preventDefault();
        e.stopPropagation();
        const start = e.clientX;
        const from = cell.getBoundingClientRect().width;
        const move = (ev: PointerEvent) => onResize(from + ev.clientX - start);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
        };
        document.body.style.cursor = "col-resize";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      className="group/resize absolute top-0 -right-1 z-10 flex h-full w-2 cursor-col-resize justify-center"
    >
      <span className="h-full w-px bg-transparent group-hover/resize:bg-brand-500" />
    </span>
  );
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onOpen,
  selected,
  onSelect,
  initialSort,
  storageKey,
  view,
  total,
  empty,
  rowActions,
  actionsWidth = 84,
  rowProps,
  canPick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  /** Keys of the picked rows; leave out for a table without check boxes. */
  selected?: Set<string>;
  onSelect?: (next: Set<string>) => void;
  initialSort?: Sort;
  /** Remembers the sort (and the rest of the view) under this localStorage key. */
  storageKey?: string;
  /** The view shared with the toolbar's ViewMenu (`useTableView`); else the table keeps its own. */
  view?: TableView<T>;
  /** All the rows before the toolbar narrowed them, for the footer's "n 件中 m 件". */
  total?: number;
  /** Shown in place of the rows when there are none (the caller says "none yet" or "no match"). */
  empty?: ReactNode;
  /** Buttons at the end of a row, shown on hover and focus. */
  rowActions?: (row: T) => ReactNode;
  /** The width of the actions column, px (two small buttons by default). */
  actionsWidth?: number;
  /** More attributes and handlers for a row (hover, context menu, data-*). */
  rowProps?: (row: T) => Omit<HTMLAttributes<HTMLTableRowElement>, "className" | "onClick" | "onKeyDown">;
  /** Rows that can be picked (default all): the others get no check box and stay out of "pick all" and ranges. */
  canPick?: (row: T) => boolean;
}) {
  const own = useTableView(columns, { storageKey, initialSort });
  const v = view ?? own;
  const shown = columns.filter((c, i) => i === 0 || !v.hidden.has(c.id));
  const heads = useRef<Record<string, HTMLElement | null>>({});
  const anchor = useRef<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => {
    const column = v.sort && columns.find((c) => c.id === v.sort!.column);
    if (!column?.sortValue) return rows;
    const value = column.sortValue;
    const list = [...rows].sort((a, b) => compare(value(a), value(b)));
    return v.sort?.descending ? list.reverse() : list;
  }, [rows, v.sort, columns]);

  // Grouped: the groups in their order, each keeping the sort inside it.
  const groupColumn = v.groupBy ? columns.find((c) => c.id === v.groupBy && c.group) : undefined;
  const groups = useMemo(() => {
    if (!groupColumn?.group) return null;
    const by = new Map<string, { key: string; label: ReactNode; order: number; rows: T[] }>();
    for (const row of sorted) {
      const g = groupColumn.group(row);
      const entry = by.get(g.key) ?? { key: g.key, label: g.label, order: g.order ?? by.size, rows: [] };
      entry.rows.push(row);
      by.set(g.key, entry);
    }
    return [...by.values()].sort((a, b) => a.order - b.order);
  }, [sorted, groupColumn]);
  const visible = groups ? groups.flatMap((g) => (folded.has(g.key) ? [] : g.rows)) : sorted;

  const picking = selected && onSelect ? { selected, onSelect } : null;
  const keys = (canPick ? visible.filter(canPick) : visible).map(rowKey);
  const pickedHere = picking ? keys.filter((k) => picking.selected.has(k)).length : 0;
  /** A click on a check box or with Ctrl: one row; with Shift: the rows from the last one picked. */
  const pick = (key: string, range: boolean) => {
    if (!picking || !keys.includes(key)) return;
    const next = new Set(picking.selected);
    const from = anchor.current ? keys.indexOf(anchor.current) : -1;
    if (range && from >= 0) {
      const to = keys.indexOf(key);
      const on = !picking.selected.has(key);
      for (const k of keys.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        if (on) next.add(k);
        else next.delete(k);
      }
    } else if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    anchor.current = key;
    picking.onSelect(next);
  };
  const pickAll = () => picking?.onSelect(pickedHere === keys.length ? new Set() : new Set(keys));
  const span = shown.length + (picking ? 1 : 0) + (rowActions ? 1 : 0);
  const compact = v.density === "compact";
  const px = (c: Column<T>) => v.widths[c.id] ?? widthOf(c.width);
  const cellY = compact ? "py-1.5" : "py-2.5";

  const renderRow = (row: T) => {
    const key = rowKey(row);
    const on = picking ? picking.selected.has(key) : false;
    return (
      <tr
        key={key}
        tabIndex={0}
        aria-selected={picking ? on : undefined}
        {...rowProps?.(row)}
        onClick={(e) => {
          // Ctrl / Shift click picks, as in a file list; a plain click opens.
          if (picking && (e.ctrlKey || e.metaKey || e.shiftKey)) return pick(key, e.shiftKey);
          onOpen?.(row);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter") onOpen?.(row);
          // Up and down move between rows, as in a list.
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            let next = e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
            while (next && !next.hasAttribute("tabindex")) next = e.key === "ArrowDown" ? next.nextElementSibling : next.previousElementSibling;
            (next as HTMLElement | null)?.focus();
          }
          if (e.key === " " && picking) {
            e.preventDefault();
            pick(key, e.shiftKey);
          }
        }}
        className={`group text-[13px] focus:outline-none ${onOpen ? "cursor-pointer" : ""} ${
          on ? "bg-brand-50" : "hover:bg-slate-50 focus-visible:bg-slate-50"
        } focus-visible:shadow-[inset_2px_0_0_var(--color-primary)]`}
      >
        {picking && (
          <td className={`border-b border-slate-100 pr-1 pl-3 ${cellY}`}>
            {(!canPick || canPick(row)) && <Check checked={on} label={t.table.select} onPick={(e) => pick(key, e.shiftKey)} />}
          </td>
        )}
        {shown.map((c) => (
          <td key={c.id} className={`border-b border-slate-100 px-3 ${cellY} ${c.hideBelow ? HIDE[c.hideBelow] : ""} ${c.align === "right" ? "text-right" : ""}`}>
            <div className="min-w-0 overflow-hidden">{c.cell(row)}</div>
          </td>
        ))}
        {rowActions && (
          <td className={`border-b border-slate-100 pr-2 pl-1 whitespace-nowrap ${compact ? "py-0.5" : "py-1.5"}`}>
            <span className="invisible flex justify-end gap-0.5 group-focus-within:visible group-hover:visible">{rowActions(row)}</span>
          </td>
        )}
      </tr>
    );
  };

  const count = total !== undefined && total !== rows.length ? t.table.shownOf(rows.length, total) : t.list.count(rows.length);

  return (
    <div className="rounded-lg border border-slate-200 bg-sheet [overflow:clip]">
      <table className="w-full table-fixed border-separate border-spacing-0 text-left [&_tbody_tr:last-child>td]:border-b-0">
        <thead className="text-[12px] text-slate-500">
          <tr>
            {picking && (
              <th className="sticky top-0 z-10 h-9 w-10 border-b border-slate-200 bg-sheet pr-1 pl-3 font-normal">
                <Check
                  checked={keys.length > 0 && pickedHere === keys.length}
                  mixed={pickedHere > 0 && pickedHere < keys.length}
                  label={t.table.selectAll}
                  onPick={pickAll}
                />
              </th>
            )}
            {shown.map((c, i) => {
              const active = v.sort?.column === c.id;
              const Icon = !active ? ChevronsUpDown : v.sort!.descending ? ArrowDown : ArrowUp;
              // The last column and the flexible ones give way; the others resize.
              const resizable = i < shown.length - 1 && px(c) !== undefined;
              return (
                <th
                  key={c.id}
                  ref={(el) => {
                    heads.current[c.id] = el;
                  }}
                  aria-sort={active ? (v.sort!.descending ? "descending" : "ascending") : undefined}
                  // Widths sit on the header cells, not a colgroup: a column hidden on a narrow pane then gives its width back.
                  style={px(c) ? { width: px(c) } : undefined}
                  className={`sticky top-0 z-10 h-9 border-b border-slate-200 bg-sheet px-3 py-0 font-medium ${c.hideBelow ? HIDE[c.hideBelow] : ""} ${c.align === "right" ? "text-right" : ""}`}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => v.setSort(active ? { column: c.id, descending: !v.sort!.descending } : { column: c.id, descending: false })}
                      className={`group/sort -mx-1.5 inline-flex h-7 max-w-full items-center gap-1 rounded-md px-1.5 whitespace-nowrap hover:bg-slate-100 hover:text-ink ${active ? "text-ink" : ""}`}
                    >
                      <span className="truncate">{c.header}</span>
                      <Icon
                        size={12}
                        strokeWidth={2}
                        aria-hidden="true"
                        className={`shrink-0 ${active ? "text-ink" : "text-slate-500 opacity-0 group-hover/sort:opacity-100"}`}
                      />
                    </button>
                  ) : (
                    <span className="block truncate">{c.header}</span>
                  )}
                  {resizable && (
                    <Resizer
                      th={() => heads.current[c.id] ?? null}
                      label={t.table.resize}
                      onResize={(px) => v.setWidth(c.id, px)}
                      onReset={() => v.resetWidth(c.id)}
                    />
                  )}
                </th>
              );
            })}
            {rowActions && <th style={{ width: actionsWidth }} className="sticky top-0 z-10 h-9 border-b border-slate-200 bg-sheet" />}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={span} className="px-3 py-10 text-center text-[13px] text-slate-500">
                {empty}
              </td>
            </tr>
          ) : groups ? (
            groups.flatMap((g) => {
              const open = !folded.has(g.key);
              return [
                <tr key={`@group:${g.key}`}>
                  <td colSpan={span} className="border-b border-slate-200 bg-paper px-2 py-1">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => {
                        setFolded((f) => {
                          const next = new Set(f);
                          if (open) next.add(g.key);
                          else next.delete(g.key);
                          return next;
                        });
                        // Folded rows are out of sight, so they leave the selection:
                        // a bulk action never touches a row the viewer cannot see.
                        if (open && picking) {
                          const gone = new Set(g.rows.map(rowKey));
                          if ([...picking.selected].some((k) => gone.has(k))) picking.onSelect(new Set([...picking.selected].filter((k) => !gone.has(k))));
                        }
                      }}
                      className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-ink hover:bg-slate-100"
                    >
                      {open ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />}
                      {g.label}
                      <span className="font-normal text-slate-500 tabular-nums">{g.rows.length}</span>
                    </button>
                  </td>
                </tr>,
                ...(open ? g.rows.map(renderRow) : []),
              ];
            })
          ) : (
            sorted.map(renderRow)
          )}
        </tbody>
      </table>
      <div className="flex h-9 items-center gap-3 border-t border-slate-100 px-3 text-[12px] text-slate-500">
        <span className="tabular-nums">{count}</span>
        {picking && pickedHere > 0 && <span className="tabular-nums">{t.table.selected(pickedHere)}</span>}
        <span className="flex-1" />
        {picking && <span className="hidden text-slate-500 @min-[720px]:inline">{t.table.pickHint}</span>}
      </div>
    </div>
  );
}

/** A panel under a toolbar button; outside clicks and Esc close it. */
function Popover({ button, children, align = "left", label }: { button: (open: boolean, toggle: () => void) => ReactNode; children: ReactNode; align?: "left" | "right"; label: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      {button(open, () => setOpen((o) => !o))}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`absolute top-full z-30 mt-1 min-w-52 rounded-lg border border-slate-200 bg-sheet p-1 text-[13px] shadow-lifted ${align === "right" ? "right-0" : "left-0"}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** The search field of a list page; Esc clears it. `hits` shows how many rows match. */
export function SearchBox({ value, onChange, placeholder, hits }: { value: string; onChange: (v: string) => void; placeholder: string; hits?: number }) {
  return (
    <div className="flex h-7 w-60 min-w-36 shrink items-center gap-1.5 rounded-lg border border-slate-200 bg-sheet px-2 focus-within:border-primary">
      <Search size={14} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-slate-500 focus:outline-none"
      />
      {value.trim() && hits !== undefined && <span className="shrink-0 text-[11px] text-slate-500">{t.list.count(hits)}</span>}
      {value && (
        <button type="button" onClick={() => onChange("")} title={t.table.clearSearch} className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-500 hover:bg-slate-100 hover:text-ink">
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export type Facet<V extends string> = { value: V; label: string; count?: number; dot?: string };

/**
 * One filter of the toolbar (shadcn's faceted filter): a dashed button with
 * the column's name; its panel picks any of the values, each with how many
 * rows have it. Once set, the button shows what is picked.
 */
export function FacetFilter<V extends string>({ label, options, value, onChange }: { label: string; options: Facet<V>[]; value: Set<V>; onChange: (next: Set<V>) => void }) {
  const [find, setFind] = useState("");
  const picked = options.filter((o) => value.has(o.value));
  const listed = find ? options.filter((o) => o.label.toLowerCase().includes(find.toLowerCase())) : options;
  return (
    <Popover
      label={label}
      button={(open, toggle) => (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className={`flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[12px] whitespace-nowrap ${
            picked.length ? "border-slate-300 bg-sheet text-ink" : "border-dashed border-slate-300 text-slate-600 hover:bg-sheet hover:text-ink"
          }`}
        >
          <PlusCircle size={13} strokeWidth={1.75} aria-hidden="true" className={picked.length ? "rotate-45 text-slate-500" : ""} />
          {label}
          {picked.length > 0 && (
            <>
              <span className="h-3.5 w-px bg-slate-300" aria-hidden="true" />
              {picked.length > 2 ? (
                <span className="rounded bg-slate-100 px-1.5 text-[11.5px] leading-5">{t.table.picked(picked.length)}</span>
              ) : (
                picked.map((o) => (
                  <span key={o.value} className="rounded bg-slate-100 px-1.5 text-[11.5px] leading-5">
                    {o.label}
                  </span>
                ))
              )}
            </>
          )}
        </button>
      )}
    >
      {options.length > 7 && (
        <div className="mb-1 flex items-center gap-1.5 border-b border-slate-100 px-2 pb-1.5">
          <Search size={13} strokeWidth={1.75} className="text-slate-500" aria-hidden="true" />
          <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder={label} className="min-w-0 flex-1 bg-transparent py-1 text-[13px] placeholder:text-slate-500 focus:outline-none" />
        </div>
      )}
      <ul className="max-h-72 overflow-y-auto" role="listbox" aria-multiselectable="true" aria-label={label}>
        {listed.map((o) => {
          const on = value.has(o.value);
          return (
            <li key={o.value} role="option" aria-selected={on}>
              <button
                type="button"
                onClick={() => {
                  const next = new Set(value);
                  if (on) next.delete(o.value);
                  else next.add(o.value);
                  onChange(next);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-100"
              >
                <span className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border ${on ? "border-primary bg-primary text-on-primary" : "border-slate-400"}`}>
                  {on && <CheckIcon size={10} strokeWidth={3} aria-hidden="true" />}
                </span>
                {o.dot && <span className={`h-2 w-2 shrink-0 rounded-full ${o.dot}`} aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.count !== undefined && <span className="text-[12px] text-slate-500 tabular-nums">{o.count}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {value.size > 0 && (
        <button type="button" onClick={() => onChange(new Set())} className="mt-1 w-full rounded-md border-t border-slate-100 px-2 py-1.5 text-center text-[12px] text-slate-600 hover:bg-slate-100 hover:text-ink">
          {t.table.clearFilter}
        </button>
      )}
    </Popover>
  );
}

/** Shown beside the filters while any is set: back to all the rows. */
export function ClearFilters({ onClear }: { onClear: () => void }) {
  return (
    <button type="button" onClick={onClear} className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] whitespace-nowrap text-slate-600 hover:bg-slate-100 hover:text-ink">
      {t.table.clearFilters}
      <X size={12} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

/** The "表示" menu: row height, grouping, which columns, and their widths back. */
export function ViewMenu<T>({ view }: { view: TableView<T> }) {
  const groupable = view.columns.filter((c) => c.group);
  const hideable = view.columns.filter((c, i) => i > 0 && c.hideable !== false);
  const segment = (on: boolean) => `h-6 flex-1 rounded-md px-2 text-[12px] ${on ? "bg-sheet font-medium text-ink shadow-sheet" : "text-slate-600 hover:text-ink"}`;
  return (
    <Popover
      label={t.table.view}
      align="right"
      button={(open, toggle) => (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex h-7 items-center gap-1.5 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[13px] text-slate-700 hover:bg-slate-50"
        >
          <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
          {t.table.view}
        </button>
      )}
    >
      <div className="w-60 p-1.5">
        <p className="mb-1 text-[11px] font-medium text-slate-500">{t.table.density}</p>
        <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
          <button type="button" className={segment(view.density === "comfortable")} onClick={() => view.setDensity("comfortable")}>
            {t.table.comfortable}
          </button>
          <button type="button" className={segment(view.density === "compact")} onClick={() => view.setDensity("compact")}>
            {t.table.compact}
          </button>
        </div>
        {groupable.length > 0 && (
          <>
            <p className="mt-3 mb-1 text-[11px] font-medium text-slate-500">{t.table.group}</p>
            <div className="flex flex-wrap gap-0.5 rounded-lg bg-slate-100 p-0.5">
              <button type="button" className={segment(view.groupBy === null)} onClick={() => view.setGroupBy(null)}>
                {t.table.noGroup}
              </button>
              {groupable.map((c) => (
                <button key={c.id} type="button" className={segment(view.groupBy === c.id)} onClick={() => view.setGroupBy(c.id)}>
                  {c.header}
                </button>
              ))}
            </div>
          </>
        )}
        {hideable.length > 0 && (
          <>
            <p className="mt-3 mb-0.5 text-[11px] font-medium text-slate-500">{t.table.columns}</p>
            <ul>
              {hideable.map((c) => {
                const on = !view.hidden.has(c.id);
                return (
                  <li key={c.id}>
                    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => view.toggleColumn(c.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-slate-100">
                      <span className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border ${on ? "border-primary bg-primary text-on-primary" : "border-slate-400"}`}>
                        {on && <CheckIcon size={10} strokeWidth={3} aria-hidden="true" />}
                      </span>
                      {c.header}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {Object.keys(view.widths).length > 0 && (
          <button type="button" onClick={view.resetWidths} className="mt-2 w-full rounded-md border-t border-slate-100 pt-1.5 text-center text-[12px] text-slate-600 hover:text-ink">
            {t.table.resetWidths}
          </button>
        )}
      </div>
    </Popover>
  );
}

export type Chip<V extends string> = { value: V; label: string; count?: number };

/** One-of filter chips ("すべて" first), each with how many rows it keeps. */
export function FilterChips<V extends string>({ chips, value, onChange, label }: { chips: Chip<V>[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
      {chips.map((chip) => {
        const on = chip.value === value;
        return (
          <button
            key={chip.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(chip.value)}
            className={`flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] ${
              on ? "bg-slate-100 font-medium text-ink ring-1 ring-slate-400" : "bg-sheet text-slate-600 ring-1 ring-slate-200 hover:text-ink"
            }`}
          >
            {chip.label}
            {chip.count !== undefined && <span className={`tabular-nums ${on ? "text-slate-600" : "text-slate-500"}`}>{chip.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The bulk actions over the picked rows, floating at the bottom of the page
 * while any are picked (Linear, Notion): how many, the actions, the way out.
 * Put it after the table, inside the page's scrolling box.
 */
export function SelectionBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  useEffect(() => {
    if (count === 0) return;
    const esc = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true], [role=dialog]");
      if (e.key === "Escape" && !typing) onClear();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [count, onClear]);
  if (count === 0) return null;
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-3 flex justify-center">
      <div role="toolbar" aria-label={t.table.selected(count)} className="pointer-events-auto flex h-10 items-center gap-1 rounded-xl border border-slate-200 bg-sheet pr-1.5 pl-3 text-[13px] text-ink shadow-lifted">
        <span className="font-medium whitespace-nowrap tabular-nums">{t.table.selected(count)}</span>
        <span className="mx-1.5 h-4 w-px bg-slate-200" aria-hidden="true" />
        {children}
        <span className="mx-1 h-4 w-px bg-slate-200" aria-hidden="true" />
        <button type="button" onClick={onClear} title={`${t.table.clear} (Esc)`} className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink">
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** A button of the SelectionBar. `danger` asks once more before it acts. */
export function BulkButton({
  icon: Icon,
  label,
  confirmLabel,
  onClick,
  danger,
}: {
  icon: typeof X;
  label: string;
  confirmLabel?: string;
  onClick: () => void | Promise<void>;
  danger?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <button
      type="button"
      onBlur={() => setConfirming(false)}
      onClick={async () => {
        // A danger with its own dialog (no confirmLabel) asks there instead of on the button.
        if (danger && confirmLabel && !confirming) return setConfirming(true);
        setConfirming(false);
        await onClick();
      }}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] whitespace-nowrap ${
        confirming ? "bg-shu-600 text-white" : danger ? "text-slate-700 hover:bg-shu-50 hover:text-shu-600" : "text-slate-700 hover:bg-slate-100 hover:text-ink"
      }`}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      {confirming ? (confirmLabel ?? label) : label}
    </button>
  );
}

/** The tones of a StatusBadge: a state of the row, said with a dot and a word. */
export type Tone = "green" | "amber" | "red" | "blue" | "slate";
const BADGE: Record<Tone, { pill: string; dot: string }> = {
  green: { pill: "bg-moegi-100 text-moegi-600", dot: "bg-moegi-500" },
  amber: { pill: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  red: { pill: "bg-shu-50 text-shu-600", dot: "bg-shu-500" },
  blue: { pill: "bg-brand-50 text-brand-600", dot: "bg-brand-500" },
  slate: { pill: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
};
/** The dot color of a tone, for a FacetFilter option that names the same state. */
export const toneDot = (tone: Tone) => BADGE[tone].dot;

/** A row's state in a cell (確定済み, 有効, 読み込みエラー…): the same pill in every table. */
export function StatusBadge({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return (
    <span className={`inline-flex h-5 max-w-full items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap ${BADGE[tone].pill}`} title={title}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${BADGE[tone].dot}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * On or off in a row (有効), turned without opening the row: a switch, not a
 * check box, so it is not mistaken for picking the row.
 */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 motion-reduce:transition-none ${checked ? "bg-brand-500" : "bg-slate-300"}`}
    >
      <span className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${checked ? "translate-x-3.5" : "translate-x-0.5"}`} />
    </button>
  );
}

/** The "…" at a row's end: the same menu as a right-click on the row. */
export function RowMenuButton({ items }: { items: () => readonly MenuSpec[] }) {
  return (
    <button
      type="button"
      title={t.table.more}
      aria-label={t.table.more}
      className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-200 hover:text-ink"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu({ clientX: r.right - 180, clientY: r.bottom + 4, preventDefault: () => {} }, items());
      }}
    >
      <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
