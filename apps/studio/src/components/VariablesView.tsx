// The third way to look at a flow, beside the flow chart and the
// procedure: every variable in one table, with where it starts, which steps
// write it and which read it, and what it held after the last run. Editing a
// variable stays in the inspector (the flow's properties); a step here
// opens it on the chart.
import { menuFor } from "../lib/contextMenu";
import { useVariableMenu } from "./menus";
import type { Step, StepTypeDef, VarDirection, VariableDef, VarType } from "@shikigami/schema";
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

/** A new variable, at the foot of the table. */
function AddRow({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form
      className="flex items-center gap-2 border-t border-slate-200 bg-slate-50/60 px-3 py-2"
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

export function VariablesView({ onView }: { onView: (view: View) => void }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const changes = useStudio((s) => s.run?.changes);
  const goTo = useStudio((s) => s.goTo);
  const setVariable = useStudio((s) => s.setVariable);
  const variableMenu = useVariableMenu();
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const rows = useMemo(() => (flow ? variableUsage(flow.steps ?? [], flow.variables) : []), [flow]);
  if (!flow) return null;
  const open = (id: string) => {
    onView("flow");
    goTo(id);
  };
  const cols = t.vars.table.columns;
  return (
    <div className="h-full overflow-auto bg-paper">
      <div className="mx-auto max-w-[1320px] px-6 py-5">
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-[15px] font-bold">{t.vars.table.title}</h2>
          <span className="text-[12px] text-slate-400">{rows.length}</span>
          <span className="ml-auto text-[11px] text-slate-400">{t.vars.table.hint}</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-sheet">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-slate-400">{t.vars.table.empty}</p>
          ) : (
            // Fixed widths: a long node name or description wraps in its own column
            // instead of squeezing the others.
            <table className="w-full table-fixed border-collapse text-left text-[12px]">
              <colgroup>
                <col className="w-[92px]" />
                <col className="w-[24%]" />
                <col className="w-[96px]" />
                <col className="w-[20%]" />
                <col />
                <col />
                {changes && <col className="w-[14%]" />}
              </colgroup>
              <thead className="bg-slate-50 text-[11px] text-slate-500">
                <tr>
                  {[cols.direction, cols.name, cols.type, cols.initial, cols.writers, cols.readers, ...(changes ? [cols.after] : [])].map((c) => (
                    <th key={c} className="border-b border-slate-200 px-3 py-2 font-semibold whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const color = TYPE_COLOR[u.type] ?? TYPE_COLOR.any;
                  const last = changes?.filter((c) => c.variable === u.name).at(-1);
                  const unused = u.readers.length === 0 && u.direction !== "output";
                  return (
                    <tr
                      key={u.name}
                      className="border-b border-slate-100 align-top last:border-b-0 hover:bg-slate-50"
                      // Lights up the same variable on the chart and the inspector.
                      onMouseEnter={() => focus.set(varFocus(u.name))}
                      onMouseLeave={() => focus.set(null)}
                      onContextMenu={menuFor(() => variableMenu(u.name, { writer: u.writers[0], onOpenWriter: open, inTable: true }))}
                    >
                      <td className="px-3 py-2">
                        {u.def ? (
                          <select
                            value={u.direction}
                            onChange={(e) => void setVariable({ ...u.def!, direction: e.target.value as VarDirection })}
                            aria-label={`${u.name} ${cols.direction}`}
                            className={`cursor-pointer appearance-none rounded-sm border border-transparent px-1.5 text-[10px] leading-4 font-semibold hover:border-slate-300 focus:border-primary focus:outline-none ${DIRECTION_TONE[u.direction]}`}
                          >
                            {DIRECTIONS.map((d) => (
                              <option key={d} value={d}>
                                {t.direction[d]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className={`rounded-sm px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap ${DIRECTION_TONE.made}`}>{t.vars.table.made}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                          <VarIcon size={12} className="shrink-0 text-slate-400" />
                          <span className="min-w-0 truncate font-mono text-[13px] font-semibold" title={u.name}>
                            {u.name}
                          </span>
                        </div>
                        {u.def?.description && (
                          <div className="mt-0.5 line-clamp-2 pl-[30px] text-[11px] text-slate-500" title={u.def.description}>
                            {u.def.description}
                          </div>
                        )}
                        {unused && <div className="mt-0.5 pl-[30px] text-[11px] text-accent-500">{t.vars.table.unused}</div>}
                      </td>
                      <td className="px-3 py-1.5" style={{ color }}>
                        {u.def ? (
                          <select
                            value={u.type}
                            onChange={(e) => void setVariable({ ...u.def!, type: e.target.value as VarType })}
                            aria-label={`${u.name} ${cols.type}`}
                            className={`${quiet} cursor-pointer appearance-none text-[12px]`}
                          >
                            {/* A type this Studio does not know (a newer flow) stays as it is. */}
                            {(TYPES.includes(u.type) ? TYPES : [u.type, ...TYPES]).map((v) => (
                              <option key={v} value={v} className="text-ink">
                                {t.varType[v] ?? v}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="px-1.5">{t.varType[u.type]}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        {u.def ? (
                          // Keyed on the type and value, so a change made elsewhere (the AI, undo) or a new type,
                          // which writes the value differently, shows here.
                          <InitialCell key={`${u.type}:${JSON.stringify(u.def.default) ?? ""}`} variable={u.def} onSet={(v) => void setVariable(v)} />
                        ) : (
                          <span className="px-1.5 text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <StepChips ids={u.writers} steps={flow.steps ?? []} defs={defs} onOpen={open} />
                      </td>
                      <td className="px-3 py-2">
                        <StepChips ids={u.readers} steps={flow.steps ?? []} defs={defs} onOpen={open} />
                      </td>
                      {changes && (
                        <td className="max-w-[200px] px-3 py-2">
                          {last ? (
                            <HoverPreview
                              value={last.secret || last.truncated ? undefined : last.value}
                              longText
                              className="block truncate rounded-md bg-brand-50 px-1.5 font-mono text-[12px] text-brand-700"
                              title={!last.secret && !last.truncated && previewSource(last.value, { longText: true }) ? undefined : valueText(last)}
                            >
                              {valueText(last)}
                            </HoverPreview>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <AddRow onAdd={(name) => void setVariable({ name, type: "string", direction: "local" })} />
        </div>
      </div>
    </div>
  );
}
