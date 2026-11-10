// A new flow on the review report, read as a whole: what it starts from, what
// it gives back, and its nodes in order, one line each. A new flow has no
// "before", so before/after cards for every node only repeat "added".
import type { Flow, Step, StepTypeDef } from "@spellsheet/schema";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useStudio } from "../context";
import { stepLabel, t } from "../lib/i18n";
import { blockLabel } from "../lib/keywords";
import { flatten } from "../lib/review";
import { type Part, plain, sentence } from "../lib/sentence";
import { IF } from "../lib/stepTypes";
import { shortText } from "./ValueView";

type Defs = ReadonlyMap<string, StepTypeDef>;
type Ctx = { defs: Defs; numbers: Map<string, number>; goTo: (stepId: string) => void };

/** A long expression is a wall of symbols in a sentence: it reads as "計算式", with the whole of it on hover. */
const LONG_CODE = 40;

function ShortSentence({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        "text" in p ? (
          <span key={i}>{p.text}</span>
        ) : p.code.length > LONG_CODE ? (
          <code key={i} title={p.code} className="mx-0.5 rounded bg-slate-100 px-1 font-sans text-[12px] text-slate-600">
            {t.desk.formula}
          </code>
        ) : (
          <code key={i} className="mx-0.5 rounded bg-brand-50 px-1 font-mono text-[12px] text-brand-600">
            {p.code}
          </code>
        ),
      )}
    </>
  );
}

function Item({ step, ctx }: { step: Step; ctx: Ctx }) {
  const def = ctx.defs.get(step.type);
  const parts = sentence(step, def);
  const id = step.id ?? "";
  const lanes = [
    ...(def?.blocks ?? []).map((b) => ({ name: b.name, label: blockLabel(step, b.name, b.label) })),
    ...Object.keys(step.blocks ?? {})
      .filter((name) => !def?.blocks?.some((b) => b.name === name))
      .map((name) => ({ name, label: name })),
  ].filter((lane) => (step.blocks?.[lane.name] ?? []).length > 0);
  const name = step.name?.trim();
  return (
    <li>
      <button
        type="button"
        onClick={() => id && ctx.goTo(id)}
        className={`group flex w-full gap-2.5 rounded-md px-1.5 py-1 text-left hover:bg-paper ${step.disabled ? "opacity-50" : ""}`}
        title={plain(parts)}
      >
        <span className="mt-[3px] w-6 shrink-0 text-right font-mono text-[11.5px] text-slate-400">{ctx.numbers.get(id)}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] leading-snug font-semibold">{name || stepLabel(step.type, def?.label)}</span>
          <span className="block truncate text-[12.5px] leading-relaxed text-slate-600">
            <ShortSentence parts={parts} />
          </span>
        </span>
        <ChevronRight size={14} className="mt-1 shrink-0 text-slate-300 opacity-0 group-hover:opacity-100" aria-hidden="true" />
      </button>
      {lanes.map((lane) => (
        <div key={lane.name} className="ml-[26px] border-l-2 border-slate-200 pl-2">
          {(lanes.length > 1 || step.type === IF) && <div className="mt-1 ml-1.5 text-[11.5px] font-semibold text-slate-500">{lane.label}</div>}
          <List steps={step.blocks?.[lane.name] ?? []} ctx={ctx} />
        </div>
      ))}
    </li>
  );
}

function List({ steps, ctx }: { steps: Step[]; ctx: Ctx }) {
  return (
    <ol>
      {steps.map((step) => (
        <Item key={step.id} step={step} ctx={ctx} />
      ))}
    </ol>
  );
}

function Variables({ title, rows }: { title: string; rows: { name: string; label: string | null; value?: string }[] }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[12px] font-bold text-slate-500">{title}</div>
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-slate-500">{t.desk.none}</p>
      ) : (
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-t border-slate-100 first:border-t-0">
                <th scope="row" className={`py-1 pr-2 text-left align-top font-normal ${row.value !== undefined ? "w-[55%]" : ""}`}>
                  <span className="block">{row.label ?? row.name}</span>
                  {row.label && <span className="block font-mono text-[11px] text-slate-400">{row.name}</span>}
                </th>
                {row.value !== undefined && <td className="py-1 align-top font-mono text-[12px] break-all text-slate-700">{row.value}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function FlowAtAGlance({ flow, defs }: { flow: Flow; defs: Defs }) {
  const goTo = useStudio((s) => s.goTo);
  const steps = flow.steps ?? [];
  const numbers = useMemo(() => new Map(flatten(steps).map((s, i) => [s.id ?? "", i + 1] as const)), [steps]);
  const vars = flow.variables ?? [];
  const label = (description?: string | null) => description?.trim() || null;
  const inputs = vars
    .filter((v) => v.direction === "input" || v.direction === "inOut")
    .map((v) => ({ name: v.name, label: label(v.description), value: v.secret ? "***" : shortText(v.default) }));
  const outputs = vars.filter((v) => v.direction === "output" || v.direction === "inOut").map((v) => ({ name: v.name, label: label(v.description) }));
  return (
    <div className="space-y-5">
      <div className="grid gap-x-8 gap-y-4 @min-[640px]:grid-cols-[3fr_2fr]">
        <Variables title={t.desk.startsFrom} rows={inputs} />
        <Variables title={t.desk.givesBack} rows={outputs} />
      </div>
      <div>
        <div className="mb-1 text-[12px] font-bold text-slate-500">{t.desk.steps(numbers.size)}</div>
        <List steps={steps} ctx={{ defs, numbers, goTo }} />
      </div>
    </div>
  );
}
