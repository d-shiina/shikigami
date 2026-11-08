// The third way to look at a flow, beside the flow chart and the
// procedure: every variable in one table, with where it starts, which steps
// write it and which read it, and what it held after the last run. Editing a
// variable stays in the inspector (the flow's properties); a step here
// opens it on the chart.
import { menuFor } from "../lib/contextMenu";
import { useVariableMenu } from "./menus";
import type { Step, StepTypeDef, VarDirection, VariableDef, VarType } from "@shikigami/schema";
import { Lock, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { varFocus, focus } from "../lib/focus";
import { stepLabel, t } from "../lib/i18n";
import { TYPE_COLOR } from "../lib/nodeRows";
import { valueText } from "../lib/runValues";
import { variableUsage, type VariableUsage } from "../lib/variableUsage";
import { findStep } from "../store";
import type { View } from "./Toolbar";
import { VarIcon } from "./VarIcon";
import { HoverPreview } from "./HoverPreview";
import { previewSource } from "../lib/preview";
import { defaultText, parseDefault } from "./VariablesPanel";
import { askedAtRun } from "../lib/runInputs";
import { AskedAtRunTag } from "./AskedAtRunTag";
import { type Chip, type Column, DataTable, FilterChips, SearchBox, SelectionBar } from "./DataTable";

function StepChips({ ids, steps, defs, onOpen }: { ids: string[]; steps: Step[]; defs: ReadonlyMap<string, StepTypeDef>; onOpen: (id: string) => void }) {
  if (ids.length === 0) return <span className="text-slate-300">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const step = findStep(steps, id);
        const label = step?.name || (step ? stepLabel(step.type, defs.get(step.type)?.label) : id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onOpen(id)}
            title={`${label}\n${t.vars.table.openStep}`}
            className="max-w-full truncate rounded-md border border-slate-200 bg-sheet px-1.5 text-[11px] leading-5 text-slate-700 hover:border-brand-500 hover:text-brand-700"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const DIRECTION_TONE: Record<VariableUsage["direction"], string> = {
  input: "bg-brand-50 text-brand-700",
  inOut: "bg-brand-50 text-brand-700",
  output: "bg-moegi-100 text-moegi-500",
  local: "bg-slate-100 text-slate-600",
  made: "bg-slate-100 text-slate-500",
};

const TYPES = Object.keys(t.varType) as VarType[];
const DIRECTIONS = Object.keys(t.direction) as VarDirection[];
/** A cell that reads as text and turns into a field on hover and focus, as a spreadsheet's does. */
const quiet =
  "w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 hover:border-slate-200 focus:border-primary focus:bg-sheet focus:outline-none";

/** The starting value, typed in place. Enter or leaving the cell keeps it; Esc puts it back. */
/** An empty cell the run will ask for: an orange edge and words, like the tag. */
const ASKED = "border-accent-500/50 bg-accent-500/5 placeholder:font-sans placeholder:font-semibold placeholder:text-accent-600";

export function InitialCell({ variable, onSet }: { variable: VariableDef; onSet: (v: VariableDef) => void }) {
  const type = variable.type ?? "any";
  const initial = defaultText(variable);
  const [draft, setDraft] = useState(initial);
  // Esc leaves the cell without keeping what was typed: the blur it causes must not save.
  const cancelled = useRef(false);
  const cancel = (el: HTMLElement) => {
    cancelled.current = true;
    setDraft(initial);
    el.blur();
  };
  if (variable.secret && askedAtRun(variable)) return <AskedAtRunTag />;
  if (variable.secret)
    return (
      <span className="px-1.5 text-[11px] text-slate-400" title={t.vars.table.secretTitle}>
        {t.secret}
      </span>
    );
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft !== initial) onSet({ ...variable, default: parseDefault(draft, type) });
  };
  // No default yet: the run asks for it, said in the cell itself.
  const asked = askedAtRun(variable) && draft === "";
  const common = {
    value: draft,
    placeholder: asked ? t.vars.askedAtRun : t.values.none,
    title: asked ? `${t.vars.askedAtRunTitle}\n${t.vars.table.editInitial}` : t.vars.table.editInitial,
    "aria-label": `${variable.name} ${t.vars.table.columns.initial}`,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
  };
  // Lists and records are typed one entry per line.
  if (type === "array" || type === "object" || draft.includes("\n"))
    return (
      <textarea
        {...common}
        rows={Math.min(4, draft.split("\n").length)}
        className={`${asked ? quiet.replace("border-transparent ", "") : quiet} block resize-y font-mono text-[12px] leading-snug text-ink ${asked ? ASKED : "placeholder:text-slate-300"}`}
        onKeyDown={(e) => e.key === "Escape" && cancel(e.currentTarget)}
      />
    );
  return (
    <input
      {...common}
      className={`${asked ? quiet.replace("border-transparent ", "") : quiet} font-mono text-[12px] text-ink ${asked ? ASKED : "placeholder:text-slate-300"}`}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") cancel(e.currentTarget);
      }}
    />
  );
}

/** A new variable, under the table. */
function AddRow({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form
      className="flex items-center gap-2 py-2 pl-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onAdd(name.trim());
        setName("");
      }}
    >
      <input
        className="w-64 rounded-md border border-slate-200 bg-sheet px-2 py-1 font-mono text-[12px] focus:border-primary focus:outline-none"
        placeholder={t.vars.table.namePlaceholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={!name.trim()} className="rounded-md border border-slate-300 bg-paper px-3 py-1 text-[12px] text-ink hover:bg-slate-100 disabled:text-slate-300">
        {t.addVariable}
      </button>
    </form>
  );
}

type Filter = "all" | "input" | "output" | "local" | "asked";

/** Which chips keep a row: an 入出力 variable is both an input and an output. */
function keeps(u: VariableUsage, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "input":
      return u.direction === "input" || u.direction === "inOut";
    case "output":
      return u.direction === "output" || u.direction === "inOut";
    case "local":
      return u.direction === "local";
    case "asked":
      return askedAtRun(u.def);
  }
}

const DIRECTION_ORDER: Record<VariableUsage["direction"], number> = { input: 0, inOut: 1, output: 2, local: 3, made: 4 };

export function VariablesView({ onView }: { onView: (view: View) => void }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const changes = useStudio((s) => s.run?.changes);
  const goTo = useStudio((s) => s.goTo);
  const setVariable = useStudio((s) => s.setVariable);
  const removeVariable = useStudio((s) => s.removeVariable);
  const variableMenu = useVariableMenu();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const all = useMemo(() => (flow ? variableUsage(flow.steps ?? [], flow.variables) : []), [flow]);
  if (!flow) return null;
  const open = (id: string) => {
    onView("flow");
    goTo(id);
  };
  const cols = t.vars.table.columns;
  const q = query.trim().toLowerCase();
  const rows = all.filter((u) => keeps(u, filter) && (!q || `${u.name}\n${u.def?.description ?? ""}`.toLowerCase().includes(q)));
  const chips: Chip<Filter>[] = (
    [
      ["all", t.vars.table.all],
      ["input", t.direction.input],
      ["output", t.direction.output],
      ["local", t.direction.local],
      ["asked", t.vars.askedAtRun],
    ] as const
  )
    .map(([value, label]) => ({ value, label, count: all.filter((u) => keeps(u, value)).length }))
    // A chip that would keep nothing is left out (but never the one in use).
    .filter((c) => c.value === "all" || c.count > 0 || c.value === filter);
  // Only declared variables can be picked: a node's own result is not one to delete or make secret.
  const picked = new Set([...selected].filter((name) => all.some((u) => u.name === name && u.def)));
  const pickedDefs = flow.variables?.filter((v) => picked.has(v.name)) ?? [];
  const clear = () => {
    setSelected(new Set());
    setConfirmDelete(false);
  };

  const columns: Column<VariableUsage>[] = [
    {
      id: "name",
      header: cols.name,
      sortValue: (u) => u.name,
      cell: (u) => {
        const color = TYPE_COLOR[u.type] ?? TYPE_COLOR.any;
        const unused = u.readers.length === 0 && u.direction !== "output";
        return (
          <>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
              <VarIcon size={12} className="shrink-0 text-slate-400" />
              <span className="min-w-0 truncate font-mono text-[13px] font-semibold" title={u.name}>
                {u.name}
              </span>
              {u.def?.secret && <Lock size={11} strokeWidth={2} className="shrink-0 text-slate-400" aria-label={t.secret} />}
            </div>
            {u.def?.description && (
              <div className="mt-0.5 line-clamp-2 pl-[30px] text-[11px] text-slate-500" title={u.def.description}>
                {u.def.description}
              </div>
            )}
            {unused && <div className="mt-0.5 pl-[30px] text-[11px] text-accent-600">{t.vars.table.unused}</div>}
          </>
        );
      },
    },
    {
      id: "direction",
      header: cols.direction,
      width: "w-[96px]",
      sortValue: (u) => DIRECTION_ORDER[u.direction],
      cell: (u) =>
        u.def ? (
          <select
            value={u.direction}
            onChange={(e) => void setVariable({ ...u.def!, direction: e.target.value as VarDirection })}
            aria-label={`${u.name} ${cols.direction}`}
            className={`cursor-pointer appearance-none rounded-sm border border-transparent px-1.5 text-[11px] leading-5 font-semibold hover:border-slate-300 focus:border-primary focus:outline-none ${DIRECTION_TONE[u.direction]}`}
          >
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {t.direction[d]}
              </option>
            ))}
          </select>
        ) : (
          <span className={`rounded-sm px-1.5 text-[11px] leading-5 font-semibold whitespace-nowrap ${DIRECTION_TONE.made}`}>{t.vars.table.made}</span>
        ),
    },
    {
      id: "type",
      header: cols.type,
      width: "w-[104px]",
      sortValue: (u) => t.varType[u.type] ?? u.type,
      cell: (u) => {
        const color = TYPE_COLOR[u.type] ?? TYPE_COLOR.any;
        return u.def ? (
          <select
            value={u.type}
            onChange={(e) => void setVariable({ ...u.def!, type: e.target.value as VarType })}
            aria-label={`${u.name} ${cols.type}`}
            style={{ color }}
            className={`${quiet} -my-0.5 cursor-pointer appearance-none text-[12px]`}
          >
            {/* A type this Studio does not know (a newer flow) stays as it is. */}
            {(TYPES.includes(u.type) ? TYPES : [u.type, ...TYPES]).map((v) => (
              <option key={v} value={v} className="text-ink">
                {t.varType[v] ?? v}
              </option>
            ))}
          </select>
        ) : (
          <span className="px-1.5 text-[12px]" style={{ color }}>
            {t.varType[u.type]}
          </span>
        );
      },
    },
    {
      id: "initial",
      header: cols.initial,
      width: "w-[22%]",
      // Inputs the run asks for sort together, ahead of the empty ones.
      sortValue: (u) => (askedAtRun(u.def) ? "\u0000" : u.def ? defaultText(u.def) || "￿" : "￿"),
      cell: (u) =>
        u.def ? (
          // Keyed on the type and value, so a change made elsewhere (the AI, undo) or a new type,
          // which writes the value differently, shows here.
          <div className="-my-0.5">
            <InitialCell key={`${u.type}:${JSON.stringify(u.def.default) ?? ""}`} variable={u.def} onSet={(v) => void setVariable(v)} />
          </div>
        ) : (
          <span className="px-1.5 text-[12px] text-slate-300">—</span>
        ),
    },
    {
      id: "writers",
      header: cols.writers,
      width: "w-[16%]",
      hideBelow: 860,
      sortValue: (u) => u.writers.length,
      cell: (u) => <StepChips ids={u.writers} steps={flow.steps ?? []} defs={defs} onOpen={open} />,
    },
    {
      id: "readers",
      header: cols.readers,
      width: "w-[16%]",
      hideBelow: 720,
      sortValue: (u) => u.readers.length,
      cell: (u) => <StepChips ids={u.readers} steps={flow.steps ?? []} defs={defs} onOpen={open} />,
    },
    ...(changes
      ? [
          {
            id: "after",
            header: cols.after,
            width: "w-[14%]",
            hideBelow: 1000 as const,
            cell: (u: VariableUsage) => {
              const last = changes.filter((c) => c.variable === u.name).at(-1);
              return last ? (
                <HoverPreview
                  value={last.secret || last.truncated ? undefined : last.value}
                  longText
                  className="block truncate rounded-md bg-brand-50 px-1.5 font-mono text-[12px] text-brand-700"
                  title={!last.secret && !last.truncated && previewSource(last.value, { longText: true }) ? undefined : valueText(last)}
                >
                  {valueText(last)}
                </HoverPreview>
              ) : (
                <span className="text-[12px] text-slate-300">—</span>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <div className="@container h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[1320px] px-6 py-5">
        {/* As the other lists read: how many and how to narrow them, or, while rows are picked, what to do with them. */}
        <div className="mb-2 flex items-center gap-2">
          {picked.size > 0 ? (
            <SelectionBar count={picked.size} onClear={clear}>
              {pickedDefs.some((v) => !v.secret) && (
                <button
                  type="button"
                  onClick={() => {
                    for (const v of pickedDefs) if (!v.secret) void setVariable({ ...v, secret: true, default: undefined });
                    clear();
                  }}
                  className="flex h-6 items-center gap-1 rounded-md px-2 text-[12px] text-slate-700 hover:bg-slate-200 hover:text-ink"
                >
                  <Lock size={13} strokeWidth={1.75} aria-hidden="true" />
                  {t.vars.table.makeSecret}
                </button>
              )}
              <button
                type="button"
                onClick={async () => {
                  if (!confirmDelete) return setConfirmDelete(true);
                  for (const v of pickedDefs) await removeVariable(v.name);
                  clear();
                }}
                onBlur={() => setConfirmDelete(false)}
                className={`flex h-6 items-center gap-1 rounded-md px-2 text-[12px] ${confirmDelete ? "bg-shu-600 text-white" : "text-slate-700 hover:bg-shu-50 hover:text-shu-600"}`}
              >
                <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                {confirmDelete ? t.vars.table.confirmDelete(picked.size) : t.vars.table.delete}
              </button>
            </SelectionBar>
          ) : (
            <>
              <h2 className="text-[15px] font-bold">{t.vars.table.title}</h2>
              <span className="text-[12px] text-slate-500">{t.list.count(all.length)}</span>
              <div className="ml-2">
                <SearchBox value={query} onChange={setQuery} placeholder={t.vars.table.search} hits={rows.length} />
              </div>
            </>
          )}
          <span className="ml-auto text-[11px] text-slate-500">{t.vars.table.hint}</span>
        </div>
        <div className="mb-3">
          <FilterChips chips={chips} value={filter} onChange={setFilter} label={cols.direction} />
        </div>
        <div className="border-b border-slate-200 text-[12px]">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(u) => u.name}
            selected={picked}
            onSelect={setSelected}
            storageKey="shikigami.studio.variables.sort"
            empty={all.length === 0 ? t.vars.table.empty : t.list.notFound}
            rowProps={(u) => ({
              // Lights up the same variable on the chart and the inspector.
              onMouseEnter: () => focus.set(varFocus(u.name)),
              onMouseLeave: () => focus.set(null),
              onContextMenu: menuFor(() => variableMenu(u.name, { writer: u.writers[0], onOpenWriter: open, inTable: true })),
            })}
          />
          <AddRow onAdd={(name) => void setVariable({ name, type: "string", direction: "local" })} />
        </div>
      </div>
    </div>
  );
}
