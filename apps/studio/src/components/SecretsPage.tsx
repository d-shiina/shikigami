import { useEffect, useState } from "react";
import { useStudio } from "../context";
import { api, type SecretInfo, type SecretKind, type WindowsCredentialInfo } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { fieldLabel, KIND_FIELDS, SECRET_KINDS } from "../lib/secretKinds";

const inputClass =
  "w-full rounded border border-slate-300 bg-sheet px-2 py-1 text-sm text-ink focus:border-primary dark:bg-paper focus:outline-none";

type Draft = {
  name: string;
  kind: SecretKind;
  username: string;
  password: string;
  totp: string;
  sites: string;
  description: string;
  /** "windows": the user name and password are read from `windowsCredential`. */
  store: "vault" | "windows";
  windowsCredential: string;
};

const empty: Draft = {
  name: "",
  kind: "login",
  username: "",
  password: "",
  totp: "",
  sites: "",
  description: "",
  store: "vault",
  windowsCredential: "",
};

function draftOf(secret: SecretInfo): Draft {
  return {
    ...empty,
    name: secret.name,
    kind: secret.kind ?? "login",
    username: secret.username,
    sites: secret.sites.join("\n"),
    description: secret.description ?? "",
    store: secret.windowsCredential ? "windows" : "vault",
    windowsCredential: secret.windowsCredential ?? "",
  };
}

/** The generic credentials of Windows Credential Manager, read once the form asks for them. */
function useWindowsCredentials(wanted: boolean): WindowsCredentialInfo[] | null {
  const [list, setList] = useState<WindowsCredentialInfo[] | null>(null);
  useEffect(() => {
    if (!wanted || list) return;
    api.listWindowsCredentials().then(setList, () => setList([]));
  }, [wanted, list]);
  return list;
}

function Choice<T extends string>({ value, options, label, onChange }: { value: T; options: Record<T, string>; label: string; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
      {(Object.keys(options) as T[]).map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          className={`rounded-lg border px-2.5 py-1 text-sm ${
            value === key ? "border-slate-400 bg-slate-100 font-medium text-ink" : "border-slate-300 text-slate-700 hover:bg-slate-100"
          }`}
          onClick={() => onChange(key)}
        >
          {options[key]}
        </button>
      ))}
    </div>
  );
}

/**
 * The form for a requested login: the existing secret with the requested
 * sites added, or a new one. `added` lists sites a saved secret would newly
 * be typed into, for the user to confirm.
 */
export function draftFor(
  secrets: SecretInfo[],
  prefill: { name: string; sites: string[]; kind?: SecretKind },
): { draft: Draft; isNew: boolean; added: string[] } {
  const existing = secrets.find((s) => s.name === prefill.name);
  if (!existing) {
    const draft = { ...empty, name: prefill.name, kind: prefill.kind ?? "login", sites: prefill.sites.join("\n") };
    return { draft, isNew: true, added: [] };
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
  const fields = KIND_FIELDS[draft.kind];
  const fromWindows = draft.store === "windows";
  const credentials = useWindowsCredentials(fromWindows);
  const picked = credentials?.find((c) => c.target === draft.windowsCredential.trim());

  return (
    <form
      className="space-y-3 rounded-lg border border-slate-200 bg-sheet p-4 shadow-sheet"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        const saved = await saveSecret({
          name: draft.name.trim(),
          kind: draft.kind,
          username: fields.includes("username") && !fromWindows ? draft.username : undefined,
          password: draft.password === "" || fromWindows ? undefined : draft.password,
          // Back from Credential Manager: an empty address keeps the values here again.
          windowsCredential: fromWindows ? draft.windowsCredential.trim() : initial.store === "windows" ? "" : undefined,
          totp: draft.totp === "" || !fields.includes("totp") ? undefined : draft.totp,
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
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-slate-600">{t.secretKind}</legend>
        <div className="flex gap-1" role="radiogroup">
          {SECRET_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={draft.kind === kind}
              className={`rounded-lg border px-2.5 py-1 text-sm ${
                draft.kind === kind
                  ? "border-slate-400 bg-slate-100 font-medium text-ink"
                  : "border-slate-300 text-slate-700 hover:bg-slate-100"
              }`}
              onClick={() => edit({ kind })}
            >
              {t.secretKinds[kind]}
            </button>
          ))}
        </div>
        <span className="block text-[11px] text-slate-500">{t.secretKindHints[draft.kind]}</span>
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-slate-600">{t.secretStore}</legend>
        <Choice value={draft.store} options={t.secretStores} label={t.secretStore} onChange={(store) => edit({ store })} />
        <span className="block text-[11px] text-slate-500">{t.secretStoreHints[draft.store]}</span>
      </fieldset>
      {fromWindows && (
        <Labeled
          label={t.secretWindowsTarget}
          hint={picked?.username ? t.secretWindowsUser(picked.username) : credentials?.length === 0 ? t.secretWindowsNone : undefined}
        >
          <input
            className={`${inputClass} font-mono text-xs`}
            list="windows-credentials"
            required
            value={draft.windowsCredential}
            onChange={(e) => edit({ windowsCredential: e.target.value })}
          />
          <datalist id="windows-credentials">
            {(credentials ?? []).map((c) => (
              <option key={c.target} value={c.target}>
                {c.username}
              </option>
            ))}
          </datalist>
        </Labeled>
      )}
      {fields.includes("username") && !fromWindows && (
        <Labeled label={fieldLabel(draft.kind, "username")}>
          <input
            className={inputClass}
            value={draft.username}
            autoFocus={asked}
            onChange={(e) => edit({ username: e.target.value })}
          />
        </Labeled>
      )}
      {!fromWindows && (
        <Labeled label={fieldLabel(draft.kind, "password")} hint={isNew || initial.store === "windows" ? undefined : t.secretPasswordKeep}>
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={draft.password}
            onChange={(e) => edit({ password: e.target.value })}
          />
        </Labeled>
      )}
      <Labeled label={draft.kind === "login" ? t.secretSites : t.secretSitesApi} hint={t.secretSitesHintKind[draft.kind]}>
        <textarea
          className={`${inputClass} font-mono text-xs`}
          rows={2}
          value={draft.sites}
          placeholder={draft.kind === "login" ? "https://example.com" : "https://api.example.com"}
          onChange={(e) => edit({ sites: e.target.value })}
        />
      </Labeled>
      {fields.includes("totp") && (
        <Labeled label={t.secretTotp} hint={t.secretTotpHint}>
          <input
            className={`${inputClass} font-mono text-xs`}
            type="password"
            autoComplete="off"
            value={draft.totp}
            onChange={(e) => edit({ totp: e.target.value })}
          />
        </Labeled>
      )}
      <Labeled label={t.secretDescription}>
        <input className={inputClass} value={draft.description} onChange={(e) => edit({ description: e.target.value })} />
      </Labeled>
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-lg px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={onDone}>
          {t.cancel}
        </button>
        <button type="submit" className="rounded-lg bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover">
          {t.secretSave}
        </button>
      </div>
    </form>
  );
}

function when(at: string): string {
  return new Date(at).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** Whether an OAuth app is signed in, until when, and whether that renews itself. */
function OAuthLine({ secret, now = Date.now() }: { secret: SecretInfo; now?: number }) {
  const status = secret.oauth;
  if (!status) return <p className="mt-1 text-[11px] text-slate-500">{t.secretOauthNotSignedIn}</p>;
  const expired = status.expiresAt !== undefined && Date.parse(status.expiresAt) <= now;
  const parts = [
    status.expiresAt && t.secretOauthExpires(when(status.expiresAt)),
    status.obtainedAt && t.secretOauthObtained(when(status.obtainedAt)),
    status.refreshable ? t.secretOauthRefreshable : t.secretOauthNotRefreshable,
  ].filter(Boolean);
  return (
    <p className="mt-1 text-[11px] text-slate-600">
      {expired && <span className="mr-1 rounded bg-shu-600/10 px-1 text-shu-600">{t.secretOauthExpired}</span>}
      {parts.join(locale === "ja" ? "・" : " · ")}
    </p>
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
            <button type="button" className="ml-auto rounded-lg bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover" onClick={() => setEditing({ draft: empty, isNew: true })}>
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
              className="rounded bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover"
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
                <li key={s.name} className="rounded-lg border border-slate-200 bg-sheet p-3 shadow-sheet">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <span className="rounded-lg border border-slate-300 px-1 text-[11px] text-slate-600">
                      {t.secretKinds[s.kind ?? "login"]}
                    </span>
                    {s.windowsCredential && (
                      <span className="rounded-lg border border-slate-300 px-1 text-[11px] text-slate-600" title={s.windowsCredential}>
                        {t.secretWindowsBadge}
                      </span>
                    )}
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
                        {fieldLabel(s.kind, f)}
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
                  {s.kind === "oauth" && <OAuthLine secret={s} />}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
