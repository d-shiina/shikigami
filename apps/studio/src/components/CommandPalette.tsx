import type { StepTypeDef } from "@shikigami/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

export const CATEGORY_LABEL: Record<string, string> = {
  control: "制御",
  variable: "変数",
  log: "ログ",
  flow: "フロー",
  browser: "ブラウザ",
  windows: "Windows",
  file: "ファイル",
  other: "その他",
};

/** Category colour, taken from the logo swirl. Used for node stripes too. */
export const CATEGORY_COLOR: Record<string, string> = {
  control: "var(--cat-control)",
  variable: "var(--cat-variable)",
  log: "var(--cat-log)",
  flow: "var(--cat-flow)",
  browser: "var(--cat-browser)",
  windows: "var(--cat-windows)",
  file: "var(--cat-file)",
  other: "var(--cat-other)",
};

function matches(def: StepTypeDef, query: string): boolean {
  if (!query) return true;
  const haystack = `${def.label} ${def.type} ${def.description ?? ""} ${CATEGORY_LABEL[def.category] ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/** Ctrl+K: summon a step by typing what you want instead of hunting a toolbox. */
export function CommandPalette() {
  const open = useStudio((s) => s.paletteOpen);
  const setOpen = useStudio((s) => s.setPaletteOpen);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const addStep = useStudio((s) => s.addStep);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => stepTypes.filter((d) => matches(d, query)), [stepTypes, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      input.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const choose = (def: StepTypeDef | undefined) => {
    if (!def) return;
    setOpen(false);
    void addStep(def.type);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-[12vh] backdrop-blur-[1px]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="w-[520px] overflow-hidden rounded-xl border border-slate-300 bg-sheet shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <img src="/mark.png" alt="" className="h-5 w-5" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") choose(results[active]);
            }}
            placeholder={t.palettePlaceholder}
            className="flex-1 bg-transparent text-base outline-none placeholder:text-slate-400"
          />
          <kbd className="rounded border border-slate-300 px-1 text-[10px] text-slate-500">Esc</kbd>
        </div>
        <div className="px-4 pt-2 text-[11px] text-slate-500">
          {t.paletteTitle} · {selection?.kind === "slot" ? t.addInto : selection?.kind === "step" ? t.addAfterSelection : t.addHere}
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-4 text-sm text-slate-400">{t.paletteEmpty}</li>}
          {results.map((def, i) => (
            <li key={def.type}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(def)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${i === active ? "bg-slate-100" : ""}`}
              >
                <span className="h-7 w-1 rounded-full" style={{ background: CATEGORY_COLOR[def.category] }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{def.label}</span>
                  <span className="block truncate text-xs text-slate-500">{def.description ?? def.type}</span>
                </span>
                <span className="shrink-0 text-[10px] text-slate-400">{CATEGORY_LABEL[def.category] ?? def.category}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
