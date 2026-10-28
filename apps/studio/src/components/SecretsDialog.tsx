import { useState } from "react";
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
function SecretForm({ initial, isNew, onDone }: { initial: Draft; isNew: boolean; onDone: () => void }) {
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
      <Labeled label={t.secretName}>
        <input
          className={inputClass}
          value={draft.name}
          disabled={!isNew}
          required
          placeholder="受注システム"
          onChange={(e) => edit({ name: e.target.value })}
        />
      </Labeled>
      <Labeled label={t.secretUsername}>
        <input className={inputClass} value={draft.username} onChange={(e) => edit({ username: e.target.value })} />
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

export function SecretsDialog() {
  const open = useStudio((s) => s.secretsOpen);
  const setOpen = useStudio((s) => s.setSecretsOpen);
  const secrets = useStudio((s) => s.secrets);
  const keyLocation = useStudio((s) => s.secretKeyLocation);
  const removeSecret = useStudio((s) => s.removeSecret);
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean } | null>(null);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30" onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-label={t.secrets}
        className="max-h-[85vh] w-[520px] overflow-y-auto rounded-lg border border-slate-200 bg-sheet p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center">
          <h2 className="font-serif text-lg font-bold">{t.secrets}</h2>
          <button
            type="button"
            className="ml-auto text-xs text-slate-500 hover:underline"
            onClick={() => {
              setEditing(null);
              setOpen(false);
            }}
          >
            {t.close}
          </button>
        </div>
        <p className="mb-1 text-xs text-slate-600">{t.secretsIntro}</p>
        {keyLocation && <p className="mb-4 text-[11px] text-slate-400">{t.secretKeyNote(keyLocation)}</p>}

        {editing ? (
          <SecretForm
            key={editing.draft.name}
            initial={editing.draft}
            isNew={editing.isNew}
            onDone={() => setEditing(null)}
          />
        ) : (
          <>
            <ul className="mb-3 space-y-2">
              {secrets.length === 0 && <li className="text-sm text-slate-400">{t.secretNone}</li>}
              {secrets.map((s) => (
                <li key={s.name} className="rounded border border-slate-200 p-2">
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
                    {s.sites.map((site) => (
                      <span key={site} className="font-mono">
                        {site}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="rounded bg-ink px-3 py-1 text-sm text-paper"
              onClick={() => setEditing({ draft: empty, isNew: true })}
            >
              {t.secretNew}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
