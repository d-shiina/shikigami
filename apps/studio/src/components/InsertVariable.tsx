// Using other nodes' results without typing `{{ … }}` by hand: a text field
// with 「変数」 that lists the columns of the row being repeated (read from
// the Excel/CSV file before any run) and the flow's other variables, and the
// list a repeat walks over chosen from the results of the nodes above it.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { Braces } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { fieldAccess } from "../lib/expr";
import { t } from "../lib/i18n";
import { enclosingLoops, listSources, otherVariables, resultStep, TABLE_READERS } from "../lib/loopScope";
import { columnsOf, type RunScope } from "../lib/runScope";
import { typeTitle } from "../lib/sentence";

export interface InsertChoices {
  /** The repeats around the node, innermost first, with the columns of their rows. */
  loops: { itemVar: string; columns: string[] }[];
  variables: string[];
}

const InsertContext = createContext<InsertChoices | null>(null);
export const InsertProvider = InsertContext.Provider;

/**
 * The field last focused, so the editor's 「使える値」 column can put a value
 * into it with one click. `insert` takes a plain expression (`item.顧客`)
 * and wraps it the way the field needs.
 */
export type ActiveField = { label: string; insert: (expression: string) => void };
let activeField: ActiveField | null = null;
const fieldWatchers = new Set<() => void>();
export function setActiveField(field: ActiveField | null) {
  // Losing focus to the editor's own buttons must not forget the field.
  if (field === null && activeField === null) return;
  activeField = field;
  for (const w of fieldWatchers) w();
}
/** Forgets `field` when it is the one registered: its input is gone (the row removed, the editor closed). */
export function dropActiveField(field: ActiveField) {
  if (activeField === field) setActiveField(null);
}
/** A field that registers on focus and forgets itself when it unmounts. */
export function useFieldRegistration(label: string | undefined, insert: (expression: string) => void): () => void {
  const self = useRef<ActiveField | null>(null);
  const latest = useRef(insert);
  latest.current = insert;
  useEffect(() => () => {
    if (self.current) dropActiveField(self.current);
  }, []);
  return () => {
    if (!label) return;
    self.current ??= { label, insert: (expression) => latest.current(expression) };
    self.current.label = label;
    setActiveField(self.current);
  };
}
export function useActiveField(): ActiveField | null {
  return useSyncExternalStore(
    (w) => {
      fieldWatchers.add(w);
      return () => fieldWatchers.delete(w);
    },
    () => activeField,
  );
}

/**
 * What a node's fields can insert. Columns come from the last run when it
 * left the table, otherwise from the file the table is read from.
 */
export function useInsertChoices(step: Step, scope: RunScope): InsertChoices {
  const flow = useStudio((s) => s.flow);
  const steps = flow?.steps ?? [];
  const loops = useMemo(() => enclosingLoops(steps, step.id ?? ""), [steps, step.id]);
  // The table-reading nodes the loops walk over, as a stable key for reading their files.
  const readers = loops
    .map((l) => (l.items ? resultStep(steps, l.items) : null))
    .map((s) => (s && TABLE_READERS.has(s.type) ? { type: s.type, params: s.params ?? {} } : null));
  const key = JSON.stringify(readers);
  const [fromFiles, setFromFiles] = useState<(string[] | null)[]>([]);
  useEffect(() => {
    if (!flow?.id) return;
    let live = true;
    Promise.all(readers.map((r) => (r ? api.tableColumns(flow.id, r.type, r.params).catch(() => []) : Promise.resolve(null)))).then(
      (cols) => live && setFromFiles(cols),
    );
    return () => {
      live = false;
    };
  }, [flow?.id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(
    () => ({
      loops: loops.map((l, i) => {
        const fromRun = l.items ? columnsOf(scope.values[l.items]) : [];
        return {
          itemVar: l.itemVar,
          columns: fromRun.length > 0 ? fromRun : (fromFiles[i] ?? []),
        };
      }),
      variables: otherVariables(flow?.variables, steps, loops),
    }),
    [loops, fromFiles, scope, flow?.variables, steps],
  );
}

/** The columns per loop variable, for the expression fields' suggestions. */
export function columnsByVariable(choices: InsertChoices): Record<string, string[]> {
  return Object.fromEntries(choices.loops.map((l) => [l.itemVar, l.columns]));
}

const inputClass = "w-full rounded-[4px] border border-slate-200 bg-sheet px-2 py-1 text-[13px] text-ink outline-none focus:border-brand-500";

/** A text field that can take variables: 「変数」 inserts `{{ item.顧客 }}` where the cursor is. */
export function TemplateInput({
  value,
  onCommit,
  placeholder,
  className,
  label,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** The setting's name, for 「クリックで「入力する文字」に入ります」. */
  label?: string;
}) {
  const choices = useContext(InsertContext);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const commit = (text = draft) => text !== value && onCommit(text);
  const insert = (expression: string) => {
    // Where the cursor is now when the field still has the focus (a click in
    // 「使える値」 keeps it), else where it was when the field lost it.
    const live = input.current && document.activeElement === input.current ? input.current.selectionStart : null;
    const at = live ?? caret.current ?? draft.length;
    const text = `${draft.slice(0, at)}{{ ${expression} }}${draft.slice(at)}`;
    setDraft(text);
    setOpen(false);
    commit(text);
    caret.current = at + expression.length + 6;
    if (live !== null) requestAnimationFrame(() => input.current?.setSelectionRange(caret.current, caret.current));
  };
  // The draft the registered insert sees is the latest one.
  const register = useFieldRegistration(label, insert);
  const field = (
    <input
      ref={input}
      className={className ?? inputClass}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={register}
      onBlur={(e) => {
        caret.current = e.target.selectionStart;
        commit();
      }}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
  if (!choices) return field;
  return (
    // A span, not a label: the row's <label> would send clicks in the menu to the field.
    <span ref={box} className="relative flex gap-1">
      {field}
      <button
        type="button"
        title={t.props.insertTitle}
        aria-expanded={open}
        className="flex shrink-0 items-center gap-1 rounded-[4px] border border-slate-200 px-1.5 text-[11px] text-slate-600 hover:border-brand-500 hover:text-brand-600"
        onMouseDown={(e) => {
          // Keep where the cursor was in the field.
          caret.current = input.current?.selectionStart ?? caret.current;
          e.preventDefault();
        }}
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
      >
        <Braces size={12} />
        {t.props.insert}
      </button>
      {open && <InsertMenu choices={choices} onPick={insert} />}
    </span>
  );
}

function InsertMenu({ choices, onPick }: { choices: InsertChoices; onPick: (expression: string) => void }) {
  const item = (key: string, label: string, expression: string, note?: string) => (
    <button
      key={key}
      type="button"
      className="flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-[12px] hover:bg-brand-50"
      onClick={(e) => {
        e.preventDefault();
        onPick(expression);
      }}
    >
      <span className="truncate text-ink">{label}</span>
      {note && <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{note}</span>}
    </button>
  );
  const heading = (text: string) => <div className="px-2.5 pt-2 pb-0.5 text-[10px] font-semibold text-slate-500">{text}</div>;
  const empty = choices.loops.length === 0 && choices.variables.length === 0;
  return (
    <div
      role="menu"
      className="absolute top-full right-0 z-30 mt-1 max-h-72 w-64 overflow-y-auto rounded-[4px] border border-slate-200 bg-sheet pb-1 shadow-lg"
    >
      {empty && <div className="px-2.5 py-2 text-[12px] text-slate-500">{t.props.insertNone}</div>}
      {choices.loops.map((l) => (
        <div key={l.itemVar}>
          {heading(t.props.insertRow(l.itemVar))}
          {l.columns.map((c) => item(`${l.itemVar}:${c}`, c, `${l.itemVar}${fieldAccess(c)}`, `${l.itemVar}${fieldAccess(c)}`))}
          {l.columns.length === 0 && <div className="px-2.5 py-1 text-[11px] leading-snug text-slate-500">{t.props.insertNoColumns}</div>}
          {item(`${l.itemVar}:*`, t.props.insertWhole(l.itemVar), l.itemVar)}
        </div>
      ))}
      {choices.variables.length > 0 && heading(t.props.insertOthers)}
      {choices.variables.map((v) => item(`v:${v}`, v, v))}
    </div>
  );
}

/**
 * A repeat's list: the results of the nodes above it to choose from, or an
 * expression for anything else (`orders.filter(…)`).
 */
export function ListSourceField({
  step,
  defs,
  value,
  onChange,
  expression,
}: {
  step: Step;
  defs: StepTypeDef[];
  value: string;
  onChange: (value: string | null) => void;
  /** The expression field, for a list that is not just a variable. */
  expression: React.ReactNode;
}) {
  const flow = useStudio((s) => s.flow);
  const sources = useMemo(() => listSources(flow?.variables, flow?.steps ?? [], step.id ?? ""), [flow, step.id]);
  // `[]` is the empty list a repeat used to start with: nothing chosen yet.
  const trimmed = value.trim() === "[]" ? "" : value.trim();
  const chosen = sources.some((s) => s.name === trimmed);
  const [writing, setWriting] = useState(false);
  const showExpr = writing || (trimmed !== "" && !chosen);
  const nodeName = (s: Step) =>
    s.name ||
    typeTitle(
      s,
      defs.find((d) => d.type === s.type),
    );
  return (
    <span className="block space-y-1">
      <select
        className={inputClass}
        value={showExpr ? "\u0000expr" : trimmed}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "\u0000expr") return setWriting(true);
          setWriting(false);
          onChange(v || null);
        }}
      >
        <option value="">{t.props.listChoose}</option>
        {sources.map((s) => (
          <option key={s.name} value={s.name}>
            {s.step ? t.props.listFrom(s.name, nodeName(s.step)) : s.name}
          </option>
        ))}
        <option value={"\u0000expr"}>{t.props.listExpr}</option>
      </select>
      {showExpr && expression}
      <span className="block text-[10px] leading-snug text-slate-400">{sources.length === 0 ? t.props.listEmpty : t.props.listSourceHint}</span>
    </span>
  );
}
