import type { ByRisk, Decision, Policy, RiskLevel } from "@shikigami/schema";
import { useEffect, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

const inputClass =
  "w-full rounded border border-slate-300 bg-sheet px-2 py-1 font-mono text-xs focus:border-ink focus:outline-none";
const selectClass = "rounded border border-slate-300 bg-sheet px-1 py-0.5 text-xs focus:border-ink focus:outline-none";
const RISKS: RiskLevel[] = ["safe", "interactive", "dangerous"];
const DECISIONS: Decision[] = ["allow", "ask", "deny"];

/** One entry per non-empty line. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function DecisionSelect({ value, onChange, label }: { value: Decision; onChange: (d: Decision) => void; label: string }) {
  return (
    <select aria-label={label} className={selectClass} value={value} onChange={(e) => onChange(e.target.value as Decision)}>
      {DECISIONS.map((d) => (
        <option key={d} value={d}>
          {t.policyDecision[d]}
        </option>
      ))}
    </select>
  );
}

function RiskRow({ label, value, onChange }: { label: string; value: ByRisk; onChange: (v: ByRisk) => void }) {
  return (
    <tr>
      <th className="py-1 pr-3 text-left text-xs font-medium text-slate-600">{label}</th>
      {RISKS.map((risk) => (
        <td key={risk} className="py-1 pr-2">
          <DecisionSelect
            label={`${label}：${t.approvalRisk[risk]}`}
            value={value[risk] ?? "allow"}
            onChange={(d) => onChange({ ...value, [risk]: d })}
          />
        </td>
      ))}
    </tr>
  );
}

/**
 * The workspace policy (policy.json): which sites and programs flows may
 * reach, and what an AI may do without the person's approval. A section of
 * the settings place. Only people edit it (here or in the file); AI clients
 * can read it but never write it.
 */
export function PolicySection() {
  const policy = useStudio((s) => s.policy);
  const setOpen = useStudio((s) => s.setPolicyOpen);
  const save = useStudio((s) => s.savePolicy);
  const flow = useStudio((s) => s.flow);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [sites, setSites] = useState("");
  const [apps, setApps] = useState("");

  // Read the file while the section is on screen: it may change outside Studio.
  useEffect(() => {
    setOpen(true);
    return () => setOpen(false);
  }, [setOpen]);

  useEffect(() => {
    if (!policy) return;
    setDraft(policy);
    setSites((policy.sites ?? []).join("\n"));
    setApps((policy.apps ?? []).join("\n"));
  }, [policy]);

  if (!draft) return null;
  const ai = draft.ai ?? {};
  const own = flow ? (draft.flows?.[flow.id] ?? {}) : null;

  const setOwn = (patch: { aiRun?: Decision | null; unattended?: boolean | null }) => {
    if (!flow) return;
    const next = { ...(draft.flows?.[flow.id] ?? {}), ...patch };
    // Leave out what is back to the default, so the file stays short.
    if (next.aiRun == null) delete next.aiRun;
    if (next.unattended == null || next.unattended) delete next.unattended;
    const flows = { ...(draft.flows ?? {}) };
    if (Object.keys(next).length === 0) delete flows[flow.id];
    else flows[flow.id] = next;
    setDraft({ ...draft, flows });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await save({ ...draft, sites: lines(sites), apps: lines(apps) });
  };

  return (
    <form aria-label={t.policy} onSubmit={submit} className="space-y-4">
      <p className="text-xs text-slate-600">{t.policyIntro}</p>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600">{t.policySites}</span>
        <textarea rows={3} className={inputClass} value={sites} onChange={(e) => setSites(e.target.value)} />
        <span className="block text-[11px] text-slate-400">{t.policySitesHint}</span>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600">{t.policyApps}</span>
        <textarea rows={3} className={inputClass} value={apps} onChange={(e) => setApps(e.target.value)} />
        <span className="block text-[11px] text-slate-400">{t.policyAppsHint}</span>
      </label>

      <section>
        <h3 className="mb-1 text-xs font-bold text-slate-600">{t.policyAi}</h3>
        <table>
          <thead>
            <tr>
              <th />
              {RISKS.map((r) => (
                <th key={r} className="pr-2 text-left text-[11px] font-normal text-slate-500">
                  {t.approvalRisk[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <RiskRow
              label={t.policyAiRun}
              value={ai.runFlow ?? { safe: "allow", interactive: "allow", dangerous: "ask" }}
              onChange={(runFlow) => setDraft({ ...draft, ai: { ...ai, runFlow } })}
            />
            <RiskRow
              label={t.policyAiTest}
              value={ai.testStep ?? { safe: "allow", interactive: "allow", dangerous: "ask" }}
              onChange={(testStep) => setDraft({ ...draft, ai: { ...ai, testStep } })}
            />
            <tr>
              <th className="py-1 pr-3 text-left text-xs font-medium text-slate-600">{t.policyAiDelete}</th>
              <td className="py-1">
                <DecisionSelect
                  label={t.policyAiDelete}
                  value={ai.deleteFlow ?? "ask"}
                  onChange={(deleteFlow) => setDraft({ ...draft, ai: { ...ai, deleteFlow } })}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {flow && own && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-bold text-slate-600">{t.policyFlow(flow.name)}</h3>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-slate-600">{t.policyFlowAi}</span>
            <select
              className={selectClass}
              value={own.aiRun ?? ""}
              onChange={(e) => setOwn({ aiRun: (e.target.value || null) as Decision | null })}
            >
              <option value="">{t.policyFlowAiInherit}</option>
              {DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {t.policyDecision[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={own.unattended ?? true}
              onChange={(e) => setOwn({ unattended: e.target.checked })}
            />
            {t.policyUnattended}
          </label>
        </section>
      )}

      <div className="flex justify-end">
        <button type="submit" className="rounded-[4px] bg-ink px-3 py-1 text-sm font-medium text-sheet hover:bg-brand-700">
          {t.policySave}
        </button>
      </div>
    </form>
  );
}
