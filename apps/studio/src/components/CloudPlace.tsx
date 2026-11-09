// 「クラウドストレージから読む」「クラウドストレージに書き出す」: the flow's
// folder fetches input/ from Box, Google Drive or OneDrive / SharePoint
// before each run, or sends what the run wrote to output/ after it, through
// the storage's API (lib/cloudPlaces.ts), so it runs on PCs without the sync
// app. It is a setting of the folder (config/cloud.json), not nodes. One
// dialog does all of it: install the plugin that comes with Writer when
// it is missing, choose or register the OAuth app to sign in with, and say
// which folder. Picking a sync app's folder (the earlier way) stays at the
// bottom, for a missing input file.
import { Blocks, Cloud, ExternalLink, Info } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStudio } from "../context";
import { agent, extensionsApi } from "../lib/api";
import {
  CLOUD_PATH,
  CLOUD_SERVICES,
  type CloudService,
  type CloudSide,
  cloudPlace,
  folderNameOf,
  serviceOf,
  signInParams,
  withCloudPlace,
} from "../lib/cloudPlaces";
import { t } from "../lib/i18n";
import { ProjectContext, projectApi, useProjectMaybe } from "../project";
import { CloudBrowser, type Picked } from "./CloudBrowser";

const NEW = "\u0000new";

const input =
  "h-8 w-full rounded-md border border-slate-300 bg-sheet px-2 text-[13px] text-ink placeholder:text-slate-400 focus:border-brand-500 focus:outline-none dark:bg-paper";

const message = (e: unknown) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** The secret already allowed to reach the service's plugin, or a new one. */
const secretFor = (oauth: { name: string; sites: string[] }[], service: CloudService) =>
  oauth.find((s) => s.sites.includes(`plugin:${service.plugin}`))?.name ?? NEW;

export function CloudPlaceDialog({
  side,
  onClose,
  onSynced,
}: {
  /** Fetch input/ from the storage, or send output/ there. */
  side: CloudSide;
  onClose: () => void;
  /** The person would rather pick a sync app's folder (not offered without it). */
  onSynced?: () => void;
}) {
  const c = t.places.cloudDialog;
  const reading = side === "input";
  const cloud = useProjectMaybe((s) => s.files?.cloud ?? null, null);
  const current = cloud?.[side] ?? null;
  const [serviceId, setServiceId] = useState<CloudService["id"]>(() => serviceOf(current)?.id ?? "box");
  const service = CLOUD_SERVICES.find((x) => x.id === serviceId) ?? CLOUD_SERVICES[0]!;
  const words = c.services[service.id]!;
  const project = useContext(ProjectContext);
  const flow = useStudio((s) => s.flow);
  const types = useStudio((s) => s.stepTypes);
  const secrets = useStudio((s) => s.secrets);
  const loadSecrets = useStudio((s) => s.loadSecrets);
  const saveSecretAdding = useStudio((s) => s.saveSecretAdding);
  const installedNode = types.some((x) => x.type === service.download);
  const oauth = secrets.filter((s) => s.kind === "oauth");
  const [secret, setSecret] = useState(() => secretFor(oauth, service));
  const [newName, setNewName] = useState(words.secret);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirect, setRedirect] = useState(() => (typeof current?.signIn?.redirectUrl === "string" ? current.signIn.redirectUrl : ""));
  const [target, setTarget] = useState(current?.folder ?? "");
  // From 「参照…」: the folder's name for people, and the files picked in it (none: every file).
  const [folderName, setFolderName] = useState(current ? folderNameOf(current) : "");
  const [files, setFiles] = useState<string[]>(current?.files ?? []);
  const [pattern, setPattern] = useState(current?.pattern ?? "");
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Plugins installed from this dialog: they work after Writer restarts.
  const [installedNow, setInstalledNow] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const restartNeeded = installedNow.includes(service.plugin);
  const plugin = installedNode || restartNeeded ? "installed" : installing ? "installing" : "missing";

  useEffect(() => void loadSecrets(), [loadSecrets]);
  // When the list arrives and when the service changes, choose the secret
  // the setting already uses, or the one already allowed to reach its node.
  const secretsKey = oauth.map((s) => `${s.name}:${s.sites.join(",")}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: chosen again only when the service or the list changes
  useEffect(() => {
    const kept = serviceOf(current)?.id === service.id && oauth.some((s) => s.name === current?.secret) ? current?.secret : undefined;
    setSecret(kept ?? secretFor(oauth, service));
    setNewName(words.secret);
  }, [service.id, secretsKey]);
  // The redirect URL the other side already uses with that secret.
  useEffect(() => {
    if (redirect) return;
    const other = cloud?.[reading ? "output" : "input"];
    const url = other?.secret === secret ? other.signIn?.redirectUrl : undefined;
    if (typeof url === "string") setRedirect(url);
  }, [cloud, secret, reading, redirect]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!flow || !project) return null;

  const install = async () => {
    setError(null);
    setInstalling(true);
    try {
      const preview = await extensionsApi.stageShipped(service.plugin);
      await extensionsApi.install(preview.id);
      setInstalledNow((list) => [...list, service.plugin]);
    } catch (e) {
      setError(message(e));
    } finally {
      setInstalling(false);
    }
  };

  const save = async (text: string | null, notice: string) => {
    if (text === null) await projectApi.remove(flow.id, CLOUD_PATH);
    else await projectApi.writeText(flow.id, CLOUD_PATH, text, true);
    project.setState({ notice, panelOpen: true });
    await project.getState().onChanged(flow.id);
    onClose();
  };

  /** The secret to sign in with, registered or allowed first when needed; null when a field is missing. */
  const readySecret = async (): Promise<string | null> => {
    const isNew = secret === NEW;
    const name = isNew ? newName.trim() : secret;
    if (!name || !redirect.trim() || (isNew && !clientId.trim())) {
      setError(c.missing);
      return null;
    }
    // The secret must allow the token URL, the API and the extension.
    const saved = await saveSecretAdding(isNew ? { name, kind: "oauth", username: clientId.trim(), password: clientSecret } : { name }, service.sites);
    if (!saved) return null;
    if (isNew) setSecret(name);
    return name;
  };

  const browse = async () => {
    setError(null);
    setBusy(true);
    try {
      const name = await readySecret();
      if (name) setBrowsing(name);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const picked = (p: Picked) => {
    setBrowsing(null);
    setTarget(p.folder);
    setFolderName(p.folderName);
    setFiles(p.files);
  };

  const submit = async () => {
    const folder = service.target(target);
    if (!folder) {
      setError(c.missing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const name = await readySecret();
      if (!name) return;
      const place = cloudPlace(service, {
        label: words.label,
        secret: name,
        redirectUrl: redirect.trim(),
        folder,
        folderName: folder === target ? folderName : "",
        pattern: reading ? pattern : "",
        files: reading ? files : [],
      });
      const shown = folderNameOf(place);
      await save(withCloudPlace(cloud, side, place), reading ? c.readDone(words.label, shown) : c.writeDone(words.label, shown));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await save(withCloudPlace(cloud, side, null), reading ? c.readRemoved : c.writeRemoved);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = plugin === "installed" && !restartNeeded;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-label={reading ? c.readTitle : c.writeTitle}
        data-cloud-dialog
        className="max-h-[88vh] w-[500px] overflow-y-auto rounded-lg border border-slate-200 bg-sheet p-5 shadow-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <h2 className="text-[15px] font-bold">{reading ? c.readTitle : c.writeTitle}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">{reading ? c.readLead : c.writeLead}</p>

        <div className="mt-4 text-[12px] font-medium text-slate-600">{c.service}</div>
        <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label={c.service}>
          {CLOUD_SERVICES.map((x) => {
            const on = x.id === service.id;
            return (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setServiceId(x.id);
                  setError(null);
                }}
                className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] ${
                  on
                    ? "border-[1.5px] border-brand-500 bg-brand-50 font-medium text-brand-600 dark:bg-brand-500/10"
                    : "border border-slate-300 text-slate-700 hover:border-brand-500 hover:text-brand-500"
                }`}
              >
                {on && <Cloud size={14} strokeWidth={1.75} aria-hidden="true" />}
                {c.services[x.id]?.label}
              </button>
            );
          })}
        </div>

        {plugin !== "installed" ? (
          <div className="mt-4 rounded-md bg-slate-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-700 dark:bg-white/5">
            {c.needPlugin(words.label)}
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                disabled={plugin === "installing"}
                onClick={() => void install()}
                className="h-7 rounded-md bg-primary px-3 text-[12.5px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-60"
              >
                {c.install}
              </button>
            </div>
          </div>
        ) : restartNeeded ? (
          <div className="mt-4 flex items-center gap-2 rounded-md bg-moegi-50 px-3 py-2.5 text-[12.5px] text-moegi-700 dark:bg-moegi-500/10">
            <span className="flex-1">{c.installed(words.label)}</span>
            <button
              type="button"
              onClick={() => void extensionsApi.restart().catch((e: unknown) => setError(message(e)))}
              className="h-7 shrink-0 rounded-md bg-primary px-3 text-[12.5px] font-medium text-on-primary hover:bg-primary-hover"
            >
              {c.restart}
            </button>
          </div>
        ) : (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-slate-500">
            <Blocks size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
            {c.usesPlugin(words.label)}
          </p>
        )}

        {browsing ? (
          <CloudBrowser
            service={service}
            label={words.label}
            secret={browsing}
            signIn={signInParams(service, redirect.trim())}
            side={side}
            start={{ folder: service.target(target), folderName, files }}
            onPick={picked}
            onCancel={() => setBrowsing(null)}
          />
        ) : (
          <>
            <fieldset disabled={!ready} className="mt-4 space-y-3 disabled:opacity-50">
              <label className="block">
                <span className="text-[12px] font-medium text-slate-600">{c.secret}</span>
                <select value={secret} onChange={(e) => setSecret(e.target.value)} className={`${input} mt-1`}>
                  {oauth.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                  <option value={NEW}>{c.newSecret}</option>
                </select>
              </label>
              {secret === NEW && (
                <div className="space-y-2 rounded-md border border-slate-200 p-3">
                  <p className="text-[12px] leading-relaxed text-slate-500">
                    {words.appHint} {c.shared}{" "}
                    <button
                      type="button"
                      onClick={() => void agent.openLink(service.console).catch(() => {})}
                      className="inline-flex items-center gap-0.5 text-brand-500 hover:underline"
                    >
                      {c.openConsole}
                      <ExternalLink size={11} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </p>
                  <Field label={c.secretName} value={newName} onChange={setNewName} />
                  <Field label={c.clientId} value={clientId} onChange={setClientId} />
                  <Field label={c.clientSecret} value={clientSecret} onChange={setClientSecret} password />
                </div>
              )}
              <Field label={c.redirect} hint={c.redirectHint} value={redirect} onChange={setRedirect} placeholder="https://www.example.com/" />
              <label className="block">
                <span className="text-[12px] font-medium text-slate-600">{reading ? c.readFolder : c.writeFolder}</span>
                <span className="mt-1 flex gap-1.5">
                  <input
                    type="text"
                    spellCheck={false}
                    value={folderName && folderName !== target ? folderName : target}
                    placeholder={reading ? c.readPlaceholder : c.writePlaceholder}
                    onChange={(e) => {
                      // Typed or pasted by hand: no longer the folder picked with 「参照…」.
                      setTarget(e.target.value);
                      setFolderName("");
                      setFiles([]);
                    }}
                    className={input}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void browse()}
                    className="h-8 shrink-0 rounded-md border border-slate-300 px-3 text-[12.5px] text-slate-700 hover:border-brand-500 hover:text-brand-500 disabled:opacity-60"
                  >
                    {c.browse.open}
                  </button>
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-slate-500">{`${words.targetHint}${c.targetHint}`}</span>
              </label>
              {reading &&
                (files.length > 0 ? (
                  <div className="rounded-md bg-slate-50 px-3 py-2 text-[12.5px] text-slate-700 dark:bg-white/5">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 font-medium">{c.browse.picked(files.length)}</span>
                      <button type="button" onClick={() => setFiles([])} className="text-brand-500 hover:underline">
                        {c.browse.allInstead}
                      </button>
                    </div>
                    <div className="mt-0.5 break-words text-slate-500">{files.join("、")}</div>
                  </div>
                ) : (
                  <Field label={c.pattern} hint={c.patternHint} value={pattern} onChange={setPattern} placeholder="*.xlsx" />
                ))}
              <p className="flex gap-1.5 text-[12px] leading-relaxed text-slate-500">
                <Info size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
                {c.signInNote(words.label)}
              </p>
            </fieldset>

            {error && <p className="mt-3 text-[12.5px] text-shu-600">{error}</p>}

            <div className="mt-5 flex items-center gap-2">
              {current ? (
                <button type="button" disabled={busy} onClick={() => void remove()} className="mr-auto text-[12.5px] text-shu-600 hover:underline">
                  {c.remove}
                </button>
              ) : onSynced ? (
                <button type="button" title={c.syncedHint} onClick={onSynced} className="mr-auto text-[12.5px] text-brand-500 hover:underline">
                  {c.synced}
                </button>
              ) : (
                <span className="mr-auto" />
              )}
              <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 text-[13px] text-slate-600 hover:bg-slate-100">
                {t.cancel}
              </button>
              <button
                type="submit"
                disabled={busy || !ready}
                className="h-8 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-60"
              >
                {reading ? c.readApply : c.writeApply}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body,
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  password,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-slate-600">{label}</span>
      <input
        type={password ? "password" : "text"}
        autoComplete={password ? "new-password" : "off"}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${input} mt-1`}
      />
      {hint && <span className="mt-0.5 block text-[11.5px] leading-snug text-slate-500">{hint}</span>}
    </label>
  );
}
