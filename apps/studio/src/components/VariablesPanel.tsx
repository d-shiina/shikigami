import type { VarDirection, VariableDef, VarType } from "@shikigami/schema";
import { useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

const TYPES = Object.keys(t.varType) as VarType[];
const DIRECTIONS = Object.keys(t.direction) as VarDirection[];
const cell = "rounded border border-slate-300 px-1.5 py-0.5 text-xs";

function parseDefault(text: string, type: VarType): unknown {
  if (text.trim() === "") return undefined;
  if (type === "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function VariableRow({ variable }: { variable: VariableDef }) {
  const setVariable = useStudio((s) => s.setVariable);
  const removeVariable = useStudio((s) => s.removeVariable);
  const type = variable.type ?? "any";
  const defaultText =
    variable.default === undefined || variable.default === null
      ? ""
      : type === "string"
        ? String(variable.default)
        : JSON.stringify(variable.default);
  const [draft, setDraft] = useState(defaultText);
  const update = (patch: Partial<VariableDef>) => setVariable({ ...variable, ...patch });

  return (
    <li className="space-y-1 rounded border border-slate-200 p-2">
      <div className="flex items-center gap-1">
        <span className="font-mono text-sm font-medium">{variable.name}</span>
        <button
          type="button"
          className="ml-auto text-xs text-slate-400 hover:text-shu-600"
          onClick={() => removeVariable(variable.name)}
        >
          {t.remove}
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        <select className={cell} value={type} onChange={(e) => update({ type: e.target.value as VarType })}>
          {TYPES.map((v) => (
            <option key={v} value={v}>
              {t.varType[v]}
            </option>
          ))}
        </select>
        <select
          className={cell}
          value={variable.direction ?? "local"}
          onChange={(e) => update({ direction: e.target.value as VarDirection })}
        >
          {DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {t.direction[d]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={variable.secret ?? false} onChange={(e) => update({ secret: e.target.checked })} />
          {t.secret}
        </label>
      </div>
      <input
        className={`${cell} w-full font-mono`}
        placeholder={t.defaultValue}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== defaultText && update({ default: parseDefault(draft, type) })}
      />
    </li>
  );
}

export function VariablesPanel() {
  const variables = useStudio((s) => s.scenario?.variables ?? []);
  const setVariable = useStudio((s) => s.setVariable);
  const [name, setName] = useState("");

  return (
    <div className="space-y-3 p-4">
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void setVariable({ name: name.trim(), type: "string", direction: "local" });
          setName("");
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 font-mono text-sm"
          placeholder={t.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="rounded bg-ink px-2 py-1 text-sm text-paper">
          {t.addVariable}
        </button>
      </form>
      <ul className="space-y-2">
        {variables.map((v) => (
          <VariableRow key={`${v.name}:${JSON.stringify(v.default)}`} variable={v} />
        ))}
      </ul>
    </div>
  );
}
