import type { VarDirection, VariableDef, VarType } from "@shikigami/schema";
import { focus, varFocus } from "../lib/focus";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { TYPE_COLOR } from "../lib/nodeRows";
import { valueText } from "../lib/runValues";
import { findStep, type VariableChange } from "../store";
import { VarIcon } from "./VarIcon";

const TYPES = Object.keys(t.varType) as VarType[];
const DIRECTIONS = Object.keys(t.direction) as VarDirection[];
const cell = "w-full rounded-[4px] border border-slate-200 bg-sheet px-1.5 py-0.5 text-xs focus:border-brand-500 focus:outline-none";
const row = "grid grid-cols-[64px_1fr] items-center gap-2";
const rowLabel = "text-right text-[11px] text-slate-500";

function parseDefault(text: string, type: VarType): unknown {
  if (text.trim() === "") return undefined;
  if (type === "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const GROUPS: { key: "input" | "output" | "local"; directions: VarDirection[] }[] = [
  { key: "input", directions: ["input", "inOut"] },
  { key: "output", directions: ["output"] },
  { key: "local", directions: ["local"] },
];

/** How a variable changed during the last run: when, by which step, to what. */
function RunTrace({ changes }: { changes: VariableChange[] }) {
  const scenario = useStudio((s) => s.scenario);
  const goTo = useStudio((s) => s.goTo);
  if (changes.length === 0) return <p className="text-[11px] text-slate-400">{t.vars.unchanged}</p>;
  const start = Date.parse(changes[0]?.at ?? "");
  return (
    <ol className="relative space-y-1 border-l border-slate-200 pl-3">
      {changes.map((c) => {
        const step = c.stepId ? findStep(scenario?.steps ?? [], c.stepId) : null;
        const ms = Date.parse(c.at) - start;
        return (
          <li key={c.seq} className="relative text-[11px]">
            <span className="absolute top-1.5 -left-[16.5px] h-2 w-2 rounded-full border-2 border-white bg-brand-500" />
            <div className="flex items-baseline gap-1.5 text-slate-500">
              {c.stepId ? (
                <button type="button" className="truncate text-brand-600 hover:underline" onClick={() => c.stepId && goTo(c.stepId)}>
                  {step?.name || step?.type || c.stepId}
                </button>
              ) : (
                <span>{t.vars.initial}</span>
              )}
              {c.iteration != null && <span className="text-slate-400">#{c.iteration}</span>}
              <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">+{Number.isFinite(ms) ? ms : 0}ms</span>
            </div>
            <div className="truncate rounded bg-slate-100 px-1.5 font-mono text-ink" title={valueText(c)}>
              {valueText(c)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function VariableRow({ variable }: { variable: VariableDef }) {
  const changes = useStudio((s) => s.run?.changes);
  const traced = changes?.filter((c) => c.variable === variable.name) ?? [];
  const last = traced.at(-1);
  const setVariable = useStudio((s) => s.setVariable);
  const removeVariable = useStudio((s) => s.removeVariable);
  const [open, setOpen] = useState(false);
  const type = variable.type ?? "any";
  const defaultText =
    variable.default === undefined || variable.default === null
      ? ""
      : type === "string"
        ? String(variable.default)
        : // Lists and records are read one entry per line, not as one long line.
          JSON.stringify(variable.default, null, typeof variable.default === "object" ? 2 : undefined);
  const [draft, setDraft] = useState(defaultText);
  const multiline = type === "array" || type === "object" || draft.includes("\n");
  const update = (patch: Partial<VariableDef>) => setVariable({ ...variable, ...patch });
  const color = TYPE_COLOR[type] ?? TYPE_COLOR.any;
  const direction = variable.direction ?? "local";

  return (
    // One box per variable: what it is on top, its starting value below, both always in view.
    <li
      className={`rounded-[4px] border bg-sheet shadow-sheet ${open ? "border-slate-300" : "border-slate-200"}`}
      // Lights up where the flow chart reads and writes this variable.
      onMouseEnter={() => focus.set(varFocus(variable.name))}
      onMouseLeave={() => focus.set(null)}
    >
      <div className="flex items-center gap-2 px-2.5 pt-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <VarIcon size={13} className="shrink-0 text-slate-400" />
        <span className="min-w-0 truncate font-mono text-[13px] font-semibold" title={variable.name}>
          {variable.name}
        </span>
        {variable.secret && <span className="shrink-0 rounded-[2px] bg-slate-200 px-1 text-[9px] text-slate-600">{t.secret}</span>}
        <span
          className="ml-auto shrink-0 rounded-[2px] px-1.5 text-[10px] leading-4 font-semibold"
          style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
        >
          {t.varType[type]}
        </span>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={t.vars.details}
          className="-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-[3px] text-slate-400 hover:bg-slate-100 hover:text-ink"
        >
          <ChevronDown size={14} strokeWidth={1.75} className={open ? "rotate-180" : ""} aria-hidden="true" />
        </button>
      </div>
      {variable.description && <p className="px-2.5 pt-0.5 text-[11px] leading-snug text-slate-500">{variable.description}</p>}
      <div className="grid grid-cols-[48px_1fr] items-baseline gap-x-2 gap-y-1 px-2.5 pt-1.5 pb-2">
        <span className="text-[11px] text-slate-500">{t.defaultValue}</span>
        {variable.secret ? (
          // A default would be stored in plain text in the scenario.
          <span className="text-[11px] text-slate-400">—</span>
        ) : (
          multiline ? (
            <textarea
              className={`${cell} max-h-48 resize-y font-mono leading-snug`}
              rows={Math.min(8, draft.split("\n").length)}
              placeholder={t.values.none}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft !== defaultText && update({ default: parseDefault(draft, type) })}
            />
          ) : (
            <input
              className={`${cell} font-mono`}
              placeholder={t.values.none}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft !== defaultText && update({ default: parseDefault(draft, type) })}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          )
        )}
        {last && (
          <>
            <span className="text-[11px] text-brand-600">{t.vars.after}</span>
            <span className="truncate rounded-[3px] bg-brand-50 px-1.5 py-0.5 font-mono text-xs text-brand-700" title={t.vars.afterRun(traced.length)}>
              {valueText(last)}
            </span>
          </>
        )}
      </div>
      {open && (
        <div className="space-y-1 border-t border-slate-100 px-2.5 py-2">
          <label className={row}>
            <span className={rowLabel}>{t.type}</span>
            <select className={cell} value={type} onChange={(e) => update({ type: e.target.value as VarType })}>
              {TYPES.map((v) => (
                <option key={v} value={v}>
                  {t.varType[v]}
                </option>
              ))}
            </select>
          </label>
          <label className={row}>
            <span className={rowLabel}>{t.vars.direction}</span>
            <select className={cell} value={direction} onChange={(e) => update({ direction: e.target.value as VarDirection })}>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {t.direction[d]}
                </option>
              ))}
            </select>
          </label>
          <label className={row}>
            <span className={rowLabel}>{t.secret}</span>
            <input
              type="checkbox"
              className="justify-self-start"
              checked={variable.secret ?? false}
              onChange={(e) => update(e.target.checked ? { secret: true, default: undefined } : { secret: false })}
            />
          </label>
          {variable.secret && <p className="text-[11px] text-slate-400">{t.secretNoDefault}</p>}
          {changes && (
            <div className="pt-2">
              <div className="pb-1 text-[11px] font-bold text-slate-600">{t.vars.changes(traced.length)}</div>
              <RunTrace changes={traced} />
            </div>
          )}
          <div className="flex justify-end pt-1">
            <button type="button" className="text-[11px] text-slate-400 hover:text-shu-600" onClick={() => removeVariable(variable.name)}>
              {t.remove}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// One shared empty list: a selector that returns a new [] on every call
// never settles and React stops with "Maximum update depth exceeded".
const NO_VARIABLES: VariableDef[] = [];

export function VariablesPanel() {
  const variables = useStudio((s) => s.scenario?.variables ?? NO_VARIABLES);
  const setVariable = useStudio((s) => s.setVariable);
  const [name, setName] = useState("");

  return (
    <div className="space-y-4 p-4">
      {GROUPS.map((group) => {
        const members = variables.filter((v) => group.directions.includes(v.direction ?? "local"));
        return (
          <section key={group.key}>
            <div className="flex items-baseline gap-2 pb-1.5">
              <span className="text-[11px] font-bold tracking-wider text-slate-600">{t.vars.groups[group.key].title}</span>
              <span className="text-[10px] text-slate-400">{t.vars.groups[group.key].hint}</span>
              <span className="ml-auto text-[10px] text-slate-400">{members.length}</span>
            </div>
            {members.length === 0 ? (
              <p className="rounded-[4px] border border-dashed border-slate-200 px-2 py-1.5 text-[11px] text-slate-400">{t.vars.nothing}</p>
            ) : (
              <ul className="space-y-2">
                {members.map((v) => (
                  <VariableRow key={`${v.name}:${JSON.stringify(v.default)}`} variable={v} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <form
        className="flex gap-1 border-t border-slate-100 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void setVariable({ name: name.trim(), type: "string", direction: "local" });
          setName("");
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-[4px] border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs focus:border-brand-500 focus:bg-sheet focus:outline-none"
          placeholder={t.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="rounded-[3px] bg-ink px-3 py-1 text-xs text-paper hover:bg-slate-700">
          {t.addVariable}
        </button>
      </form>
    </div>
  );
}
