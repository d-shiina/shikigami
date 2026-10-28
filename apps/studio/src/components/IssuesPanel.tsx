import { useStudio } from "../context";
import { t } from "../lib/i18n";

export function IssuesPanel() {
  const validation = useStudio((s) => s.validation);
  const select = useStudio((s) => s.select);
  const issues = validation?.issues ?? [];
  if (issues.length === 0) return <p className="p-4 text-sm text-emerald-700">✓ {t.noIssues}</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {issues.map((issue) => (
        <li key={`${issue.code}${issue.path}${issue.message}`}>
          <button
            type="button"
            className="w-full px-4 py-2 text-left hover:bg-slate-50"
            onClick={() => issue.stepId && select({ kind: "step", stepId: issue.stepId })}
          >
            <div className={`text-xs font-semibold ${issue.severity === "error" ? "text-red-700" : "text-amber-700"}`}>
              {issue.severity === "error" ? "エラー" : "警告"} · {issue.code}
            </div>
            <div className="text-sm">{issue.message}</div>
            <div className="font-mono text-[10px] text-slate-400">{issue.path}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}
