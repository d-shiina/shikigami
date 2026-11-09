// The secrets place: a list of the registered secrets (built like the flow
// library: a toolbar, then a table without boxes) and, for one of them, a
// settings-style form. Values are never shown: the list has names, kinds,
// sites and the flows that use each one; the form keeps saved values hidden
// and only takes new ones.
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, AppWindow, ArrowLeft, Check, Key, KeyRound, Lock, Pencil, ShieldCheck, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { api, type SecretInfo, type SecretKind, type WindowsCredentialInfo } from "../lib/api";
import { relativeTime } from "../lib/changes";
import { confirmAsk } from "../lib/ask";
import { locale, t } from "../lib/i18n";
import { fieldLabel, KIND_FIELDS, SECRET_KINDS } from "../lib/secretKinds";
import { BulkButton, ClearFilters, type Column, DataTable, FacetFilter, SearchBox, SelectionBar, useTableView, ViewMenu } from "./DataTable";
import { SettingsGroup, SettingsRow, settingsInput, settingsPrimary } from "./settingsLayout";

const KIND_ICON: Record<SecretKind, LucideIcon> = { login: KeyRound, apiKey: Key, oauth: AppWindow };

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

/** A segmented choice: one of a few options, side by side. */
function Choice<T extends string>({ value, options, label, onChange }: { value: T; options: Record<T, string>; label: string; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-0.5 rounded-lg bg-slate-100 p-0.5" role="radiogroup" aria-label={label}>
      {(Object.keys(options) as T[]).map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          className={`h-7 rounded-md px-2.5 text-[13px] ${
            value === key ? "bg-sheet font-medium text-ink shadow-sm ring-1 ring-slate-300" : "text-slate-600 hover:text-ink"
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


function when(at: string): string {
  return new Date(at).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** A saved value: never shown, only that there is one. */
const MASK = "••••••••";

/**
 * Registers or changes one secret. Values go to the backend once and never
 * come back: a saved password shows as a hidden placeholder and is kept
 * unless something is typed.
 */
function SecretForm({
  initial,
  isNew,
  asked,
  added = [],
  usedBy,
  onDone,
}: {
  initial: Draft;
  isNew: boolean;
  /** Opened from a request or a failed run: name and sites are filled in. */
  asked?: boolean;
  /** Sites the request adds to a saved secret. */
  added?: string[];
  /** Flows that refer to it, to open from here. */
  usedBy: { id: string; name: string }[];
  onDone: () => void;
}) {
  const saveSecret = useStudio((s) => s.saveSecret);
  const signOut = useStudio((s) => s.signOutSecret);
  const oauth = useStudio((s) => s.secrets.find((x) => x.name === initial.name));
  const removeSecret = useStudio((s) => s.removeSecret);
  const openFlow = useOpenFlow();
  const [draft, setDraft] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const edit = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const fields = KIND_FIELDS[draft.kind];
  const fromWindows = draft.store === "windows";
  const credentials = useWindowsCredentials(fromWindows);
  const picked = credentials?.find((c) => c.target === draft.windowsCredential.trim());
  const saved = !isNew && initial.store !== "windows";

  return (
    <form
      className="space-y-5"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await saveSecret({
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
        if (ok) onDone();
      }}
    >
      {/* Where this is, and the way back to the list. */}
      <div className="flex items-center gap-1.5 text-[13px]">
        <button type="button" onClick={onDone} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-slate-600 hover:bg-slate-100 hover:text-ink">
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          {t.secrets}
        </button>
        <span className="text-slate-400">/</span>
        <span className="font-semibold text-ink">{isNew ? initial.name || t.secretPage.newTitle : initial.name}</span>
      </div>
      {asked && <p className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-[13px] text-slate-700">{t.secretAskHint}</p>}
      {added.length > 0 && (
        <p className="rounded-lg border border-shu-600/40 bg-shu-600/5 px-3 py-2 text-[13px] text-slate-700">{t.secretAskAdded(initial.name, added)}</p>
      )}

      <SettingsGroup title={t.secretPage.basic}>
        <SettingsRow label={t.secretPage.name} hint={t.secretPage.nameHint} htmlFor="secret-name">
          <input
            id="secret-name"
            className={`${settingsInput} disabled:bg-slate-50 disabled:text-slate-600`}
            value={draft.name}
            disabled={!isNew}
            required
            autoFocus={isNew && !asked}
            placeholder={t.secretNamePlaceholder}
            onChange={(e) => edit({ name: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow label={t.secretKind} hint={t.secretKindHints[draft.kind]}>
          <Choice
            value={draft.kind}
            options={Object.fromEntries(SECRET_KINDS.map((k) => [k, t.secretKinds[k]])) as Record<SecretKind, string>}
            label={t.secretKind}
            onChange={(kind) => edit({ kind })}
          />
        </SettingsRow>
        <SettingsRow label={t.secretPage.note} hint={t.secretPage.noteHint} htmlFor="secret-note">
          <input id="secret-note" className={settingsInput} value={draft.description} onChange={(e) => edit({ description: e.target.value })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t.secretPage.values} description={t.secretPage.safety}>
        <SettingsRow label={t.secretPage.store} hint={t.secretStoreHints[draft.store]}>
          <Choice value={draft.store} options={t.secretStores} label={t.secretPage.store} onChange={(store) => edit({ store })} />
        </SettingsRow>
        {fromWindows && (
          <SettingsRow
            label={t.secretWindowsTarget}
            hint={picked?.username ? t.secretWindowsUser(picked.username) : credentials?.length === 0 ? t.secretWindowsNone : undefined}
            htmlFor="secret-windows"
          >
            <input
              id="secret-windows"
              className={`${settingsInput} font-mono text-xs`}
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
          </SettingsRow>
        )}
        {fields.includes("username") && !fromWindows && (
          <SettingsRow label={fieldLabel(draft.kind, "username")} htmlFor="secret-user">
            <input id="secret-user" className={settingsInput} value={draft.username} autoFocus={asked} onChange={(e) => edit({ username: e.target.value })} />
          </SettingsRow>
        )}
        {!fromWindows && (
          <SettingsRow label={fieldLabel(draft.kind, "password")} hint={saved ? t.secretPage.stored : undefined} htmlFor="secret-password">
            <input
              id="secret-password"
              className={`${settingsInput} placeholder:tracking-widest`}
              type="password"
              autoComplete="new-password"
              placeholder={saved ? MASK : undefined}
              value={draft.password}
              onChange={(e) => edit({ password: e.target.value })}
            />
          </SettingsRow>
        )}
        {fields.includes("totp") && (
          <SettingsRow label={t.secretPage.totp} hint={t.secretPage.totpHint} htmlFor="secret-totp">
            <input
              id="secret-totp"
              className={`${settingsInput} font-mono text-xs`}
              type="password"
              autoComplete="off"
              value={draft.totp}
              onChange={(e) => edit({ totp: e.target.value })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      {!isNew && draft.kind === "oauth" && initial.kind === "oauth" && oauth && (
        <SettingsGroup title={t.secretPage.signIn}>
          <SettingsRow label={t.secretPage.signInState} hint={oauthDetail(oauth)}>
            <div className="flex items-center gap-3">
              <KindState secret={oauth} />
              {oauth.signedIn && (
                <button
                  type="button"
                  className="h-7 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[13px] text-slate-700 hover:bg-slate-50"
                  onClick={async () => {
                    const yes = await confirmAsk({ title: t.secretSignOutAsk.title(oauth.name), body: t.secretSignOutAsk.body, confirm: t.secretSignOut, danger: true });
                    if (yes) void signOut(oauth.name);
                  }}
                >
                  {t.secretSignOut}
                </button>
              )}
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup title={t.secretPage.allowed}>
        <SettingsRow
          label={draft.kind === "login" ? t.secretPage.sitesLogin : t.secretPage.sitesApi}
          hint={t.secretPage.oneLine + t.secretSitesHintKind[draft.kind]}
          htmlFor="secret-sites"
          align="start"
        >
          <textarea
            id="secret-sites"
            className={`${settingsInput} font-mono text-xs`}
            rows={3}
            value={draft.sites}
            placeholder={draft.kind === "login" ? "https://example.com" : "https://api.example.com"}
            onChange={(e) => edit({ sites: e.target.value })}
          />
        </SettingsRow>
      </SettingsGroup>

      {!isNew && (
        <SettingsGroup title={t.secretPage.usedBy}>
          {usedBy.length === 0 ? (
            <p className="px-4 py-2.5 text-[13px] text-slate-500">{t.secretPage.usedByNone}</p>
          ) : (
            usedBy.map((flow) => (
              <button
                key={flow.id}
                type="button"
                onClick={() => openFlow(flow.id)}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] text-ink hover:bg-slate-50"
              >
                <Workflow size={14} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
                {flow.name}
              </button>
            ))
          )}
        </SettingsGroup>
      )}

      {/* Deleting sits apart on the left; saving, the page's one filled button, ends the row. */}
      <div className="flex items-center gap-2 border-t border-slate-200 pt-4">
        {!isNew && (
          <button
            type="button"
            title={t.secretPage.deleteHint}
            className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] ${confirming ? "bg-shu-600 text-white" : "text-slate-600 hover:bg-shu-50 hover:text-shu-600"}`}
            onClick={() => {
              if (confirming) {
                void removeSecret(initial.name);
                onDone();
              }
              setConfirming(!confirming);
            }}
            onBlur={() => setConfirming(false)}
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
            {confirming ? t.secretPage.confirmDelete : t.secretPage.delete}
          </button>
        )}
        {confirming && <span className="text-[12px] text-slate-500">{t.secretPage.deleteHint}</span>}
        <span className="flex-1" />
        <button type="button" className="h-8 rounded-lg px-3 text-[13px] text-slate-600 hover:bg-slate-100" onClick={onDone}>
          {t.cancel}
        </button>
        <button type="submit" className={`h-8 ${settingsPrimary}`}>
          {t.secretSave}
        </button>
      </div>
    </form>
  );
}

/** Opens a flow in the editor. */
function useOpenFlow() {
  const open = useStudio((s) => s.open);
  const setPlace = useStudio((s) => s.setPlace);
  return (id: string) => {
    setPlace("flows");
    void open(id);
  };
}

/** When an OAuth app's sign-in ends and whether it renews itself, in words. */
function oauthDetail(secret: SecretInfo, sep = locale === "ja" ? "・" : " · "): string {
  const status = secret.oauth;
  if (!status) return t.secretOauthNotSignedIn;
  return [
    status.expiresAt && t.secretOauthExpires(when(status.expiresAt)),
    status.obtainedAt && t.secretOauthObtained(when(status.obtainedAt)),
    status.refreshable ? t.secretOauthRefreshable : t.secretOauthNotRefreshable,
  ]
    .filter(Boolean)
    .join(sep);
}

/** The second line of the kind column: where the values live, or how an OAuth app stands. */
function KindState({ secret, now = Date.now() }: { secret: SecretInfo; now?: number }) {
  if (secret.windowsCredential) {
    return (
      <div className="truncate text-[12px] text-slate-500" title={secret.windowsCredential}>
        {t.secretPage.windows}
      </div>
    );
  }
  if (secret.kind !== "oauth") return null;
  const status = secret.oauth;
  const expired = status?.expiresAt !== undefined && Date.parse(status.expiresAt) <= now && !status.refreshable;
  const title = oauthDetail(secret, "\n");
  return (
    <div className="flex items-center gap-1 text-[12px]" title={title}>
      {expired ? (
        <span className="flex items-center gap-1 text-shu-600">
          <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
          {t.secretPage.expired}
        </span>
      ) : secret.signedIn ? (
        <span className="flex items-center gap-1 text-slate-600">
          <Check size={12} strokeWidth={2} className="text-moegi-600" aria-hidden="true" />
          {t.secretPage.signedIn}
        </span>
      ) : (
        <span className="text-slate-500">{t.secretPage.notSignedIn}</span>
      )}
    </div>
  );
}

/** At most `n` items, then how many more. */
function Some({ items, n, render }: { items: string[]; n: number; render: (item: string) => React.ReactNode }) {
  return (
    <>
      {items.slice(0, n).map(render)}
      {items.length > n && <div className="text-[12px] text-slate-500">{t.secretPage.more(items.length - n)}</div>}
    </>
  );
}

type FlowRef = { id: string; name: string };
type Usage = "used" | "unused";

/** Edit and delete, at the end of a row on hover. Deleting asks once more in place. */
function RowActions({ secret, onEdit }: { secret: SecretInfo; onEdit: () => void }) {
  const removeSecret = useStudio((s) => s.removeSecret);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        title={t.secretPage.edit}
        className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-200 hover:text-ink"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
      >
        <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        title={confirming ? t.secretPage.deleteHint : t.secretPage.delete}
        className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] ${confirming ? "bg-shu-600 text-white" : "text-slate-500 hover:bg-shu-50 hover:text-shu-600"}`}
        onClick={(e) => {
          e.stopPropagation();
          if (confirming) void removeSecret(secret.name);
          setConfirming(!confirming);
        }}
        onBlur={() => setConfirming(false)}
      >
        <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
        {confirming && t.secretPage.confirmDelete}
      </button>
    </>
  );
}

/** The columns of the secrets table. */
function useColumns(usedBy: Map<string, FlowRef[]>): Column<SecretInfo>[] {
  const openFlow = useOpenFlow();
  return [
    {
      id: "name",
      header: t.secretPage.name,
      sortValue: (s) => s.name,
      cell: (s) => {
        const Icon = KIND_ICON[s.kind ?? "login"];
        const sub = [s.username, s.description].filter(Boolean).join("・");
        return (
          <>
            <div className="flex items-center gap-2">
              <Icon size={14} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
              <span className="truncate text-[13px] font-semibold text-ink">{s.name}</span>
            </div>
            {sub && <div className="mt-0.5 truncate pl-[22px] text-[12px] text-slate-500">{sub}</div>}
          </>
        );
      },
    },
    {
      id: "kind",
      header: t.secretPage.kind,
      width: "w-[150px]",
      hideBelow: 600,
      sortValue: (s) => SECRET_KINDS.indexOf(s.kind ?? "login"),
      cell: (s) => (
        <>
          <div className="text-[13px] leading-5 text-slate-700">{t.secretKinds[s.kind ?? "login"]}</div>
          <KindState secret={s} />
        </>
      ),
    },
    {
      id: "sites",
      header: t.secretPage.sites,
      width: "w-[210px]",
      hideBelow: 860,
      sortValue: (s) => s.sites[0] ?? "\uffff",
      cell: (s) =>
        s.sites.length === 0 ? (
          <div className="text-[13px] leading-5 text-slate-500">{t.secretPage.noSites}</div>
        ) : (
          <Some
            items={s.sites}
            n={2}
            render={(site) => (
              <div key={site} className="truncate font-mono text-[12px] leading-5 text-slate-600" title={site}>
                {site.replace(/^https?:\/\//, "")}
              </div>
            )}
          />
        ),
    },
    {
      id: "flows",
      header: t.secretPage.flows,
      width: "w-[200px]",
      sortValue: (s) => (usedBy.get(s.name) ?? []).length,
      cell: (s) => {
        const flows = usedBy.get(s.name) ?? [];
        if (flows.length === 0) return <div className="text-[13px] leading-5 text-slate-500">{t.secretPage.unused}</div>;
        return (
          <Some
            items={flows.map((f) => f.id)}
            n={2}
            render={(id) => (
              <button
                key={id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openFlow(id);
                }}
                className="flex max-w-full items-center gap-1.5 text-left text-[13px] leading-5 text-slate-700 hover:text-ink hover:underline"
              >
                <Workflow size={12} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
                <span className="truncate">{flows.find((f) => f.id === id)?.name}</span>
              </button>
            )}
          />
        );
      },
    },
    {
      id: "updated",
      header: t.secretPage.updated,
      width: "w-[96px]",
      hideBelow: 720,
      sortValue: (s) => s.updatedAt,
      cell: (s) => <div className="text-[12px] leading-5 whitespace-nowrap text-slate-500">{s.updatedAt ? relativeTime(s.updatedAt) : "—"}</div>,
    },
  ];
}

/** The first screen with nothing registered: what a secret is, and the one way to add one. */
function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-sheet p-6">
      <div className="flex items-start gap-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600">
          <KeyRound size={20} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-ink">{t.secretPage.emptyTitle}</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{t.secretPage.emptyLead}</p>
          <ul className="mt-3 space-y-1.5">
            {t.secretPage.emptyPoints.map((point, i) => {
              const Icon = [Lock, ShieldCheck, KeyRound][i] ?? Lock;
              return (
                <li key={point} className="flex items-center gap-2 text-[13px] text-slate-700">
                  <Icon size={14} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
                  {point}
                </li>
              );
            })}
          </ul>
          <button type="button" onClick={onAdd} className="mt-5 flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover">
            ＋ {t.secretPage.add}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Secrets registered on another PC or Windows user: only the names, and the way out. */
function KeyMissing({ secrets }: { secrets: SecretInfo[] }) {
  const resetSecrets = useStudio((s) => s.resetSecrets);
  return (
    <section className="rounded-lg border border-shu-600/40 bg-sheet p-5">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
        <AlertTriangle size={16} strokeWidth={1.75} className="text-shu-600" aria-hidden="true" />
        {t.secretPage.keyMissingTitle}
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{t.secretKeyMissing}</p>
      {secrets.length > 0 && (
        <ul className="mt-3 border-y border-slate-200">
          {secrets.map((s) => (
            <li key={s.name} className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-[13px] last:border-b-0">
              <Lock size={14} strokeWidth={1.75} className="text-slate-400" aria-hidden="true" />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="mt-4 h-8 rounded-lg bg-primary px-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover"
        onClick={async () => {
          const ask = t.secretResetAsk;
          if (await confirmAsk({ title: ask.title, body: ask.body(secrets.length), confirm: ask.confirm, danger: true })) void resetSecrets();
        }}
      >
        {t.secretReset}
      </button>
    </section>
  );
}

/** The secrets place: registered secrets, and the form to add or change one. */
export function SecretsPage() {
  const secrets = useStudio((s) => s.secrets);
  const summaries = useStudio((s) => s.summaries);
  const keyLocation = useStudio((s) => s.secretKeyLocation);
  const keyMissing = useStudio((s) => s.secretKeyMissing);
  const prefill = useStudio((s) => s.secretPrefill);
  const clearPrefill = useStudio((s) => s.clearSecretPrefill);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean; asked?: boolean; added?: string[] } | null>(null);
  useEffect(() => {
    if (!prefill) return;
    setEditing({ ...draftFor(secrets, prefill), asked: true });
    clearPrefill();
  }, [prefill, secrets, clearPrefill]);

  // Which flows refer to each secret, by name.
  const usedBy = useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const flow of summaries) {
      for (const name of flow.secrets ?? []) map.set(name, [...(map.get(name) ?? []), { id: flow.id, name: flow.name }]);
    }
    return map;
  }, [summaries]);
  const [kinds, setKinds] = useState<Set<SecretKind>>(new Set());
  const [usage, setUsage] = useState<Set<Usage>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const removeSecret = useStudio((s) => s.removeSecret);
  const columns = useColumns(usedBy);
  const view = useTableView(columns, { storageKey: "spellsheet.studio.secrets.sort", initialSort: { column: "name", descending: false } });
  const q = query.trim().toLowerCase();
  const usageOf = (s: SecretInfo): Usage => ((usedBy.get(s.name) ?? []).length ? "used" : "unused");
  // Each filter's counts are over the rows the other one keeps.
  const keep = (s: SecretInfo, skip?: "kind" | "usage") =>
    (skip === "kind" || !kinds.size || kinds.has(s.kind ?? "login")) &&
    (skip === "usage" || !usage.size || usage.has(usageOf(s))) &&
    (!q ||
      [s.name, s.username, s.description ?? "", ...s.sites, ...(usedBy.get(s.name) ?? []).map((f) => f.name)]
        .join(" ")
        .toLowerCase()
        .includes(q));
  const rows = secrets.filter((s) => keep(s));
  const kindOptions = SECRET_KINDS.map((value) => ({ value, label: t.secretKinds[value], count: secrets.filter((s) => keep(s, "kind") && (s.kind ?? "login") === value).length })).filter(
    (o) => o.count > 0 || kinds.has(o.value),
  );
  const usageOptions = (["used", "unused"] as Usage[]).map((value) => ({
    value,
    label: value === "used" ? t.secretPage.used : t.secretPage.unused,
    count: secrets.filter((s) => keep(s, "usage") && usageOf(s) === value).length,
  }));
  // Picked rows the list no longer shows (deleted, filtered or searched out) drop out,
  // so a bulk delete only ever touches rows on screen.
  const picked = new Set([...selected].filter((name) => rows.some((s) => s.name === name)));
  const deletePicked = async () => {
    for (const name of picked) await removeSecret(name);
    setSelected(new Set());
  };
  const add = () => setEditing({ draft: empty, isNew: true });

  return (
    <div className="@container h-full overflow-y-auto bg-paper">
      {editing && !keyMissing ? (
        <div className="mx-auto max-w-[880px] px-6 py-5">
          <SecretForm
            key={`${editing.draft.name}\n${editing.draft.sites}`}
            initial={editing.draft}
            isNew={editing.isNew}
            asked={editing.asked}
            added={editing.added}
            usedBy={usedBy.get(editing.draft.name) ?? []}
            onDone={() => setEditing(null)}
          />
        </div>
      ) : (
        <div className="mx-auto max-w-[1040px] px-6 py-5">
          {keyMissing ? (
            <KeyMissing secrets={secrets} />
          ) : secrets.length === 0 ? (
            <Empty onAdd={add} />
          ) : (
            <>
              {/* Read left to right: how many, how to narrow them, then adding one, the filled button, at the end.
                  While rows are picked, the bar of what to do with them takes the count's place. */}
              <div className="mb-3 flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <SearchBox value={query} onChange={setQuery} placeholder={t.secretPage.search} hits={rows.length} />
                <FacetFilter label={t.secretKind} value={kinds} onChange={setKinds} options={kindOptions} />
                <FacetFilter label={t.secretPage.usage} value={usage} onChange={setUsage} options={usageOptions} />
                {kinds.size + usage.size > 0 && (
                  <ClearFilters
                    onClear={() => {
                      setKinds(new Set());
                      setUsage(new Set());
                    }}
                  />
                )}
                </div>
                <ViewMenu view={view} />
                <button
                  type="button"
                  onClick={add}
                  className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-primary px-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover"
                >
                  ＋ {t.secretPage.add}
                </button>
              </div>
              <div>
                <DataTable
                  columns={columns}
                  rows={rows}
                  total={secrets.length}
                  rowKey={(s) => s.name}
                  onOpen={(s) => setEditing({ draft: draftOf(s), isNew: false })}
                  selected={picked}
                  onSelect={setSelected}
                  view={view}
                  empty={t.list.notFound}
                  rowActions={(s) => <RowActions secret={s} onEdit={() => setEditing({ draft: draftOf(s), isNew: false })} />}
                />
                <SelectionBar count={picked.size} onClear={() => setSelected(new Set())}>
                  <BulkButton icon={Trash2} danger label={t.secretPage.delete} confirmLabel={t.secretPage.confirmDeleteMany(picked.size)} onClick={deletePicked} />
                </SelectionBar>
              </div>
            </>
          )}
          {/* How the values are kept, said once under the list. */}
          {!keyMissing && secrets.length > 0 && (
            <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-slate-500">
              <Lock size={12} strokeWidth={1.75} className="mt-[3px] shrink-0" aria-hidden="true" />
              <span>
                {t.secretPage.safety}
                {keyLocation && ` ${t.secretPage.keyAt(keyLocation)}`}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
