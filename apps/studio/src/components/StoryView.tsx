import type { HistoryEntry, Step, StepTypeDef, VariableDef } from "@shikigami/schema";
import { useMemo } from "react";
import { useStudio } from "../context";
import { actorLabel, describe, formatValue, relativeTime } from "../lib/changes";
import { t } from "../lib/i18n";
import { type Part, plain, sentence } from "../lib/sentence";
import { revertBlocker, type StepRunState, touchedSteps } from "../store";
import { ActorMark, usePendingReview } from "./Timeline";

type Defs = ReadonlyMap<string, StepTypeDef>;

/** Unreviewed external edits per step, with how each touched it. */
type Marks = Map<string, { entry: HistoryEntry; added: boolean }[]>;

const RUN_RING: Record<StepRunState, string> = {
  running: "border-accent-500 text-accent-500 animate-pulse",
  succeeded: "border-moegi-500 text-moegi-500",
  failed: "border-shu-500 bg-shu-500 text-white",
  skipped: "border-slate-300 text-slate-300",
};

function Sentence({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        "text" in p ? (
          <span key={i}>{p.text}</span>
        ) : (
          <code key={i} className="mx-0.5 rounded bg-brand-50 px-1 font-mono text-[12.5px] text-brand-600">
            {p.code}
          </code>
        ),
      )}
    </>
  );
}

function ReviewTag({ entry, added, stepId }: { entry: HistoryEntry; added: boolean; stepId: string }) {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const history = useStudio((s) => s.history);
  const approve = useStudio((s) => s.approve);
  const revert = useStudio((s) => s.revert);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const blocker = revertBlocker(entry, history);
  const diffs = added
    ? []
    : describe(entry, scenario, defs)
        .filter((l) => l.stepId === stepId)
        .flatMap((l) => l.diffs);
  return (
    <div className="mt-1.5 space-y-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {diffs.length > 0 && (
        <dl className="space-y-0.5 font-mono text-[11.5px]">
          {diffs.map((d) => (
            <div key={d.field} className="flex flex-wrap items-baseline gap-x-1.5">
              <dt className="text-slate-500">{d.field}</dt>
              {d.before !== undefined && <dd className="text-shu-600 line-through decoration-shu-500/50">{formatValue(d.before)}</dd>}
              {d.before !== undefined && <span className="text-slate-400">→</span>}
              <dd className="text-moegi-500">{formatValue(d.after)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
        <ActorMark entry={entry} size={18} />
        <span>
          {actorLabel(entry)}が{added ? "追加" : "変更"} · {relativeTime(entry.at)}
        </span>
        <button
          type="button"
          onClick={() => approve(entry.revision)}
          className="rounded bg-ink px-2 py-px text-paper hover:bg-slate-700"
        >
          {t.approve}
        </button>
        <button
          type="button"
          onClick={() => revert(entry)}
          disabled={blocker !== null}
          title={blocker ?? undefined}
          className="rounded border border-shu-500 px-2 py-px text-shu-600 enabled:hover:bg-shu-50 disabled:border-slate-300 disabled:text-slate-400"
        >
          {t.revert}
        </button>
      </div>
    </div>
  );
}

function AddLine({ parentId, block, label }: { parentId: string | null; block: string | null; label?: string }) {
  const selection = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const setPaletteOpen = useStudio((s) => s.setPaletteOpen);
  const active = selection?.kind === "slot" && selection.parentId === parentId && selection.block === block;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        select({ kind: "slot", parentId, block });
        setPaletteOpen(true);
      }}
      className={`ml-9 block w-[calc(100%-2.25rem)] rounded-md border border-dashed px-3 py-1.5 text-left text-xs ${
        active ? "border-ink text-ink" : "border-transparent text-slate-400 hover:border-slate-300 hover:text-slate-600"
      }`}
    >
      ＋ {label ?? t.storyAddHere}
      <kbd className="ml-2 text-[10px] text-slate-400">{t.shortcut}</kbd>
    </button>
  );
}

type Ctx = {
  defs: Defs;
  marks: Marks;
  numbers: Map<string, number>;
};

function StepItem({ step, ctx }: { step: Step; ctx: Ctx }) {
  const selection = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const runState = useStudio((s) => (step.id ? s.run?.steps[step.id] : undefined));
  const issues = useStudio((s) => s.validation?.issues.filter((i) => i.stepId === step.id && i.severity === "error").length ?? 0);
  const id = step.id ?? "";
  const number = ctx.numbers.get(id);
  const def = ctx.defs.get(step.type);
  const parts = sentence(step, def);
  const marks = ctx.marks.get(id) ?? [];
  const added = marks.some((m) => m.added);
  const selected = selection?.kind === "step" && selection.stepId === id;
  const lanes = [
    ...(def?.blocks ?? []).map((b) => ({ name: b.name, label: b.label })),
    ...Object.keys(step.blocks ?? {})
      .filter((name) => !def?.blocks?.some((b) => b.name === name))
      .map((name) => ({ name, label: name })),
  ];
  const rationale = typeof step.meta?.rationale === "string" ? step.meta.rationale : typeof step.meta?.note === "string" ? step.meta.note : null;

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => select({ kind: "step", stepId: id })}
        onKeyDown={(e) => e.key === "Enter" && select({ kind: "step", stepId: id })}
        className={`group flex cursor-pointer gap-3 rounded-lg px-2.5 py-2 ${
          added
            ? "bg-gradient-to-r from-moegi-100 to-transparent shadow-[inset_3px_0_var(--color-moegi-500)]"
            : marks.length > 0
              ? "bg-gradient-to-r from-brand-50 to-transparent shadow-[inset_3px_0_var(--color-brand-500)]"
              : "hover:bg-paper"
        } ${selected ? "ring-2 ring-ink/20" : ""} ${step.disabled ? "opacity-50" : ""}`}
      >
        <span
          className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-[1.5px] bg-sheet text-[11px] ${
            runState ? RUN_RING[runState] : "border-slate-300 text-slate-500"
          }`}
          title={runState ? t.status[runState === "skipped" ? "cancelled" : runState] : undefined}
        >
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-[15px] leading-relaxed ${step.disabled ? "line-through" : ""}`} title={plain(parts)}>
            <Sentence parts={parts} />
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            {step.name && <span className="text-slate-600">{step.name}</span>}
            <span>{def?.label ?? step.type}</span>
            {issues > 0 && <span className="rounded-full bg-shu-100 px-1.5 font-semibold text-shu-600">! {issues}</span>}
          </div>
          {rationale && <p className="mt-1 text-xs text-slate-500">💬 {rationale}</p>}
          {marks.map((m) => (
            <ReviewTag key={m.entry.revision} entry={m.entry} added={m.added} stepId={id} />
          ))}
        </div>
      </div>
      {lanes.map((lane) => (
        <div key={lane.name} className="ml-[21px] border-l-2 border-slate-200 pl-3">
          {lanes.length > 1 || step.type === "control.if" ? (
            <div className="mt-1 ml-2.5 text-xs font-semibold text-slate-500">{lane.label}</div>
          ) : null}
          <StepList steps={step.blocks?.[lane.name] ?? []} ctx={ctx} parentId={id} block={lane.name} />
        </div>
      ))}
    </li>
  );
}

function StepList({ steps, ctx, parentId, block }: { steps: Step[]; ctx: Ctx; parentId: string | null; block: string | null }) {
  return (
    <ol>
      {steps.map((step) => (
        <StepItem key={step.id} step={step} ctx={ctx} />
      ))}
      <li>
        <AddLine parentId={parentId} block={block} label={steps.length === 0 ? t.storyEmptyBlock : undefined} />
      </li>
    </ol>
  );
}

const DIRECTION_VERB: Record<NonNullable<VariableDef["direction"]>, string> = {
  input: "受け取る",
  output: "返す",
  inOut: "受け取って返す",
  local: "使う",
};

/** A default value short enough for a chip: lists show their size. */
function brief(value: unknown): string {
  if (Array.isArray(value)) return `${value.length}件`;
  const text = formatValue(value);
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** The scenario read top to bottom as a procedure, AI edits marked in place. */
export function StoryView() {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const select = useStudio((s) => s.select);
  const pending = usePendingReview();
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);

  const marks = useMemo(() => {
    const map: Marks = new Map();
    for (const entry of pending) {
      const added = new Set((entry.ops ?? []).flatMap((op) => (op.op === "addStep" && op.step.id ? [op.step.id] : [])));
      for (const id of new Set(touchedSteps(entry))) {
        map.set(id, [...(map.get(id) ?? []), { entry, added: added.has(id) }]);
      }
    }
    return map;
  }, [pending]);

  // Reading order numbers, computed up front so a re-render of one step
  // (e.g. its run state) never renumbers it.
  const numbers = useMemo(() => {
    const map = new Map<string, number>();
    const walk = (steps: Step[]) => {
      for (const step of steps) {
        if (step.id) map.set(step.id, map.size + 1);
        const order = defs.get(step.type)?.blocks?.map((b) => b.name) ?? [];
        const names = Object.keys(step.blocks ?? {}).sort(
          (a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1),
        );
        for (const name of names) walk(step.blocks?.[name] ?? []);
      }
    };
    walk(scenario?.steps ?? []);
    return map;
  }, [scenario, defs]);

  if (!scenario) {
    return (
      <div className="washi flex h-full flex-col items-center justify-center gap-3 text-slate-400">
        <img src="/mark.png" alt="" className="h-16 w-16 opacity-30 grayscale" />
        {t.noSelection}
      </div>
    );
  }

  const ctx: Ctx = { defs, marks, numbers };
  const variables = (scenario.variables ?? []).filter((v) => v.direction && v.direction !== "local");

  return (
    <div className="washi h-full overflow-y-auto px-6 pt-14 pb-24" onClick={() => select(null)} onKeyDown={() => {}}>
      <article
        className="mx-auto max-w-[760px] rounded-xl border border-slate-200 bg-sheet px-9 py-7 shadow-[0_1px_0_#e3d9c7]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
      >
        <h1 className="font-serif text-2xl font-semibold">{scenario.name}</h1>
        {scenario.description && <p className="mt-1 text-sm text-slate-500">{scenario.description}</p>}
        {variables.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {variables.map((v) => (
              <span key={v.name} className="rounded-full border border-slate-200 bg-paper px-2.5 py-0.5">
                {DIRECTION_VERB[v.direction ?? "local"]} <b className="font-mono font-medium text-brand-600">{v.name}</b>
                {v.default !== undefined && v.default !== null && !v.secret && (
                  <span className="text-slate-500"> = {brief(v.default)}</span>
                )}
                {v.description && <span className="text-slate-500"> {v.description}</span>}
              </span>
            ))}
          </div>
        )}
        <div className="mt-5">
          <StepList steps={scenario.steps ?? []} ctx={ctx} parentId={null} block={null} />
        </div>
      </article>
    </div>
  );
}
