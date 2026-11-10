// 「こうなれば正しい」 on the review: the promises the AI wrote for its
// change (test cases in business words), whether the flow keeps them, and
// the person's answer to whether each promise is right.
import type { Evidence, TestCase } from "@spellsheet/schema";
import { Check, ChevronDown, ChevronRight, Play, X } from "lucide-react";
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
    <div className="space-y-3">
      {fresh.length > 0 && (
        <div>
          <PromiseHead answering />
          {fresh.map((p) => (
            <PromiseRow key={p.name} promise={p} answer={answers[p.name]} onAnswer={(v) => onAnswer(p.name, v)} onWrong={() => onWrong(p)} />
          ))}
        </div>
      )}
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
          <button type="button" onClick={() => setShowOlder(!showOlder)} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-ink">
            {showOlder ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            {t.promises.older(older.length)}
            {olderBroken > 0 && <span className="font-semibold text-shu-600">{t.promises.olderBroken(olderBroken)}</span>}
          </button>
          {showOlder && (
            <div className="mt-1.5">
              <PromiseHead answering={false} />
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

/** The columns of the promises table on a wide sheet; on a narrow one each promise stacks. */
const ROW = "grid gap-x-4 gap-y-1 @min-[720px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(9.5em,1fr)_auto]";

/** The heads of the promises table, shown only when its rows are laid out as a table. */
function PromiseHead({ answering }: { answering: boolean }) {
  return (
    <div className={`${ROW} hidden border-b border-slate-200 px-1 pb-1.5 text-[11.5px] font-semibold text-slate-500 @min-[720px]:grid`}>
      <span>{t.promises.colPromise}</span>
      <span>{t.promises.colGiven}</span>
      <span>{t.promises.colThen}</span>
      <span>{t.promises.colKept}</span>
      <span>{answering ? t.promises.isRight : ""}</span>
    </div>
  );
}

/** One promise: what should hold, with which input and result, whether the flow keeps it, and whether it is the right promise. */
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
  const variables = useStudio((s) => s.flow?.variables);
  const labels = useMemo(
    () => new Map((variables ?? []).flatMap((v) => (v.description?.trim() ? [[v.name, v.description.trim()] as const] : []))),
    [variables],
  );
  const terms = promiseTerms(promise.testCase, labels);
  const kept = promise.kept;
  const state = !kept ? "unchecked" : kept.passed ? "kept" : "broken";
  const word = { kept: t.promises.kept, broken: t.promises.broken, unchecked: t.promises.unchecked }[state];
  const errorStep = promise.testCase.expect?.errorStep;
  const chip = (on: boolean, tone: string) =>
    `inline-flex items-center gap-1 rounded-md border px-2.5 text-[12px] leading-6 whitespace-nowrap ${on ? `${tone} font-semibold` : "border-slate-200 text-slate-600 hover:border-slate-400"}`;
  const label = (text: string) => <span className="mr-1.5 text-[11px] text-slate-500 @min-[720px]:hidden">{text}</span>;
  return (
    <div className={`${ROW} border-b border-slate-100 px-1 py-2.5 text-[12.5px] leading-relaxed ${state === "broken" ? "bg-shu-50/40" : ""}`}>
      <div className="min-w-0">
        <span className="font-semibold whitespace-pre-wrap">{promise.text}</span>
        {promise.fresh && (
          <span className="ml-1.5 rounded-md bg-brand-50 px-1.5 align-[1px] text-[10px] leading-4 font-bold whitespace-nowrap text-brand-600">
            {promise.replaced ? t.promises.replaced : t.promises.fresh}
          </span>
        )}
      </div>
      <div className="min-w-0 break-all text-slate-600">
        {label(t.promises.given)}
        {terms.given ?? "—"}
      </div>
      <div className="min-w-0 break-all text-slate-600">
        {label(t.promises.then)}
        {terms.then}
        {errorStep && (
          <button type="button" onClick={() => goTo(errorStep)} className="ml-1 inline-flex align-middle text-brand-600 hover:text-brand-700">
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="min-w-0">
        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 text-[11px] leading-[20px] font-bold whitespace-nowrap ${KEPT_STYLE[state]}`}>
          {state === "kept" ? <Check size={11} strokeWidth={2.5} aria-hidden="true" /> : state === "broken" ? <X size={11} strokeWidth={2.5} aria-hidden="true" /> : null}
          {word}
        </span>
        {kept && !kept.passed && kept.mismatches.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[11.5px] text-shu-600">
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
        {kept && (
          <div className="mt-0.5 text-[11px] text-slate-500">
            {kept.by === "ai" ? t.promises.byAi : t.promises.byYou}
            {kept.stale && <span className="ml-1 text-amber-700">・{t.promises.stale}</span>}
          </div>
        )}
      </div>
      <div className="flex items-start gap-1.5">
        {onAnswer && (
          <>
            <span className="mr-auto self-center text-[11.5px] text-slate-600 @min-[720px]:hidden">{t.promises.isRight}</span>
            <button type="button" onClick={() => onAnswer(answer === "ok" ? null : "ok")} className={chip(answer === "ok", "border-moegi-500 text-moegi-500")}>
              {answer === "ok" && <Check size={12} strokeWidth={2.25} aria-hidden="true" />}
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
          </>
        )}
      </div>
    </div>
  );
}
