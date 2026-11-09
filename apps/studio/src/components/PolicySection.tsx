import type { ByRisk, Decision, Policy, RiskLevel } from "@spellsheet/schema";
import { useEffect, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { SettingsGroup, SettingsRow, settingsInput, settingsPrimary, settingsSelect } from "./settingsLayout";

const RISKS: RiskLevel[] = ["safe", "interactive", "dangerous"];
const DECISIONS: Decision[] = ["allow", "ask", "deny"];

/** One entry per non-empty line. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function DecisionSelect({
  value,
  onChange,
  label,
  className = "",
}: {
  value: Decision;
  onChange: (d: Decision) => void;
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      className={`${settingsSelect} ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value as Decision)}
    >
      {DECISIONS.map((d) => (
        <option key={d} value={d}>
          {t.policyDecision[d]}
        </option>
      ))}
    </select>
  );
}

/** The AI operations by how far they reach: one column per risk, the same in every row. */
const RISK_GRID = "grid grid-cols-3 gap-2";

function RiskRow({ label, value, onChange }: { label: string; value: ByRisk; onChange: (v: ByRisk) => void }) {
  return (
    <SettingsRow label={label}>
      <div className={RISK_GRID}>
        {RISKS.map((risk) => (
          <div key={risk} className="min-w-0">
            {/* The column headings are hidden when the rows stack, so name each risk here. */}
            <span className="mb-0.5 block truncate text-xs text-slate-500 @min-[640px]:hidden">{t.approvalRisk[risk]}</span>
            <DecisionSelect
              className="w-full"
              label={`${label}：${t.approvalRisk[risk]}`}
              value={value[risk] ?? "allow"}
              onChange={(d) => onChange({ ...value, [risk]: d })}
            />
          </div>
        ))}
      </div>
    </SettingsRow>
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
    <form aria-label={t.policy} onSubmit={submit} className="space-y-5">
      <p className="px-1 text-xs leading-relaxed text-slate-600">{t.policyIntro}</p>
      <SettingsGroup>
        <SettingsRow
          align="start"
          label={t.policySites}
          htmlFor="policy-sites"
          hint={
            <>
              {t.policyOnePerLine}
              <br />
              {t.policySitesHint}
            </>
          }
        >
          <textarea id="policy-sites" rows={3} className={`${settingsInput} font-mono text-[12px]`} value={sites} onChange={(e) => setSites(e.target.value)} />
        </SettingsRow>
        <SettingsRow
          align="start"
          label={t.policyApps}
          htmlFor="policy-apps"
          hint={
            <>
              {t.policyOnePerLine}
              <br />
              {t.policyAppsHint}
            </>
          }
        >
          <textarea id="policy-apps" rows={3} className={`${settingsInput} font-mono text-[12px]`} value={apps} onChange={(e) => setApps(e.target.value)} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t.policyAi}>
        <div className="hidden gap-x-6 bg-slate-50 px-4 py-1.5 @min-[640px]:grid @min-[640px]:grid-cols-[minmax(180px,2fr)_minmax(0,3fr)]">
          <span />
          <div className={RISK_GRID}>
            {RISKS.map((r) => (
              <span key={r} className="truncate text-xs text-slate-500">
                {t.approvalRisk[r]}
              </span>
            ))}
          </div>
        </div>
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
        <SettingsRow label={t.policyAiDelete}>
          <DecisionSelect
            label={t.policyAiDelete}
            value={ai.deleteFlow ?? "ask"}
            onChange={(deleteFlow) => setDraft({ ...draft, ai: { ...ai, deleteFlow } })}
          />
        </SettingsRow>
      </SettingsGroup>

      {flow && own && (
        <SettingsGroup title={t.policyFlow(flow.name)} description={t.policyFlowHint}>
          <SettingsRow label={t.policyFlowAi} htmlFor="policy-flow-ai">
            <select
              id="policy-flow-ai"
              className={settingsSelect}
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
          </SettingsRow>
          <SettingsRow label={t.policyUnattended} hint={t.policyUnattendedHint}>
            <label className="flex items-center gap-2 text-slate-700">
              <input
                type="checkbox"
                checked={own.unattended ?? true}
                onChange={(e) => setOwn({ unattended: e.target.checked })}
              />
              {t.policyAllow}
            </label>
          </SettingsRow>
        </SettingsGroup>
      )}

      {/* Kept in sight while the person scrolls the policy, since it saves all of it at once. */}
      <div className="sticky bottom-0 -mx-1 flex justify-end bg-paper px-1 py-2">
        <button type="submit" className={settingsPrimary}>
          {t.policySave}
        </button>
      </div>
    </form>
  );
}
