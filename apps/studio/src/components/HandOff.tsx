// Handing a flow to another person or PC as one `.spx` file, and looking at
// one before importing it (docs/design/sharing-versioning.md).
//
// 「渡す」 says what goes in (the published version by default, the folder's
// files except input/) and what the receiver's PC needs. Opening a file
// (double-click in Explorer, dropping it on the window, 「ファイルから読み込む」)
// shows a sheet of paper with what it holds and what this PC still lacks,
// each with the button that adds it, before anything is imported.
import type { CheckKind, DiffKind, PackageFileChoice, PackageRequires1, RequirementCheck } from "@shikigami/schema";
import { AppWindow, Check, CircleAlert, FileText, Globe, KeyRound, Puzzle, TextCursorInput, Workflow } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStudio, useStudioApi } from "../context";
import { api, events } from "../lib/api";
import { stepLabel, t } from "../lib/i18n";

const base = "h-8 rounded-md px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const primary = `${base} bg-primary text-on-primary hover:bg-primary-hover disabled:opacity-50`;
const quiet = `${base} text-slate-600 hover:bg-slate-100`;
const secondary = `${base} border border-slate-300 bg-sheet text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-sheet`;
const small = "h-7 shrink-0 rounded-md border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-primary";

const ICON = { plugin: Puzzle, secret: KeyRound, site: Globe, app: AppWindow } satisfies Record<CheckKind, unknown>;

function kb(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const pluginName = (key: string) => key.replace(/^plugin:/, "");

/** The veil and the sheet; Esc and a click outside cancel, Tab stays inside, focus comes back. */
export function Modal({ label, onCancel, wide, children }: { label: string; onCancel: () => void; wide?: boolean; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Tab") {
      const items = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)") ?? [])];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
      e.preventDefault();
      items[next]?.focus();
    }
  };
  return (
    <div className="fixed inset-0 z-[65] grid place-items-center bg-ink/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()} onKeyDown={onKeyDown}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`flex max-h-[90vh] w-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-dialog ${wide ? "max-w-[600px]" : "max-w-[560px]"}`}
      >
        {children}
      </div>
    </div>
  );
}

function Choice({ on, onPick, title, note, children }: { on: boolean; onPick: () => void; title: string; note?: string; children?: React.ReactNode }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 ${on ? "border-primary bg-brand-50 dark:bg-brand-700/20" : "border-slate-200 hover:bg-slate-50"}`}>
      <input type="radio" checked={on} onChange={onPick} className="mt-1 accent-[var(--color-primary)]" />
      <span className="min-w-0 text-[13px] text-ink">
        {title}
        {note && <span className="mt-0.5 block text-xs text-slate-500">{note}</span>}
        {children}
      </span>
    </label>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-700">{children}</ul>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-xs text-slate-500">{children}</h3>;
}

/** What the receiving PC needs, as plain lines. */
function Needs({ requires }: { requires: PackageRequires1 }) {
  const h = t.handOff;
  const rows: { icon: typeof Puzzle; text: string }[] = [
    ...Object.entries(requires.plugins ?? {}).map(([k, v]) => ({ icon: Puzzle, text: h.plugin(pluginName(k), v) })),
    ...((requires.secrets ?? []).length ? [{ icon: KeyRound, text: h.secret((requires.secrets ?? []).map(t.quote).join("")) }] : []),
    ...(requires.sites ?? []).map((s) => ({ icon: Globe, text: h.site(s) })),
    ...(requires.apps ?? []).map((s) => ({ icon: AppWindow, text: h.app(s) })),
    ...((requires.inputs ?? []).length ? [{ icon: TextCursorInput, text: h.input((requires.inputs ?? []).map((i) => t.quote(i.name)).join("")) }] : []),
  ];
  if (rows.length === 0) return <p className="text-xs text-slate-500">{h.needsNothing}</p>;
  return (
    <Rows>
      {rows.map((r) => (
        <li key={r.text} className="flex items-center gap-2.5 px-3 py-1.5 text-[13px]">
          <r.icon size={15} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
          <span className="min-w-0 break-words">{r.text}</span>
        </li>
      ))}
    </Rows>
  );
}

const fileKey = (f: { flowId: string; path: string }) => `${f.flowId}\u0000${f.path}`;

/** 「渡す」: choose the content and files, see what the receiver needs, save the `.spx` file. */
export function HandOffDialog() {
  const plan = useStudio((s) => s.handOff);
  const close = useStudio((s) => s.closeHandOff);
  const exportPackage = useStudio((s) => s.exportPackage);
  const openHandOff = useStudio((s) => s.openHandOff);
  const folders = useStudio((s) => s.distribution.folders);
  const checkDistribution = useStudio((s) => s.checkDistribution);
  const placeInDistribution = useStudio((s) => s.placeInDistribution);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState("");
  const opened = !!plan;
  useEffect(() => {
    if (opened) void checkDistribution();
  }, [opened, checkDistribution]);
  useEffect(() => {
    setPicked(new Set((plan?.files ?? []).filter((f) => f.includedByDefault).map(fileKey)));
  }, [plan]);
  if (!plan) return null;
  const h = t.handOff;
  const published = plan.published ?? null;
  // The plan is for what is chosen: its files, needs and name follow the choice.
  const current = plan.current;
  const fileName = plan.fileName;
  const setCurrent = (on: boolean) => {
    if (on !== current) void openHandOff(plan.flowId, on ? "current" : "auto");
  };
  const byFlow = new Map<string, PackageFileChoice[]>();
  for (const f of plan.files) byFlow.set(f.flowId, [...(byFlow.get(f.flowId) ?? []), f]);
  const toggle = (f: PackageFileChoice) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(fileKey(f))) next.delete(fileKey(f));
      else next.add(fileKey(f));
      return next;
    });
  // Exactly the files shown and ticked: anything not listed stays out (saving and placing alike).
  const only = () => plan.files.filter((f) => picked.has(fileKey(f))).map((f) => ({ flowId: f.flowId, path: f.path }));
  const save = async () => {
    setBusy(true);
    const out = await exportPackage(plan.flowId, { content: current ? "current" : "auto", versions: "content", includeInput: true, only: only() });
    setBusy(false);
    if (out) void api.revealFile(out.path).catch(() => {});
  };
  const d = t.distribution;
  const target = folders.some((f) => f.name === folder) ? folder : (folders[0]?.name ?? "");
  const canPlace = !!published && !current;
  const place = async () => {
    setBusy(true);
    await placeInDistribution(plan.flowId, target, only());
    setBusy(false);
  };
  return (
    <Modal label={h.title(plan.name)} onCancel={close}>
      <header className="px-5 pt-4 pb-2">
        <h2 className="text-[15px] font-semibold text-ink">{h.title(plan.name)}</h2>
        <p className="mt-1 text-xs text-slate-500">{h.lead}</p>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-2">
        <section>
          <Label>{h.content}</Label>
          {published ? (
            <div className="space-y-1.5">
              <Choice on={!current} onPick={() => setCurrent(false)} title={h.published(published.number, published.name)} note={h.publishedNote} />
              <Choice on={current} onPick={() => setCurrent(true)} title={h.current} note={plan.hasUnpublishedChanges ? h.currentChanged : undefined} />
            </div>
          ) : (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-[13px] text-slate-600 dark:bg-slate-800">{h.currentOnly}</p>
          )}
        </section>
        <section>
          <Label>{h.files}</Label>
          {plan.files.length === 0 && plan.subflows.length === 0 ? (
            <p className="text-xs text-slate-500">{h.noFiles}</p>
          ) : (
            <Rows>
              {plan.files
                .filter((f) => f.flowId === plan.flowId)
                .map((f) => (
                  <FileRow key={fileKey(f)} file={f} on={picked.has(fileKey(f))} onToggle={() => toggle(f)} />
                ))}
              {plan.subflows.map((sub) => (
                <li key={sub.id} className="px-3 py-1.5 text-[13px]">
                  <div className="flex items-center gap-2.5">
                    <Workflow size={15} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
                    <span className="min-w-0 break-words">{h.subflow(sub.name)}</span>
                  </div>
                  {(byFlow.get(sub.id) ?? []).length > 0 && (
                    <ul className="mt-1 pl-4">
                      {(byFlow.get(sub.id) ?? []).map((f) => (
                        <FileRow key={fileKey(f)} file={f} on={picked.has(fileKey(f))} onToggle={() => toggle(f)} nested />
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </Rows>
          )}
          {plan.files.some((f) => !f.includedByDefault) && <p className="mt-1.5 text-xs text-slate-500">{h.inputNote}</p>}
          <p className="mt-1 text-xs text-slate-500">{h.notIncluded}</p>
        </section>
        <section>
          <Label>{h.needs}</Label>
          <Needs requires={plan.requires} />
        </section>
        <section>
          <Label>{h.saveAs}</Label>
          <p className="flex flex-wrap items-baseline gap-2 rounded-md bg-slate-50 px-3 py-1.5 font-mono text-[12.5px] break-all text-ink dark:bg-slate-800">
            {fileName}
            <span className="font-sans text-xs text-slate-500">{h.downloads}</span>
          </p>
        </section>
      </div>
      <footer className="flex items-center gap-2 border-t border-slate-100 px-5 py-3">
        {folders.length > 0 && (
          // Only a published version goes to a 配布フォルダー: others take it in from there.
          <div className="flex min-w-0 items-center gap-1.5" title={canPlace ? undefined : d.placeOnlyPublished}>
            {folders.length > 1 && (
              <select
                aria-label={d.title}
                value={target}
                onChange={(e) => setFolder(e.target.value)}
                disabled={!canPlace || busy}
                className="h-8 max-w-[140px] min-w-0 rounded-md border border-slate-300 bg-sheet px-2 text-[13px] text-ink disabled:opacity-50"
              >
                {folders.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className={secondary} disabled={!canPlace || busy} onClick={() => void place()}>
              {folders.length > 1 ? d.place : d.placeIn(target)}
            </button>
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" className={quiet} onClick={close}>
            {t.cancel}
          </button>
          <button type="button" className={primary} onClick={() => void save()} disabled={busy} data-autofocus>
            {h.save}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

function FileRow({ file, on, onToggle, nested }: { file: PackageFileChoice; on: boolean; onToggle: () => void; nested?: boolean }) {
  const input = !file.includedByDefault;
  return (
    <li className={nested ? "py-1" : "px-3 py-1.5"}>
      <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
        <input type="checkbox" checked={on} onChange={onToggle} className="shrink-0 accent-[var(--color-primary)]" />
        <span className="min-w-0 flex-1 break-all">{file.path}</span>
        {input && <span className="shrink-0 rounded bg-amber-50 px-1.5 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">{t.handOff.maybePersonal}</span>}
        <span className="shrink-0 text-xs text-slate-500 tabular-nums">{kb(file.size)}</span>
      </label>
    </li>
  );
}

const KIND_STYLE: Record<DiffKind, string> = {
  added: "text-moegi-600",
  removed: "text-shu-600",
  changed: "text-brand-600",
  moved: "text-slate-500",
};

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The sheet shown before a flow file is imported. */
export function ReceiveSheet() {
  const received = useStudio((s) => s.received);
  const close = useStudio((s) => s.closeReceived);
  const importReceived = useStudio((s) => s.importReceived);
  const stepAway = useStudio((s) => s.stepAwayFromReceived);
  const back = useStudio((s) => s.backToReceived);
  const openSecretForm = useStudio((s) => s.openSecretForm);
  const setPlace = useStudio((s) => s.setPlace);
  const setPolicyOpen = useStudio((s) => s.setPolicyOpen);
  const defs = useStudio((s) => s.stepTypes);
  const [mode, setMode] = useState<"update" | "copy">("update");
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const defMap = useMemo(() => new Map(defs.map((d) => [d.type, d])), [defs]);
  useEffect(() => setMode("update"), [received?.preview]);
  if (!received) return null;
  const r = t.receive;
  const { manifest, existing, checks } = received.preview;
  const requires = manifest.requires ?? {};
  if (received.away) {
    return (
      <div className="fixed right-4 bottom-4 z-[60] flex items-center gap-2 rounded-lg border border-slate-200 bg-sheet px-3 py-2 text-[13px] shadow-lifted">
        <FileText size={15} strokeWidth={1.75} className="text-brand-500" aria-hidden="true" />
        <span className="truncate">{manifest.flow.name}</span>
        <button type="button" className={small} onClick={() => void back()}>
          {r.import}
        </button>
        <button type="button" className="h-7 px-1.5 text-xs text-slate-500 hover:text-ink" onClick={close}>
          {t.cancel}
        </button>
      </div>
    );
  }
  const v = manifest.flow.version ?? null;
  const who = manifest.exportedBy;
  const date = day(manifest.exportedAt);
  const subtitle = [
    who ? r.from(who, date) : r.fromUnknown(date),
    v ? (manifest.flow.published ? r.publishedVersion(v.number) : r.version(v.number)) : r.notVersion,
  ].join(" ・ ");
  const fileCount = manifest.contents.filter((c) => c.path.startsWith("files/")).length;
  const inputs = requires.inputs ?? [];
  const go = (c: RequirementCheck) => {
    stepAway();
    if (c.kind === "secret") openSecretForm({ name: c.name, sites: requires.sites ?? [], fields: ["username", "password"] });
    else if (c.kind === "plugin") setPlace("extensions");
    else setPolicyOpen(true);
  };
  const action = (c: RequirementCheck) => (c.kind === "secret" ? r.register : c.kind === "plugin" ? r.install : r.allow);
  const line = (c: RequirementCheck) =>
    c.kind === "plugin" ? r.plugin(c.name, c.range ?? "") : c.kind === "secret" ? r.secret(c.name) : c.kind === "site" ? r.site(c.name) : r.appRun(c.name);
  const changes = existing
    ? [
        ...existing.diff.flow.map((f) => ({ kind: "changed" as DiffKind, text: (t.versionField as Record<string, string>)[f.field] ?? f.field })),
        ...existing.diff.variables.map((x) => ({ kind: x.kind, text: `${t.variables} ${x.name}` })),
        ...existing.diff.steps.map((s) => ({ kind: s.kind, text: s.name || stepLabel(s.type, defMap.get(s.type)?.label) })),
      ]
    : [];
  const doImport = async () => {
    setBusy(true);
    await importReceived(existing ? mode : undefined);
    setBusy(false);
  };
  const kept = (existing?.keptInputs ?? []).map((p) => p.replace(/^input\//i, ""));
  const keptInputs = kept.length > 3 ? `${kept.slice(0, 3).join("・")} ${r.moreChanges(kept.length - 3)}` : kept.join("・");
  const publishedHere = existing?.publishedVersion != null ? `v${existing.publishedVersion}` : null;
  return (
    <Modal label={manifest.flow.name} onCancel={close} wide>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-2" aria-labelledby={titleId}>
        <p className="text-xs text-slate-500">{subtitle}</p>
        <h2 id={titleId} className="mt-0.5 flex flex-wrap items-center gap-2 text-[18px] font-bold text-ink">
          {manifest.flow.name}
          {existing && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {existing.latestVersion != null ? r.exists(`v${existing.latestVersion}`) : r.existsCurrent}
            </span>
          )}
        </h2>
        {manifest.flow.description && <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{manifest.flow.description}</p>}
        <dl className="my-3 flex flex-wrap gap-x-6 gap-y-1 border-y border-slate-100 py-2.5">
          {[
            [manifest.flow.stepCount, r.steps],
            [manifest.subflows?.length ?? 0, r.subflows],
            [fileCount, r.files],
            [inputs.length, inputs.length ? `${r.inputs}（${inputs.map((i) => i.name).join("・")}）` : r.inputs],
          ].map(([n, label]) => (
            <div key={String(label)}>
              <dd className="text-[15px] font-semibold text-ink tabular-nums">{n}</dd>
              <dt className="text-xs text-slate-500">{label}</dt>
            </div>
          ))}
        </dl>
        {existing ? (
          <section className="mb-3">
            <Label>{r.changesFrom}</Label>
            {existing.hasPackageVersion || existing.diff.identical ? (
              <p className="text-[13px] text-slate-600">{existing.hasPackageVersion ? r.sameVersion : r.identical}</p>
            ) : (
              <ul className="space-y-0.5 rounded-md border border-slate-200 px-3 py-2 text-[12.5px]">
                {changes.slice(0, 8).map((c, i) => (
                  <li key={`${c.kind}-${i}`} className="flex gap-2">
                    <span className={`w-9 shrink-0 font-semibold ${KIND_STYLE[c.kind]}`}>{t.diffKind[c.kind]}</span>
                    <span className="min-w-0 break-words">{c.text}</span>
                  </li>
                ))}
                {changes.length > 8 && <li className="text-slate-500">{r.moreChanges(changes.length - 8)}</li>}
              </ul>
            )}
            <div className="mt-2.5 space-y-1.5">
              <Choice on={mode === "update"} onPick={() => setMode("update")} title={r.update} note={r.updateNote(publishedHere)}>
                {keptInputs.length > 0 && <span className="mt-1 block text-xs text-slate-600">{r.keptInputs(keptInputs)}</span>}
              </Choice>
              <Choice on={mode === "copy"} onPick={() => setMode("copy")} title={r.copy} note={r.copyNote(existing.name)} />
            </div>
          </section>
        ) : null}
        <section>
          <Label>{r.needs}</Label>
          <Rows>
            <li className="flex items-center gap-2.5 px-3 py-1.5 text-[13px]">
              <Check size={15} strokeWidth={2} className="shrink-0 text-moegi-600" aria-hidden="true" />
              <span className="min-w-0 flex-1">{r.app(manifest.appVersion)}</span>
            </li>
            {checks.map((c) => {
              const Icon = ICON[c.kind];
              const ok = c.status === "ok";
              return (
                <li key={`${c.kind}-${c.name}`} className="flex items-center gap-2.5 px-3 py-1.5 text-[13px]">
                  {ok ? (
                    <Check size={15} strokeWidth={2} className="shrink-0 text-moegi-600" aria-label={r.status.ok} />
                  ) : (
                    <CircleAlert size={15} strokeWidth={1.75} className="shrink-0 text-amber-600" aria-label={r.status[c.status]} />
                  )}
                  <Icon size={14} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words">
                    {line(c)}
                    {!ok && (
                      <span className="ml-2 text-xs text-slate-500">
                        {c.kind === "plugin" && c.status === "missing" ? r.pluginMissing : c.installed ? `${r.status[c.status]}（${c.installed}）` : r.status[c.status]}
                      </span>
                    )}
                  </span>
                  {ok ? (
                    <span className="shrink-0 rounded bg-moegi-100 px-1.5 text-[11px] text-moegi-600">{c.kind === "secret" ? r.installed : r.status.ok}</span>
                  ) : (
                    <button type="button" className={small} onClick={() => go(c)}>
                      {action(c)}
                    </button>
                  )}
                </li>
              );
            })}
          </Rows>
          <p className="mt-2.5 text-xs leading-relaxed text-slate-500">{r.note}</p>
        </section>
      </div>
      <footer className="flex justify-end gap-2 border-t border-slate-100 px-6 py-3">
        <button type="button" className={quiet} onClick={close}>
          {t.cancel}
        </button>
        <button type="button" className={primary} onClick={() => void doImport()} disabled={busy} data-autofocus>
          {r.import}
        </button>
      </footer>
    </Modal>
  );
}

/** Reads a chosen file for receiveFile (base64; `.spx` files are zips). */
export async function fileToFlowFile(file: File): Promise<{ data: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(binary) };
}

/** Shows a `.spx` file opened from Explorer, at start and while Writer runs. */
export function useOpenedFiles() {
  const store = useStudioApi();
  useEffect(() => {
    const show = () =>
      void api
        .takeOpenedFile()
        .then((path) => {
          if (path) void store.getState().receiveFile({ path });
        })
        .catch(() => {
          // Outside Tauri (tests, the browser preview) nothing is opened.
        });
    show();
    let off: (() => void) | null = null;
    let gone = false;
    events
      .onOpenedFile(show)
      .then((unlisten) => {
        if (gone) unlisten();
        else off = unlisten;
      })
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [store]);
}

/** Mounted once with the dialogs: shows files opened from Explorer. */
export function OpenedFiles() {
  useOpenedFiles();
  return null;
}
