// Where an interactive run waits for the person: what failed (or where it
// stopped), the screen and the variables at that point, and what to do next:
// ask the AI to fix it, retry, skip, step, or end the run. Also tells about
// a run that ended in failure instead of letting it end quietly.
import { Play, Sparkles } from "lucide-react";
import { useState } from "react";
import { flowBusy, useAgent } from "../agent";
import { useStudio } from "../context";
import { explainError } from "../lib/errorText";
import { fixRequest } from "../lib/fixRequest";
import { plain, sentence } from "../lib/sentence";
import { diveChain, errorPlace, findStep, isActive } from "../store";
import { usePendingReview } from "./Timeline";
import { shortText } from "./ValueView";
import { HoverPreview } from "./HoverPreview";
import { openImage } from "./ImageViewer";
import { stepLabel as typeName, t } from "../lib/i18n";

const MAX_VARS = 14;

function Button({
  children,
  tone = "plain",
  keys,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "danger" | "plain" | "ai"; keys?: string }) {
  const tones = {
    primary: "bg-primary text-on-primary hover:bg-primary-hover disabled:bg-slate-300",
    ai: "border border-brand-300 bg-sheet text-brand-700 hover:bg-brand-50 disabled:opacity-50",
    danger: "text-shu-600 hover:bg-shu-50 disabled:text-slate-300",
    plain: "border border-slate-300 bg-sheet text-ink hover:bg-slate-50 disabled:text-slate-300",
  } as const;
  return (
    <button
      type="button"
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold disabled:cursor-not-allowed ${tones[tone]}`}
      {...rest}
    >
      {children}
      {keys && <kbd className="rounded-md bg-current/10 px-1 font-sans text-[10px] font-normal opacity-70">{keys}</kbd>}
    </button>
  );
}

/** Longer strings arrive cut short (see the Runtime's previews): not editable. */
const PREVIEW_CHARS = 1000;

/**
 * What a typed value becomes: text stays text for a text variable; other
 * values are read as JSON (number, true / false, a list, ...). `undefined`:
 * not a value of that kind.
 */
export function editedValue(text: string, current: unknown): unknown {
  if (typeof current === "string") return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return current === null || current === undefined ? text : undefined;
  }
}

function editableValue(value: unknown): boolean {
  if (value === "***") return false;
  if (typeof value === "string") return [...value].length <= PREVIEW_CHARS || !value.endsWith("…");
  return true;
}

function Variable({ name, value, secret }: { name: string; value: unknown; secret: boolean }) {
  const debug = useStudio((s) => s.debug);
  const [text, setText] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const editable = !secret && editableValue(value);
  const start = () => {
    setWrong(false);
    setText(typeof value === "string" ? value : JSON.stringify(value));
  };
  const save = async () => {
    if (text === null) return;
    const next = editedValue(text, value);
    if (next === undefined) {
      setWrong(true);
      return;
    }
    if (JSON.stringify(next) !== JSON.stringify(value) && !(await debug({ action: "setVariable", name, value: next }))) return;
    setText(null);
  };
  if (text !== null) {
    return (
      <span className="flex items-center gap-1 rounded-lg bg-slate-100 px-1.5 text-[12px] leading-[20px]">
        <span className="shrink-0 font-semibold text-slate-600">{name}</span>
        <span className="text-slate-400">=</span>
        <textarea
          autoFocus
          rows={Math.min(6, text.split("\n").length)}
          aria-label={t.pause.valueOf(name)}
          aria-invalid={wrong}
          title={wrong ? t.pause.notAValue : t.pause.editHint}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setWrong(false);
          }}
          onKeyDown={(e) => {
            // Shift+Enter starts a new line: a text keeps its line breaks.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") setText(null);
          }}
          onBlur={() => void save()}
          className={`min-h-5 w-[140px] resize-none rounded-md border bg-paper px-1 text-[12px] leading-[18px] text-ink outline-none ${wrong ? "border-shu-500" : "border-brand-500"}`}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={!editable}
      onClick={start}
      title={editable ? `${name} = ${JSON.stringify(value, null, 2)}\n${t.pause.clickToEdit}` : secret || value === "***" ? t.pause.secretNotEditable : t.pause.tooLongToEdit}
      className="flex max-w-[220px] items-center gap-1 rounded-lg bg-slate-100 px-1.5 text-left text-[12px] leading-[20px] enabled:hover:bg-slate-200"
    >
      <span className="shrink-0 font-semibold text-slate-600">{name}</span>
      <span className="text-slate-400">=</span>
      <HoverPreview value={value} longText className="truncate text-ink">
        {shortText(value)}
      </HoverPreview>
    </button>
  );
}

function Variables({ values, secrets }: { values: Record<string, unknown>; secrets: ReadonlySet<string> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return <span className="text-[12px] text-slate-400">{t.pause.noVariables}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.slice(0, MAX_VARS).map(([name, value]) => (
        <Variable key={name} name={name} value={value} secret={secrets.has(name)} />
      ))}
      {entries.length > MAX_VARS && <span className="text-[12px] text-slate-400">{t.pause.moreVariables(entries.length - MAX_VARS)}</span>}
    </div>
  );
}

function Screenshot({ src, title }: { src: string; title: string }) {
  return (
    <button
      type="button"
      onClick={() => openImage({ src, title })}
      title={t.pause.screenshotTitle}
      className="shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-slate-300 hover:border-brand-500"
    >
      <img src={src} alt={title} className="h-[92px] w-auto max-w-[180px] object-cover object-top" />
    </button>
  );
}

export function RunPausePanel() {
  const run = useStudio((s) => s.run);
  const flow = useStudio((s) => s.flow);
  const called = useStudio((s) => s.called);
  const stepTypes = useStudio((s) => s.stepTypes);
  const debug = useStudio((s) => s.debug);
  const startRun = useStudio((s) => s.startRun);
  const dismissFailure = useStudio((s) => s.dismissFailure);
  const goToPlace = useStudio((s) => s.goToPlace);
  const setReviewing = useStudio((s) => s.setReviewing);
  const reviewing = useStudio((s) => s.reviewing);
  const pending = usePendingReview();
  const agentAvailable = useAgent((s) => s.info?.available === true);
  const agentName = useAgent((s) => s.info?.name ?? "AI");
  const openAgent = useAgent((s) => s.setOpen);
  const agentBusy = useAgent((s) => flowBusy(s, flow?.id));
  const askAgent = useAgent((s) => s.send);
  const [asking, setAsking] = useState(false);
  const [told, setTold] = useState<string | null>(null);

  if (!run || !flow || (run.flowId && run.flowId !== flow.id)) return null;
  const pause = run.status === "paused" ? run.pause : null;
  const failure = !isActive(run) ? run.failure : null;
  if (!pause && !failure) return null;

  // A run that failed inside a called flow ended at the call step; the node
  // in there is where it went wrong.
  const failedAt = !pause && failure?.stepId ? errorPlace(flow, called, failure.stepId, failure.details) : null;
  const stepId = pause?.stepId ?? failedAt?.stepId ?? null;
  // Paused inside a call: the step and its fix belong to the called flow.
  const inCall = pause?.callPath ?? failedAt?.path ?? [];
  const owner = inCall.length > 0 ? (diveChain(flow, called, inCall).at(-1)?.flow ?? flow) : flow;
  const step = stepId ? findStep(owner.steps ?? [], stepId) : null;
  // The paused values are the owner's (a called flow has its own variables).
  const secretNames = new Set((owner.variables ?? []).filter((v) => v.secret).map((v) => v.name));
  const show = () => {
    if (stepId) goToPlace({ path: inCall, stepId });
  };
  const def = step ? stepTypes.find((d) => d.type === step.type) : undefined;
  const stepLabel = step ? step.name || plain(sentence(step, def)) : stepId ? t.evidence.goneStep : null;
  const kind = step ? typeName(step.type, def?.label) : undefined;
  const error = pause?.error ?? failure;
  const explained = error ? explainError(error, step) : null;
  const onError = pause ? pause.reason === "error" : true;
  // An AI's fix waits in the review queue: look at it before running it.
  const unreviewed = pause && flow.revision !== pause.revision ? pending.length : 0;
  const changed = pause !== null && flow.revision !== pause.revision;

  const askAi = async () => {
    if (!pause) return;
    setAsking(true);
    try {
      const text = fixRequest({ flow: owner, runId: run.runId, pause, evidence: run.evidence, defs: stepTypes });
      if (agentAvailable) {
        // Straight to the AI pane; its edits come back through the review queue.
        const sent = await askAgent(text, { id: owner.id, name: owner.name, stepId: pause.stepId }, `${owner.name} ・ ${t.pause.fixContext}`);
        setTold(sent ? t.pause.asked(agentName) : t.pause.notSent(agentName));
      } else {
        // No AI to ask yet: the AI pane shows how to set one up.
        openAgent(true);
        setTold(t.aiSetUpFirst);
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
            {inCall.length > 0 && owner !== flow && <span className="mr-1.5 font-semibold text-slate-500">{owner.name} ›</span>}
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
                    : t.pause.setUpTitle
              }
            >
              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
              {t.pause.askFix(agentAvailable ? agentName : "AI")}
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
              <Play size={14} strokeWidth={2} aria-hidden="true" />
              {t.runMsg.resume.continue}
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

      {error && explained && (
        <div className="mt-1.5 flex items-baseline gap-2 text-[13px]">
          <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-shu-500" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="break-words font-semibold text-ink">{explained.what}</div>
            {explained.todo && <div className="break-words text-slate-600">{explained.todo}</div>}
            {explained.known && (
              <details className="text-[12px] text-slate-600">
                <summary className="w-fit cursor-pointer select-none hover:text-ink">{t.pause.original}</summary>
                <div lang="en" className="break-words font-mono">
                  {error.code}: {error.message}
                </div>
              </details>
            )}
          </div>
        </div>
      )}

      {unreviewed > 0 && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-[13px] text-brand-700">
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
            <Variables values={pause.variables} secrets={secretNames} />
          </div>
        </div>
      )}
    </section>
  );
}
