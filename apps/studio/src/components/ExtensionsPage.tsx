// The 「拡張機能」 place (docs/extensions.md): extensions installed on this
// PC, as in VS Code: turn one on or off, check for an update, uninstall it,
// or install one from a zip file, an https URL, a GitHub repository or the
// catalog (a JSON index whose URL is set here). Installing shows what the
// extension is first (its nodes, what they send outside, the secrets and the
// program) and installs only when the person confirms. Studio loads
// extensions when it starts, so a change offers a restart.
import { CirclePause, CirclePlay, CloudUpload, Puzzle, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useStudioApi } from "../context";
import { type ExtensionList, type ExtensionPreview, type ExtensionSummary, extensionsApi, type InstalledExtension, type RegistryEntry } from "../lib/api";
import { type MenuSpec, menuFor } from "../lib/contextMenu";
import { t } from "../lib/i18n";
import { EXTENSION_ICONS } from "../lib/nodeIcons";
import { BulkButton, ClearFilters, type Column, DataTable, FacetFilter, RowMenuButton, SearchBox, SelectionBar, StatusBadge, Switch, type Tone, toneDot, useTableView, ViewMenu } from "./DataTable";

const inputClass = "w-full rounded border border-slate-300 bg-sheet px-2 py-1 text-sm focus:border-primary focus:outline-none";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Problems from a manifest check come in `details.problems`. */
function problemsOf(e: unknown): string[] {
  const details = (e as { details?: { problems?: unknown } } | null)?.details;
  return Array.isArray(details?.problems) ? details.problems.map(String) : [];
}

function ExtIcon({ ext, small }: { ext: Pick<ExtensionSummary, "icon">; small?: boolean }) {
  const Icon = (ext.icon && EXTENSION_ICONS[ext.icon]) || Puzzle;
  return (
    <span className={`grid shrink-0 place-items-center rounded-lg border border-slate-200 bg-sheet text-slate-600 ${small ? "h-7 w-7" : "h-9 w-9"}`}>
      <Icon size={small ? 15 : 18} strokeWidth={1.75} aria-hidden="true" />
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
    <div className="rounded-lg border border-slate-200 bg-sheet p-4">
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
    <div className="rounded-lg border border-slate-200 bg-sheet p-4">
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

type InstalledState = "on" | "off" | "dev" | "error";
const INSTALLED_STATES: InstalledState[] = ["on", "off", "dev", "error"];
const INSTALLED_TONE: Record<InstalledState, Tone> = { on: "green", off: "slate", dev: "blue", error: "red" };
const stateOf = (ext: InstalledExtension): InstalledState => (ext.problems.length > 0 ? "error" : !ext.managed ? "dev" : ext.enabled ? "on" : "off");
const installedLabel = (s: InstalledState) => {
  const e = t.extensions;
  return s === "on" ? e.enabled : s === "off" ? e.disabled : s === "dev" ? e.dev : e.loadError;
};

/** The name cell: the icon, the name and what it does, as in the flow and secret tables. */
function NameCell({ ext, problems }: { ext: Pick<ExtensionSummary, "icon" | "label" | "description">; problems?: string[] }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ExtIcon ext={ext} small />
      <span className="min-w-0">
        <span className="block truncate font-medium">{ext.label}</span>
        {problems && problems.length > 0 ? (
          <span className="block truncate font-mono text-[11px] text-shu-600" title={problems.join("\n")}>
            {problems[0]}
          </span>
        ) : (
          ext.description && (
            <span className="block truncate text-[12px] text-slate-500" title={ext.description}>
              {ext.description}
            </span>
          )
        )}
      </span>
    </span>
  );
}

const muted = (text: string) => <span className="block truncate text-[12.5px] text-slate-600">{text}</span>;

function installedColumns(onEnabled: (ext: InstalledExtension, on: boolean) => void): Column<InstalledExtension>[] {
  const e = t.extensions;
  return [
    { id: "name", header: t.runs.name, sortValue: (ext) => ext.label, cell: (ext) => <NameCell ext={ext} problems={ext.problems} /> },
    {
      id: "publisher",
      header: e.publisherColumn,
      width: "w-[180px]",
      hideBelow: 860,
      sortValue: (ext) => ext.publisher ?? "",
      group: (ext) => ({ key: ext.publisher ?? "", label: ext.publisher || "—" }),
      cell: (ext) => muted(ext.publisher || "—"),
    },
    {
      id: "nodes",
      header: e.nodesColumn,
      width: "w-[92px]",
      align: "right",
      sortValue: (ext) => ext.steps?.length ?? 0,
      cell: (ext) => (
        <span className="text-[12.5px] text-slate-600 tabular-nums" title={(ext.steps ?? []).map((s) => s.label).join("\n")}>
          {ext.steps?.length ?? "—"}
        </span>
      ),
    },
    {
      id: "sends",
      header: e.sendsColumn,
      width: "w-[170px]",
      hideBelow: 1000,
      sortValue: (ext) => (ext.steps ?? []).filter((s) => s.external).length,
      cell: (ext) => {
        const sends = (ext.steps ?? []).filter((s) => s.external);
        if (sends.length === 0) return <span className="text-[12.5px] text-slate-500">{e.sendsNone}</span>;
        const services = [...new Set(sends.map((s) => s.external!.service))];
        return (
          <span
            className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-amber-700"
            title={sends.map((s) => e.preview.sentTo(s.external!.service, s.external!.data)).join("\n")}
          >
            <CloudUpload size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{services.join("・")}</span>
          </span>
        );
      },
    },
    {
      id: "version",
      header: e.versionColumn,
      width: "w-[120px]",
      hideBelow: 720,
      sortValue: (ext) => ext.version ?? "",
      cell: (ext) => <span className="text-[12.5px] text-slate-600 tabular-nums">{ext.version ? e.version(ext.version) : "—"}</span>,
    },
    {
      id: "state",
      header: e.stateColumn,
      width: "w-[150px]",
      sortValue: (ext) => INSTALLED_STATES.indexOf(stateOf(ext)),
      group: (ext) => {
        const s = stateOf(ext);
        return { key: s, order: INSTALLED_STATES.indexOf(s), label: <StatusBadge tone={INSTALLED_TONE[s]} label={installedLabel(s)} /> };
      },
      cell: (ext) => {
        const s = stateOf(ext);
        return <StatusBadge tone={INSTALLED_TONE[s]} label={installedLabel(s)} title={s === "dev" ? e.devTitle : s === "error" ? ext.problems.join("\n") : undefined} />;
      },
    },
    {
      id: "enabled",
      header: e.enabled,
      width: "w-[88px]",
      hideable: false,
      sortValue: (ext) => (ext.enabled ? 0 : 1),
      cell: (ext) =>
        ext.managed ? (
          <Switch checked={ext.enabled} label={ext.enabled ? e.disable : e.enable} onChange={(on) => onEnabled(ext, on)} />
        ) : (
          <span className="text-[12px] text-slate-500" title={e.devTitle}>
            —
          </span>
        ),
    },
  ];
}

type Offered = RegistryEntry & { have?: InstalledExtension };

function registryColumns(onInstall: (source: string) => void): Column<Offered>[] {
  const e = t.extensions;
  return [
    { id: "name", header: t.runs.name, sortValue: (x) => x.label, cell: (x) => <NameCell ext={{ ...x, icon: x.have?.icon }} /> },
    {
      id: "publisher",
      header: e.publisherColumn,
      width: "w-[180px]",
      hideBelow: 860,
      sortValue: (x) => x.publisher ?? "",
      group: (x) => ({ key: x.publisher ?? "", label: x.publisher || "—" }),
      cell: (x) => muted(x.publisher || "—"),
    },
    {
      id: "version",
      header: e.versionColumn,
      width: "w-[120px]",
      hideBelow: 720,
      sortValue: (x) => x.version ?? "",
      cell: (x) => <span className="text-[12.5px] text-slate-600 tabular-nums">{x.version ? e.version(x.version) : "—"}</span>,
    },
    {
      id: "state",
      header: e.stateColumn,
      width: "w-[168px]",
      sortValue: (x) => (x.have ? 0 : 1),
      group: (x) => ({ key: x.have ? "have" : "new", order: x.have ? 0 : 1, label: x.have ? e.installedState : e.notInstalled }),
      cell: (x) =>
        x.have ? (
          <StatusBadge tone="green" label={e.installedState} title={x.have.version ? e.version(x.have.version) : undefined} />
        ) : (
          <span className="text-[12.5px] text-slate-500">{e.notInstalled}</span>
        ),
    },
    {
      // What the catalog is for, so always in view (not a hover action).
      id: "install",
      header: "",
      width: "w-[132px]",
      align: "right",
      hideable: false,
      cell: (x) => (
        <button
          type="button"
          className="h-7 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12.5px] whitespace-nowrap text-slate-700 hover:bg-slate-100"
          onClick={(ev) => {
            ev.stopPropagation();
            onInstall(x.source);
          }}
        >
          {x.have ? e.checkUpdate : e.install}
        </button>
      ),
    },
  ];
}

/** The catalog: a JSON index set by URL, nothing hosted by Shikigami. */
function Registry({
  list,
  installed,
  query,
  onInstall,
  onSaved,
}: {
  list: ExtensionList;
  installed: InstalledExtension[];
  query: string;
  onInstall: (source: string) => void;
  onSaved: () => void;
}) {
  const r = t.extensions.registry;
  const e = t.extensions;
  const [url, setUrl] = useState(list.registry ?? "");
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [states, setStates] = useState<Set<"have" | "new">>(new Set());
  const columns = registryColumns(onInstall);
  const view = useTableView(columns, { storageKey: "shikigami.studio.extensions.registry.sort", initialSort: { column: "name", descending: false } });
  const load = useCallback(async () => {
    if (!list.registry) return setEntries(null);
    setEntries(null);
    setError(null);
    try {
      setEntries(await extensionsApi.registry());
    } catch (err) {
      setError(message(err));
    }
  }, [list.registry]);
  useEffect(() => void load(), [load]);
  const offered: Offered[] = (entries ?? []).map((entry) => ({ ...entry, have: installed.find((i) => i.name === entry.name) }));
  const q = query.trim().toLowerCase();
  const matches = (x: Offered) => !q || [x.label, x.name, x.description ?? "", x.publisher ?? ""].join(" ").toLowerCase().includes(q);
  const rows = offered.filter((x) => matches(x) && (!states.size || states.has(x.have ? "have" : "new")));
  return (
    <div>
      {/* Where the catalog comes from: a setting of this tab, kept on one line above it. */}
      <div className="mb-3 flex items-center gap-2">
        <span className="shrink-0 text-[12px] font-medium text-slate-600">{r.url}</span>
        <input className={`${inputClass} h-7 max-w-[520px]`} value={url} placeholder={r.urlPlaceholder} onChange={(ev) => setUrl(ev.target.value)} />
        <button
          type="button"
          disabled={url === (list.registry ?? "")}
          className="h-7 shrink-0 rounded-lg border border-slate-300 px-2.5 text-[13px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          onClick={async () => {
            try {
              await extensionsApi.setRegistry(url);
              onSaved();
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          {r.save}
        </button>
        {entries && entries.length > 0 && (
          <>
            <span className="flex-1" />
            <FacetFilter
              label={e.stateColumn}
              value={states}
              onChange={setStates}
              options={(["have", "new"] as const).map((value) => ({
                value,
                label: value === "have" ? e.installedState : e.notInstalled,
                count: offered.filter((x) => matches(x) && (value === "have") === !!x.have).length,
              }))}
            />
            <ViewMenu view={view} />
          </>
        )}
      </div>
      {error && <p className="mb-2 text-xs text-shu-600">{error}</p>}
      {!list.registry ? (
        <Empty>{r.notSet}</Empty>
      ) : entries === null ? (
        !error && <p className="text-sm text-slate-500">{r.loading}</p>
      ) : entries.length === 0 ? (
        <Empty>{r.empty}</Empty>
      ) : (
        <DataTable
          columns={columns}
          view={view}
          rows={rows}
          total={offered.length}
          rowKey={(x) => x.name}
          empty={e.notFound}
        />
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-slate-500">{r.intro}</p>
    </div>
  );
}

function Empty({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center text-[13px] text-slate-600">
      <Puzzle size={22} strokeWidth={1.5} className="mb-1 text-slate-400" aria-hidden="true" />
      <p>{children}</p>
      {hint && <p className="max-w-[520px] text-[12px] text-slate-500">{hint}</p>}
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
  const [query, setQuery] = useState("");
  const [states, setStates] = useState<Set<InstalledState>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
  const setEnabled = (exts: InstalledExtension[], on: boolean) =>
    act(async () => {
      for (const ext of exts) if (ext.managed && ext.enabled !== on) await extensionsApi.setEnabled(ext.name, on);
    });
  const uninstall = (exts: InstalledExtension[]) =>
    act(async () => {
      for (const ext of exts) if (ext.managed) await extensionsApi.uninstall(ext.name);
      setSelected(new Set());
    });
  const columns = installedColumns((ext, on) => void setEnabled([ext], on));
  const view = useTableView(columns, { storageKey: "shikigami.studio.extensions.sort", initialSort: { column: "name", descending: false } });
  const q = query.trim().toLowerCase();
  const keep = (ext: InstalledExtension, skip?: "state") =>
    (skip === "state" || !states.size || states.has(stateOf(ext))) &&
    (!q || [ext.label, ext.name, ext.description ?? "", ext.publisher ?? "", ...(ext.steps ?? []).map((s) => s.label)].join(" ").toLowerCase().includes(q));
  const rows = installed.filter((ext) => keep(ext));
  const stateOptions = INSTALLED_STATES.map((value) => ({
    value,
    label: installedLabel(value),
    dot: toneDot(INSTALLED_TONE[value]),
    count: installed.filter((x) => keep(x, "state") && stateOf(x) === value).length,
  })).filter((o) => o.count > 0 || states.has(o.value));
  // Only rows on screen that can be changed are picked: a developer's folder is listed, not managed.
  const picked = rows.filter((ext) => selected.has(ext.dir) && ext.managed);
  const menu = (ext: InstalledExtension): MenuSpec[] => [
    ext.source && { label: e.checkUpdate, icon: RefreshCw, run: () => void checkUpdate(ext) },
    ext.managed && { label: ext.enabled ? e.disable : e.enable, icon: ext.enabled ? CirclePause : CirclePlay, run: () => void setEnabled([ext], !ext.enabled) },
    ext.managed && "-",
    ext.managed && { label: e.uninstall, icon: Trash2, danger: true, confirm: e.confirmUninstallOnce, run: () => void uninstall([ext]) },
  ];
  const formOpen = installing !== null || !!preview;
  return (
    <div className="@container h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[1280px] px-6 pt-5 pb-3">
        {/* The two lists, then finding and narrowing, then installing, the filled button, at the end. */}
        <div className="mb-3 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div role="tablist" className="flex h-7 shrink-0 items-center rounded-lg bg-slate-100 p-0.5">
              {(["installed", "registry"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={`flex h-6 items-center gap-1.5 rounded-md px-2.5 text-[13px] whitespace-nowrap ${
                    tab === id ? "bg-sheet font-medium text-ink shadow-sm" : "text-slate-600 hover:text-ink"
                  }`}
                >
                  {e.tabs[id]}
                  {id === "installed" && list && <span className="text-[11.5px] text-slate-500 tabular-nums">{installed.length}</span>}
                </button>
              ))}
            </div>
            {(tab === "registry" || installed.length > 0) && <SearchBox value={query} onChange={setQuery} placeholder={e.search} hits={tab === "installed" ? rows.length : undefined} />}
            {tab === "installed" && installed.length > 0 && (
              <>
                <FacetFilter label={e.stateColumn} value={states} onChange={setStates} options={stateOptions} />
                {states.size > 0 && <ClearFilters onClear={() => setStates(new Set())} />}
              </>
            )}
          </div>
          {tab === "installed" && installed.length > 0 && <ViewMenu view={view} />}
          <button
            type="button"
            hidden={formOpen}
            onClick={() => setInstalling("")}
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-primary px-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover"
          >
            ＋ {e.install}
          </button>
        </div>
        {list?.restartNeeded && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-sheet px-3 py-2 text-[13px]">
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
        {formOpen && (
          <div className="mb-4 max-w-[680px]">
            {preview ? (
              <Preview preview={preview} busy={busy} onConfirm={() => void confirm()} onCancel={close} />
            ) : (
              <SourceForm key={installing ?? ""} initial={installing ?? ""} onPreview={setPreview} onCancel={close} />
            )}
          </div>
        )}
        {list &&
          (tab === "installed" ? (
            <>
              {installed.length === 0 ? (
                <Empty hint={e.noneHint}>{e.none}</Empty>
              ) : (
                <>
                  <DataTable
                    columns={columns}
                    view={view}
                    rows={rows}
                    total={installed.length}
                    rowKey={(ext) => ext.dir}
                    selected={new Set(picked.map((ext) => ext.dir))}
                    onSelect={setSelected}
                    empty={e.notFound}
                    actionsWidth={44}
                    rowActions={(ext) => (ext.managed || ext.source ? <RowMenuButton items={() => menu(ext)} /> : null)}
                    rowProps={(ext) => ({ onContextMenu: menuFor(() => menu(ext)) })}
                  />
                  <SelectionBar count={picked.length} onClear={() => setSelected(new Set())}>
                    <BulkButton icon={CirclePlay} label={e.enable} onClick={() => setEnabled(picked, true)} />
                    <BulkButton icon={CirclePause} label={e.disable} onClick={() => setEnabled(picked, false)} />
                    <BulkButton icon={Trash2} danger label={e.uninstall} confirmLabel={e.uninstallMany(picked.length)} onClick={() => uninstall(picked)} />
                  </SelectionBar>
                </>
              )}
              <p className="mt-3 text-[12px] leading-relaxed text-slate-500">{e.intro}</p>
            </>
          ) : (
            <Registry
              list={list}
              installed={installed}
              query={query}
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
