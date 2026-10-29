// The third way to look at a scenario, beside the flow chart and the
// procedure: every variable in one table, with where it starts, which steps
// write it and which read it, and what it held after the last run. Editing a
// variable stays in the inspector (the scenario's properties); a step here
// opens it on the chart.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { useMemo } from "react";
import { useStudio } from "../context";
import { varFocus, focus } from "../lib/focus";
import { stepLabel, t } from "../lib/i18n";
import { TYPE_COLOR } from "../lib/nodeRows";
import { valueText } from "../lib/runValues";
import { variableUsage, type VariableUsage } from "../lib/variableUsage";
import { findStep } from "../store";
import type { View } from "./Toolbar";
import { VarIcon } from "./VarIcon";

function initialText(u: VariableUsage): string {
  const value = u.def?.default;
  if (u.def?.secret) return t.secret;
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

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
            title={t.vars.table.openStep}
            className="max-w-[180px] truncate rounded-[3px] border border-slate-200 bg-sheet px-1.5 text-[11px] leading-5 text-slate-700 hover:border-brand-500 hover:text-brand-700"
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

export function VariablesView({ onView }: { onView: (view: View) => void }) {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const changes = useStudio((s) => s.run?.changes);
  const goTo = useStudio((s) => s.goTo);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const rows = useMemo(() => (scenario ? variableUsage(scenario.steps ?? [], scenario.variables) : []), [scenario]);
  if (!scenario) return null;
  const open = (id: string) => {
    onView("flow");
    goTo(id);
  };
  const cols = t.vars.table.columns;
  return (
    <div className="h-full overflow-auto bg-paper">
      <div className="mx-auto max-w-[1200px] px-6 py-5">
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-[15px] font-bold">{t.vars.table.title}</h2>
          <span className="text-[12px] text-slate-400">{rows.length}</span>
          <span className="ml-auto text-[11px] text-slate-400">{t.vars.table.hint}</span>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-[4px] border border-dashed border-slate-300 px-4 py-8 text-center text-[13px] text-slate-400">{t.vars.table.empty}</p>
        ) : (
          <div className="overflow-hidden rounded-[4px] border border-slate-200 bg-sheet shadow-sheet">
            <table className="w-full border-collapse text-left text-[12px]">
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
                  const initial = initialText(u);
                  const last = changes?.filter((c) => c.variable === u.name).at(-1);
                  const unused = u.readers.length === 0 && u.direction !== "output";
                  return (
                    <tr
                      key={u.name}
                      className="border-b border-slate-100 align-top last:border-b-0 hover:bg-slate-50"
                      // Lights up the same variable on the chart and the inspector.
                      onMouseEnter={() => focus.set(varFocus(u.name))}
                      onMouseLeave={() => focus.set(null)}
                    >
                      <td className="px-3 py-2">
                        <span className={`rounded-[2px] px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap ${DIRECTION_TONE[u.direction]}`}>
                          {u.direction === "made" ? t.vars.table.made : t.direction[u.direction]}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                          <VarIcon size={12} className="shrink-0 text-slate-400" />
                          <span className="font-mono text-[13px] font-semibold">{u.name}</span>
                        </div>
                        {u.def?.description && <div className="mt-0.5 pl-[30px] text-[11px] text-slate-500">{u.def.description}</div>}
                        {unused && <div className="mt-0.5 pl-[30px] text-[11px] text-accent-500">{t.vars.table.unused}</div>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color }}>
                        {t.varType[u.type]}
                      </td>
                      <td className="max-w-[240px] px-3 py-2">
                        {initial ? (
                          <span className="block truncate font-mono text-[12px] text-ink" title={initial}>
                            {initial}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <StepChips ids={u.writers} steps={scenario.steps ?? []} defs={defs} onOpen={open} />
                      </td>
                      <td className="px-3 py-2">
                        <StepChips ids={u.readers} steps={scenario.steps ?? []} defs={defs} onOpen={open} />
                      </td>
                      {changes && (
                        <td className="max-w-[200px] px-3 py-2">
                          {last ? (
                            <span className="block truncate rounded-[3px] bg-brand-50 px-1.5 font-mono text-[12px] text-brand-700" title={valueText(last)}>
                              {valueText(last)}
                            </span>
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
          </div>
        )}
      </div>
    </div>
  );
}
