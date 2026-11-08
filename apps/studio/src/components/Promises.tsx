// 「こうなれば正しい」 on the review: the promises the AI wrote for its
// change (test cases in business words), whether the flow keeps them, and
// the person's answer to whether each promise is right.
import type { Evidence, TestCase } from "@shikigami/schema";
import { Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { type Promised, promiseCounts, promisesOf, promiseTerms, useChecked } from "../lib/promises";
import { mismatchText } from "../lib/testCases";
import { keepResults, useSuite } from "./TestsPanel";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The flow's test cases, read again when the AI saves or runs one. */
export function usePromises(flowId: string | undefined, evidence: Evidence[], revision: number): Promised[] {
  const [cases, setCases] = useState<{ name: string; case: TestCase }[]>([]);
  const checked = useChecked((s) => (flowId ? s[flowId] : undefined));
  const current = useRef(flowId);
  current.current = flowId;
  // A new saved case or a new run: the list may have changed.
  const stamp = evidence
    .filter((e) => e.kind === "testCase" || e.kind === "testCases")
    .map((e) => e.at)
    .join();
  useEffect(() => {
    setCases([]);
    if (!flowId) return;
    api.listTestCases(flowId).then(
      (list) => current.current === flowId && setCases(list),
      () => undefined,
    );
  }, [flowId, stamp]);
  return useMemo(() => promisesOf(cases, evidence, revision, checked), [cases, evidence, revision, checked]);
}

export function Promises({
  flowId,
  revision,
  promises,
  answers,
  onAnswer,
  onWrong,
  onAsk,
}: {
  flowId: string;
  revision: number;
  promises: Promised[];
  answers: Record<string, "ok" | "no">;
  onAnswer: (name: string, value: "ok" | "no" | null) => void;
  onWrong: (p: Promised) => void;
  onAsk: () => void;
}) {
  const suite = useSuite((s) => s.running);
  const [error, setError] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const fresh = promises.filter((p) => p.fresh);
  const older = promises.filter((p) => !p.fresh);
  const olderBroken = promiseCounts(older).broken;
  const running = suite?.flowId === flowId;
  const check = useCallback(async () => {
    const names = promises.map((p) => p.name);
    useSuite.setState({ running: { flowId, names } });
    setError(null);
    try {
      const results = await api.runTests(flowId, names);
      keepResults(flowId, results);
      useChecked.setState({ [flowId]: { revision, at: new Date().toISOString(), results } });
    } catch (e) {
      setError(t.promises.failed(message(e)));
    } finally {
      useSuite.setState({ running: null });
    }
  }, [flowId, promises, revision]);

  if (promises.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">
        <p>{t.promises.none}</p>
        <button type="button" onClick={onAsk} className="mt-1.5 text-[12px] font-semibold text-brand-600 hover:underline">
          {t.promises.ask}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {fresh.length > 0 && <p className="text-[11.5px] leading-relaxed text-slate-500">{t.promises.lead}</p>}
      {fresh.map((p) => (
        <PromiseRow key={p.name} promise={p} answer={answers[p.name]} onAnswer={(v) => onAnswer(p.name, v)} onWrong={() => onWrong(p)} />
      ))}
      {fresh.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-[12px] leading-relaxed text-slate-600">
          <p>{t.promises.none}</p>
          <button type="button" onClick={onAsk} className="mt-1 text-[12px] font-semibold text-brand-600 hover:underline">
            {t.promises.ask}
          </button>
        </div>
      )}
      {older.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowOlder(!showOlder)} className="text-[11px] text-slate-500 hover:text-ink">
            {showOlder ? "▾" : "▸"} {t.promises.older(older.length)}
            {olderBroken > 0 && <span className="font-semibold text-shu-600">{t.promises.olderBroken(olderBroken)}</span>}
          </button>
          {showOlder && (
            <div className="mt-1.5 space-y-1.5">
              {older.map((p) => (
                <PromiseRow key={p.name} promise={p} />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void check()}
          disabled={suite !== null}
          title={t.promises.checkTitle}
          className="flex h-7 items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-[12px] font-semibold text-ink hover:border-brand-500 hover:text-brand-700 disabled:opacity-50"
        >
          <Play size={12} strokeWidth={2} aria-hidden="true" />
          {running ? t.promises.checking : t.promises.check}
        </button>
        {error && <span className="min-w-0 flex-1 text-[11.5px] text-shu-600">{error}</span>}
      </div>
    </div>
  );
}

const KEPT_STYLE = {
  kept: "bg-moegi-100 text-moegi-500",
  broken: "bg-shu-50 text-shu-600",
  unchecked: "bg-slate-100 text-slate-600",
};

/** One promise: what should hold, with which input and result, and whether the flow keeps it. */
function PromiseRow({
  promise,
  answer,
  onAnswer,
  onWrong,
}: {
  promise: Promised;
  answer?: "ok" | "no";
  onAnswer?: (value: "ok" | "no" | null) => void;
  onWrong?: () => void;
}) {
  const goTo = useStudio((s) => s.goTo);
  const terms = promiseTerms(promise.testCase);
  const kept = promise.kept;
  const state = !kept ? "unchecked" : kept.passed ? "kept" : "broken";
  const word = { kept: t.promises.kept, broken: t.promises.broken, unchecked: t.promises.unchecked }[state];
  const errorStep = promise.testCase.expect?.errorStep;
  const chip = (on: boolean, tone: string) =>
    `rounded-md border px-2 text-[11px] leading-5 ${on ? `${tone} font-semibold` : "border-slate-200 text-slate-600 hover:border-slate-400"}`;
  return (
    <div className={`rounded-lg border bg-sheet px-2.5 py-2 ${state === "broken" ? "border-shu-500/50" : "border-slate-200"}`}>
      <div className="flex items-start gap-1.5">
        <p className="min-w-0 flex-1 text-[13px] leading-snug font-semibold whitespace-pre-wrap">{promise.text}</p>
        {promise.fresh && (
          <span className="mt-px shrink-0 rounded-md bg-brand-50 px-1.5 text-[10px] leading-4 font-bold text-brand-600">
            {promise.replaced ? t.promises.replaced : t.promises.fresh}
          </span>
        )}
      </div>
      <div className="mt-1 grid grid-cols-[2.6em_1fr] gap-x-1.5 text-[12px] leading-relaxed text-slate-600">
        {terms.given && (
          <>
            <span className="text-[10.5px] text-slate-500">{t.promises.given}</span>
            <span className="min-w-0 break-all">{terms.given}</span>
          </>
        )}
        <span className="text-[10.5px] text-slate-500">{t.promises.then}</span>
        <span className="min-w-0 break-all">
          {terms.then}
          {errorStep && (
            <button type="button" onClick={() => goTo(errorStep)} className="ml-1 text-[11px] text-brand-600 hover:underline">
              ›
            </button>
          )}
        </span>
      </div>
      {kept && !kept.passed && kept.mismatches.length > 0 && (
        <ul className="mt-1 space-y-0.5 rounded-md bg-shu-50/60 px-2 py-1 text-[11.5px] text-shu-600">
          {kept.mismatches.map((m) => {
            const d = mismatchText(m);
            return (
              <li key={m.at}>
                {d.where}：{t.tests.expected} {d.expected} ／ {t.tests.actual} {d.actual}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className={`rounded-md px-1.5 text-[10.5px] leading-[18px] font-bold ${KEPT_STYLE[state]}`}>
          {state === "kept" ? "✓ " : state === "broken" ? "× " : ""}
          {word}
        </span>
        {kept && (
          <span className="text-[10.5px] text-slate-500">
            {kept.by === "ai" ? t.promises.byAi : t.promises.byYou}
            {kept.stale && <span className="ml-1 text-amber-700">・{t.promises.stale}</span>}
          </span>
        )}
      </div>
      {onAnswer && (
        <div className="mt-1.5 flex items-center gap-1.5 border-t border-dashed border-slate-200 pt-1.5">
          <span className="mr-auto text-[11.5px] text-slate-600">{t.promises.isRight}</span>
          <button type="button" onClick={() => onAnswer(answer === "ok" ? null : "ok")} className={chip(answer === "ok", "border-moegi-500 text-moegi-500")}>
            {t.promises.right}
          </button>
          <button
            type="button"
            onClick={() => {
              if (answer !== "no") onWrong?.();
              onAnswer(answer === "no" ? null : "no");
            }}
            className={chip(answer === "no", "border-shu-500 text-shu-600")}
          >
            {t.promises.wrong}
          </button>
        </div>
      )}
    </div>
  );
}
