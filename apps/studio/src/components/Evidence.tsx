// What the AI left behind to show its work: why it changed things, the test
// runs it did, and the screens it looked at. Also the note a person sends
// back. All of it is read from Core (review_timeline); nothing is kept here.
import type { Evidence, HistoryEntry, ObservationContent, StepNote } from "@shikigami/schema";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAgent } from "../agent";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { relativeTime } from "../lib/changes";
import { plain, sentence } from "../lib/sentence";
import { findStep } from "../store";
import { t } from "../lib/i18n";

export type TestRun = Extract<Evidence, { kind: "testRun" }>;
export type Observed = Extract<Evidence, { kind: "observation" }>;
export type Review = Extract<Evidence, { kind: "review" }>;

/** A step's name as the flow chart shows it, or a placeholder for one that is gone. */
export function useStepLabel(): (id: string) => string {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  return useCallback(
    (id: string) => {
      const step = findStep(scenario?.steps ?? [], id);
      if (!step) return t.evidence.goneStep;
      return step.name || plain(sentence(step, stepTypes.find((d) => d.type === step.type)));
    },
    [scenario, stepTypes],
  );
}

function StepLink({ id }: { id: string }) {
  const label = useStepLabel();
  const goTo = useStudio((s) => s.goTo);
  return (
    <button
      type="button"
      onClick={() => goTo(id)}
      className="max-w-full truncate rounded-[4px] bg-slate-100 px-1.5 text-left text-[11px] text-slate-600 hover:bg-brand-50 hover:text-brand-700"
      title={t.evidence.showInFlow}
    >
      {label(id)}
    </button>
  );
}

export function Section({ title, tone = "text-slate-500", children }: { title: string; tone?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className={`mb-1.5 text-[11px] font-bold ${tone}`}>{title}</div>
      {children}
    </section>
  );
}

/** The last time someone sent this scenario back, and whether the AI has acted on it since. */
export function FeedbackBox({ feedback, fixedAfter }: { feedback: Review; fixedAfter: boolean }) {
  return (
    <div className="rounded-[4px] border border-shu-100 bg-shu-50/60 px-3 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-bold text-shu-600">{t.evidence.lastSendBack}</span>
        <span className="text-slate-400">
          {t.evidence.revision(feedback.revision)} ・ {relativeTime(feedback.at)}
        </span>
        <span className={`ml-auto rounded-[3px] px-1.5 font-semibold ${fixedAfter ? "bg-moegi-100 text-moegi-500" : "bg-slate-200 text-slate-600"}`}>
          {fixedAfter ? t.evidence.fixedAfter : t.evidence.waitingFix}
        </span>
      </div>
      {feedback.reason && <p className="mt-1 text-[12px] whitespace-pre-wrap text-ink">{feedback.reason}</p>}
      {(feedback.steps ?? []).length > 0 && (
        <ul className="mt-1 space-y-1">
          {(feedback.steps ?? []).map((n) => (
            <li key={n.stepId} className="text-[12px]">
              <StepLink id={n.stepId} />
              <div className="pl-1.5 whitespace-pre-wrap text-slate-600">{n.note}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The AI's own words for each edit, oldest first. */
export function Explanations({ entries }: { entries: HistoryEntry[] }) {
  const said = entries.filter((e) => e.summary);
  if (said.length === 0) {
    return <p className="text-[12px] text-slate-400">{t.evidence.noExplanation}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {said.map((e) => (
        <li key={e.revision} className="rounded-[4px] border-l-[3px] border-brand-300 bg-brand-50/50 px-2.5 py-1.5">
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{e.summary}</p>
          {(e.stepIds ?? []).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {(e.stepIds ?? []).map((id) => (
                <StepLink key={id} id={id} />
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const RUN_STATUS: Record<string, { mark: string; label: () => string; style: string }> = {
  succeeded: { mark: "✓", label: () => t.status.succeeded, style: "bg-moegi-100 text-moegi-500" },
  failed: { mark: "×", label: () => t.status.failed, style: "bg-shu-50 text-shu-600" },
  cancelled: { mark: "■", label: () => t.evidence.aborted, style: "bg-slate-100 text-slate-600" },
};

/** The AI's test runs, newest first. The first one answers "does it work now?". */
export function TestRuns({ runs, revision }: { runs: TestRun[]; revision: number }) {
  if (runs.length === 0) {
    return (
      <p className="rounded-[4px] bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">
        {t.evidence.notTested}
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {[...runs].reverse().map((run, i) => {
        const status = RUN_STATUS[run.status] ?? { mark: "・", label: () => run.status, style: "bg-slate-100 text-slate-600" };
        const current = run.revision === revision;
        return (
          <li key={run.runId} className={`rounded-[4px] border px-2.5 py-1.5 ${i === 0 ? "border-slate-200 bg-sheet" : "border-transparent"}`}>
            <div className="flex items-center gap-2 text-[12px]">
              <span className={`rounded-[3px] px-1.5 text-[11px] font-bold ${status.style}`}>
                {status.mark} {status.label()}
              </span>
              <span className={current ? "text-slate-600" : "text-amber-700"}>
                {current ? t.evidence.onCurrent : t.evidence.onOlder(run.revision)}
              </span>
              <span className="ml-auto text-[11px] text-slate-400">{relativeTime(run.finishedAt)}</span>
            </div>
            {run.status !== "succeeded" && (run.errorMessage || run.stepId) && (
              <div className="mt-1 space-y-0.5 pl-1 text-[12px] text-shu-600">
                {run.stepId && <StepLink id={run.stepId} />}
                {run.errorMessage && <div className="whitespace-pre-wrap">{run.errorMessage}</div>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Observations never change once saved, so one fetch per id is enough.
const contents = new Map<string, Promise<ObservationContent>>();
function useObservation(id: string | null): ObservationContent | null | "missing" {
  const [value, setValue] = useState<ObservationContent | null | "missing">(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    let request = contents.get(id);
    if (!request) {
      request = api.getObservation(id);
      contents.set(id, request);
      request.catch(() => contents.delete(id));
    }
    setValue(null);
    request.then(
      (v) => live && setValue(v),
      () => live && setValue("missing"),
    );
    return () => {
      live = false;
    };
  }, [id]);
  return value;
}

const source = (s: Observed["source"]) => t.evidence.source[s];

/** Screens the AI looked at before changing things, as thumbnails. */
export function Observations({ items }: { items: Observed[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (items.length === 0) return <p className="text-[12px] text-slate-400">{t.evidence.noScreens}</p>;
  const open = items.find((o) => o.observationId === openId) ?? null;
  return (
    <>
      <ul className="grid grid-cols-2 gap-2">
        {items.map((o) => (
          <li key={o.observationId}>
            <button
              type="button"
              onClick={() => setOpenId(o.observationId)}
              className="w-full overflow-hidden rounded-[4px] border border-slate-200 bg-sheet text-left hover:border-brand-500"
            >
              <Thumb item={o} />
              <div className="px-2 py-1">
                <div className="truncate text-[11.5px] font-semibold">{o.title}</div>
                <div className="text-[10px] text-slate-400">
                  {source(o.source)} ・ {t.evidence.revision(o.revision)}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {open && <ObservationViewer item={open} onClose={() => setOpenId(null)} />}
    </>
  );
}

function Thumb({ item }: { item: Observed }) {
  const content = useObservation(item.hasScreenshot ? item.observationId : null);
  const box = "grid aspect-[16/10] w-full place-items-center bg-slate-100 text-[11px] text-slate-400";
  if (!item.hasScreenshot) return <div className={box}>{t.evidence.treeOnly}</div>;
  if (content === "missing") return <div className={box}>{t.evidence.unreadable}</div>;
  if (!content?.screenshotDataUrl) return <div className={`${box} animate-pulse`} />;
  return <img src={content.screenshotDataUrl} alt="" className="aspect-[16/10] w-full object-cover object-top" />;
}

function ObservationViewer({ item, onClose }: { item: Observed; onClose: () => void }) {
  const content = useObservation(item.observationId);
  const [tab, setTab] = useState<"shot" | "tree">(item.hasScreenshot ? "shot" : "tree");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const loaded = content && content !== "missing" ? content : null;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-6" onClick={onClose}>
      <div
        lang="ja"
        className="flex max-h-full w-[min(1100px,100%)] flex-col overflow-hidden rounded-[4px] bg-sheet shadow-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-bold">{item.title}</div>
            <div className="text-[11px] text-slate-500">
              {item.source === "runPause" ? t.evidence.pausedScreen : t.evidence.seenBy(source(item.source))} ・ {t.evidence.revision(item.revision)} ・{" "}
              {relativeTime(item.at)}
            </div>
          </div>
          <div className="flex rounded-[4px] bg-slate-100 p-0.5 text-[12px]">
            {item.hasScreenshot && (
              <button type="button" onClick={() => setTab("shot")} className={`rounded-[4px] px-2.5 py-1 ${tab === "shot" ? "bg-sheet font-semibold shadow-sheet" : "text-slate-500"}`}>
                {t.evidence.screen}
              </button>
            )}
            <button type="button" onClick={() => setTab("tree")} className={`rounded-[4px] px-2.5 py-1 ${tab === "tree" ? "bg-sheet font-semibold shadow-sheet" : "text-slate-500"}`}>
              {t.evidence.tree}
            </button>
          </div>
          <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-100" aria-label={t.close}>
            ✕
          </button>
        </div>
        {(item.stepIds ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-4 py-1.5 text-[11px] text-slate-500">
            {t.evidence.stepsFrom}
            {(item.stepIds ?? []).map((id) => (
              <StepLink key={id} id={id} />
            ))}
          </div>
        )}
        <div className="min-h-[240px] flex-1 overflow-auto bg-paper">
          {content === "missing" ? (
            <p className="p-6 text-[13px] text-slate-500">{t.evidence.missing}</p>
          ) : !loaded ? (
            <p className="p-6 text-[13px] text-slate-400">{t.loading}</p>
          ) : tab === "shot" && loaded.screenshotDataUrl ? (
            <img src={loaded.screenshotDataUrl} alt={item.title} className="mx-auto block max-w-full" />
          ) : (
            <pre className="p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre text-slate-700">{loaded.tree ?? t.evidence.noTree}</pre>
          )}
        </div>
        {loaded && (loaded.notes ?? []).length > 0 && (
          <div className="border-t border-slate-200 px-4 py-1.5 text-[11px] text-slate-500">{(loaded.notes ?? []).join(" ・ ")}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The reason and step notes that go back to the AI. */
export function SendBackForm({ onCancel, onSent }: { onCancel: () => void; onSent: () => void }) {
  const selection = useStudio((s) => s.selection);
  const sendBack = useStudio((s) => s.sendBack);
  const scenario = useStudio((s) => s.scenario);
  const agentReady = useAgent((s) => s.info?.available === true && s.turnId === null && !s.sending);
  const agentName = useAgent((s) => s.info?.name ?? "AI");
  const askAgent = useAgent((s) => s.send);
  const [fixNow, setFixNow] = useState(true);
  const label = useStepLabel();
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState<StepNote[]>([]);
  const [busy, setBusy] = useState(false);
  const selected = selection?.kind === "step" ? selection.stepId : null;
  const canNote = selected !== null && !notes.some((n) => n.stepId === selected);
  const ready = reason.trim() !== "" || notes.some((n) => n.note.trim() !== "");
  const hint = useMemo(() => (selected ? t.evidence.noteOn(label(selected)) : t.evidence.selectToNote), [selected, label]);
  const submit = async () => {
    setBusy(true);
    const ok = await sendBack(reason, notes);
    setBusy(false);
    if (!ok) return;
    onSent();
    if (fixNow && agentReady && scenario) {
      // The reason itself travels through Core (get_scenario feedback); this only wakes the AI.
      void askAgent(t.evidence.sentBackAsk(reason.trim()), { id: scenario.id, name: scenario.name }, `${scenario.name} ・ ${t.evidence.sendBackShort}`);
    }
  };
  return (
    <div className="space-y-2">
      <div className="text-[12px] font-bold text-shu-600">{t.evidence.sendBack}</div>
      <textarea
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder={t.evidence.reasonPlaceholder}
        className="w-full resize-y rounded-[4px] border border-slate-300 bg-paper px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-500"
      />
      {notes.map((n, i) => (
        <div key={n.stepId} className="rounded-[4px] border border-slate-200 bg-paper p-1.5">
          <div className="flex items-center gap-1">
            <StepLink id={n.stepId} />
            <button
              type="button"
              onClick={() => setNotes(notes.filter((_, j) => j !== i))}
              className="ml-auto px-1 text-[12px] text-slate-400 hover:text-shu-600"
              aria-label={t.evidence.removeNote}
            >
              ✕
            </button>
          </div>
          <textarea
            autoFocus
            value={n.note}
            onChange={(e) => setNotes(notes.map((m, j) => (j === i ? { ...m, note: e.target.value } : m)))}
            rows={2}
            placeholder={t.evidence.notePlaceholder}
            className="mt-1 w-full resize-y rounded-[4px] border border-slate-200 px-2 py-1 text-[12.5px] outline-none focus:border-brand-500"
          />
        </div>
      ))}
      <button
        type="button"
        disabled={!canNote}
        onClick={() => selected && setNotes([...notes, { stepId: selected, note: "" }])}
        className="w-full truncate rounded-[4px] border border-dashed border-slate-300 px-2 py-1 text-left text-[12px] text-slate-600 enabled:hover:border-brand-500 enabled:hover:text-brand-700 disabled:text-slate-400"
      >
        ＋ {hint}
      </button>
      {agentReady && (
        <label className="flex items-center gap-1.5 text-[12px] text-slate-600">
          <input type="checkbox" checked={fixNow} onChange={(e) => setFixNow(e.target.checked)} />
          {t.evidence.fixNow(agentName)}
        </label>
      )}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onCancel} className="h-9 rounded-[4px] px-3 text-[13px] text-slate-500 hover:bg-slate-100">
          {t.cancel}
        </button>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void submit()}
          className="h-9 flex-1 rounded-[4px] bg-shu-500 px-3 text-[13px] font-semibold text-white enabled:hover:bg-shu-600 disabled:bg-slate-200 disabled:text-slate-400"
        >
          {t.evidence.sendBack}
        </button>
      </div>
    </div>
  );
}
