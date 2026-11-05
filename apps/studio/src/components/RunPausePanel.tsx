// Where an interactive run waits for the person: what failed (or where it
// stopped), the screen and the variables at that point, and what to do next:
// ask the AI to fix it, retry, skip, step, or end the run. Also tells about
// a run that ended in failure instead of letting it end quietly.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useAgent } from "../agent";
import { useStudio } from "../context";
import { clipboardAi } from "../lib/askAi";
import { fixRequest } from "../lib/fixRequest";
import { plain, sentence } from "../lib/sentence";
import { diveChain, findStep, isActive } from "../store";
import { usePendingReview } from "./Timeline";
import { shortText } from "./ValueView";
import { stepLabel as typeName, t } from "../lib/i18n";

const MAX_VARS = 14;

function Button({
  children,
  tone = "plain",
  keys,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "danger" | "plain" | "ai"; keys?: string }) {
  const tones = {
    primary: "bg-ink text-paper hover:bg-brand-700 disabled:bg-slate-300",
    ai: "bg-brand-500 text-paper hover:bg-brand-600 disabled:opacity-50",
    danger: "text-shu-600 hover:bg-shu-50 disabled:text-slate-300",
    plain: "border border-slate-300 bg-sheet text-ink hover:bg-slate-50 disabled:text-slate-300",
  } as const;
  return (
    <button
      type="button"
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-[4px] px-2.5 text-[13px] font-semibold disabled:cursor-not-allowed ${tones[tone]}`}
      {...rest}
    >
      {children}
      {keys && <kbd className="rounded-[3px] bg-current/10 px-1 font-sans text-[10px] font-normal opacity-70">{keys}</kbd>}
    </button>
  );
}

function Variables({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return <span className="text-[12px] text-slate-400">{t.pause.noVariables}</span>;
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
      {entries.length > MAX_VARS && <span className="text-[12px] text-slate-400">{t.pause.moreVariables(entries.length - MAX_VARS)}</span>}
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
        title={t.pause.screenshotTitle}
        className="shrink-0 overflow-hidden rounded-[4px] border border-slate-300 hover:border-brand-500"
      >
        <img src={src} alt={title} className="h-[92px] w-auto max-w-[180px] object-cover object-top" />
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-6" onClick={() => setOpen(false)}>
            <figure lang="ja" className="max-h-full overflow-auto rounded-[4px] bg-sheet p-2 shadow-dialog">
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
  const called = useStudio((s) => s.called);
  const leaveCalls = useStudio((s) => s.leaveCalls);
  const enterCall = useStudio((s) => s.enterCall);
  const stepTypes = useStudio((s) => s.stepTypes);
  const debug = useStudio((s) => s.debug);
  const startRun = useStudio((s) => s.startRun);
  const dismissFailure = useStudio((s) => s.dismissFailure);
  const goTo = useStudio((s) => s.goTo);
  const setReviewing = useStudio((s) => s.setReviewing);
  const reviewing = useStudio((s) => s.reviewing);
  const pending = usePendingReview();
  const agentAvailable = useAgent((s) => s.info?.available === true);
  const agentBusy = useAgent((s) => s.turnId !== null || s.sending);
  const agentName = useAgent((s) => s.info?.name ?? "AI");
  const askAgent = useAgent((s) => s.send);
  const [asking, setAsking] = useState(false);
  const [told, setTold] = useState<string | null>(null);

  if (!run || !scenario || (run.scenarioId && run.scenarioId !== scenario.id)) return null;
  const pause = run.status === "paused" ? run.pause : null;
  const failure = !isActive(run) ? run.failure : null;
  if (!pause && !failure) return null;

  const stepId = pause?.stepId ?? failure?.stepId ?? null;
  // Paused inside a call: the step and its fix belong to the called scenario.
  const inCall = pause?.callPath ?? [];
  const owner = inCall.length > 0 ? (diveChain(scenario, called, inCall).at(-1)?.scenario ?? scenario) : scenario;
  const step = stepId ? findStep(owner.steps ?? [], stepId) : null;
  const show = () => {
    if (!stepId) return;
    if (inCall.length === 0) return goTo(stepId);
    leaveCalls(0);
    for (const id of inCall) enterCall(id);
  };
  const def = step ? stepTypes.find((d) => d.type === step.type) : undefined;
  const stepLabel = step ? step.name || plain(sentence(step, def)) : stepId ? t.evidence.goneStep : null;
  const kind = step ? typeName(step.type, def?.label) : undefined;
  const error = pause?.error ?? failure;
  const onError = pause ? pause.reason === "error" : true;
  // An AI's fix waits in the review queue: look at it before running it.
  const unreviewed = pause && scenario.revision !== pause.revision ? pending.length : 0;
  const changed = pause !== null && scenario.revision !== pause.revision;

  const askAi = async () => {
    if (!pause) return;
    setAsking(true);
    try {
      const text = fixRequest({ scenario: owner, runId: run.runId, pause, evidence: run.evidence, defs: stepTypes });
      if (agentAvailable) {
        // Straight to the AI pane; its edits come back through the review queue.
        const sent = await askAgent(text, { id: owner.id, name: owner.name, stepId: pause.stepId }, `${owner.name} ・ ${t.pause.fixContext}`);
        setTold(sent ? t.pause.asked(agentName) : t.pause.notSent(agentName));
      } else {
        setTold(await clipboardAi.ask(text));
      }
    } catch (e) {
      setTold(t.pause.askFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      setAsking(false);
    }
  };

  const evidence = run.evidence?.observation;
  const looking = pause && onError && !run.evidence && /^(browser|desktop)\./.test(pause.stepType);
  const resumeBlocked = unreviewed > 0 ? t.runMsg.reviewBeforeResume : undefined;

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
          {pause ? (onError ? t.pause.onError : pause.reason === "breakpoint" ? t.pause.breakpoint : t.status.paused) : t.agent.failed}
        </span>
        {stepLabel && (
          <button
            type="button"
            onClick={show}
            className="min-w-0 truncate text-[14px] font-bold hover:text-brand-600 hover:underline"
            title={t.pause.showStep}
          >
            {kind && <span className="mr-1.5 text-[12px] font-semibold text-slate-500">{kind}</span>}
            {stepLabel}
            {pause && !onError && <span className="ml-1.5 text-[12px] font-normal text-slate-500">{t.pause.before}</span>}
          </button>
        )}
        <span className="flex-1" />
        {pause && onError && (
          <>
            <Button
              tone="ai"
              onClick={askAi}
              disabled={asking || (agentAvailable && agentBusy)}
              title={
                agentAvailable && agentBusy
                  ? t.pause.agentBusy(agentName)
                  : agentAvailable
                    ? t.pause.askTitle(agentName)
                    : t.pause.copyTitle
              }
            >
              ✦ {t.pause.askFix(agentAvailable ? agentName : "AI")}
            </Button>
            <Button
              tone="primary"
              onClick={() => void debug({ action: "retry" })}
              disabled={unreviewed > 0}
              title={resumeBlocked ?? t.pause.retryTitle}
              keys="F5"
            >
              {changed ? t.pause.resumeFixed : t.pause.retry}
            </Button>
            <Button onClick={() => void debug({ action: "skip" })} disabled={unreviewed > 0} title={resumeBlocked ?? t.pause.skipTitle}>
              {t.pause.skipNext}
            </Button>
            <Button tone="danger" onClick={() => void debug({ action: "abort" })} title={t.pause.abortTitle}>
              {t.pause.abort}
            </Button>
          </>
        )}
        {pause && !onError && (
          <>
            <Button tone="primary" onClick={() => void debug({ action: "continue" })} disabled={unreviewed > 0} title={resumeBlocked} keys="F5">
              ▶ {t.runMsg.resume.continue}
            </Button>
            <Button onClick={() => void debug({ action: "stepOver" })} disabled={unreviewed > 0} title={resumeBlocked ?? t.pause.stepOverTitle} keys="F10">
              {t.pause.stepOver}
            </Button>
            <Button onClick={() => void debug({ action: "stepInto" })} disabled={unreviewed > 0} title={resumeBlocked ?? t.pause.stepIntoTitle} keys="F11">
              {t.pause.stepInto}
            </Button>
            <Button onClick={() => void debug({ action: "stepOut" })} disabled={unreviewed > 0} title={resumeBlocked ?? t.pause.stepOutTitle} keys="⇧F11">
              {t.pause.stepOut}
            </Button>
            <Button onClick={() => void debug({ action: "skip" })} disabled={unreviewed > 0} title={resumeBlocked ?? t.pause.skipStepTitle}>
              {t.pause.skip}
            </Button>
          </>
        )}
        {failure && (
          <>
            <Button tone="primary" onClick={() => void startRun()} keys="F5">
              {t.pause.runAgain}
            </Button>
            <Button onClick={dismissFailure}>{t.close}</Button>
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
        <div className="mt-2 flex items-center gap-2 rounded-[4px] bg-brand-50 px-3 py-1.5 text-[13px] text-brand-700">
          <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" />
          {t.pause.fixArrived(unreviewed)}
          {!reviewing && (
            <button type="button" className="ml-auto shrink-0 font-semibold underline" onClick={() => setReviewing(true)}>
              {t.pause.review}
            </button>
          )}
        </div>
      )}
      {told && !unreviewed && pause && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-slate-600">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
          {told}
          <button type="button" className="ml-auto shrink-0 text-slate-400 hover:underline" onClick={() => setTold(null)}>
            {t.close}
          </button>
        </div>
      )}

      {pause && (
        <div className="mt-2 flex gap-3">
          {evidence?.screenshotDataUrl && <Screenshot src={evidence.screenshotDataUrl} title={evidence.title} />}
          <div className="min-w-0 flex-1 space-y-1">
            {looking && <div className="text-[12px] text-slate-500">{t.pause.capturing}</div>}
            {run.evidence?.problem && <div className="text-[12px] text-slate-500">
                {t.pause.captureFailed}
                {t.colon}
                {run.evidence.problem}
              </div>}
            {evidence && !evidence.screenshotDataUrl && <div className="text-[12px] text-slate-500">
                {t.evidence.pausedScreen}
                {t.colon}
                {evidence.title}
              </div>}
            <div className="text-[11px] font-semibold text-slate-500">{t.pause.variablesNow}</div>
            <Variables values={pause.variables} />
          </div>
        </div>
      )}
    </section>
  );
}
