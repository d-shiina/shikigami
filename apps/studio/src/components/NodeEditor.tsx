// One node, full size: double-clicking a node on the chart opens it here.
// Left, the values the node can use (the row being repeated and its
// columns, read from the Excel/CSV file before any run; the other
// variables), a click away from the field being edited. Middle, the same
// settings, with room. Right, what the node gave: 「ノードの単体実行」 runs
// only this node with the values the last run left (lib/stepTest.ts);
// 「ここまで実行」 runs the flow from the start through it and pauses.
import type { Step, StepTypeDef } from "@spellsheet/schema";
import { ChevronLeft, FileText, Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { enclosingLoops, resultStep } from "../lib/loopScope";
import { TYPE_COLOR, knownVariables } from "../lib/nodeRows";
import { runScope, sampleOf, shortValue } from "../lib/runScope";
import { typeTitle } from "../lib/sentence";
import { stepInputs } from "../lib/stepTest";
import { findStep, isActive, type StepTest } from "../store";
import { useProjectMaybe } from "../project";
import { startFileDrag } from "./FileDrag";
import { StepInspector } from "./inspector/StepInspector";
import { useActiveField, useInsertChoices } from "./InsertVariable";
import { OcrResult, isOcrOutput } from "./OcrResult";
import { ValueView } from "./ValueView";

export function NodeEditor() {
  const editing = useStudio((s) => s.editing);
  const flow = useStudio((s) => s.flow);
  const step = editing && flow ? findStep(flow.steps ?? [], editing) : null;
  const close = useStudio((s) => s.closeEditor);
  useEffect(() => {
    if (!step) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.closest("[role=menu],[aria-expanded=true]"))) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, close]);
  // The node went away (undo, the AI removed it): nothing to edit.
  useEffect(() => {
    if (editing && !step) close();
  }, [editing, step, close]);
  // The settings pane shows the selected node: a link to another node in it
  // (「変数のつながり」) moves the whole editor there, never only the middle.
  const selection = useStudio((s) => s.selection);
  const openEditor = useStudio((s) => s.openEditor);
  useEffect(() => {
    if (!editing) return;
    if (selection?.kind === "step" && selection.stepId !== editing) openEditor(selection.stepId);
    else if (selection?.kind !== "step") close();
  }, [editing, selection, openEditor, close]);
  if (!step?.id) return null;
  return <Editor key={step.id} step={step} />;
}

function Editor({ step }: { step: Step }) {
  const stepTypes = useStudio((s) => s.stepTypes);
  const def = stepTypes.find((d) => d.type === step.type);
  const close = useStudio((s) => s.closeEditor);
  return (
    <div className="absolute inset-0 z-30 grid grid-rows-[48px_minmax(0,1fr)] bg-paper" role="dialog" aria-label={typeTitle(step, def)}>
      <header className="flex items-center gap-3 border-b border-slate-200 px-4">
        <button type="button" onClick={close} className="flex items-center gap-0.5 rounded-lg px-1.5 py-1 text-[12px] text-slate-600 hover:bg-slate-100 hover:text-ink">
          <ChevronLeft size={14} aria-hidden="true" />
          {t.editor.back}
        </button>
        <span className="shrink-0 text-[15px] font-bold text-ink">{typeTitle(step, def)}</span>
        {/* The name, typed in place: the form below is only what the node does. */}
        <NameInput step={step} />
        <span className="ml-auto flex items-center gap-2">
          {/* One way out: "フロー図に戻る" on the left (or Esc). */}
          <RunButtons step={step} def={def} />
        </span>
      </header>
      <div className="grid min-h-0 grid-cols-[300px_minmax(0,1fr)_380px]">
        <section className="flex min-h-0 flex-col border-r border-slate-200">
          <h3 className="shrink-0 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-bold tracking-wider text-slate-600">{t.editor.usable}</h3>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Usable step={step} />
            <Files />
          </div>
        </section>
        <section className="flex min-h-0 flex-col">
          <h3 className="shrink-0 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-bold tracking-wider text-slate-600">{t.editor.settings}</h3>
          <div className="min-h-0 flex-1 overflow-y-auto" data-wide>
            <StepInspector inEditor />
          </div>
        </section>
        <section className="flex min-h-0 flex-col border-l border-slate-200">
          <h3 className="shrink-0 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-bold tracking-wider text-slate-600">{t.editor.result}</h3>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Result stepId={step.id!} hasOutput={def?.hasOutput ?? false} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** The node's name in the header, plain text until pointed at (n8n, Linear). */
export function NameInput({ step }: { step: Step }) {
  const updateStep = useStudio((s) => s.updateStep);
  const [draft, setDraft] = useState(step.name ?? "");
  useEffect(() => setDraft(step.name ?? ""), [step.name]);
  const commit = () => {
    const name = draft.trim();
    if (name !== (step.name ?? "")) void updateStep(step.id!, { name });
  };
  return (
    <input
      value={draft}
      aria-label={t.stepName}
      title={t.editor.renameTitle}
      placeholder={t.editor.namePlaceholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(step.name ?? "");
        }
      }}
      className="min-w-0 max-w-[420px] flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[13px] text-slate-700 placeholder:text-slate-400 hover:border-slate-200 focus:border-primary focus:bg-sheet focus:outline-none"
    />
  );
}

export function RunButtons({ step, def }: { step: Step; def: StepTypeDef | undefined }) {
  const run = useStudio((s) => s.run);
  const flow = useStudio((s) => s.flow);
  const trying = useStudio((s) => s.trying);
  const stepTest = useStudio((s) => s.stepTest);
  const runTo = useStudio((s) => s.runTo);
  const testStep = useStudio((s) => s.testStep);
  const stopRun = useStudio((s) => s.stopRun);
  const tested = useStudio((s) => (flow ? s.tested[flow.id] : undefined));
  // The last run's values, and over them what nodes run alone since gave.
  const scope = useMemo(() => {
    const last = runScope(run, flow?.id);
    if (!tested) return last;
    const partial = new Set([...(last.partial ?? [])].filter((name) => !(name in tested)));
    return { ...last, values: { ...last.values, ...tested }, partial };
  }, [run, flow?.id, tested]);
  const stepTypes = useStudio((s) => s.stepTypes);
  const stopStepTest = useStudio((s) => s.stopStepTest);
  const inputs = useMemo(
    () => stepInputs(flow?.steps ?? [], step, (type) => (type === step.type ? def : stepTypes.find((d) => d.type === type)), flow?.variables, scope),
    [flow, step, def, stepTypes, scope],
  );
  const active = run !== null && isActive(run);
  const button = "flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-[12.5px] text-slate-700 enabled:hover:border-brand-500 enabled:hover:text-brand-600 disabled:opacity-50";
  if (active)
    return (
      <button type="button" onClick={() => void stopRun()} className={button}>
        <Square size={12} aria-hidden="true" />
        {trying ? t.editor.trying : t.editor.stopRun}
      </button>
    );
  if (stepTest?.running)
    return (
      <button type="button" onClick={() => void stopStepTest()} className={button}>
        <Square size={12} aria-hidden="true" />
        {t.editor.testing}
      </button>
    );
  const blocked = inputs.missing.length > 0 || inputs.partial.length > 0;
  const why = inputs.missing.length > 0 ? t.editor.testMissing(inputs.missing.join("・")) : t.editor.testPartial(inputs.partial.join("・"));
  return (
    <>
      <button type="button" title={t.editor.runToTitle} onClick={() => void runTo(step.id!)} className={button}>
        <Play size={12} aria-hidden="true" />
        {t.editor.runTo}
      </button>
      <button
        type="button"
        disabled={blocked}
        title={blocked ? why : t.editor.testTitle}
        onClick={() => void testStep(step.id!, inputs.values)}
        className={button}
      >
        <Play size={12} aria-hidden="true" />
        {t.editor.testNode}
      </button>
    </>
  );
}

/** The values the node can use; a click puts one into the field last focused. */
function Usable({ step }: { step: Step }) {
  const flow = useStudio((s) => s.flow);
  const run = useStudio((s) => s.run);
  const stepTypes = useStudio((s) => s.stepTypes);
  const scope = useMemo(() => runScope(run, flow?.id), [run, flow?.id]);
  const choices = useInsertChoices(step, scope);
  const vars = useMemo(() => knownVariables(flow?.variables, flow?.steps ?? []), [flow]);
  const field = useActiveField();
  const [done, setDone] = useState<string | null>(null);
  const put = (expression: string) => {
    if (!field) return;
    field.insert(expression);
    setDone(field.label);
    setTimeout(() => setDone(null), 1500);
  };
  const sourceOf = (itemVar: string): string | undefined => {
    const loop = choices.loops.find((l) => l.itemVar === itemVar);
    if (!loop) return undefined;
    const items = enclosingLoops(flow?.steps ?? [], step.id ?? "").find((l) => l.itemVar === itemVar)?.items ?? null;
    const reader = items ? resultStep(flow?.steps ?? [], items) : null;
    const path = typeof reader?.params?.path === "string" ? reader.params.path : undefined;
    return path ?? (reader ? reader.name || typeTitle(reader, stepTypes.find((d) => d.type === reader.type)) : (items ?? undefined));
  };
  const empty = choices.loops.length === 0 && choices.variables.length === 0;
  const row = (key: string, label: string, expression: string, note: string, color?: string) => (
    <button
      key={key}
      type="button"
      disabled={!field}
      title={field ? t.editor.clickTo(field.label) : t.editor.pickField}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => put(expression)}
      className="flex w-full items-baseline gap-2 px-4 py-1 text-left text-[12.5px] hover:bg-brand-50 disabled:cursor-default disabled:hover:bg-transparent"
    >
      {color && <span className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full" style={{ background: color }} />}
      <span className="truncate text-ink">{label}</span>
      <span className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-400">{note}</span>
    </button>
  );
  return (
    <div className="pb-3">
      <p className="px-4 pt-2 pb-1 text-[11px] leading-snug text-slate-500">{done ? t.editor.insertedInto(done) : field ? t.editor.clickTo(field.label) : t.editor.pickField}</p>
      {empty && <p className="px-4 py-2 text-[12px] leading-relaxed text-slate-500">{t.editor.none}</p>}
      {choices.loops.map((l) => {
        const source = sourceOf(l.itemVar);
        const value = scope.values[l.itemVar];
        return (
          <div key={l.itemVar} className="pt-2">
            <div className="px-4 pb-0.5 text-[11px] font-semibold text-slate-600">
              {t.editor.loopRows(l.itemVar)}
              {source && <span className="ml-1 font-normal text-slate-400">← {t.editor.fromTable(source)}</span>}
            </div>
            {l.columns.map((c) => row(`${l.itemVar}.${c}`, c, `${l.itemVar}${access(c)}`, shortValue(sampleOf(value, c), 24)))}
            {l.columns.length === 0 && <p className="px-4 py-1 text-[11px] leading-snug text-slate-500">{t.editor.noColumns}</p>}
          </div>
        );
      })}
      {choices.variables.length > 0 && (
        <div className="pt-2">
          <div className="px-4 pb-0.5 text-[11px] font-semibold text-slate-600">{t.editor.others}</div>
          {choices.variables.map((v) => row(`v:${v}`, v, v, shortValue(scope.values[v], 24), TYPE_COLOR[vars.get(v) ?? "any"]))}
        </div>
      )}
    </div>
  );
}

/** The flow's files, to drag into a file setting (the project panel is under this editor). */
function Files() {
  const files = useProjectMaybe((s) => s.files?.files, undefined);
  const list = (files ?? []).filter((f) => !f.path.startsWith("work/") && !f.path.startsWith("logs/"));
  if (list.length === 0) return null;
  return (
    <div className="border-t border-slate-100 pt-2 pb-3">
      <div className="px-4 pb-0.5 text-[11px] font-semibold text-slate-600">{t.fileDrop.files}</div>
      <p className="px-4 pb-1 text-[11px] leading-snug text-slate-500">{t.fileDrop.dragHint}</p>
      {list.map((f) => (
        <div
          key={f.path}
          onPointerDown={(e) => startFileDrag(e, f.path)}
          title={f.path}
          className="flex cursor-grab items-center gap-2 px-4 py-1 text-[12.5px] select-none hover:bg-brand-50 active:cursor-grabbing"
        >
          <FileText size={13} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate font-mono text-[11.5px] text-ink">{f.path}</span>
        </div>
      ))}
    </div>
  );
}

/** `item.顧客`, or `item['税込 金額']` for a name that is not a plain word. */
function access(column: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(column) ? `.${column}` : `['${column.replace(/'/g, "\\'")}']`;
}

/** A node's value: OCR results as lines to check, anything else as a table. */
function Output({ stepType, value }: { stepType?: string; value: unknown }) {
  return isOcrOutput(stepType, value) ? <OcrResult value={value} /> : <ValueView value={value} size="panel" />;
}

/** The node's result: its run alone, or else what the last run did there. */
export function Result({ stepId, hasOutput }: { stepId: string; hasOutput: boolean }) {
  const stepTest = useStudio((s) => s.stepTest);
  const flow = useStudio((s) => s.flow);
  if (stepTest && stepTest.stepId === stepId && stepTest.flowId === flow?.id) return <TestResult test={stepTest} hasOutput={hasOutput} />;
  return <RunResult stepId={stepId} hasOutput={hasOutput} />;
}

/** What 「ノードの単体実行」 gave. */
function TestResult({ test, hasOutput }: { test: StepTest; hasOutput: boolean }) {
  const flow = useStudio((s) => s.flow);
  const stepType = flow ? findStep(flow.steps ?? [], test.stepId)?.type : undefined;
  if (test.running) return <p className="px-4 py-3 text-[12.5px] font-semibold text-slate-600">{t.editor.testing}</p>;
  const r = test.result;
  const ok = r?.status === "succeeded";
  return (
    <div className="space-y-3 px-4 py-3 text-[12.5px]">
      <div className={`font-semibold ${ok ? "text-moegi-600" : "text-shu-600"}`}>{ok ? t.editor.tested : t.editor.testFailed}</div>
      {(test.error || r?.error) && <p className="text-[12px] leading-relaxed text-shu-600">{test.error ?? r?.error?.message}</p>}
      {r && hasOutput && (
        <div>
          <div className="pb-1 text-[11px] font-semibold text-slate-600">{t.editor.output}</div>
          <Output stepType={stepType} value={r.output} />
        </div>
      )}
      {r && r.logs.length > 0 && (
        <div>
          <div className="pb-1 text-[11px] font-semibold text-slate-600">{t.editor.log}</div>
          <ul className="space-y-0.5 font-mono text-[11px] leading-snug">
            {r.logs.map((l, i) => (
              <li key={i} className={l.level === "error" ? "text-shu-600" : l.level === "warn" ? "text-accent-600" : "text-slate-600"}>
                {l.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** What the last run did at this node: its state, the value it saved, and its log lines. */
function RunResult({ stepId, hasOutput }: { stepId: string; hasOutput: boolean }) {
  const run = useStudio((s) => s.run);
  const flow = useStudio((s) => s.flow);
  const trying = useStudio((s) => s.trying);
  const debug = useStudio((s) => s.debug);
  const stopRun = useStudio((s) => s.stopRun);
  const step = flow ? findStep(flow.steps ?? [], stepId) : null;
  const state = run?.flowId === flow?.id ? run?.steps[stepId] : undefined;
  const change = run && run.flowId === flow?.id && step?.saveAs ? [...run.changes].reverse().find((c) => c.stepId === stepId && c.variable === step.saveAs) : undefined;
  const lines = run && run.flowId === flow?.id ? run.logs.filter((l) => (l.callPath?.length ? l.callPath[0] === stepId : l.stepId === stepId)) : [];
  if (!run || run.flowId !== flow?.id || (!state && !trying)) return <p className="px-4 py-3 text-[12px] leading-relaxed text-slate-500">{t.editor.noResult}</p>;
  const active = isActive(run);
  const headline =
    trying || state === "running" ? t.editor.running
    : state === "failed" ? t.editor.failed
    : state === "skipped" ? t.editor.skipped
    : active && run.pause ? t.editor.pausedAfter
    : t.editor.finished;
  const tone = state === "failed" ? "text-shu-600" : state === "succeeded" || (active && run.pause) ? "text-moegi-600" : "text-slate-600";
  return (
    <div className="space-y-3 px-4 py-3 text-[12.5px]">
      <div className={`font-semibold ${tone}`}>{headline}</div>
      {active && run.pause && !trying && (
        <div className="flex gap-2">
          <button type="button" onClick={() => void debug({ action: "continue" })} className="rounded-lg border border-slate-300 px-2.5 py-1 text-[12px] hover:bg-slate-50">
            {t.editor.continueRun}
          </button>
          <button type="button" onClick={() => void stopRun()} className="rounded-lg border border-slate-300 px-2.5 py-1 text-[12px] hover:bg-slate-50">
            {t.editor.stopRun}
          </button>
        </div>
      )}
      {hasOutput && (
        <div>
          <div className="pb-1 text-[11px] font-semibold text-slate-600">
            {t.editor.output}
            {step?.saveAs && <span className="ml-1.5 font-mono font-normal text-slate-500">{step.saveAs}</span>}
          </div>
          {change ? <Output stepType={step?.type} value={change.value} /> : <span className="text-slate-400">—</span>}
        </div>
      )}
      {!hasOutput && <div className="text-[11.5px] text-slate-400">{t.editor.noOutput}</div>}
      {lines.length > 0 && (
        <div>
          <div className="pb-1 text-[11px] font-semibold text-slate-600">{t.editor.log}</div>
          <ul className="space-y-0.5 font-mono text-[11px] leading-snug">
            {lines.map((l) => (
              <li key={l.seq} className={l.level === "error" ? "text-shu-600" : l.level === "warn" ? "text-accent-600" : "text-slate-600"}>
                {l.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
