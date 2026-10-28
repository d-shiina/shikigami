import type { StepTypeDef } from "@shikigami/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { KEYWORD } from "../lib/keywords";
import { PRESETS } from "../lib/presets";

export const CATEGORY_LABEL: Record<string, string> = {
  control: "制御",
  variable: "変数",
  log: "ログ",
  flow: "フロー",
  browser: "ブラウザ",
  windows: "Windows",
  office: "Office",
  file: "ファイル",
  network: "Web API",
  system: "システム",
  text: "文字",
  number: "数値",
  date: "日付",
  list: "表・リスト",
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
  office: "var(--cat-office)",
  file: "var(--cat-file)",
  network: "var(--cat-browser)",
  system: "var(--cat-windows)",
  // Presets are "変数に代入" steps underneath, so they share its colour.
  text: "var(--cat-variable)",
  number: "var(--cat-variable)",
  date: "var(--cat-variable)",
  list: "var(--cat-variable)",
  other: "var(--cat-other)",
};

/** Categories in the order they are listed: the flow's own steps first, then what they drive. */
const ORDER = ["control", "variable", "text", "number", "date", "list", "flow", "log", "browser", "windows", "office", "file", "network", "system", "other"];
const CATEGORY_KEY = "shikigami.studio.paletteCategory";

const rank = (category: string) => {
  const at = ORDER.indexOf(category);
  return at < 0 ? ORDER.length : at;
};

/** One line of the palette: a step type, or a ready-made "変数に代入" (preset). */
type Item = { key: string; category: string; label: string; keyword?: string; summary: string; search: string; add: (addStep: AddStep) => void };
type AddStep = (type: string, params?: Record<string, unknown>, name?: string) => Promise<void>;

function stepItem(def: StepTypeDef): Item {
  return {
    key: def.type,
    category: def.category,
    label: def.label,
    keyword: KEYWORD[def.type],
    summary: summary(def.description ?? def.type),
    search: `${def.label} ${def.type} ${def.description ?? ""}`,
    add: (addStep) => void addStep(def.type),
  };
}

const PRESET_ITEMS: Item[] = PRESETS.map((preset) => ({
  key: preset.key,
  category: preset.category,
  label: preset.label,
  keyword: preset.keyword,
  summary: `${preset.description}　${preset.name} ← ${preset.expression}`,
  search: `${preset.label} ${preset.keyword} ${preset.description}`,
  add: (addStep) => void addStep("variable.set", { name: preset.name, expression: preset.expression }, preset.label),
}));

/** The first sentence of a description: enough to tell steps apart in a list. */
function summary(text: string): string {
  // "e.g." and "i.e." do not end a sentence.
  const end = text.search(/(?<!\b(?:e\.g|i\.e))\.\s|。/);
  return end < 0 ? text : text.slice(0, end + 1);
}

function loadCategory(): string {
  try {
    return globalThis.localStorage?.getItem(CATEGORY_KEY) ?? "control";
  } catch {
    return "control";
  }
}

function matches(item: Item, query: string): boolean {
  if (!query) return true;
  const haystack = `${item.search} ${CATEGORY_LABEL[item.category] ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/**
 * Ctrl+K: summon a step by typing what you want instead of hunting a toolbox.
 * Without a query it browses one category at a time (←→ or the list on the
 * left); typing searches every category, grouped under their names.
 */
export function CommandPalette() {
  const open = useStudio((s) => s.paletteOpen);
  const setOpen = useStudio((s) => s.setPaletteOpen);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const addStep = useStudio((s) => s.addStep);
  const [query, setQuery] = useState("");
  const [category, setCategoryState] = useState(loadCategory);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const items = useMemo(() => [...stepTypes.map(stepItem), ...PRESET_ITEMS], [stepTypes]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    return [...counts].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [items]);
  const current = categories.some(([c]) => c === category) ? category : (categories[0]?.[0] ?? "control");
  const results = useMemo(
    () =>
      query
        ? items.filter((i) => matches(i, query)).sort((a, b) => rank(a.category) - rank(b.category))
        : items.filter((i) => i.category === current),
    [items, query, current],
  );

  const setCategory = (next: string) => {
    setCategoryState(next);
    setActive(0);
    try {
      globalThis.localStorage?.setItem(CATEGORY_KEY, next);
    } catch {
      // Only a remembered preference.
    }
  };

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
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const choose = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    item.add(addStep);
  };
  const shiftCategory = (delta: number) => {
    const at = categories.findIndex(([c]) => c === current);
    const next = categories[(at + delta + categories.length) % categories.length];
    if (next) setCategory(next[0]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-[12vh] backdrop-blur-[1px]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="flex max-h-[70vh] w-[min(760px,92vw)] flex-col overflow-hidden rounded-[4px] border border-slate-300 bg-sheet shadow-dialog"
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
              } else if (!query && (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Tab")) {
                e.preventDefault();
                shiftCategory(e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
              } else if (e.key === "Enter") choose(results[active]);
            }}
            placeholder={t.palettePlaceholder}
            className="flex-1 bg-transparent text-base outline-none placeholder:text-slate-400"
          />
          <kbd className="rounded border border-slate-300 px-1 text-[10px] text-slate-500">Esc</kbd>
        </div>
        <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-slate-500">
          {t.paletteTitle} · {selection?.kind === "slot" ? t.addInto : selection?.kind === "step" ? t.addAfterSelection : t.addHere}
          <span className="ml-auto">{query ? "すべてのカテゴリから検索" : "←→ でカテゴリ切り替え"}</span>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="w-[156px] shrink-0 overflow-y-auto border-r border-slate-100 p-2">
            {categories.map(([c, count]) => {
              const on = !query && c === current;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setCategory(c);
                    input.current?.focus();
                  }}
                  className={`flex w-full items-center gap-2 rounded-[3px] px-2.5 py-1.5 text-left text-[13px] ${
                    on ? "bg-slate-100 font-semibold text-ink" : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="h-3.5 w-1 shrink-0 rounded-[1px]" style={{ background: CATEGORY_COLOR[c] ?? CATEGORY_COLOR.other }} />
                  <span className="flex-1 truncate">{CATEGORY_LABEL[c] ?? c}</span>
                  <span className="text-[11px] text-slate-400">{count}</span>
                </button>
              );
            })}
          </nav>
          <ul ref={list} className="min-w-0 flex-1 overflow-y-auto p-2">
            {results.length === 0 && <li className="px-3 py-4 text-sm text-slate-400">{t.paletteEmpty}</li>}
            {results.map((item, i) => (
              <li key={item.key}>
                {query && item.category !== results[i - 1]?.category && (
                  <div className="px-3 pt-2 pb-1 text-[11px] font-bold text-slate-400">{CATEGORY_LABEL[item.category] ?? item.category}</div>
                )}
                <button
                  type="button"
                  data-index={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}
                  className={`flex w-full items-center gap-3 rounded-[3px] px-3 py-2 text-left ${i === active ? "bg-slate-100" : ""}`}
                >
                  <span className="h-7 w-1 shrink-0 rounded-[1px]" style={{ background: CATEGORY_COLOR[item.category] ?? CATEGORY_COLOR.other }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {item.label}
                      {item.keyword && <span className="font-mono text-[11px] font-normal text-slate-400">{item.keyword}</span>}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{item.summary}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
