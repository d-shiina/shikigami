import { useMemo, useState } from "react";
import { useStudio } from "../context";
import type { SecretField } from "../lib/api";
import { t } from "../lib/i18n";
import { nextSecretAsk, type SecretAsk } from "../lib/secretAsk";

const inputClass =
  "w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-ink focus:outline-none";
const primary = "rounded bg-ink px-3 py-1 text-sm text-paper";
const quiet = "rounded px-3 py-1 text-sm text-slate-500 hover:bg-slate-100";

const FIELD_INPUT: Record<SecretField, { type: string; autoComplete: string; mono?: boolean }> = {
  username: { type: "text", autoComplete: "off" },
  password: { type: "password", autoComplete: "new-password" },
  totp: { type: "password", autoComplete: "off", mono: true },
  // Obtained by oauth.signIn; never asked for (the vault drops it from requests).
  accessToken: { type: "password", autoComplete: "off", mono: true },
};

function siteLabel(site: string) {
  return site.replace(/^https?:\/\//, "");
}

/**
 * The values for one ask. Name and sites are filled in from the request (or
 * the failed run): the user only types the values, which go to the vault
 * once and never reach the AI.
 */
function AskForm({ ask }: { ask: SecretAsk }) {
  const saveSecret = useStudio((s) => s.saveSecretAdding);
  const dismissRequest = useStudio((s) => s.dismissSecretRequest);
  const dismissFix = useStudio((s) => s.dismissSecretFix);
  const openForm = useStudio((s) => s.openSecretForm);
  const error = useStudio((s) => s.error);
  const [values, setValues] = useState<Partial<Record<SecretField, string>>>({});
  const [site, setSite] = useState("");
  const [saving, setSaving] = useState(false);

  const later = () => (ask.source === "ai" ? void dismissRequest(ask.name) : dismissFix());
  const fullForm = () => {
    // A run's ask is handled there; an AI's request stays until it is answered.
    if (ask.source === "run") dismissFix();
    openForm({ name: ask.name, sites: ask.sites, fields: ask.fields });
  };

  return (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ask.quick) return;
        setSaving(true);
        await saveSecret(
          {
            name: ask.name,
            username: ask.fields.includes("username") ? (values.username ?? "") : undefined,
            password: ask.fields.includes("password") ? values.password : undefined,
            totp: ask.fields.includes("totp") ? values.totp : undefined,
          },
          [...ask.sites, ...(site.trim() ? [site.trim()] : [])],
        );
        setSaving(false);
      }}
    >
      <p className="text-sm">
        {ask.source === "run" ? t.secretFixTitle(ask.name, ask.code ?? "") : t.secretAskLead(ask.name)}
      </p>
      {ask.reason && (
        // The AI's own words: a quote, never Shikigami's instruction.
        <p className="rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
          {t.secretAskFrom}：「{ask.reason}」
        </p>
      )}

      {ask.quick ? (
        <>
          {ask.fields.map((field, i) => (
            <label key={field} className="block space-y-1">
              <span className="text-xs font-medium text-slate-600">{t.secretField[field]}</span>
              <input
                className={`${inputClass} ${FIELD_INPUT[field].mono ? "font-mono text-xs" : ""}`}
                type={FIELD_INPUT[field].type}
                autoComplete={FIELD_INPUT[field].autoComplete}
                autoFocus={i === 0}
                required
                value={values[field] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
              />
              {field === "totp" && <span className="block text-[11px] text-slate-400">{t.secretTotpHint}</span>}
            </label>
          ))}
          {ask.needsSite && (
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600">{t.secretAskSiteInput}</span>
              <input
                className={`${inputClass} font-mono text-xs`}
                required
                autoFocus={ask.fields.length === 0}
                placeholder="https://example.com/login"
                value={site}
                onChange={(e) => setSite(e.target.value)}
              />
            </label>
          )}
          {ask.sites.length > 0 && (
            <div className={ask.existing ? "rounded border border-shu-600/40 bg-shu-600/5 px-2 py-1.5" : ""}>
              <span className="text-xs font-medium text-slate-600">
                {ask.existing ? t.secretAskNewSites : t.secretAskSites}
              </span>
              <ul className="font-mono text-xs text-slate-700">
                {ask.sites.map((s) => (
                  <li key={s}>{siteLabel(s)}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <>
          {ask.page && <p className="text-xs text-slate-600">{t.secretFixSite(ask.page)}</p>}
          <p className="text-xs text-slate-500">{t.secretAskNeedsForm}</p>
        </>
      )}

      {error && <p className="text-xs text-shu-600">{error}</p>}
      <p className="text-[11px] text-slate-500">{t.secretAskNote}</p>
      <div className="flex items-center gap-2">
        {ask.quick ? (
          <button type="submit" className={primary} disabled={saving}>
            {t.secretAskSave}
          </button>
        ) : (
          <button type="button" className={primary} onClick={fullForm}>
            {t.secretAskRegister}
          </button>
        )}
        <button type="button" className={quiet} onClick={later}>
          {t.secretAskLater}
        </button>
        {ask.quick && (
          <button type="button" className="ml-auto text-xs text-brand-600 hover:underline" onClick={fullForm}>
            {t.secretAskFullForm}
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Opens by itself when a login is needed: an AI called request_secret, or a
 * run stopped on a missing secret. One ask at a time, oldest first.
 */
export function SecretAskDialog() {
  const requests = useStudio((s) => s.secretRequests);
  const fix = useStudio((s) => s.secretFix);
  const secrets = useStudio((s) => s.secrets);
  const secretsOpen = useStudio((s) => s.secretsOpen);
  const keyMissing = useStudio((s) => s.secretKeyMissing);
  const ask = useMemo(() => nextSecretAsk(requests, fix, secrets), [requests, fix, secrets]);
  // The secrets dialog (full form, or a key reset) takes over while open.
  if (!ask || secretsOpen || keyMissing) return null;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30">
      <div
        role="dialog"
        aria-label={t.secretAskTitle}
        className="max-h-[85vh] w-[440px] overflow-y-auto rounded-[4px] border border-slate-200 bg-sheet p-5 shadow-dialog"
      >
        <div className="mb-3 flex items-center gap-2">
          <span aria-hidden>🔑</span>
          <h2 className="text-lg font-bold">{t.secretAskTitle}</h2>
          {requests.length > 1 && <span className="ml-auto text-xs text-slate-500">{t.secretAskOthers(requests.length - 1)}</span>}
        </div>
        {/* A new ask starts with empty values. */}
        <AskForm key={`${ask.source}\n${ask.name}\n${ask.fields.join()}\n${ask.sites.join()}`} ask={ask} />
      </div>
    </div>
  );
}
