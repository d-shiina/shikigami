// Where the flow's files come from and go to, when that is not its own
// folder. The input part of the files panel lists the files the flow reads
// that are not there yet, and offers three ways: put the file in the
// folder, read it from a file server, or read it from a Box Drive /
// OneDrive folder. The output/ part of the files panel offers the same for where
// files are written. A place outside is kept as a folder setting
// (lib/filePlaces.ts), so the flow can be handed over and the receiver
// only changes the setting.
import type { NeededFile } from "@spellsheet/schema";
import { CircleAlert, Cloud, FileInput, FolderOutput, Server } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useContext, useEffect, useState } from "react";
import { useStudio } from "../context";
import { chooseAsk } from "../lib/ask";
import { placeChange, placeName, portable } from "../lib/filePlaces";
import { t } from "../lib/i18n";
import { ProjectContext, projectApi, useProjectMaybe } from "../project";
import { stepName } from "./ProjectPanel";

const NONE: NeededFile[] = [];

interface SyncFolders {
  profile: string | null;
  folders: { name: string; path: string }[];
}

const pick = (kind: "file" | "folder", start: string | null) =>
  invoke<string | null>("runner_pick", { kind, start }).catch(() => null);

const syncFolders = () => invoke<SyncFolders>("sync_folders").catch((): SyncFolders => ({ profile: null, folders: [] }));

/** Picks a folder on a file server or in a synced cloud folder; null when cancelled. */
async function pickPlace(where: "fileServer" | "cloud"): Promise<string | null> {
  if (where === "fileServer") return pick("folder", null);
  const sync = await syncFolders();
  const start = sync.folders[0]?.path ?? null;
  const folder = await pick("folder", start);
  return folder === null ? null : portable(folder, sync.profile);
}

/**
 * Points the readers of `file` (input/受注.xlsx), or every writer into
 * output/ (`file` null), at a folder the person picks.
 */
export function usePlace() {
  const project = useContext(ProjectContext);
  const flow = useStudio((s) => s.flow);
  const types = useStudio((s) => s.stepTypes);
  const applyOps = useStudio((s) => s.applyOps);
  return async (where: "fileServer" | "cloud", file: string | null): Promise<void> => {
    if (!flow || !project) return;
    const folder = await pickPlace(where);
    if (!folder) return;
    const settings = await projectApi.readText(flow.id, "config/settings.json").catch(() => null);
    const name = file ? placeName(file, t.places.settingName) : t.places.outputName;
    const change = placeChange({
      flow,
      types,
      prefix: file ? "input" : "output",
      file,
      folder,
      settings,
      name,
      description: file ? t.places.settingDescription(file.split("/").pop() ?? file) : t.places.outputDescription,
    });
    if (!change) {
      project.setState({ notice: t.places.noOutput });
      return;
    }
    try {
      await projectApi.writeText(flow.id, change.configPath, change.configText, true);
      if (await applyOps(change.ops)) project.setState({ notice: t.places.done(change.name, change.steps), panelOpen: true });
    } catch (e) {
      project.setState({ error: e instanceof Error ? e.message : String(e) });
    }
    await project.getState().onChanged(flow.id);
  };
}

/**
 * Keeps the list of missing input files current: it comes with the folder's
 * files, and an edit to the flow (a node that now reads input/x.xlsx) asks
 * for it again. Mounted with the chart, whether the files panel is open or not.
 */
export function NeededFilesWatch() {
  const project = useContext(ProjectContext);
  const id = useStudio((s) => s.flow?.id);
  const revision = useStudio((s) => s.flow?.revision);
  useEffect(() => {
    if (!project || !id) return;
    const timer = setTimeout(() => void project.getState().onChanged(id), 300);
    return () => clearTimeout(timer);
  }, [project, id, revision]);
  return null;
}

/** The input files the flow reads that are not there yet (a fixed empty list when none). */
export function useNeededFiles(): NeededFile[] {
  const id = useStudio((s) => s.flow?.id);
  // A fixed empty list: a new [] on every call would make the store re-render without end.
  return useProjectMaybe((s) => (s.files?.flowId === id ? (s.files?.needed ?? NONE) : NONE), NONE);
}

/**
 * In the input part of the files panel, where the file would go: each file
 * the flow reads that is not there yet, and the three ways to get it.
 */
export function NeededFiles() {
  const project = useContext(ProjectContext);
  const flow = useStudio((s) => s.flow);
  const types = useStudio((s) => s.stepTypes);
  const select = useStudio((s) => s.select);
  const needed = useNeededFiles();
  const place = usePlace();
  if (!flow || needed.length === 0) return null;
  const nameOf = (stepId: string) => {
    const find = (list: typeof flow.steps): string | null => {
      for (const s of list ?? []) {
        if (s.id === stepId) return stepName(s, types);
        for (const children of Object.values(s.blocks ?? {})) {
          const found = find(children);
          if (found) return found;
        }
      }
      return null;
    };
    return find(flow.steps) ?? stepId;
  };
  const put = async (path: string) => {
    const from = await pick("file", null);
    if (!from || !project) return;
    try {
      await invoke("copy_into_project_as", { id: flow.id, from, path, overwrite: false });
      project.setState({ notice: t.places.copied(path) });
    } catch (e) {
      project.setState({ error: typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e) });
    }
    await project.getState().onChanged(flow.id);
  };
  return (
    <div data-needed-files className="mx-1 mb-1 space-y-1.5">
      <p className="flex items-start gap-1.5 px-1 text-[11.5px] leading-snug text-amber-700 dark:text-amber-400">
        <CircleAlert size={13} strokeWidth={1.75} className="mt-px shrink-0" aria-hidden="true" />
        <span>
          {t.places.neededTitle(needed.length)}
          <span className="block text-slate-500">{t.places.neededBody}</span>
        </span>
      </p>
      {needed.map((n) => (
        <div key={n.path} className="rounded-lg border-[1.5px] border-dashed border-role-input/60 px-2 py-1.5">
          <div className="truncate text-[12px] font-medium text-ink" title={n.path}>
            {n.path.replace(/^input\//i, "")}
          </div>
          <button
            type="button"
            onClick={() => n.stepIds[0] && select({ kind: "step", stepId: n.stepIds[0] })}
            className="block max-w-full truncate text-[11px] text-brand-500 hover:underline"
          >
            {t.places.readBy(n.stepIds.map((id) => t.quote(nameOf(id))).join(""))}
          </button>
          <div className="mt-1.5 grid gap-1">
            <Choice icon={FileInput} label={t.places.put} title={t.places.putTitle(n.path)} onClick={() => void put(n.path)} />
            <Choice icon={Server} label={t.places.fileServer} title={t.places.fileServerTitle} onClick={() => void place("fileServer", n.path)} />
            <Choice icon={Cloud} label={t.places.cloud} title={t.places.cloudTitle} onClick={() => void place("cloud", n.path)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Choice({ icon: Icon, label, title, onClick }: { icon: typeof Server; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-md border border-slate-300 bg-sheet px-2 text-left text-[12px] text-slate-700 hover:border-brand-500 hover:text-brand-500"
    >
      <Icon size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}

/** In the output/ part of the files panel: write somewhere else instead. */
export function OutputPlaceMenu() {
  const [open, setOpen] = useState(false);
  const place = usePlace();
  return (
    <span className="relative">
      <button
        type="button"
        title={t.places.changeOutputTitle}
        aria-label={t.places.changeOutput}
        onClick={() => setOpen(!open)}
        className="grid h-5 w-5 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-ink"
      >
        <FolderOutput size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-6 right-0 z-50 w-56 rounded-lg border border-slate-200 bg-sheet py-1 shadow-lifted">
            <div className="px-3 pt-1 pb-1.5 text-[11px] font-semibold text-slate-500">{t.places.changeOutput}</div>
            {(
              [
                ["fileServer", Server, t.places.writeFileServer],
                ["cloud", Cloud, t.places.writeCloud],
              ] as const
            ).map(([where, Icon, label]) => (
              <button
                key={where}
                type="button"
                onClick={() => {
                  setOpen(false);
                  void place(where, null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-slate-100"
              >
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

/**
 * A file picked with 「参照…」 outside the flow's folder: read it where it is
 * (a file server, Box) or copy it in. True to keep its full path.
 */
export async function keepWhereItIs(path: string): Promise<boolean | null> {
  const answer = await chooseAsk({
    title: t.places.keepOrCopyTitle,
    body: t.places.keepOrCopyBody(path),
    confirm: t.places.keep,
    other: t.places.copy,
  });
  return answer === "cancel" ? null : answer === "confirm";
}
