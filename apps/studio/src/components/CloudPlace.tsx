// 「クラウドストレージから読む」「クラウドストレージに書き出す」: the flow
// reaches Box, Google Drive or OneDrive / SharePoint through its API
// (lib/cloudPlaces.ts), so it runs on PCs
// without the sync app. One dialog does all of it: install the custom node
// that comes with Writer when it is missing, choose or register the OAuth
// app to sign in with, and say where in the storage. Picking a sync app's
// folder (the earlier way) stays at the bottom.
import { Cloud, ExternalLink, Info } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStudio } from "../context";
import { agent, extensionsApi } from "../lib/api";
import { CLOUD_SERVICES, type CloudService, cloudChange } from "../lib/cloudPlaces";
import { placeName } from "../lib/filePlaces";
import { t } from "../lib/i18n";
import { ProjectContext, projectApi } from "../project";

const NEW = "\u0000new";

const input =
  "h-8 w-full rounded-md border border-slate-300 bg-sheet px-2 text-[13px] text-ink placeholder:text-slate-400 focus:border-brand-500 focus:outline-none dark:bg-paper";

const message = (e: unknown) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** The secret already allowed to reach the service's custom node, or a new one. */
const secretFor = (oauth: { name: string; sites: string[] }[], service: CloudService) =>
  oauth.find((s) => s.sites.includes(`plugin:${service.plugin}`))?.name ?? NEW;

export function CloudPlaceDialog({
  file,
  onClose,
  onSynced,
}: {
  /** input/受注.xlsx to read, or null to write what goes in output/. */
  file: string | null;
  onClose: () => void;
  /** The person would rather pick a sync app's folder. */
  onSynced: () => void;
}) {
  const c = t.places.cloudDialog;
  const [serviceId, setServiceId] = useState<CloudService["id"]>("box");
  const service = CLOUD_SERVICES.find((x) => x.id === serviceId) ?? CLOUD_SERVICES[0]!;
  const words = c.services[service.id]!;
  const label = words.short;
  const project = useContext(ProjectContext);
  const flow = useStudio((s) => s.flow);
  const types = useStudio((s) => s.stepTypes);
  const secrets = useStudio((s) => s.secrets);
  const loadSecrets = useStudio((s) => s.loadSecrets);
  const saveSecretAdding = useStudio((s) => s.saveSecretAdding);
  const applyOps = useStudio((s) => s.applyOps);
  const installedNode = types.some((x) => x.type === service.download);
  const oauth = secrets.filter((s) => s.kind === "oauth");
  const [secret, setSecret] = useState(() => secretFor(oauth, service));
  const [newName, setNewName] = useState(words.secret);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirect, setRedirect] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Custom nodes installed from this dialog: they work after Writer restarts.
  const [installedNow, setInstalledNow] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const restartNeeded = installedNow.includes(service.plugin);
  const plugin = installedNode || restartNeeded ? "installed" : installing ? "installing" : "missing";

  useEffect(() => void loadSecrets(), [loadSecrets]);
  // When the list arrives and when the service changes, choose the secret already allowed to reach its node.
  const secretsKey = oauth.map((s) => `${s.name}:${s.sites.join(",")}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: chosen again only when the service or the list changes
  useEffect(() => {
    setSecret(secretFor(oauth, service));
    setNewName(words.secret);
  }, [service.id, secretsKey]);
  // The redirect URL of a sign-in node the flow already has for that secret.
  useEffect(() => {
    const existing = (flow?.steps ?? []).find((s) => s.type === "oauth.signIn" && s.params?.secret === secret);
    const url = existing?.params?.redirectUrl;
    if (typeof url === "string") setRedirect(url);
  }, [flow, secret]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!flow || !project) return null;
  const fileName = file ? (file.split("/").pop() ?? file) : "";

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

  const submit = async () => {
    const isNew = secret === NEW;
    const name = isNew ? newName.trim() : secret;
    const where = service.target(target);
    if (!name || !where || !redirect.trim() || (isNew && !clientId.trim())) {
      setError(c.missing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The secret must allow the token URL, the API and the custom node.
      const saved = await saveSecretAdding(isNew ? { name, kind: "oauth", username: clientId.trim(), password: clientSecret } : { name }, service.sites);
      if (!saved) return;
      const settings = await projectApi.readText(flow.id, "config/settings.json").catch(() => null);
      const settingName = file ? placeName(file, c.settingName(label)) : placeName(c.outputName(label), "");
      const change = cloudChange({
        flow,
        types,
        service,
        file,
        target: where,
        secret: name,
        redirectUrl: redirect.trim(),
        settings,
        name: settingName,
        description: file ? c.settingDescription(fileName, label) : c.outputDescription(label),
        labels: { signIn: c.signInNode(label), download: c.downloadNode, upload: c.uploadNode },
      });
      if (!change) {
        project.setState({ notice: t.places.noOutput });
        onClose();
        return;
      }
      await projectApi.writeText(flow.id, change.configPath, change.configText, true);
      if (await applyOps(change.ops)) {
        project.setState({
          notice: file ? c.readDone(fileName, label, change.count) : c.writeDone(label, change.count),
          panelOpen: true,
        });
        onClose();
      }
      await project.getState().onChanged(flow.id);
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
        aria-label={file ? c.readTitle : c.writeTitle}
        data-cloud-dialog
        className="max-h-[88vh] w-[500px] overflow-y-auto rounded-lg border border-slate-200 bg-sheet p-5 shadow-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <h2 className="text-[15px] font-bold">{file ? c.readTitle : c.writeTitle}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">{file ? c.readLead(fileName) : c.writeLead}</p>

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
        ) : null}

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
          <Field
            label={file ? c.file : c.folder}
            hint={`${words.targetHint}${c.targetHint}`}
            value={target}
            onChange={setTarget}
            placeholder={file ? c.filePlaceholder : c.folderPlaceholder}
          />
          <p className="flex gap-1.5 text-[12px] leading-relaxed text-slate-500">
            <Info size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
            {c.signInNote(words.label)}
          </p>
        </fieldset>

        {error && <p className="mt-3 text-[12.5px] text-shu-600">{error}</p>}

        <div className="mt-5 flex items-center gap-2">
          <button type="button" title={c.syncedHint} onClick={onSynced} className="mr-auto text-[12.5px] text-brand-500 hover:underline">
            {c.synced}
          </button>
          <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 text-[13px] text-slate-600 hover:bg-slate-100">
            {t.cancel}
          </button>
          <button
            type="submit"
            disabled={busy || !ready}
            className="h-8 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-60"
          >
            {file ? c.readApply : c.writeApply}
          </button>
        </div>
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
