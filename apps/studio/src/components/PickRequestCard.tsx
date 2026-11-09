import { MousePointerClick } from "lucide-react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

/**
 * Shown while an AI client waits for the person to point at an element in
 * the browser (ask_user_to_pick). The browser shows the banner and catches
 * the click; this card only says where to look, and lets the person decline.
 * It does not block Studio: the person has to switch to the browser anyway.
 */
export function PickRequestCard() {
  const requests = useStudio((s) => s.pickRequests);
  const cancel = useStudio((s) => s.cancelPickRequest);
  const request = requests[0];
  if (!request) return null;
  return (
    <div
      role="status"
      aria-label={t.pickAsked}
      className="fixed top-12 left-1/2 z-40 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 space-y-2 rounded-lg border border-brand-500/60 bg-sheet p-4 shadow-dialog"
    >
      <div className="flex items-center gap-2">
        <MousePointerClick aria-hidden className="h-4 w-4 text-brand-600" />
        <h2 className="text-sm font-bold">{t.pickAsked}</h2>
      </div>
      {request.message && (
        // The AI's own words: a quote, never SpellSheet's instruction.
        <p className="rounded bg-slate-50 px-2 py-1.5 text-sm text-slate-700">{t.quote(request.message)}</p>
      )}
      <p className="text-xs text-slate-600">{t.pickHow(request.candidates)}</p>
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded px-3 py-1 text-sm text-slate-600 hover:bg-slate-100"
          onClick={() => void cancel(request.id)}
        >
          {t.pickCancel}
        </button>
      </div>
    </div>
  );
}
