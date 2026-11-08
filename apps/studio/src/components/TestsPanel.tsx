import type { CaseResult, TestCase } from "@shikigami/schema";
import { Check, Play, Save, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { explainError } from "../lib/errorText";
import { t } from "../lib/i18n";
import { badName, freeName, mismatchText } from "../lib/testCases";
import { isActive } from "../store";
import { create } from "zustand";

type Named = { name: string; case: TestCase };

/**
 * The suite outlives the tab: switching to the log or closing the panel
 * unmounts the component while the cases still run, and results belong to
 * the flow that ran them, not to whichever flow is open when they arrive.
 */
export const useSuite = create<{
  /** Last results here, by flow, then by case name. */
  results: Record<string, Record<string, CaseResult>>;
  /** The flow and the cases running now. */
  running: { flowId: string; names: string[] } | null;
}>(() => ({ results: {}, running: null }));

export const keepResults = (flowId: string, done: CaseResult[]) =>
  useSuite.setState((s) => ({
    results: { ...s.results, [flowId]: { ...(s.results[flowId] ?? {}), ...Object.fromEntries(done.map((r) => [r.name, r])) } },
  }));

const NONE: Record<string, CaseResult> = {};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 「テスト」 under the chart: the flow's test cases (tests/<name>.json),
 * each with how it went the last time it ran here. A finished run can be
 * kept as a case; 「すべて実行」 runs them with the working content.
 */
export function TestsPanel() {
  const flowId = useStudio((s) => s.flow?.id ?? null);
  const run = useStudio((s) => s.run);
  const [cases, setCases] = useState<Named[]>([]);
  const results = useSuite((s) => (flowId ? s.results[flowId] : undefined)) ?? NONE;
  const suite = useSuite((s) => s.running);
  const running = suite && suite.flowId === flowId ? suite.names : null;
  const [naming, setNaming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The flow open now: answers for one opened before are dropped.
  const current = useRef(flowId);
  current.current = flowId;

  const reload = useCallback(async () => {
    if (!flowId) return;
    try {
      const list = await api.listTestCases(flowId);
      if (current.current === flowId) setCases(list);
    } catch (e) {
      if (current.current === flowId) setError(message(e));
    }
  }, [flowId]);

  useEffect(() => {
    setCases([]);
    setNaming(null);
    setNote(null);
    setError(null);
    void reload();
  }, [reload]);

  if (!flowId) return null;
  // A run of this flow that has ended can become a case.
  const lastRun = run && run.flowId === flowId && !isActive(run) ? run : null;
  // One suite at a time, whichever flow it is of.
  const busy = suite !== null;

  const runCases = async (names?: string[]) => {
    const id = flowId;
    useSuite.setState({ running: { flowId: id, names: names ?? cases.map((c) => c.name) } });
    setError(null);
    try {
      keepResults(id, await api.runTests(id, names));
    } catch (e) {
      if (current.current === id) setError(message(e));
    } finally {
      useSuite.setState({ running: null });
    }
  };

  const saveRun = async (name: string) => {
    if (!lastRun) return;
    setError(null);
    try {
      const saved = await api.testCaseFromRun(flowId, lastRun.runId, name.trim());
      setNaming(null);
      setNote(saved.leftOut.length > 0 ? t.tests.leftOut(saved.leftOut.join("、")) : null);
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };

  const remove = async (name: string) => {
    try {
      await api.deleteTestCase(flowId, name);
      useSuite.setState((s) => {
        const { [name]: _, ...rest } = s.results[flowId] ?? {};
        return { results: { ...s.results, [flowId]: rest } };
      });
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };

  const ran = cases.filter((c) => results[c.name]);
  const failed = ran.filter((c) => !results[c.name]?.passed).length;

  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        {running ? (
          <button type="button" className="flex items-center gap-1 rounded-md px-2 text-xs leading-6 text-slate-600 hover:bg-slate-100 hover:text-ink" onClick={() => void api.stopTests()}>
            <Square size={12} aria-hidden /> {t.tests.stop}
          </button>
        ) : (
          <button
            type="button"
            disabled={cases.length === 0 || busy}
            className="flex items-center gap-1 rounded-md px-2 text-xs leading-6 text-slate-600 hover:bg-slate-100 hover:text-ink disabled:opacity-40"
            onClick={() => void runCases()}
            title={t.tests.usesDraft}
          >
            <Play size={12} aria-hidden /> {t.tests.runAll}
          </button>
        )}
        <button
          type="button"
          disabled={!lastRun || busy}
          className="flex items-center gap-1 rounded-md px-2 text-xs leading-6 text-slate-600 hover:bg-slate-100 hover:text-ink disabled:opacity-40"
          onClick={() => setNaming(freeName(cases.map((c) => c.name)))}
          title={t.tests.saveRunHint}
        >
          <Save size={12} aria-hidden /> {t.tests.saveRun}
        </button>
        <span className="flex-1" />
        {running && <span className="text-xs text-slate-500">{t.tests.running}</span>}
        {!busy && ran.length > 0 && (
          <span className={`text-xs ${failed ? "text-shu-600" : "text-moegi-500"}`}>{t.tests.summary(ran.length - failed, failed)}</span>
        )}
      </div>
      {naming !== null && (
        <form
          className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!badName(naming)) void saveRun(naming);
          }}
        >
          <label className="text-xs text-slate-600" htmlFor="test-case-name">
            {t.tests.nameLabel}
          </label>
          <input
            id="test-case-name"
            autoFocus
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNaming(null)}
            className="w-56 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs"
          />
          <button type="submit" disabled={badName(naming)} className="rounded-md bg-ink px-2 text-xs leading-6 text-white disabled:opacity-40">
            {t.tests.save}
          </button>
          <button type="button" className="rounded-md px-2 text-xs leading-6 text-slate-500 hover:bg-slate-100" onClick={() => setNaming(null)}>
            {t.tests.cancel}
          </button>
          {badName(naming) && naming !== "" && <span className="text-xs text-shu-600">{t.tests.badName}</span>}
        </form>
      )}
      {note && <p className="border-b border-slate-100 bg-amber-50/60 px-3 py-1.5 text-xs text-amber-700">{note}</p>}
      {error && <p className="border-b border-slate-100 px-3 py-1.5 text-xs text-shu-600">{error}</p>}
      {cases.length === 0 ? (
        <p className="px-4 py-3 text-xs leading-5 text-slate-500">{t.tests.empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {cases.map((c) => (
            <CaseRow
              key={c.name}
              named={c}
              result={results[c.name]}
              running={running?.includes(c.name) ?? false}
              busy={busy}
              onRun={() => void runCases([c.name])}
              onDelete={() => void remove(c.name)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseRow({
  named,
  result,
  running,
  busy,
  onRun,
  onDelete,
}: {
  named: Named;
  result: CaseResult | undefined;
  running: boolean;
  busy: boolean;
  onRun: () => void;
  onDelete: () => void;
}) {
  const goTo = useStudio((s) => s.goTo);
  const mark = running ? (
    <span className="h-3 w-3 animate-pulse rounded-full bg-brand-500" aria-label={t.tests.running} />
  ) : !result ? (
    <span className="h-3 w-3 rounded-full border border-slate-300" aria-label={t.tests.notRun} />
  ) : result.passed ? (
    <Check size={14} className="text-moegi-500" aria-label={t.tests.passed} />
  ) : (
    <X size={14} className="text-shu-600" aria-label={t.tests.failed} />
  );
  return (
    <li className="group px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="grid w-4 shrink-0 place-items-center">{mark}</span>
        <span className="font-medium text-ink">{named.name}</span>
        {named.case.description && <span className="truncate text-xs text-slate-500">{named.case.description}</span>}
        <span className="flex-1" />
        {result && (
          <span className="text-xs text-slate-400" title={result.runId}>
            {t.tests.duration(result.durationMs)}
          </span>
        )}
        <button
          type="button"
          disabled={busy}
          className="grid h-6 w-6 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink disabled:opacity-40"
          onClick={onRun}
          title={t.tests.run}
          aria-label={`${named.name} ${t.tests.run}`}
        >
          <Play size={12} aria-hidden />
        </button>
        <button
          type="button"
          disabled={busy}
          className="grid h-6 w-6 place-items-center rounded-md text-slate-400 opacity-0 hover:bg-slate-100 hover:text-shu-600 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
          onClick={onDelete}
          title={t.tests.delete}
          aria-label={`${named.name} ${t.tests.delete}`}
        >
          <Trash2 size={12} aria-hidden />
        </button>
      </div>
      {result && !result.passed && (
        <div className="mt-1 ml-6 space-y-0.5 text-xs">
          {result.mismatches.map((m) => {
            const words = mismatchText(m);
            return (
              <div key={m.at} className="flex flex-wrap gap-x-2">
                <span className="text-slate-600">{words.where}</span>
                <span className="text-slate-500">
                  {t.tests.expected} <span className="text-ink">{words.expected}</span>
                </span>
                <span className="text-slate-500">
                  {t.tests.actual} <span className="text-shu-600">{words.actual}</span>
                </span>
              </div>
            );
          })}
          {result.error && (
            <div className="text-slate-500">
              {explainError(result.error).what}
              {result.error.stepId && (
                <button type="button" className="ml-2 text-brand-600 hover:underline" onClick={() => result.error?.stepId && goTo(result.error.stepId)}>
                  {t.tests.at.errorStep}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
