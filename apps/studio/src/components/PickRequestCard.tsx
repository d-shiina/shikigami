import { Hand, MousePointerClick } from "lucide-react";
import { useEffect } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

/** A waiting AI touches its request every few seconds; one it left behind (stopped with the AI) drops out on reload. */
const RELOAD_MS = 5000;

/**
 * Shown while an AI client waits for the person in the browser: to point at
 * an element (ask_user_to_pick), or to finish something by hand there, such
 * as a login, while its test_step waits. The browser shows the page; this
 * card only says where to look, and lets the person end the wait. It does
 * not block Studio: the person has to switch to the browser anyway.
 */
export function PickRequestCard() {
  const requests = useStudio((s) => s.pickRequests);
  const cancel = useStudio((s) => s.cancelPickRequest);
  const finish = useStudio((s) => s.finishPickRequest);
  const reload = useStudio((s) => s.loadPickRequests);
  const waiting = requests.length > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void reload(), RELOAD_MS);
    return () => clearInterval(timer);
  }, [waiting, reload]);
  const request = requests.find((r) => !r.done);
  if (!request) return null;
  const byHand = request.kind === "human";
  const title = byHand ? t.humanAsked : t.pickAsked;
  const Icon = byHand ? Hand : MousePointerClick;
  return (
    <div
      role="status"
      aria-label={title}
      className="fixed top-12 left-1/2 z-40 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 space-y-2 rounded-lg border border-brand-500/60 bg-sheet p-4 shadow-dialog"
    >
      <div className="flex items-center gap-2">
        <Icon aria-hidden className="h-4 w-4 text-brand-600" />
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      {request.message && (
        // The AI's own words: a quote, never Shikigami's instruction.
        <p className="rounded bg-slate-50 px-2 py-1.5 text-sm text-slate-700">{t.quote(request.message)}</p>
      )}
      <p className="text-xs text-slate-600">{byHand ? t.humanHow : t.pickHow(request.candidates)}</p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded px-3 py-1 text-sm text-slate-600 hover:bg-slate-100"
          onClick={() => void cancel(request.id)}
        >
          {byHand ? t.humanCancel : t.pickCancel}
        </button>
        {byHand && (
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover"
            onClick={() => void finish(request.id)}
          >
            {t.humanDone}
          </button>
        )}
      </div>
    </div>
  );
}
