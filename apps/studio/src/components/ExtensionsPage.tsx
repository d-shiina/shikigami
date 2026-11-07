// The 「拡張機能」 place (docs/extensions.md): extensions installed on this
// PC, as in VS Code: turn one on or off, check for an update, uninstall it,
// or install one from a zip file, an https URL, a GitHub repository or the
// catalog (a JSON index whose URL is set here). Installing shows what the
// extension is first (its nodes, what they send outside, the secrets and the
// program) and installs only when the person confirms. Studio loads
// extensions when it starts, so a change offers a restart.
import { CloudUpload, Puzzle, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useStudioApi } from "../context";
import { type ExtensionList, type ExtensionPreview, type ExtensionSummary, extensionsApi, type InstalledExtension, type RegistryEntry } from "../lib/api";
import { t } from "../lib/i18n";
import { EXTENSION_ICONS } from "../lib/nodeIcons";

const inputClass = "w-full rounded border border-slate-300 bg-sheet px-2 py-1 text-sm focus:border-primary focus:outline-none";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Problems from a manifest check come in `details.problems`. */
function problemsOf(e: unknown): string[] {
  const details = (e as { details?: { problems?: unknown } } | null)?.details;
  return Array.isArray(details?.problems) ? details.problems.map(String) : [];
}

function ExtIcon({ ext, size = 18 }: { ext: Pick<ExtensionSummary, "icon">; size?: number }) {
  const Icon = (ext.icon && EXTENSION_ICONS[ext.icon]) || Puzzle;
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-200 bg-sheet text-slate-600">
      <Icon size={size} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

function Tag({ children, tone = "plain", title }: { children: React.ReactNode; tone?: "plain" | "warn" | "off"; title?: string }) {
  const tones = {
    plain: "border-slate-300 text-slate-600",
    warn: "border-shu-500/40 bg-shu-600/5 text-shu-600",
    off: "border-slate-200 bg-slate-100 text-slate-500",
  };
  return (
    <span title={title} className={`rounded-sm border px-1 text-[10.5px] leading-4 whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** What an extension is, before it is installed: read it, then confirm. */
function Preview({ preview, busy, onConfirm, onCancel }: { preview: ExtensionPreview; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const p = t.extensions.preview;
  const steps = preview.steps ?? [];
  const sends = steps.filter((s) => s.external);
  const isUpdate = preview.installedVersion !== null && preview.installedVersion !== undefined;
  return (
    <div className="rounded-lg border border-slate-200 bg-sheet p-4 shadow-sheet">
      <div className="flex items-start gap-3">
        <ExtIcon ext={preview} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold">{p.title(preview.label)}</h3>
          <p className="text-[12px] text-slate-500">
            {preview.name} · {t.extensions.version(preview.version ?? "")}
            {preview.publisher ? ` · ${t.extensions.by(preview.publisher)}` : ""}
          </p>
          {isUpdate && (
            <p className="mt-0.5 text-[12px] text-slate-600">
              {preview.installedVersion === preview.version ? p.reinstall(preview.version ?? "") : p.update(preview.installedVersion ?? "", preview.version ?? "")}
            </p>
          )}
        </div>
      </div>
      {preview.description && <p className="mt-2 text-[13px] text-slate-700">{preview.description}</p>}

      <h4 className="mt-4 mb-1 text-xs font-medium text-slate-600">{p.nodes}</h4>
      <ul className="space-y-0.5 text-[13px]">
        {steps.map((s) => (
          <li key={s.type} className="flex items-center gap-2">
            <span>{s.label}</span>
            <Tag>{t.extensions.risk[s.risk] ?? s.risk}</Tag>
          </li>
        ))}
      </ul>

      <h4 className="mt-4 mb-1 text-xs font-medium text-slate-600">{p.sends}</h4>
      {sends.length === 0 ? (
        <p className="text-[12.5px] text-slate-500">{p.sendsNone}</p>
      ) : (
        <ul className="space-y-0.5">
          {sends.map((s) => (
            <li key={s.type} className="flex items-center gap-1.5 text-[12.5px] text-amber-700">
              <CloudUpload size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
              {p.sentTo(s.external!.service, s.external!.data)}
            </li>
          ))}
        </ul>
      )}

      {(preview.credentials?.length ?? 0) > 0 && (
        <>
          <h4 className="mt-4 mb-1 text-xs font-medium text-slate-600">{p.secrets}</h4>
          <ul className="space-y-0.5 text-[12.5px]">
            {preview.credentials!.map((c) => (
              <li key={c.label}>
                {c.label}
                <span className="text-slate-500">（{t.secretKinds[c.kind]}）</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="mt-4 mb-1 text-xs font-medium text-slate-600">{p.program}</h4>
      <p className="font-mono text-[12px] text-slate-700">{preview.program}</p>

      <p className="mt-4 flex gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[12px] text-amber-800">
        <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
        {p.warning}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-lg px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={onCancel} disabled={busy}>
          {t.extensions.cancel}
        </button>
        <button type="button" className="rounded-lg bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover disabled:opacity-50" onClick={onConfirm} disabled={busy}>
          {isUpdate ? p.confirmUpdate : p.confirm}
        </button>
      </div>
    </div>
  );
}

/** Where to install from: a zip, a URL or a GitHub repository. */
function SourceForm({ initial, onPreview, onCancel }: { initial: string; onPreview: (p: ExtensionPreview) => void; onCancel: () => void }) {
  const [source, setSource] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; problems: string[] } | null>(null);
  const check = async (from = source) => {
    if (!from.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onPreview(await extensionsApi.stage(from));
    } catch (e) {
      setError({ text: message(e), problems: problemsOf(e) });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initial) void check(initial);
    // Only for the source given when opened (from the catalog).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="rounded-lg border border-slate-200 bg-sheet p-4 shadow-sheet">
      <h3 className="mb-2 text-[15px] font-semibold">{t.extensions.installTitle}</h3>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600">{t.extensions.sourceLabel}</span>
        <div className="flex gap-2">
          <input
            className={inputClass}
            value={source}
            placeholder={t.extensions.sourcePlaceholder}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void check()}
            autoFocus
          />
          <button
            type="button"
            className="shrink-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-700 hover:bg-slate-100"
            onClick={async () => {
              const picked = await extensionsApi.pickZip().catch(() => null);
              if (picked) {
                setSource(picked);
                void check(picked);
              }
            }}
          >
            {t.extensions.pickFile}
          </button>
        </div>
        <span className="block text-[11px] text-slate-500">{t.extensions.sourceHint}</span>
      </label>
      {error && (
        <div className="mt-2 text-[12px] text-shu-600">
          <p>{error.text}</p>
          {error.problems.length > 0 && (
            <ul className="mt-1 list-disc pl-4 font-mono text-[11px]">
              {error.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-lg px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={onCancel}>
          {t.extensions.cancel}
        </button>
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover disabled:opacity-50"
          onClick={() => void check()}
          disabled={busy || !source.trim()}
        >
          {busy ? t.extensions.checking : t.extensions.check}
        </button>
      </div>
    </div>
  );
}

function InstalledRow({
  ext,
  onToggle,
  onUpdate,
  onUninstall,
}: {
  ext: InstalledExtension;
  onToggle: (on: boolean) => void;
  onUpdate: () => void;
  onUninstall: () => void;
}) {
  const e = t.extensions;
  const broken = ext.problems.length > 0;
  const sends = (ext.steps ?? []).filter((s) => s.external);
  return (
    <li className={`flex gap-3 border-b border-slate-200 py-3 ${ext.enabled ? "" : "opacity-70"}`}>
      <ExtIcon ext={ext} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{ext.label}</span>
          {ext.version && <span className="text-[12px] text-slate-500">{e.version(ext.version)}</span>}
          {!ext.enabled && <Tag tone="off">{e.disabled}</Tag>}
          {!ext.managed && <Tag title={e.devTitle}>{e.dev}</Tag>}
          {broken && <Tag tone="warn">{e.loadError}</Tag>}
        </div>
        {ext.description && <p className="mt-0.5 text-[12.5px] text-slate-700">{ext.description}</p>}
        <p className="mt-0.5 text-[11.5px] text-slate-500">
          {[ext.publisher && e.by(ext.publisher), ext.steps && e.nodes(ext.steps.length), ext.name].filter(Boolean).join(" · ")}
        </p>
        {sends.map((s) => (
          <p key={s.type} className="mt-0.5 flex items-center gap-1 text-[11.5px] text-amber-700">
            <CloudUpload size={12} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
            {e.preview.sentTo(s.external!.service, s.external!.data)}
          </p>
        ))}
        {broken && (
          <ul className="mt-1 list-disc pl-4 font-mono text-[11px] text-shu-600">
            {ext.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      {ext.managed && (
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <label className="flex items-center gap-1.5 text-[12px] text-slate-600">
            <input type="checkbox" checked={ext.enabled} onChange={(ev) => onToggle(ev.target.checked)} />
            {e.enabled}
          </label>
          <div className="flex gap-2 text-[12px]">
            {ext.source && (
              <button type="button" className="flex items-center gap-1 text-brand-600 hover:underline" onClick={onUpdate}>
                <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
                {e.checkUpdate}
              </button>
            )}
            <button type="button" className="text-slate-500 hover:text-shu-600" onClick={onUninstall}>
              {e.uninstall}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** The catalog: a JSON index set by URL, nothing hosted by Shikigami. */
function Registry({ list, installed, onInstall, onSaved }: { list: ExtensionList; installed: InstalledExtension[]; onInstall: (source: string) => void; onSaved: () => void }) {
  const r = t.extensions.registry;
  const [url, setUrl] = useState(list.registry ?? "");
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!list.registry) return setEntries(null);
    setEntries(null);
    setError(null);
    try {
      setEntries(await extensionsApi.registry());
    } catch (e) {
      setError(message(e));
    }
  }, [list.registry]);
  useEffect(() => void load(), [load]);
  return (
    <div>
      <p className="mb-3 text-xs text-slate-600">{r.intro}</p>
      <label className="mb-4 block space-y-1">
        <span className="text-xs font-medium text-slate-600">{r.url}</span>
        <div className="flex gap-2">
          <input className={inputClass} value={url} placeholder={r.urlPlaceholder} onChange={(e) => setUrl(e.target.value)} />
          <button
            type="button"
            className="shrink-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-700 hover:bg-slate-100"
            onClick={async () => {
              try {
                await extensionsApi.setRegistry(url);
                onSaved();
              } catch (e) {
                setError(message(e));
              }
            }}
          >
            {r.save}
          </button>
        </div>
      </label>
      {error && <p className="mb-2 text-xs text-shu-600">{error}</p>}
      {!list.registry ? (
        <p className="text-sm text-slate-500">{r.notSet}</p>
      ) : entries === null ? (
        !error && <p className="text-sm text-slate-500">{r.loading}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-slate-500">{r.empty}</p>
      ) : (
        <ul>
          {entries.map((entry) => {
            const have = installed.find((i) => i.name === entry.name);
            return (
              <li key={entry.name} className="flex items-start gap-3 border-b border-slate-200 py-3">
                <ExtIcon ext={{ icon: have?.icon }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{entry.label}</span>
                    {entry.version && <span className="text-[12px] text-slate-500">{t.extensions.version(entry.version)}</span>}
                    {have && <Tag tone="off">{r.installed}</Tag>}
                  </div>
                  {entry.description && <p className="mt-0.5 text-[12.5px] text-slate-700">{entry.description}</p>}
                  <p className="mt-0.5 text-[11.5px] text-slate-500">{[entry.publisher && t.extensions.by(entry.publisher), entry.name].filter(Boolean).join(" · ")}</p>
                </div>
                <button type="button" className="shrink-0 rounded-lg border border-slate-300 px-2 py-0.5 text-[12px] text-slate-700 hover:bg-slate-100" onClick={() => onInstall(entry.source)}>
                  {have ? t.extensions.checkUpdate : t.extensions.install}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ExtensionsPage() {
  const e = t.extensions;
  const store = useStudioApi();
  const [list, setList] = useState<ExtensionList | null>(null);
  const [tab, setTab] = useState<"installed" | "registry">("installed");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // null: closed; a string: the source form, filled with it (from the catalog).
  const [installing, setInstalling] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExtensionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setList(await extensionsApi.list());
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const act = async (what: () => Promise<unknown>) => {
    setNotice(null);
    try {
      await what();
      await load();
    } catch (err) {
      setError(message(err));
    }
  };
  const close = () => {
    if (preview) void extensionsApi.discard(preview.id).catch(() => {});
    setPreview(null);
    setInstalling(null);
  };
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await extensionsApi.install(preview.id);
      setPreview(null);
      setInstalling(null);
      setTab("installed");
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const checkUpdate = async (ext: InstalledExtension) => {
    setNotice(null);
    try {
      const next = await extensionsApi.stageUpdate(ext.name);
      if (next.version === ext.version) {
        await extensionsApi.discard(next.id);
        setNotice(e.latest(ext.label, ext.version ?? ""));
      } else setPreview(next);
    } catch (err) {
      setError(message(err));
    }
  };
  const installed = list?.installed ?? [];
  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[680px] px-6 py-6">
        <div className="mb-3 flex items-end gap-4 border-b border-slate-200">
          <h2 className="pb-2 text-lg font-bold">{e.place}</h2>
          <div role="tablist" className="flex">
            {(["installed", "registry"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-2 pb-2 text-sm ${tab === id ? "border-ink font-semibold" : "border-transparent text-slate-500 hover:text-ink"}`}
              >
                {e.tabs[id]}
              </button>
            ))}
          </div>
          {installing === null && !preview && (
            <button type="button" className="mb-2 ml-auto rounded-lg bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover" onClick={() => setInstalling("")}>
              {e.install}
            </button>
          )}
        </div>
        <p className="mb-4 text-xs text-slate-600">{e.intro}</p>
        {list?.restartNeeded && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-sheet px-3 py-2 text-[13px]">
            <span className="flex-1">
              {e.restartNeeded}
              <span className="ml-1 text-[11.5px] text-slate-500">{e.restartHint}</span>
            </span>
            <button
              type="button"
              className="rounded-lg border border-slate-300 bg-sheet px-2 py-0.5 text-[12.5px] hover:bg-slate-100"
              onClick={() => void extensionsApi.restart().catch((err: unknown) => store.setState({ error: message(err) }))}
            >
              {e.restart}
            </button>
          </div>
        )}
        {error && <p className="mb-3 text-xs text-shu-600">{error}</p>}
        {notice && <p className="mb-3 text-xs text-slate-600">{notice}</p>}
        {preview ? (
          <div className="mb-4">
            <Preview preview={preview} busy={busy} onConfirm={() => void confirm()} onCancel={close} />
          </div>
        ) : (
          installing !== null && (
            <div className="mb-4">
              <SourceForm key={installing} initial={installing} onPreview={setPreview} onCancel={close} />
            </div>
          )
        )}
        {list &&
          (tab === "installed" ? (
            installed.length === 0 ? (
              <div className="text-sm text-slate-500">
                <p>{e.none}</p>
                <p className="mt-1 text-xs">{e.noneHint}</p>
              </div>
            ) : (
              <ul className="border-t border-slate-200">
                {installed.map((ext) => (
                  <InstalledRow
                    key={ext.dir}
                    ext={ext}
                    onToggle={(on) => void act(() => extensionsApi.setEnabled(ext.name, on))}
                    onUpdate={() => void checkUpdate(ext)}
                    onUninstall={() => window.confirm(e.confirmUninstall(ext.label)) && void act(() => extensionsApi.uninstall(ext.name))}
                  />
                ))}
              </ul>
            )
          ) : (
            <Registry
              list={list}
              installed={installed}
              onInstall={(source) => {
                setPreview(null);
                setInstalling(source);
              }}
              onSaved={() => void load()}
            />
          ))}
      </div>
    </div>
  );
}
