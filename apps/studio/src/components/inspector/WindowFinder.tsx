// The window a desktop node acts on, in words: which app, and how the node
// finds that window next time ("Excel ならどれでも", "タイトルに「請求書」を
// 含む", "「…」だけ"), chosen with one click instead of filling in title
// and 照合方法. The raw fields stay under 「詳しく…」.
import type { Step } from "@shikigami/schema";
import { useState } from "react";
import { useStudio } from "../../context";
import { stepLabel, t } from "../../lib/i18n";
import {
  alignOps,
  droppedDate,
  exeName,
  normalWindow,
  othersOnApp,
  type PickedWindow,
  type WindowChoice,
  type WindowQuery,
  windowChips,
} from "../../lib/windowFinder";
import type { JsonSchema } from "./fields";
import { ObjectFields } from "./params";

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

function chipLabel(choice: WindowChoice, app: string): string {
  const title = choice.title ?? String(choice.window.title ?? "");
  const how = normalWindow(choice.window).match;
  if (choice.window.title === undefined) return t.windowFinder.any(app);
  if (how === "exact") return t.windowFinder.exact(title);
  if (how === "contains" || how === undefined) return t.windowFinder.contains(title);
  const templates = t.picker.windowTag as Record<string, string>;
  return fill(templates[String(how)] ?? templates.contains!, { app, title });
}

export function WindowFinder({
  step,
  schema,
  value,
  picked,
  onChange,
}: {
  step: Step;
  /** The schema of `target.window`, for 「詳しく…」. */
  schema: JsonSchema;
  value: WindowQuery;
  /** What the last pick said about the window (its ways to be found). */
  picked?: PickedWindow;
  onChange: (window: WindowQuery | null) => void;
}) {
  const flow = useStudio((s) => s.flow);
  const applyOps = useStudio((s) => s.applyOps);
  const stepTypes = useStudio((s) => s.stepTypes);
  const [details, setDetails] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const app = picked?.app && picked.choices.some((c) => sameExe(c.window, value)) ? picked.app : exeName(value.process);
  const chips = windowChips(value, picked);
  const on = chips.find((c) => c.on)?.choice;
  const dropped = droppedDate(value, picked);
  const parts = flow?.parts ?? {};
  const others = othersOnApp(flow?.steps ?? [], parts, step, value);
  const name = (s: Step) => s.name || stepLabel(s.type, stepTypes.find((d) => d.type === s.type)?.label);
  const names = others
    .slice(0, 3)
    .map((o) => (o.step ? name(o.step) : t.windowFinder.part(parts[o.part!]?.label || o.part!)))
    .join("・");
  const align = async () => {
    if (await applyOps(alignOps(others, parts, value))) setNote(t.windowFinder.aligned(others.length));
  };
  const label = "w-[76px] shrink-0 pt-1 text-right text-[11px] text-slate-500";
  return (
    <div className="mb-1 space-y-1.5 rounded-lg border border-slate-200 bg-paper px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className={`${label} pt-0`}>{t.windowFinder.window}</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-slate-100 px-2 py-0.5 text-[12px] text-ink">
          <span className="h-2 w-2 shrink-0 rounded-[2px] bg-accent-500" aria-hidden="true" />
          <span className="truncate">
            {app}
            {value.process && app.toLowerCase() !== exeName(value.process).toLowerCase() ? `（${String(value.process)}）` : ""}
          </span>
        </span>
      </div>
      {value.process !== undefined && (
        <div className="flex items-start gap-2">
          <span className={label}>{t.windowFinder.how}</span>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1" role="radiogroup" aria-label={t.windowFinder.how}>
            {chips.map(({ choice, on: chosen }) => (
              <button
                key={JSON.stringify(choice.window)}
                type="button"
                role="radio"
                aria-checked={chosen}
                title={chipLabel(choice, app)}
                className={`max-w-full truncate rounded-full border px-2.5 py-0.5 text-[12px] ${
                  chosen ? "border-brand-500 bg-brand-50 font-semibold text-brand-700" : "border-slate-300 bg-paper text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => {
                  setNote(null);
                  if (!chosen) onChange(choice.window);
                }}
              >
                {chipLabel(choice, app)}
              </button>
            ))}
            <button
              type="button"
              aria-expanded={details}
              className="rounded-full border border-dashed border-slate-300 px-2.5 py-0.5 text-[12px] text-slate-600 hover:bg-slate-100"
              onClick={() => setDetails(!details)}
            >
              {details ? t.windowFinder.less : t.windowFinder.details}
            </button>
          </div>
        </div>
      )}
      {dropped && <p className="ml-[84px] rounded-md bg-amber-50 px-2 py-1 text-[11px] leading-relaxed text-amber-800">{t.windowFinder.droppedDate(dropped)}</p>}
      {on && on.finds > 1 && (
        <p className="ml-[84px] text-[11px] leading-relaxed text-shu-600">
          {on.kind === "any" ? t.windowFinder.anyMany(on.finds) : t.windowFinder.findsMany(on.finds)}
        </p>
      )}
      {(details || value.process === undefined) && <ObjectFields schema={schema} value={value} onChange={(next) => onChange(next as WindowQuery | null)} />}
      {others.length > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-brand-100 bg-brand-50 px-2 py-1.5 text-[11px] leading-relaxed text-brand-700">
          <span className="min-w-0">{t.windowFinder.others(others.length, others.length > 3 ? `${names}…` : names)}</span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-brand-300 bg-paper px-2 py-0.5 text-[11px] text-brand-700 hover:bg-brand-50"
            onClick={() => void align()}
          >
            {t.windowFinder.align}
          </button>
        </div>
      )}
      {note && (
        <p role="status" className="ml-[84px] text-[11px] text-slate-600">
          {note}
        </p>
      )}
    </div>
  );
}

const sameExe = (a: WindowQuery, b: WindowQuery) =>
  exeName(a.process).toLowerCase() === exeName(b.process).toLowerCase();
