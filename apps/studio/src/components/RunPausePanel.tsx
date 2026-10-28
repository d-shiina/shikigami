// Where an interactive run waits for the person: what failed (or where it
// stopped), the screen and the variables at that point, and what to do next:
// ask the AI to fix it, retry, skip, step, or end the run. Also tells about
// a run that ended in failure instead of letting it end quietly.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useStudio } from "../context";
import { clipboardAi } from "../lib/askAi";
import { fixRequest } from "../lib/fixRequest";
import { plain, sentence } from "../lib/sentence";
import { findStep, isActive } from "../store";
import { usePendingReview } from "./Timeline";
import { shortText } from "./ValueView";

const MAX_VARS = 14;

function Button({
  children,
  tone = "plain",
  keys,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "danger" | "plain" | "ai"; keys?: string }) {
  const tones = {
    primary: "bg-ink text-paper hover:bg-brand-700 disabled:bg-slate-300",
    ai: "swirl text-white hover:brightness-110 disabled:opacity-50",
    danger: "text-shu-600 hover:bg-shu-50 disabled:text-slate-300",
    plain: "border border-slate-300 bg-sheet text-ink hover:bg-slate-50 disabled:text-slate-300",
  } as const;
  return (
    <button
      type="button"
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-semibold disabled:cursor-not-allowed ${tones[tone]}`}
      {...rest}
    >
      {children}
      {keys && <kbd className="rounded-[3px] bg-current/10 px-1 font-sans text-[10px] font-normal opacity-70">{keys}</kbd>}
    </button>
  );
}

function Variables({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return <span className="text-[12px] text-slate-400">変数はありません</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.slice(0, MAX_VARS).map(([name, value]) => (
        <span
          key={name}
          title={`${name} = ${JSON.stringify(value, null, 2)}`}
          className="flex max-w-[220px] items-center gap-1 rounded-[4px] bg-slate-100 px-1.5 text-[12px] leading-[20px]"
        >
          <span className="shrink-0 font-semibold text-slate-600">{name}</span>
          <span className="text-slate-400">=</span>
          <span className="truncate text-ink">{shortText(value)}</span>
        </span>
      ))}
      {entries.length > MAX_VARS && <span className="text-[12px] text-slate-400">ほか {entries.length - MAX_VARS} 個</span>}
    </div>
  );
}

function Screenshot({ src, title }: { src: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="止まったときの画面（クリックで拡大）"
        className="shrink-0 overflow-hidden rounded-[4px] border border-slate-300 hover:border-brand-500"
      >
        <img src={src} alt={title} className="h-[92px] w-auto max-w-[180px] object-cover object-top" />
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-6" onClick={() => setOpen(false)}>
            <figure lang="ja" className="max-h-full overflow-auto rounded-[8px] bg-sheet p-2 shadow-xl">
              <figcaption className="px-1 pb-2 text-[13px] font-bold">{title}</figcaption>
              <img src={src} alt={title} className="max-w-[min(1200px,90vw)]" />
            </figure>
          </div>,
          document.body,
        )}
    </>
  );
}

export function RunPausePanel() {
  const run = useStudio((s) => s.run);
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const debug = useStudio((s) => s.debug);
  const startRun = useStudio((s) => s.startRun);
  const dismissFailure = useStudio((s) => s.dismissFailure);
  const goTo = useStudio((s) => s.goTo);
  const setReviewing = useStudio((s) => s.setReviewing);
  const reviewing = useStudio((s) => s.reviewing);
  const pending = usePendingReview();
  const [asking, setAsking] = useState(false);
  const [told, setTold] = useState<string | null>(null);

  if (!run || !scenario || (run.scenarioId && run.scenarioId !== scenario.id)) return null;
  const pause = run.status === "paused" ? run.pause : null;
  const failure = !isActive(run) ? run.failure : null;
  if (!pause && !failure) return null;

  const stepId = pause?.stepId ?? failure?.stepId ?? null;
  const step = stepId ? findStep(scenario.steps ?? [], stepId) : null;
  const def = step ? stepTypes.find((d) => d.type === step.type) : undefined;
  const stepLabel = step ? step.name || plain(sentence(step, def)) : stepId ? "（いまは無い手順）" : null;
  const kind = def?.label ?? step?.type;
  const error = pause?.error ?? failure;
  const onError = pause ? pause.reason === "error" : true;
  // An AI's fix waits in the review queue: look at it before running it.
  const unreviewed = pause && scenario.revision !== pause.revision ? pending.length : 0;
  const changed = pause !== null && scenario.revision !== pause.revision;

  const askAi = async () => {
    if (!pause) return;
    setAsking(true);
    try {
      const text = fixRequest({ scenario, runId: run.runId, pause, evidence: run.evidence, defs: stepTypes });
      setTold(await clipboardAi.ask(text));
    } catch (e) {
      setTold(`依頼できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAsking(false);
    }
  };

  const evidence = run.evidence?.observation;
  const looking = pause && onError && !run.evidence && /^(browser|desktop)\./.test(pause.stepType);
  const resumeBlocked = unreviewed > 0 ? "AIの修正を確認してから再開できます" : undefined;

  return (
    <section
      lang="ja"
      className={`border-t-2 bg-sheet px-4 py-2.5 ${onError ? "border-shu-500" : "border-mizu-500"}`}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-bold text-white ${onError ? "bg-shu-500" : "bg-mizu-500"}`}
        >
          {pause ? (onError ? "エラーで一時停止中" : pause.reason === "breakpoint" ? "ブレークポイント" : "一時停止中") : "失敗しました"}
        </span>
        {stepLabel && (
          <button
            type="button"
            onClick={() => stepId && goTo(stepId)}
            className="min-w-0 truncate text-[14px] font-bold hover:text-brand-600 hover:underline"
            title="この手順を表示"
          >
            {kind && <span className="mr-1.5 text-[12px] font-semibold text-slate-500">{kind}</span>}
            {stepLabel}
            {pause && !onError && <span className="ml-1.5 text-[12px] font-normal text-slate-500">の前</span>}
          </button>
        )}
        <span className="flex-1" />
        {pause && onError && (
          <>
            <Button tone="ai" onClick={askAi} disabled={asking} title="エラーと止まった画面・変数を添えて AI に修正を頼みます">
              ✦ AIに直してもらう
            </Button>
            <Button
              tone="primary"
              onClick={() => void debug({ action: "retry" })}
              disabled={unreviewed > 0}
              title={resumeBlocked ?? "このステップをもう一度実行して続けます（変数はそのまま）"}
              keys="F5"
            >
              {changed ? "直した内容で再開" : "もう一度"}
            </Button>
            <Button onClick={() => void debug({ action: "skip" })} disabled={unreviewed > 0} title={resumeBlocked ?? "このステップを飛ばして次へ進みます"}>
              飛ばして次へ
            </Button>
            <Button tone="danger" onClick={() => void debug({ action: "abort" })} title="失敗として実行を終えます">
              終える
            </Button>
          </>
        )}
        {pause && !onError && (
          <>
            <Button tone="primary" onClick={() => void debug({ action: "continue" })} disabled={unreviewed > 0} title={resumeBlocked} keys="F5">
              ▶ 続行
            </Button>
            <Button onClick={() => void debug({ action: "stepOver" })} disabled={unreviewed > 0} title={resumeBlocked ?? "この手順を（中も含めて）実行して次で止まる"} keys="F10">
              次へ
            </Button>
            <Button onClick={() => void debug({ action: "stepInto" })} disabled={unreviewed > 0} title={resumeBlocked ?? "ブロックの中の最初の手順で止まる"} keys="F11">
              中へ
            </Button>
            <Button onClick={() => void debug({ action: "stepOut" })} disabled={unreviewed > 0} title={resumeBlocked ?? "今いるブロックを最後まで実行して止まる"} keys="⇧F11">
              外へ
            </Button>
            <Button onClick={() => void debug({ action: "skip" })} disabled={unreviewed > 0} title={resumeBlocked ?? "この手順を実行せずに次へ"}>
              飛ばす
            </Button>
          </>
        )}
        {failure && (
          <>
            <Button tone="primary" onClick={() => void startRun()} keys="F5">
              もう一度実行
            </Button>
            <Button onClick={dismissFailure}>閉じる</Button>
          </>
        )}
      </div>

      {error && (
        <div className="mt-1.5 flex items-baseline gap-2 text-[13px]">
          <code className="shrink-0 rounded-[3px] bg-shu-50 px-1.5 text-[12px] font-semibold text-shu-600">{error.code}</code>
          <span className="min-w-0 break-words text-ink">{error.message}</span>
        </div>
      )}

      {unreviewed > 0 && (
        <div className="mt-2 flex items-center gap-2 rounded-[6px] bg-brand-50 px-3 py-1.5 text-[13px] text-brand-700">
          <span className="swirl h-2 w-2 shrink-0 rounded-full" />
          AIの修正が届きました（未確認 {unreviewed} 件）。確認して承認すると、止まったところから再開できます。
          {!reviewing && (
            <button type="button" className="ml-auto shrink-0 font-semibold underline" onClick={() => setReviewing(true)}>
              確認する
            </button>
          )}
        </div>
      )}
      {told && !unreviewed && pause && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-slate-600">
          <span className="swirl h-1.5 w-1.5 shrink-0 rounded-full" />
          {told}
          <button type="button" className="ml-auto shrink-0 text-slate-400 hover:underline" onClick={() => setTold(null)}>
            閉じる
          </button>
        </div>
      )}

      {pause && (
        <div className="mt-2 flex gap-3">
          {evidence?.screenshotDataUrl && <Screenshot src={evidence.screenshotDataUrl} title={evidence.title} />}
          <div className="min-w-0 flex-1 space-y-1">
            {looking && <div className="text-[12px] text-slate-500">止まったときの画面を取得しています…</div>}
            {run.evidence?.problem && <div className="text-[12px] text-slate-500">画面を取得できませんでした：{run.evidence.problem}</div>}
            {evidence && !evidence.screenshotDataUrl && <div className="text-[12px] text-slate-500">止まったときの画面：{evidence.title}</div>}
            <div className="text-[11px] font-semibold text-slate-500">この時点の変数</div>
            <Variables values={pause.variables} />
          </div>
        </div>
      )}
    </section>
  );
}
