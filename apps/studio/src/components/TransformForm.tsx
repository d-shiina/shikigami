// The parameters of a "変数に代入": the variable, and what goes in it as a
// form ("表の列を集計" · 表 · 列) when the expression has one of the shapes in
// lib/transforms.ts, or an expression field otherwise. The form only writes
// the expression; the flow keeps `{ name, expression }` as before.
import type { Step, StepPatch } from "@shikigami/schema";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { t } from "../lib/i18n";
import { TYPE_COLOR } from "../lib/nodeRows";
import { groupLabel } from "../lib/palette";
import { columnsOf, type RunScope, shortValue } from "../lib/runScope";
import {
  build,
  carryOver,
  type Category,
  choiceLabel,
  columnOf,
  columnSource,
  optionalSlots,
  recognize,
  type SlotKind,
  type Slots,
  slotsOf,
  splitParts,
  textOf,
  textSource,
  TRANSFORMS,
  transformByKey,
  type ValueKind,
  valueKind,
  wordsOf,
} from "../lib/transforms";
import { ExpressionField, ResultLine, useResult } from "./ExpressionField";

const inputClass =
  "w-full rounded-[4px] border border-slate-200 bg-slate-50 px-2 py-1 text-xs focus:border-brand-500 focus:bg-sheet focus:outline-none";

const CATEGORIES: Category[] = ["text", "number", "date", "list"];

/** A "項目 | 値" row like the inspector's other rows (a div: it holds several controls). */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-start gap-x-2 py-1">
      <span className="flex min-h-[26px] items-center justify-end text-right text-[11px] leading-tight text-slate-500">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Text field that commits on blur / Enter. */
function Commit({ value, onCommit, placeholder, list, mono }: { value: string; onCommit: (v: string) => void; placeholder?: string; list?: string; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <input
      className={`${inputClass} ${mono ? "font-mono" : ""}`}
      value={draft}
      list={list}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

export function VariableSetForm({
  step,
  types,
  scope,
  update,
}: {
  step: Step;
  types: Map<string, string | undefined>;
  scope: RunScope;
  update: (p: StepPatch) => void;
}) {
  const params = step.params ?? {};
  const expression = typeof params.expression === "string" ? params.expression : "";
  const match = useMemo(() => recognize(expression), [expression]);
  // "式を書く" chosen while the expression still has a form's shape.
  const [free, setFree] = useState(false);
  useEffect(() => setFree(false), [step.id]);
  const showForm = Boolean(match) && !free;
  const known = useMemo(() => new Set(types.keys()), [types]);
  const result = useResult(showForm ? expression : "", known, scope);

  const write = (next: Record<string, unknown>) => update({ replaceParams: { ...params, ...next } });
  const setExpression = (expr: string) => write({ expression: expr });
  const setSlots = (slots: Slots) => {
    if (!match) return;
    const expr = build(match.def, slots);
    if (expr !== null) setExpression(expr);
  };
  const choose = (key: string) => {
    if (key === "") {
      setFree(true);
      return;
    }
    const def = transformByKey.get(key);
    if (!def) return;
    setFree(false);
    const expr = build(def, carryOver(match, def));
    if (expr !== null) setExpression(expr);
  };

  return (
    <>
      <Line label={`${t.transforms.transform}`}>
        <select className={inputClass} value={showForm ? match!.def.key : ""} onChange={(e) => choose(e.target.value)} aria-label={t.transforms.transform}>
          <option value="">{t.transforms.freeExpression}</option>
          {CATEGORIES.map((c) => (
            <optgroup key={c} label={groupLabel(c)}>
              {TRANSFORMS.filter((d) => d.category === c).map((d) => (
                <option key={d.key} value={d.key}>
                  {wordsOf(d).label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {showForm && <span className="mt-0.5 block text-[10px] leading-snug text-slate-500">{wordsOf(match!.def).description}</span>}
      </Line>
      {showForm ? (
        <>
          <SlotFields match={match!} types={types} scope={scope} onChange={setSlots} />
          <Line label={`${variableLabel()} *`}>
            <Commit value={String(params.name ?? "")} onCommit={(v) => write({ name: v.trim() })} />
          </Line>
          <div className="pl-[92px]">
            <ResultLine result={result} />
          </div>
          <details className="mt-1.5 pl-[92px]">
            <summary className="cursor-pointer list-none text-[11px] text-brand-600 select-none hover:underline">{t.transforms.editExpression}</summary>
            <div className="pt-1">
              <ExpressionField value={expression} onCommit={setExpression} types={types} scope={scope} label={t.transforms.expression} noResult />
            </div>
          </details>
        </>
      ) : (
        <>
          <Line label={t.transforms.expression}>
            <ExpressionField value={expression} onCommit={setExpression} types={types} scope={scope} label={t.transforms.expression} />
            {free && match === null && expression !== "" && <span className="mt-0.5 block text-[10px] text-slate-500">{t.transforms.notRecognized}</span>}
          </Line>
          <Line label={`${variableLabel()} *`}>
            <Commit value={String(params.name ?? "")} onCommit={(v) => write({ name: v.trim() })} />
          </Line>
        </>
      )}
    </>
  );
}

const variableLabel = () => t.transforms.target;

function SlotFields({
  match,
  types,
  scope,
  onChange,
}: {
  match: NonNullable<ReturnType<typeof recognize>>;
  types: Map<string, string | undefined>;
  scope: RunScope;
  onChange: (slots: Slots) => void;
}) {
  const { def, slots } = match;
  const words = wordsOf(def);
  const optional = optionalSlots(def);
  const set = (name: string, value: string) => onChange({ ...slots, [name]: value });
  const tableValue = scope.values[(slots.table ?? "").trim()];
  const listId = `cols-${def.key}`;
  return (
    <>
      {slotsOf(def).map(({ name, kind }) => {
        if (kind === "param") return null;
        const label = `${words.slots[name] ?? name}${optional.has(name) || kind === "choice" ? "" : " *"}`;
        return (
          <Line key={name} label={label}>
            <SlotEditor
              kind={kind}
              value={slots[name] ?? ""}
              options={def.choices?.[name]}
              slot={name}
              types={types}
              scope={scope}
              optional={optional.has(name)}
              columns={kind === "col" ? columnsOf(tableValue) : undefined}
              listId={listId}
              onChange={(v) => set(name, v)}
            />
          </Line>
        );
      })}
    </>
  );
}

function SlotEditor({
  kind,
  value,
  options,
  slot,
  types,
  scope,
  optional,
  columns,
  listId,
  onChange,
}: {
  kind: SlotKind;
  value: string;
  options?: string[];
  slot: string;
  types: Map<string, string | undefined>;
  scope: RunScope;
  optional: boolean;
  columns?: string[];
  listId: string;
  onChange: (v: string) => void;
}) {
  switch (kind) {
    case "var":
      return <VariableSelect value={value} types={types} scope={scope} onChange={onChange} />;
    case "text":
      return <Commit value={textOf(value) ?? value} onCommit={(v) => onChange(textSource(v))} />;
    case "num":
      return (
        <Commit
          value={value}
          onCommit={(v) => {
            const n = v.trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
            if (n === "" ? optional : /^-?\d+(\.\d+)?$/.test(n)) onChange(n);
          }}
        />
      );
    case "col":
      return (
        <>
          <Commit value={columnOf(value)} list={columns?.length ? listId : undefined} placeholder={t.transforms.columnPlaceholder} onCommit={(v) => v.trim() && onChange(columnSource(v.trim()))} />
          {columns && columns.length > 0 && (
            <datalist id={listId}>
              {columns.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          )}
        </>
      );
    case "choice":
      return (
        <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
          {(options ?? []).map((o) => (
            <option key={o} value={o}>
              {choiceLabel(slot, o)}
            </option>
          ))}
        </select>
      );
    case "value":
    case "date":
      return <ValueEditor value={value} date={kind === "date"} types={types} scope={scope} onChange={onChange} />;
    case "parts":
      return <PartsEditor value={value} types={types} scope={scope} onChange={onChange} />;
    default:
      return null;
  }
}

/** A variable of the flow, with its last value beside the name. */
function VariableSelect({ value, types, scope, onChange }: { value: string; types: Map<string, string | undefined>; scope: RunScope; onChange: (v: string) => void }) {
  const names = [...types.keys()];
  const color = TYPE_COLOR[types.get(value.split(/[.[]/)[0] ?? "") ?? "any"];
  return (
    <select
      className={`${inputClass} font-mono`}
      style={{ color: types.has(value.split(/[.[]/)[0] ?? "") ? color : undefined }}
      value={value}
      onChange={(e) => e.target.value && onChange(e.target.value)}
    >
      {!value && <option value="">{t.transforms.chooseVariable}</option>}
      {!names.includes(value) && value && <option value={value}>{value}</option>}
      {names.map((n) => {
        const v = shortValue(scope.values[n], 24);
        return (
          <option key={n} value={n}>
            {v ? `${n}　${v}` : n}
          </option>
        );
      })}
    </select>
  );
}

const VALUE_KINDS: ValueKind[] = ["variable", "text", "number"];
const DATE_KINDS: ValueKind[] = ["today", "now", "variable", "text"];

/** A variable, text or a number (or today / now for a date). */
function ValueEditor({ value, date, types, scope, onChange }: { value: string; date?: boolean; types: Map<string, string | undefined>; scope: RunScope; onChange: (v: string) => void }) {
  const current = valueKind(value);
  const kinds = date ? DATE_KINDS : VALUE_KINDS;
  const switchTo = (k: ValueKind) => {
    if (k === current) return;
    if (k === "today") onChange("today()");
    else if (k === "now") onChange("now()");
    else if (k === "text") onChange(textSource(current === "number" ? value : ""));
    else if (k === "number") onChange("0");
    else onChange([...types.keys()][0] ?? "x");
  };
  return (
    <div className="flex items-center gap-1">
      <select className={`${inputClass.replace("w-full", "w-[76px]")} shrink-0`} value={current} onChange={(e) => switchTo(e.target.value as ValueKind)} aria-label={t.transforms.transform}>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {t.transforms.kinds[k]}
          </option>
        ))}
      </select>
      <div className="min-w-0 flex-1">
        {current === "variable" ? (
          <VariableSelect value={value} types={types} scope={scope} onChange={onChange} />
        ) : current === "text" ? (
          <Commit value={textOf(value) ?? ""} onCommit={(v) => onChange(textSource(v))} />
        ) : current === "number" ? (
          <Commit value={value} onCommit={(v) => /^-?\d+(\.\d+)?$/.test(v.trim()) && onChange(v.trim())} />
        ) : null}
      </div>
    </div>
  );
}

/** `a + ' ' + b`: one value per line, with 追加 and 削除. */
function PartsEditor({ value, types, scope, onChange }: { value: string; types: Map<string, string | undefined>; scope: RunScope; onChange: (v: string) => void }) {
  const parts = splitParts(value);
  const write = (next: string[]) => onChange(next.join(" + "));
  return (
    <div className="space-y-1">
      {parts.map((p, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <ValueEditor value={p} types={types} scope={scope} onChange={(v) => write(parts.map((x, j) => (j === i ? v : x)))} />
          </div>
          <button
            type="button"
            title={t.transforms.removePart}
            disabled={parts.length <= 2}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-[3px] text-slate-500 hover:bg-shu-50 hover:text-shu-600 disabled:opacity-40"
            onClick={() => write(parts.filter((_, j) => j !== i))}
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <button type="button" className="text-[11px] text-brand-600 hover:underline" onClick={() => write([...parts, "''"])}>
        ＋{t.transforms.addPart}
      </button>
    </div>
  );
}
