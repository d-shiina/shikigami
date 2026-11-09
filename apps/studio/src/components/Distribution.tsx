// 配布フォルダー (docs/design/sharing-versioning.md): shared folders where
// people put the `.spx` files of published versions. This PC registers the
// ones it looks at (Settings), the flows page says when one holds a newer
// version, and the list shows each flow there against this PC with the
// button that takes it in (through the same sheet as any received file:
// what changed, what this PC needs, nothing published until a person here
// publishes it).
import type { DistributedFlow, DistributionFolder, DistributionView } from "@spellsheet/schema";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, FolderSync, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useStudio } from "../context";
import { relativeTime } from "../lib/changes";
import { t } from "../lib/i18n";
import { Modal } from "./HandOff";
import { SettingsGroup, SettingsRow, settingsInput } from "./settingsLayout";

const base = "h-8 shrink-0 rounded-md px-3 text-[13px] font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const primary = `${base} bg-primary text-on-primary hover:bg-primary-hover disabled:opacity-50`;
const secondary = `${base} border border-slate-300 bg-sheet text-slate-700 hover:bg-slate-50 disabled:opacity-50`;
const quiet = `${base} text-slate-600 hover:bg-slate-100`;

/** Flows there that are new to this PC or newer than its version. */
export function fresh(views: DistributionView[] | null): { folder: string; count: number }[] {
  return (views ?? [])
    .map((v) => ({ folder: v.folder.name, count: v.flows.filter((f) => f.state === "new" || f.state === "update").length }))
    .filter((v) => v.count > 0);
}

const date = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`;
};

/** Looks through the folders when the flows page shows and when the window comes back, at most once a minute. */
export function useDistributionCheck() {
  const check = useStudio((s) => s.checkDistribution);
  useEffect(() => {
    let last = 0;
    const run = () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      void check();
    };
    run();
    window.addEventListener("focus", run);
    return () => window.removeEventListener("focus", run);
  }, [check]);
}

/** One line above the flows when a 配布フォルダー holds something new. */
export function DistributionNotice() {
  const views = useStudio((s) => s.distribution.views);
  const open = useStudio((s) => s.openDistribution);
  const news = fresh(views);
  if (news.length === 0) return null;
  const d = t.distribution;
  const total = news.reduce((n, v) => n + v.count, 0);
  return (
    <div role="status" className="mb-3 flex items-center gap-2.5 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-[13px] text-ink dark:border-brand-700/60 dark:bg-brand-700/20">
      <FolderSync size={16} strokeWidth={1.75} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{news.length === 1 ? d.notice(news[0]!.folder, total) : d.noticeMany(total)}</span>
      <button type="button" onClick={open} className="h-7 shrink-0 rounded-md border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 hover:bg-slate-50">
        {d.show}
      </button>
    </div>
  );
}

function FlowRow({ flow, onTake }: { flow: DistributedFlow; onTake: (flow: DistributedFlow) => void }) {
  const d = t.distribution;
  const when = date(flow.exportedAt);
  const sub = [flow.exportedBy ? d.by(flow.exportedBy, when) : d.at(when), flow.version.name ? `「${flow.version.name}」` : ""].join(" ");
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-ink">{flow.name}</div>
        <div className="truncate text-xs text-slate-500">{sub}</div>
      </div>
      {flow.state === "update" ? (
        <>
          <span className="shrink-0 text-xs text-slate-500">
            {flow.localVersion ? d.local(flow.localVersion) : d.localNone} → <b className="font-semibold text-primary">v{flow.version.number}</b>
          </span>
          <button type="button" className={primary} onClick={() => onTake(flow)}>
            {d.takeUpdate}
          </button>
        </>
      ) : flow.state === "new" ? (
        <>
          <span className="shrink-0 text-xs text-slate-500">v{flow.version.number}</span>
          <button type="button" className={secondary} onClick={() => onTake(flow)}>
            {d.take}
          </button>
        </>
      ) : flow.state === "latest" ? (
        <>
          <span className="shrink-0 text-xs text-slate-500">v{flow.version.number}</span>
          <span className="shrink-0 rounded bg-moegi-100 px-1.5 py-0.5 text-[11px] text-moegi-600">{d.latest}</span>
        </>
      ) : (
        <span className="shrink-0 text-xs text-slate-500">
          v{flow.version.number}・{d.older}
        </span>
      )}
    </li>
  );
}

function FolderSheet({ view, onTake }: { view: DistributionView; onTake: (flow: DistributedFlow) => void }) {
  const d = t.distribution;
  return (
    <section>
      <header className="flex items-baseline gap-3 px-1 pb-1.5">
        <h3 className="shrink-0 text-[14px] font-semibold text-ink">{view.folder.name}</h3>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500" title={view.folder.path}>
          {view.folder.path}
        </span>
        <span className="shrink-0 text-[11px] text-slate-500">{d.checked(relativeTime(view.checkedAt))}</span>
      </header>
      <div className="rounded-lg border border-slate-200">
        {view.error ? (
          <p className="px-4 py-3 text-[13px] text-shu-600">{d.unreachable(view.error)}</p>
        ) : view.flows.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-slate-500">{d.empty}</p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {view.flows.map((f) => (
              <FlowRow key={f.flowId} flow={f} onTake={onTake} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The list of each registered folder's flows against this PC. */
export function DistributionDialog() {
  const { folders, views, open } = useStudio((s) => s.distribution);
  const close = useStudio((s) => s.closeDistribution);
  const check = useStudio((s) => s.checkDistribution);
  const receiveFile = useStudio((s) => s.receiveFile);
  const setPlace = useStudio((s) => s.setPlace);
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const d = t.distribution;
  const take = (flow: DistributedFlow) => {
    close();
    void receiveFile({ path: flow.path });
  };
  return (
    <Modal label={d.title} onCancel={close} wide>
      <header className="flex items-center gap-2 px-6 pt-5 pb-2">
        <h2 className="flex-1 text-[15px] font-semibold text-ink">{d.title}</h2>
        {folders.length > 0 && (
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink disabled:opacity-50"
            title={d.refresh}
            aria-label={d.refresh}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await check();
              setBusy(false);
            }}
          >
            <RefreshCw size={14} strokeWidth={1.75} className={busy ? "motion-safe:animate-spin" : ""} aria-hidden="true" />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-2">
        {folders.length === 0 ? (
          <div className="py-4">
            <p className="text-[13px] font-medium text-ink">{d.none}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{d.noneHint}</p>
          </div>
        ) : views === null ? (
          <p className="py-4 text-[13px] text-slate-500">…</p>
        ) : (
          views.map((v) => <FolderSheet key={v.folder.name} view={v} onTake={take} />)
        )}
        {folders.length > 0 && <p className="text-xs leading-relaxed text-slate-500">{d.note}</p>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-slate-100 px-6 py-3">
        {folders.length === 0 ? (
          <>
            <button type="button" className={quiet} onClick={close}>
              {t.cancel}
            </button>
            <button
              type="button"
              className={primary}
              data-autofocus
              onClick={() => {
                close();
                setPlace("settings");
              }}
            >
              {d.toSettings}
            </button>
          </>
        ) : (
          <button type="button" className={secondary} onClick={close} data-autofocus>
            {t.close}
          </button>
        )}
      </footer>
    </Modal>
  );
}

/** Settings → the folders this PC looks at: add (name and folder), remove. */
export function DistributionSettings() {
  const folders = useStudio((s) => s.distribution.folders);
  const save = useStudio((s) => s.setDistributionFolders);
  const check = useStudio((s) => s.checkDistribution);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  useEffect(() => {
    void check();
  }, [check]);
  const d = t.distribution;
  const add = async () => {
    if (!name.trim() || !path.trim()) return;
    const next: DistributionFolder[] = [...folders, { name: name.trim(), path: path.trim() }];
    if (await save(next)) {
      setName("");
      setPath("");
    }
  };
  const browse = async () => {
    const picked = await invoke<string | null>("runner_pick", { kind: "folder", start: path || null }).catch(() => null);
    if (picked) setPath(picked);
  };
  return (
    <SettingsGroup title={d.settingsTitle} description={d.settingsHint}>
      {folders.length === 0 ? (
        <div className="px-4 py-2.5 text-[13px] text-slate-500">{d.nothingYet}</div>
      ) : (
        folders.map((f) => (
          <SettingsRow key={f.name} label={f.name}>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-600" title={f.path}>
                {f.path}
              </code>
              <button
                type="button"
                title={d.remove(f.name)}
                aria-label={d.remove(f.name)}
                onClick={() => void save(folders.filter((x) => x.name !== f.name))}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-shu-600"
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </SettingsRow>
        ))
      )}
      <form
        className="grid grid-cols-1 items-center gap-x-6 gap-y-1.5 px-4 py-2.5 @min-[640px]:grid-cols-[minmax(180px,2fr)_minmax(0,3fr)]"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input aria-label={d.name} value={name} onChange={(e) => setName(e.target.value)} placeholder={d.namePlaceholder} className={settingsInput} />
        <div className="flex min-w-0 items-center gap-2">
          <input aria-label={d.path} value={path} onChange={(e) => setPath(e.target.value)} placeholder={d.pathPlaceholder} className={`${settingsInput} min-w-0 flex-1 font-mono text-[12px]`} />
          <button type="button" onClick={() => void browse()} className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-slate-300 bg-sheet px-2 text-[12px] text-slate-700 hover:bg-slate-50">
            <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
            {t.props.browse}
          </button>
          <button type="submit" disabled={!name.trim() || !path.trim()} className={secondary}>
            {d.add}
          </button>
        </div>
      </form>
    </SettingsGroup>
  );
}
