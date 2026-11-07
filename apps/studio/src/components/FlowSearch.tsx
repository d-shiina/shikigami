// Ctrl+F on the chart: a search box over the top of it that finds nodes of
// the open flow by name, kind, what they do, memo, result variable and the
// values of their settings (so a variable's name finds the nodes using it).
// Moving through the results shows each node on the chart; Enter keeps it
// selected and closes the box.
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { searchFlow, type SearchHit } from "../lib/flowSearch";
import { t } from "../lib/i18n";
import { nodeIcon } from "../lib/nodeIcons";
import { typeTitle } from "../lib/sentence";
import type { StepTypeDef } from "@shikigami/schema";

const MAX_HITS = 100;

function Hit({ hit, def, active, onPick }: { hit: SearchHit; def: StepTypeDef | undefined; active: boolean; onPick: () => void }) {
  const Icon = nodeIcon(hit.step.type, def?.category ?? hit.step.type.split(".")[0] ?? "other");
  const title = hit.step.name || typeTitle(hit.step, def);
  return (
    <li>
      <button
        type="button"
        data-active={active || undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPick}
        className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${active ? "bg-brand-50" : "hover:bg-slate-50"}`}
        style={{ paddingLeft: 8 + Math.min(hit.depth, 4) * 10 }}
      >
        <Icon size={14} className="mt-0.5 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink">{title}</span>
          <span className="block truncate text-[12px] text-slate-500">
            <span className="text-slate-600">{hit.field}</span>
            {t.colon}
            {hit.text.slice(0, hit.start)}
            <mark className="rounded-sm bg-amber-100 text-ink">{hit.text.slice(hit.start, hit.start + hit.length)}</mark>
            {hit.text.slice(hit.start + hit.length)}
            {hit.more > 0 && <span className="ml-1 text-slate-400">{t.search.more(hit.more)}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

export function FlowSearch() {
  const open = useStudio((s) => s.searchOpen);
  const setOpen = useStudio((s) => s.setSearchOpen);
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const goTo = useStudio((s) => s.goTo);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const hits = useMemo(() => searchFlow(flow?.steps ?? [], defs, query), [flow?.steps, defs, query]);
  const shown = hits.slice(0, MAX_HITS);

  useEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open || !flow) return null;

  const show = (index: number) => {
    const hit = shown[index];
    if (!hit) return;
    setActive(index);
    goTo(hit.id);
  };
  const close = () => setOpen(false);

  return (
    <div className="absolute top-3 left-1/2 z-30 w-[min(440px,calc(100%-32px))] -translate-x-1/2 rounded-lg border border-slate-200 bg-sheet shadow-raised">
      <div className="flex h-9 items-center gap-2 px-2.5">
        <Search size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t.search.label}
          placeholder={t.search.placeholder}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              show(Math.min(active + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              show(Math.max(active - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const hit = shown[active];
              if (hit) {
                goTo(hit.id);
                close();
              }
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-slate-400"
        />
        {query.trim() && <span className="shrink-0 text-[12px] text-slate-500">{t.search.count(hits.length)}</span>}
        <button type="button" onClick={close} title={t.close} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-ink">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {query.trim() && (
        <div className="border-t border-slate-200">
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-slate-500">{t.search.none}</p>
          ) : (
            <ul ref={list} className="max-h-[320px] overflow-y-auto p-1">
              {shown.map((hit, i) => (
                <Hit key={hit.id} hit={hit} def={defs.get(hit.step.type)} active={i === active} onPick={() => show(i)} />
              ))}
            </ul>
          )}
          {hits.length > MAX_HITS && <p className="border-t border-slate-200 px-3 py-1.5 text-[12px] text-slate-500">{t.search.tooMany(MAX_HITS)}</p>}
        </div>
      )}
    </div>
  );
}
