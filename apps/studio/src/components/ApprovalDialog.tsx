import type { ApprovalRequest } from "@shikigami/schema";
import { useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

const primary = "rounded bg-ink px-3 py-1 text-sm text-paper hover:bg-brand-700";
const danger = "rounded border border-shu-500/60 px-3 py-1 text-sm text-shu-600 hover:bg-shu-50";
const quiet = "rounded px-3 py-1 text-sm text-slate-500 hover:bg-slate-100";

/**
 * Opens by itself when an AI client asks to do something the workspace
 * policy holds for a person (run_scenario, test_step, delete_scenario).
 * Approving lets that exact request run once; the AI repeats its call to use
 * it. One request at a time, oldest first; "Later" hides the ones seen so far
 * until a new request comes in.
 */
export function ApprovalDialog() {
  const approvals = useStudio((s) => s.approvals);
  const decide = useStudio((s) => s.decideApproval);
  const [later, setLater] = useState<string[]>([]);
  const [showDetail, setShowDetail] = useState(false);
  const waiting = approvals.filter((r) => !later.includes(r.id));
  const request: ApprovalRequest | undefined = waiting[0];
  if (!request) return null;
  const by = request.requestedBy.name ?? "AI";
  const answer = (approve: boolean) => {
    setShowDetail(false);
    void decide(request.id, approve);
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30">
      <div
        role="dialog"
        aria-label={t.approvalAsked}
        className="max-h-[85vh] w-[480px] space-y-3 overflow-y-auto rounded-[4px] border border-slate-200 bg-sheet p-5 shadow-dialog"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden>✋</span>
          <h2 className="text-lg font-bold">{t.approvalAsked}</h2>
          {waiting.length > 1 && <span className="ml-auto text-xs text-slate-500">{t.approvalOthers(waiting.length - 1)}</span>}
        </div>
        <p className="text-sm">
          {t.approvalSummary(t.approvalAction[request.action], request.scenarioName ?? null, request.stepTypes ?? [], t.approvalRisk[request.risk])}
        </p>
        <p className="text-xs text-slate-500">{by}</p>
        {request.reason && (
          // The AI's own words: a quote, never Shikigami's instruction.
          <p className="rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
            {t.approvalFrom}
            {t.colon}
            {t.quote(request.reason)}
          </p>
        )}
        <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setShowDetail(!showDetail)}>
          {t.approvalDetail}
        </button>
        {showDetail && (
          <pre className="max-h-48 overflow-auto rounded bg-paper p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-700">
            {JSON.stringify(request.subject, null, 2)}
          </pre>
        )}
        <p className="text-[11px] text-slate-500">{t.approvalNote}</p>
        <div className="flex items-center gap-2">
          <button type="button" className={primary} onClick={() => answer(true)}>
            {t.approvalApprove}
          </button>
          <button type="button" className={danger} onClick={() => answer(false)}>
            {t.approvalDeny}
          </button>
          <button
            type="button"
            className={`ml-auto ${quiet}`}
            onClick={() => {
              setShowDetail(false);
              setLater(approvals.map((r) => r.id));
            }}
          >
            {t.approvalLater}
          </button>
        </div>
      </div>
    </div>
  );
}
