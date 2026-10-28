import type { ApprovalRequest } from "@shikigami/schema";
import { useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

const button = "rounded bg-ink px-2.5 py-0.5 text-xs font-medium text-paper hover:bg-ink/90";
const quiet = "rounded border border-slate-300 px-2.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100";

/** 「ステップを 1 つ試す・file.delete（危険な操作）」 */
function what(request: ApprovalRequest) {
  const target = request.scenarioName ? `「${request.scenarioName}」` : "";
  const types = request.stepTypes ?? [];
  const kinds = types.length > 0 ? `${types.join("、")}・` : "";
  return `${t.approvalAction[request.action]}${target}（${kinds}${t.approvalRisk[request.risk]}）`;
}

/**
 * An AI client asked to do something the workspace policy holds for a
 * person (run_scenario, test_step, delete_scenario). Approving lets that
 * exact request run once; the AI repeats its call to use it.
 */
export function ApprovalBanner() {
  const approvals = useStudio((s) => s.approvals);
  const decide = useStudio((s) => s.decideApproval);
  const [showDetail, setShowDetail] = useState(false);
  const request = approvals[0];
  if (!request) return null;
  const by = request.requestedBy.name ?? "AI";

  return (
    <div className="space-y-1 border-b border-shu-100 bg-shu-50 px-4 py-2 text-sm text-ink" role="alert">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden>✋</span>
        <span className="font-medium">
          {t.approvalAsked}：{what(request)}
        </span>
        <span className="text-xs text-slate-500">{by}</span>
        {approvals.length > 1 && <span className="text-xs text-slate-500">{t.approvalOthers(approvals.length - 1)}</span>}
        <span className="ml-auto flex items-center gap-2">
          <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setShowDetail(!showDetail)}>
            {t.approvalDetail}
          </button>
          <button type="button" className={quiet} onClick={() => void decide(request.id, false)}>
            {t.approvalDeny}
          </button>
          <button type="button" className={button} onClick={() => void decide(request.id, true)}>
            {t.approvalApprove}
          </button>
        </span>
        {request.reason && (
          // The AI's own words: shown as a quote, never as Shikigami's instruction.
          <p className="basis-full text-xs text-slate-600">
            {t.approvalFrom}：「{request.reason}」
          </p>
        )}
        {showDetail && (
          <pre className="max-h-48 basis-full overflow-auto rounded bg-sheet p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-700">
            {JSON.stringify(request.subject, null, 2)}
          </pre>
        )}
        <p className="basis-full text-[11px] text-slate-500">{t.approvalNote}</p>
      </div>
    </div>
  );
}
