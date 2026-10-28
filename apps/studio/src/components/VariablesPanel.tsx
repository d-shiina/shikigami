import type { VarDirection, VariableDef, VarType } from "@shikigami/schema";
import { focus, varFocus } from "../lib/focus";
import { useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { TYPE_COLOR } from "../lib/nodeRows";
import { valueText } from "../lib/runValues";
import { findStep, type VariableChange } from "../store";

const TYPES = Object.keys(t.varType) as VarType[];
const DIRECTIONS = Object.keys(t.direction) as VarDirection[];
const cell = "w-full rounded-md border border-slate-200 bg-sheet px-1.5 py-0.5 text-xs focus:border-brand-500 focus:outline-none";
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

const GROUPS: { title: string; directions: VarDirection[]; hint: string }[] = [
  { title: "入力", directions: ["input", "inOut"], hint: "実行するときに渡す値" },
  { title: "出力", directions: ["output"], hint: "終わったときに返す値" },
  { title: "内部", directions: ["local"], hint: "シナリオの中だけで使う値" },
];

/** How a variable changed during the last run: when, by which step, to what. */
function RunTrace({ changes }: { changes: VariableChange[] }) {
  const scenario = useStudio((s) => s.scenario);
  const select = useStudio((s) => s.select);
  if (changes.length === 0) return <p className="text-[11px] text-slate-400">この実行では変わっていません</p>;
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
                <button type="button" className="truncate text-brand-600 hover:underline" onClick={() => c.stepId && select({ kind: "step", stepId: c.stepId })}>
                  {step?.name || step?.type || c.stepId}
                </button>
              ) : (
                <span>はじめの値</span>
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
        : JSON.stringify(variable.default);
  const [draft, setDraft] = useState(defaultText);
  const update = (patch: Partial<VariableDef>) => setVariable({ ...variable, ...patch });
  const color = TYPE_COLOR[type] ?? TYPE_COLOR.any;
  const direction = variable.direction ?? "local";

  return (
    <li
      className={`rounded-lg ${open ? "bg-slate-50 ring-1 ring-slate-200" : "hover:bg-slate-50"}`}
      // Lights up where the flow chart reads and writes this variable.
      onMouseEnter={() => focus.set(varFocus(variable.name))}
      onMouseLeave={() => focus.set(null)}
    >
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left">
        {direction !== "output" && <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white" style={{ background: color }} />}
        <span className="truncate font-mono text-[13px] font-semibold">{variable.name}</span>
        {variable.secret && <span className="rounded bg-slate-200 px-1 text-[9px] text-slate-600">{t.secret}</span>}
        <span className="ml-auto shrink-0 text-[10px] font-medium" style={{ color }}>
          {t.varType[type]}
        </span>
        {last ? (
          <span className="max-w-[110px] truncate rounded bg-brand-50 px-1.5 font-mono text-[10px] text-brand-700" title={`実行後の値（${traced.length}回変化）`}>
            {valueText(last)}
          </span>
        ) : (
          <span className="max-w-[90px] truncate rounded bg-slate-100 px-1.5 font-mono text-[10px] text-slate-500">{defaultText || "—"}</span>
        )}
        {direction === "output" && <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white" style={{ background: color }} />}
      </button>
      {open && (
        <div className="space-y-1 px-2 pb-2">
          {variable.description && <p className="pb-1 text-[11px] text-slate-500">{variable.description}</p>}
          <label className={row}>
            <span className={rowLabel}>型</span>
            <select className={cell} value={type} onChange={(e) => update({ type: e.target.value as VarType })}>
              {TYPES.map((v) => (
                <option key={v} value={v}>
                  {t.varType[v]}
                </option>
              ))}
            </select>
          </label>
          <label className={row}>
            <span className={rowLabel}>向き</span>
            <select className={cell} value={direction} onChange={(e) => update({ direction: e.target.value as VarDirection })}>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {t.direction[d]}
                </option>
              ))}
            </select>
          </label>
          {variable.secret ? (
            // A default would be stored in plain text in the scenario.
            <p className="text-[11px] text-slate-400">{t.secretNoDefault}</p>
          ) : (
            <label className={row}>
              <span className={rowLabel}>{t.defaultValue}</span>
              <input
                className={`${cell} font-mono`}
                placeholder="（なし）"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => draft !== defaultText && update({ default: parseDefault(draft, type) })}
              />
            </label>
          )}
          <label className={row}>
            <span className={rowLabel}>{t.secret}</span>
            <input
              type="checkbox"
              className="justify-self-start"
              checked={variable.secret ?? false}
              onChange={(e) => update(e.target.checked ? { secret: true, default: undefined } : { secret: false })}
            />
          </label>
          {changes && (
            <div className="pt-2">
              <div className="pb-1 text-[11px] font-bold text-slate-600">実行中の変化（{traced.length}回）</div>
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
          <section key={group.title}>
            <div className="flex items-baseline gap-2 px-2 pb-1">
              <span className="text-[11px] font-bold tracking-wider text-slate-600">{group.title}</span>
              <span className="text-[10px] text-slate-400">{group.hint}</span>
              <span className="ml-auto text-[10px] text-slate-400">{members.length}</span>
            </div>
            {members.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-2 py-1.5 text-[11px] text-slate-400">なし</p>
            ) : (
              <ul className="space-y-0.5">
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
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs focus:border-brand-500 focus:bg-sheet focus:outline-none"
          placeholder={t.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="rounded-full bg-ink px-3 py-1 text-xs text-paper hover:bg-slate-700">
          {t.addVariable}
        </button>
      </form>
    </div>
  );
}
