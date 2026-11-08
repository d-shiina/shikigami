// A data table for the list pages (Linear / Notion style): the header stays
// in view while the page scrolls, a column header sorts by it, rows can be
// picked with their check boxes for a bulk action, and columns that matter
// less give way on narrow panes instead of squeezing the names.
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from "lucide-react";
import { type HTMLAttributes, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";

export type Column<T> = {
  id: string;
  header: string;
  /** Tailwind width class for the column (the first column takes the rest). */
  width?: string;
  align?: "left" | "right";
  /** Sortable when given: the value the column sorts by. */
  sortValue?: (row: T) => string | number;
  /** Hidden when the page is narrower than this (container width, px). */
  hideBelow?: 720 | 860 | 1000;
  cell: (row: T) => ReactNode;
};

export type Sort = { column: string; descending: boolean };

const HIDE: Record<NonNullable<Column<unknown>["hideBelow"]>, string> = {
  720: "hidden @min-[720px]:table-cell",
  860: "hidden @min-[860px]:table-cell",
  1000: "hidden @min-[1000px]:table-cell",
};

function compare(a: string | number, b: string | number): number {
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "ja");
}

/** A check box that can also show "some selected". */
function Check({ checked, mixed, label, onChange }: { checked: boolean; mixed?: boolean; label: string; onChange: () => void }) {
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
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer rounded-sm accent-[var(--color-primary)]"
    />
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
  empty,
  rowActions,
  rowProps,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  /** Keys of the picked rows; leave out for a table without check boxes. */
  selected?: Set<string>;
  onSelect?: (next: Set<string>) => void;
  initialSort?: Sort;
  /** Remembers the sort under this localStorage key. */
  storageKey?: string;
  /** Shown in place of the rows when there are none (the caller says "none yet" or "no match"). */
  empty?: ReactNode;
  /** Buttons at the end of a row, shown on hover and focus. */
  rowActions?: (row: T) => ReactNode;
  /** More attributes and handlers for a row (hover, context menu, data-*). */
  rowProps?: (row: T) => Omit<HTMLAttributes<HTMLTableRowElement>, "className" | "onClick" | "onKeyDown">;
}) {
  const [sort, setSortState] = useState<Sort | null>(() => {
    try {
      const saved = storageKey ? globalThis.localStorage?.getItem(storageKey) : null;
      if (saved) return JSON.parse(saved) as Sort;
    } catch {
      // Only a remembered preference.
    }
    return initialSort ?? null;
  });
  const setSort = (next: Sort) => {
    setSortState(next);
    try {
      if (storageKey) globalThis.localStorage?.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Only a remembered preference.
    }
  };
  const sorted = useMemo(() => {
    const column = sort && columns.find((c) => c.id === sort.column);
    if (!column?.sortValue) return rows;
    const value = column.sortValue;
    const list = [...rows].sort((a, b) => compare(value(a), value(b)));
    return sort?.descending ? list.reverse() : list;
  }, [rows, sort, columns]);
  const picking = selected && onSelect;
  const keys = sorted.map(rowKey);
  const pickedHere = picking ? keys.filter((k) => selected.has(k)).length : 0;
  const toggle = (key: string) => {
    if (!picking) return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelect(next);
  };
  const toggleAll = () => picking && onSelect(pickedHere === keys.length ? new Set() : new Set(keys));
  const span = columns.length + (picking ? 1 : 0) + (rowActions ? 1 : 0);

  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead className="sticky top-0 z-10 bg-paper text-[11px] text-slate-500">
        <tr>
          {picking && (
            <th className="w-9 border-b border-slate-200 py-2 pl-3">
              <Check
                checked={keys.length > 0 && pickedHere === keys.length}
                mixed={pickedHere > 0 && pickedHere < keys.length}
                label={t.table.selectAll}
                onChange={toggleAll}
              />
            </th>
          )}
          {columns.map((c) => {
            const active = sort?.column === c.id;
            const Icon = !active ? ChevronsUpDown : sort.descending ? ArrowDown : ArrowUp;
            return (
              <th
                key={c.id}
                aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}
                className={`border-b border-slate-200 px-3 py-0 font-medium ${c.width ?? ""} ${c.hideBelow ? HIDE[c.hideBelow] : ""} ${c.align === "right" ? "text-right" : ""}`}
              >
                {c.sortValue ? (
                  <button
                    type="button"
                    onClick={() => setSort(active ? { column: c.id, descending: !sort.descending } : { column: c.id, descending: false })}
                    className={`group/sort -mx-1.5 flex h-8 items-center gap-1 rounded-md px-1.5 hover:bg-slate-100 hover:text-ink ${active ? "text-ink" : ""} ${c.align === "right" ? "ml-auto" : ""}`}
                  >
                    {c.header}
                    <Icon
                      size={12}
                      strokeWidth={2}
                      aria-hidden="true"
                      className={active ? "text-ink" : "text-slate-400 opacity-0 group-hover/sort:opacity-100"}
                    />
                  </button>
                ) : (
                  <span className="flex h-8 items-center">{c.header}</span>
                )}
              </th>
            );
          })}
          {rowActions && <th className="w-[84px] border-b border-slate-200" />}
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr>
            <td colSpan={span} className="px-3 py-8 text-center text-[13px] text-slate-500">
              {empty}
            </td>
          </tr>
        ) : (
          sorted.map((row) => {
            const key = rowKey(row);
            const on = picking ? selected.has(key) : false;
            return (
              <tr
                {...rowProps?.(row)}
                key={key}
                tabIndex={0}
                aria-selected={picking ? on : undefined}
                onClick={() => onOpen?.(row)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter") onOpen?.(row);
                  // Up and down move between rows, as in a list.
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const next = e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
                    (next as HTMLElement | null)?.focus();
                  }
                  if (e.key === " " && picking) {
                    e.preventDefault();
                    toggle(key);
                  }
                }}
                className={`group border-b border-slate-100 align-top last:border-b-0 focus:outline-none ${onOpen ? "cursor-pointer" : ""} ${
                  on ? "bg-brand-50" : "hover:bg-slate-50 focus:bg-slate-50"
                }`}
              >
                {picking && (
                  <td className="py-3 pl-3">
                    <span className={on || selected.size > 0 ? "" : "opacity-0 group-hover:opacity-100 group-focus:opacity-100"}>
                      <Check checked={on} label={t.table.select} onChange={() => toggle(key)} />
                    </span>
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className={`px-3 py-2.5 ${c.hideBelow ? HIDE[c.hideBelow] : ""} ${c.align === "right" ? "text-right" : ""}`}
                  >
                    {c.cell(row)}
                  </td>
                ))}
                {rowActions && (
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className="invisible flex justify-end gap-0.5 group-focus-within:visible group-hover:visible">{rowActions(row)}</span>
                  </td>
                )}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

/** The search field of a list page; Esc clears it. `hits` shows how many rows match. */
export function SearchBox({ value, onChange, placeholder, hits }: { value: string; onChange: (v: string) => void; placeholder: string; hits?: number }) {
  return (
    <div className="flex h-7 w-72 min-w-36 shrink items-center gap-1.5 rounded-lg border border-slate-200 bg-sheet px-2 focus-within:border-primary">
      <Search size={14} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] focus:outline-none"
      />
      {value.trim() && hits !== undefined && <span className="shrink-0 text-[11px] text-slate-500">{t.list.count(hits)}</span>}
    </div>
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

/** Takes the toolbar's place while rows are picked: how many, the bulk actions, and the way out. */
export function SelectionBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-2 rounded-lg bg-brand-50 pr-1 pl-3 text-[13px] text-ink ring-1 ring-brand-100">
      <span className="font-medium tabular-nums">{t.table.selected(count)}</span>
      <span className="h-4 w-px bg-slate-300" />
      {children}
      <button type="button" onClick={onClear} title={t.table.clear} className="ml-1 grid h-6 w-6 place-items-center rounded-md text-slate-500 hover:bg-slate-200 hover:text-ink">
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
