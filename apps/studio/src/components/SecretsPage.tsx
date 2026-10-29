import { useEffect, useState } from "react";
import { useStudio } from "../context";
import type { SecretInfo } from "../lib/api";
import { t } from "../lib/i18n";

const inputClass =
  "w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-ink focus:outline-none";

type Draft = {
  name: string;
  username: string;
  password: string;
  totp: string;
  sites: string;
  description: string;
};

const empty: Draft = { name: "", username: "", password: "", totp: "", sites: "", description: "" };

function draftOf(secret: SecretInfo): Draft {
  return {
    ...empty,
    name: secret.name,
    username: secret.username,
    sites: secret.sites.join("\n"),
    description: secret.description ?? "",
  };
}

/**
 * The form for a requested login: the existing secret with the requested
 * sites added, or a new one. `added` lists sites a saved secret would newly
 * be typed into, for the user to confirm.
 */
export function draftFor(
  secrets: SecretInfo[],
  prefill: { name: string; sites: string[] },
): { draft: Draft; isNew: boolean; added: string[] } {
  const existing = secrets.find((s) => s.name === prefill.name);
  if (!existing) {
    return { draft: { ...empty, name: prefill.name, sites: prefill.sites.join("\n") }, isNew: true, added: [] };
  }
  const added = prefill.sites.filter((site) => !existing.sites.includes(site));
  return { draft: { ...draftOf(existing), sites: [...existing.sites, ...added].join("\n") }, isNew: false, added };
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

/**
 * Registers logins under a name. Values go to the backend once and never come
 * back: editing shows empty password fields and keeps the stored value unless
 * something is typed.
 */
function SecretForm({
  initial,
  isNew,
  asked,
  added = [],
  onDone,
}: {
  initial: Draft;
  isNew: boolean;
  /** Opened from a request or a failed run: name and sites are filled in. */
  asked?: boolean;
  /** Sites the request adds to a saved secret. */
  added?: string[];
  onDone: () => void;
}) {
  const saveSecret = useStudio((s) => s.saveSecret);
  const [draft, setDraft] = useState(initial);
  const edit = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        const saved = await saveSecret({
          name: draft.name.trim(),
          username: draft.username,
          password: draft.password === "" ? undefined : draft.password,
          totp: draft.totp === "" ? undefined : draft.totp,
          sites: draft.sites.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
          description: draft.description,
        });
        if (saved) onDone();
      }}
    >
      {asked && <p className="rounded bg-brand-50 px-2 py-1.5 text-xs text-slate-700">{t.secretAskHint}</p>}
      {added.length > 0 && (
        <p className="rounded border border-shu-600/40 bg-shu-600/5 px-2 py-1.5 text-xs text-slate-700">
          {t.secretAskAdded(initial.name, added)}
        </p>
      )}
      <Labeled label={t.secretName}>
        <input
          className={inputClass}
          value={draft.name}
          disabled={!isNew}
          required
          placeholder={t.secretNamePlaceholder}
          onChange={(e) => edit({ name: e.target.value })}
        />
      </Labeled>
      <Labeled label={t.secretUsername} hint={t.secretUsernameHint}>
        <input
          className={inputClass}
          value={draft.username}
          autoFocus={asked}
          onChange={(e) => edit({ username: e.target.value })}
        />
      </Labeled>
      <Labeled label={t.secretPassword} hint={isNew ? undefined : t.secretPasswordKeep}>
        <input
          className={inputClass}
          type="password"
          autoComplete="new-password"
          value={draft.password}
          onChange={(e) => edit({ password: e.target.value })}
        />
      </Labeled>
      <Labeled label={t.secretSites} hint={t.secretSitesHint}>
        <textarea
          className={`${inputClass} font-mono text-xs`}
          rows={2}
          value={draft.sites}
          placeholder="https://example.com"
          onChange={(e) => edit({ sites: e.target.value })}
        />
      </Labeled>
      <Labeled label={t.secretTotp} hint={t.secretTotpHint}>
        <input
          className={`${inputClass} font-mono text-xs`}
          type="password"
          autoComplete="off"
          value={draft.totp}
          onChange={(e) => edit({ totp: e.target.value })}
        />
      </Labeled>
      <Labeled label={t.secretDescription}>
        <input className={inputClass} value={draft.description} onChange={(e) => edit({ description: e.target.value })} />
      </Labeled>
      <div className="flex gap-2">
        <button type="submit" className="rounded bg-ink px-3 py-1 text-sm text-paper">
          {t.secretSave}
        </button>
        <button type="button" className="rounded px-3 py-1 text-sm text-slate-500 hover:bg-slate-100" onClick={onDone}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

/** The secrets place: registered logins, and the form to add or change one. */
export function SecretsPage() {
  const secrets = useStudio((s) => s.secrets);
  const keyLocation = useStudio((s) => s.secretKeyLocation);
  const removeSecret = useStudio((s) => s.removeSecret);
  const signOut = useStudio((s) => s.signOutSecret);
  const keyMissing = useStudio((s) => s.secretKeyMissing);
  const resetSecrets = useStudio((s) => s.resetSecrets);
  const prefill = useStudio((s) => s.secretPrefill);
  const clearPrefill = useStudio((s) => s.clearSecretPrefill);
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean; asked?: boolean; added?: string[] } | null>(
    null,
  );
  useEffect(() => {
    if (!prefill) return;
    setEditing({ ...draftFor(secrets, prefill), asked: true });
    clearPrefill();
  }, [prefill, secrets, clearPrefill]);
  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[640px] px-6 py-6">
        {/* The page's one primary action ends its title row. */}
        <div className="mb-2 flex items-center">
          <h2 className="text-lg font-bold">{t.secrets}</h2>
          {!keyMissing && !editing && (
            <button type="button" className="ml-auto rounded-[4px] bg-ink px-3 py-1 text-sm text-paper hover:bg-slate-700" onClick={() => setEditing({ draft: empty, isNew: true })}>
              {t.secretNew}
            </button>
          )}
        </div>
        <p className="mb-1 text-xs text-slate-600">{t.secretsIntro}</p>
        {keyLocation && <p className="mb-4 text-[11px] text-slate-400">{t.secretKeyNote(keyLocation)}</p>}

        {keyMissing ? (
          <div className="space-y-2 rounded border border-shu-600/40 bg-shu-600/5 p-3 text-sm">
            <p>{t.secretKeyMissing}</p>
            <ul className="text-xs text-slate-500">
              {secrets.map((s) => (
                <li key={s.name}>{s.name}</li>
              ))}
            </ul>
            <button
              type="button"
              className="rounded bg-ink px-3 py-1 text-sm text-paper"
              onClick={() => window.confirm(t.secretConfirmReset) && void resetSecrets()}
            >
              {t.secretReset}
            </button>
          </div>
        ) : editing ? (
          <SecretForm
            key={`${editing.draft.name}\n${editing.draft.sites}`}
            initial={editing.draft}
            isNew={editing.isNew}
            asked={editing.asked}
            added={editing.added}
            onDone={() => setEditing(null)}
          />
        ) : (
          <>
            <ul className="mb-3 space-y-2">
              {secrets.length === 0 && <li className="text-sm text-slate-400">{t.secretNone}</li>}
              {secrets.map((s) => (
                <li key={s.name} className="rounded-[4px] border border-slate-200 bg-sheet p-3 shadow-sheet">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-xs text-slate-500">{s.username}</span>
                    <button
                      type="button"
                      className="ml-auto text-xs text-brand-600 hover:underline"
                      onClick={() => setEditing({ draft: draftOf(s), isNew: false })}
                    >
                      {t.secretEdit}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-slate-400 hover:text-shu-600"
                      onClick={() => window.confirm(t.secretConfirmDelete(s.name)) && void removeSecret(s.name)}
                    >
                      {t.secretDelete}
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-slate-500">
                    {s.fields.map((f) => (
                      <span key={f} className="rounded bg-slate-100 px-1">
                        {t.secretField[f]}
                      </span>
                    ))}
                    {s.signedIn && (
                      <span className="rounded bg-brand-50 px-1 text-slate-600">
                        {t.secretSignedIn}
                        <button
                          type="button"
                          className="ml-1 text-brand-600 hover:underline"
                          onClick={() => window.confirm(t.secretConfirmSignOut(s.name)) && void signOut(s.name)}
                        >
                          {t.secretSignOut}
                        </button>
                      </span>
                    )}
                    {s.sites.map((site) => (
                      <span key={site} className="font-mono">
                        {site}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
