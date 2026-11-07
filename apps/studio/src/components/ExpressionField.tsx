// The field for an expression: variables shown in their type's colour so
// they stand apart from text and numbers, suggestions of variables, table
// columns and functions (with what each does), the function being written
// above the field, and the result under it computed by Core with the values
// of the last run. The flow keeps the expression exactly as typed.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { formatValue } from "../lib/changes";
import { explainError } from "../lib/errorText";
import { classify, cursorContext, isPlainName, type Piece, paramSource, readsVariables } from "../lib/expr";
import { locale, t } from "../lib/i18n";
import { TYPE_COLOR } from "../lib/nodeRows";
import { normalize } from "../lib/palette";
import { columnsOf, type RunScope, sampleOf, shortValue } from "../lib/runScope";
import { useFieldRegistration } from "./InsertVariable";

/** Fonts and spacing shared by the field and the coloured copy under it, so the letters line up. */
const BOX = "block w-full rounded-lg border px-2 py-1 font-mono text-xs leading-5 whitespace-pre-wrap break-all";

type Suggestion = {
  key: string;
  kind: "variable" | "column" | "function";
  label: string;
  /** Replaces the word being typed (from `from` to the cursor). */
  insert: string;
  from: number;
  /** Where the cursor goes, counted from the start of `insert`. */
  caret?: number;
  note: string;
  color?: string;
};

function pieceStyle(p: Piece, types: Map<string, string | undefined>): React.CSSProperties | undefined {
  switch (p.role) {
    case "variable": {
      const color = TYPE_COLOR[types.get(p.text) ?? "any"] ?? TYPE_COLOR.any;
      // A tinted band without padding, so the field's letters stay aligned.
      const bg = `color-mix(in srgb, ${color} 16%, transparent)`;
      return { color, background: bg, boxShadow: `0 0 0 1.5px ${bg}`, borderRadius: 2 };
    }
    case "unknown":
      return { color: "var(--color-shu-600)", textDecoration: "underline wavy", textUnderlineOffset: 3 };
    case "param":
      return { color: "var(--color-slate-500)" };
    case "function":
      return { color: "var(--color-brand-700)" };
    case "string":
      return { color: "var(--color-moegi-500)" };
    case "number":
      return { color: "var(--color-slate-700)" };
    case "operator":
      return { color: "var(--color-slate-500)" };
    case "error":
      return { color: "var(--color-shu-600)" };
    default:
      return undefined;
  }
}

export function ExpressionField({
  value,
  onCommit,
  types,
  scope,
  placeholder,
  autoFocus,
  label,
  noResult,
}: {
  value: string;
  onCommit: (value: string) => void;
  /** The flow's variables and their types. */
  types: Map<string, string | undefined>;
  scope: RunScope;
  placeholder?: string;
  autoFocus?: boolean;
  label?: string;
  /** The form above already shows the result. */
  noResult?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  const known = useMemo(() => new Set(types.keys()), [types]);
  const pieces = useMemo(() => classify(draft, known), [draft, known]);
  const context = useMemo(() => cursorContext(draft, cursor), [draft, cursor]);
  const suggestions = useMemo(() => (open ? suggest(draft, context, types, scope) : []), [open, draft, context, types, scope]);
  const result = useResult(noResult ? "" : draft, known, scope);

  // Grow with the text instead of scrolling inside a small box.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const commit = () => draft !== value && onCommit(draft);
  const sync = () => setCursor(area.current?.selectionStart ?? 0);
  const accept = (s: Suggestion) => {
    const next = draft.slice(0, s.from) + s.insert + draft.slice(cursor);
    const at = s.from + (s.caret ?? s.insert.length);
    setDraft(next);
    setOpen(false);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
      setCursor(at);
    });
  };

  const help = context.call ? t.functionHelp[context.call.name] : undefined;
  const latest = useRef({ draft, cursor });
  latest.current = { draft, cursor };
  const insertAt = (expression: string) => {
    const { draft, cursor } = latest.current;
    const next = draft.slice(0, cursor) + expression + draft.slice(cursor);
    const at = cursor + expression.length;
    setDraft(next);
    setCursor(at);
    onCommit(next);
    requestAnimationFrame(() => area.current?.setSelectionRange(at, at));
  };
  const register = useFieldRegistration(label, insertAt);

  return (
    <div className="relative">
      {focused && help && context.call && (
        <div className="mb-0.5 truncate text-[10.5px] leading-4 text-slate-500" title={help.summary}>
          <span className="font-mono text-ink">
            {context.call.name}(
            {help.args.map((a, i) => (
              <span key={i} className={i === context.call!.arg ? "font-bold text-brand-700" : undefined}>
                {i > 0 && ", "}
                {a}
              </span>
            ))}
            )
          </span>{" "}
          {help.label}：{help.summary}
        </div>
      )}
      <div className={`relative rounded-lg ${focused ? "bg-sheet" : "bg-slate-50"}`}>
        <div aria-hidden="true" className={`${BOX} pointer-events-none absolute inset-0 border-transparent text-ink`}>
          {pieces.map((p, i) => (
            <span key={i} style={pieceStyle(p, types)}>
              {p.text}
            </span>
          ))}
          {/* Keeps the last line's height when the text ends with a line break. */}
          {"​"}
        </div>
        <textarea
          ref={area}
          rows={1}
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          title={t.exprField.hint}
          className={`${BOX} relative resize-none overflow-hidden border-slate-200 bg-transparent text-transparent caret-ink placeholder:text-slate-400 focus:border-primary focus:outline-none`}
          onChange={(e) => {
            setDraft(e.target.value.replace(/\r?\n/g, " "));
            setCursor(e.target.selectionStart);
            setOpen(true);
            setActive(0);
          }}
          onSelect={sync}
          onClick={sync}
          onFocus={() => {
            setFocused(true);
            register();
          }}
          onBlur={() => {
            setFocused(false);
            setOpen(false);
            commit();
          }}
          onKeyDown={(e) => {
            // Enter while converting with an IME confirms the conversion.
            if (e.nativeEvent.isComposing) return;
            if (e.key === " " && e.ctrlKey) {
              e.preventDefault();
              setOpen(true);
              return;
            }
            if (open && suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                accept(suggestions[Math.min(active, suggestions.length - 1)]!);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                return;
              }
            }
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      </div>
      {focused && open && suggestions.length > 0 && (
        <ul
          role="listbox"
          className="absolute right-0 left-0 z-30 mt-0.5 max-h-64 overflow-auto rounded-md border border-slate-200 bg-sheet py-1 text-[12px] shadow-lifted"
        >
          {suggestions.map((s, i) => {
            const heading = i === 0 || suggestions[i - 1]!.kind !== s.kind;
            return (
              <li key={s.key}>
                {heading && (
                  <div className="px-2.5 pt-1 pb-0.5 text-[10px] text-slate-400">
                    {s.kind === "variable" ? t.exprField.variables : s.kind === "column" ? t.exprField.columns(paramSource(draft, context.owner ?? "") ?? context.owner ?? "") : t.exprField.functions}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  // Keep the focus in the field.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center gap-2 px-2.5 py-0.5 text-left ${i === active ? "bg-brand-50" : ""}`}
                >
                  <span className="shrink-0 font-mono" style={s.color ? { color: s.color } : undefined}>
                    {s.label}
                  </span>
                  <span className="ml-auto min-w-0 truncate text-[11px] text-slate-500">{s.note}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ResultLine result={result} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestions

function suggest(source: string, ctx: ReturnType<typeof cursorContext>, types: Map<string, string | undefined>, scope: RunScope): Suggestion[] {
  const word = normalize(ctx.word);
  const matches = (text: string) => word === "" || normalize(text).includes(word);
  const out: Suggestion[] = [];
  if (ctx.owner) {
    // A column: of the table a `r =>` walks over, or of a record variable.
    const table = paramSource(source, ctx.owner) ?? ctx.owner;
    const value = scope.values[table];
    const known = columnsOf(value);
    for (const col of known.length > 0 ? known : (scope.columns?.[table] ?? [])) {
      if (!matches(col)) continue;
      const plain = isPlainName(col);
      // `['税込 金額']` replaces the `.` too.
      out.push({
        key: `c:${col}`,
        kind: "column",
        label: col,
        insert: plain ? col : `['${col.replace(/'/g, "\\'")}']`,
        from: plain ? ctx.from : ctx.from - 1,
        note: shortValue(sampleOf(value, col)),
      });
    }
    return out.slice(0, 12);
  }
  for (const [name, type] of types) {
    if (!matches(name)) continue;
    out.push({
      key: `v:${name}`,
      kind: "variable",
      label: name,
      insert: name,
      from: ctx.from,
      note: shortValue(scope.values[name]),
      color: TYPE_COLOR[type ?? "any"],
    });
  }
  const vars = out.slice(0, 6);
  const fns: Suggestion[] = [];
  if (ctx.word !== "") {
    for (const [name, help] of Object.entries(t.functionHelp)) {
      if (!matches(`${name} ${help.label}`)) continue;
      fns.push({ key: `f:${name}`, kind: "function", label: name, insert: `${name}()`, caret: name.length + 1, from: ctx.from, note: help.label });
    }
    // Names that start with the word first.
    fns.sort((a, b) => Number(!normalize(a.label).startsWith(word)) - Number(!normalize(b.label).startsWith(word)));
  }
  return [...vars, ...fns.slice(0, 6)];
}

// ---------------------------------------------------------------------------
// The result under the field

export type Result =
  | { kind: "none" }
  | { kind: "value"; value: unknown; partial: boolean }
  | { kind: "needsRun" }
  | { kind: "error"; what: string; todo: string };

export function useResult(source: string, known: Set<string>, scope: RunScope): Result {
  const [result, setResult] = useState<Result>({ kind: "none" });
  useEffect(() => {
    if (source.trim() === "") {
      setResult({ kind: "none" });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      const reads = readsVariables(source);
      const unknown = reads.find((n) => !known.has(n));
      if (unknown) {
        setResult({ kind: "error", what: t.exprField.unknownVariable(unknown), todo: "" });
        return;
      }
      // A variable without a recorded value: nothing to compute with yet.
      if (reads.some((n) => !(n in scope.values))) {
        setResult({ kind: "needsRun" });
        return;
      }
      api.evalExpression(source, scope.values).then(
        (value) => live && setResult({ kind: "value", value, partial: reads.some((n) => scope.partial.has(n)) }),
        (e: unknown) => {
          if (!live) return;
          if (e instanceof ApiError && e.code.startsWith("EXPR_")) {
            const explained = explainError(e);
            setResult({ kind: "error", what: explained.what, todo: explained.todo });
          } else setResult({ kind: "none" });
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, known, scope]);
  return result;
}

function resultText(value: unknown): string {
  if (Array.isArray(value)) {
    const json = JSON.stringify(value);
    return `${t.exprField.items(value.length)}  ${json.length > 160 ? `${json.slice(0, 160)}…` : json}`;
  }
  // Digits grouped for reading; the value itself has none.
  if (typeof value === "number") return value.toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { maximumFractionDigits: 10 });
  return shortValue(value, 160) || formatValue(value);
}

export function ResultLine({ result }: { result: Result }) {
  if (result.kind === "none") return null;
  if (result.kind === "needsRun") return <p className="mt-1 text-[10.5px] leading-snug text-slate-500">{t.exprField.needsRun}</p>;
  if (result.kind === "error")
    return (
      <div className="mt-1 rounded-sm border-l-2 border-shu-500 bg-shu-50 px-2 py-1 text-[11px] leading-snug text-ink">
        {result.what}
        {result.todo && <span className="block text-[10.5px] text-slate-500">{result.todo}</span>}
      </div>
    );
  return (
    <div className="mt-1 rounded-sm border-l-2 border-moegi-500 bg-moegi-100/50 px-2 py-1 text-[11px] leading-snug">
      <span className="text-slate-500">{t.exprField.result}</span>{" "}
      <span className="font-mono text-[12px] font-bold break-all text-ink">{resultText(result.value)}</span>
      <span className="block text-[10px] text-slate-500">{result.partial ? t.exprField.fromPartialRun : t.exprField.fromRun}</span>
    </div>
  );
}
