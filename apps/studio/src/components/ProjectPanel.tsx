// The scenario's folder, floating over the left of the chart: its files on
// shelves by what they are for (input, settings, templates, output), each in
// one of the logo's colours, with which nodes use them and whether Excel has
// them open. Work and logs sit at the foot. Files dropped from Explorer land
// on the shelf under the pointer, or are sorted by name when dropped
// anywhere else on the editor.
import type { ProjectFile, Scenario, Step, StepTypeDef } from "@shikigami/schema";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Eraser,
  ExternalLink,
  FileCog,
  FileOutput,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  type LucideIcon,
  PanelLeftClose,
  Plus,
  ScrollText,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStudio } from "../context";
import { locale, stepLabel, t } from "../lib/i18n";
import { latestLog, logStatus, type Role, ROLES, roleOf, useProject, usersOf } from "../project";

const ROLE_COLOR: Record<Role, string> = {
  input: "var(--color-role-input)",
  config: "var(--color-role-config)",
  templates: "var(--color-role-templates)",
  output: "var(--color-role-output)",
};

function iconFor(path: string, role: Role | null): LucideIcon {
  if (role === "config") return FileCog;
  if (/\.(xlsx|xlsm|xls|csv|tsv)$/i.test(path)) return FileSpreadsheet;
  if (role === "output") return FileOutput;
  return FileText;
}

const nameOf = (path: string) => path.split("/").pop() ?? path;

/** What a step is called where a name is short: its own name, else its type's label. */
export function stepName(step: Step, types: StepTypeDef[]): string {
  return step.name || stepLabel(step.type, types.find((d) => d.type === step.type)?.label);
}

function meta(file: ProjectFile, scenario: Scenario | null, types: StepTypeDef[], role: Role): { text: string; dim: boolean } {
  if (file.inUse) return { text: t.project.inUse, dim: false };
  if (role === "output") return { text: file.modified ? new Date(file.modified).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { dateStyle: "medium", timeStyle: "short" }) : "", dim: false };
  const users = usersOf(scenario, file.path);
  if (users.length === 0) return { text: t.project.unused, dim: true };
  if (users.length === 1) return { text: t.project.usedBy(stepName(users[0]!, types)), dim: false };
  return { text: t.project.usedByMany(users.length), dim: false };
}

type Menu = { x: number; y: number; path: string } | null;

function FileRow({ file, role, onMenu }: { file: ProjectFile; role: Role; onMenu: (m: Menu) => void }) {
  const scenario = useStudio((s) => s.scenario);
  const types = useStudio((s) => s.stepTypes);
  const openFile = useProject((s) => s.openFile);
  const open = useProject((s) => s.sheet?.path === file.path);
  const Icon = iconFor(file.path, role);
  const color = ROLE_COLOR[role];
  const { text, dim } = meta(file, scenario, types, role);
  // Inside the shelf: input/2026/a.xlsx shows as 2026/a.xlsx.
  const shown = file.path.split("/").slice(1).join("/");
  return (
    <button
      type="button"
      onClick={() => void openFile(file.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY, path: file.path });
      }}
      title={file.path}
      className={`flex w-full items-center gap-2 rounded-[4px] px-2 py-1 text-left ${open ? "bg-brand-50" : "hover:bg-slate-100"} ${dim ? "opacity-60" : ""}`}
    >
      <span
        className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[4px]"
        style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
      >
        <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[12.5px] text-ink">{shown}</span>
        <span className={`truncate text-[10.5px] ${file.inUse ? "text-shu-500" : "text-slate-400"}`}>{text}</span>
      </span>
      {file.inUse && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-shu-500 ring-[3px] ring-shu-500/15" title={t.project.inUse} />}
    </button>
  );
}

function Shelf({ role, files, over, onMenu }: { role: Role; files: ProjectFile[]; over: boolean; onMenu: (m: Menu) => void }) {
  const newSettings = useProject((s) => s.newSettings);
  const color = ROLE_COLOR[role];
  return (
    <section
      data-shelf={role}
      className={`rounded-[4px] pb-1 ${over ? "outline-2 outline-dashed" : ""}`}
      style={over ? { outlineColor: color, background: `color-mix(in srgb, ${color} 6%, transparent)` } : undefined}
    >
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] text-slate-400">
        <i className="inline-block h-2 w-2 rounded-[2px]" style={{ background: color }} />
        <b className="font-semibold text-slate-600">{t.project.shelves[role]}</b>
        <span className="ml-auto font-mono text-[10.5px]">{over ? t.project.dropHere(`${role}/`) : `${role}/`}</span>
      </div>
      {files.map((f) => (
        <FileRow key={f.path} file={f} role={role} onMenu={onMenu} />
      ))}
      {files.length === 0 &&
        (role === "config" ? (
          <button
            type="button"
            onClick={() => void newSettings()}
            className="mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-[4px] border border-dashed border-slate-300 px-2 py-1.5 text-[11.5px] text-slate-500 hover:border-brand-500 hover:text-brand-500"
          >
            <FilePlus2 size={14} strokeWidth={1.75} aria-hidden="true" />
            {t.project.newSettings}
          </button>
        ) : (
          <div className="px-2 pb-1 text-[11px] text-slate-400">{t.project.emptyShelf[role]}</div>
        ))}
    </section>
  );
}

function ContextMenu({ menu, onClose }: { menu: NonNullable<Menu>; onClose: () => void }) {
  const p = useProject((s) => s);
  const isFolder = !menu.path.includes("/");
  const item = (label: string, action: () => void, danger = false) => (
    <button
      type="button"
      onClick={() => {
        onClose();
        action();
      }}
      className={`flex h-7 w-full items-center px-3 text-left text-[12.5px] hover:bg-slate-100 ${danger ? "text-shu-500" : "text-ink"}`}
    >
      {label}
    </button>
  );
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div
        className="fixed z-50 w-56 rounded-[4px] border border-slate-200 bg-sheet py-1 shadow-lifted"
        style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 220) }}
      >
        {!isFolder && item(t.project.menu.open, () => void p.openFile(menu.path))}
        {!isFolder && item(t.project.menu.openWithApp, () => void p.open(menu.path))}
        {item(t.project.menu.reveal, () => void p.open(menu.path, true))}
        {item(t.project.menu.copyPath, () => void navigator.clipboard.writeText(menu.path))}
        <div className="my-1 border-t border-slate-100" />
        {!isFolder &&
          item(t.project.menu.rename, () => {
            const name = window.prompt(t.project.renamePrompt, nameOf(menu.path));
            if (name && name !== nameOf(menu.path)) void p.rename(menu.path, `${menu.path.slice(0, menu.path.lastIndexOf("/") + 1)}${name}`);
          })}
        {!isFolder && item(t.project.menu.remove, () => void p.remove(menu.path), true)}
      </div>
    </>
  );
}

/** Reads picked files as base64 for upload_project_file. */
function readAll(list: FileList): Promise<{ name: string; data: string }[]> {
  return Promise.all(
    [...list].map(
      (file) =>
        new Promise<{ name: string; data: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: file.name, data: String(reader.result).replace(/^data:[^,]*,/, "") });
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }),
    ),
  );
}

/** Where a drop from Explorer goes: the shelf under the pointer, or sorted by name. */
function useFileDrop(onOver: (shelf: Role | "panel" | null) => void) {
  const copyIn = useProject((s) => s.copyIn);
  const hasScenario = useProject((s) => s.scenarioId !== null);
  const latest = useRef(onOver);
  latest.current = onOver;
  useEffect(() => {
    if (!hasScenario) return;
    const shelfAt = (x: number, y: number): Role | "panel" | null => {
      const el = document.elementFromPoint(x / devicePixelRatio, y / devicePixelRatio);
      const shelf = el?.closest("[data-shelf]")?.getAttribute("data-shelf");
      if (shelf && (ROLES as string[]).includes(shelf)) return shelf as Role;
      return el?.closest("[data-project-panel]") ? "panel" : null;
    };
    let off: (() => void) | null = null;
    let gone = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const payload = e.payload;
        if (payload.type === "over") latest.current(shelfAt(payload.position.x, payload.position.y) ?? "panel");
        else if (payload.type === "enter") latest.current("panel");
        else if (payload.type === "leave") latest.current(null);
        else if (payload.type === "drop") {
          const shelf = shelfAt(payload.position.x, payload.position.y);
          latest.current(null);
          // Bundles and scenario files are imported from the library, not added here.
          void copyIn(payload.paths, shelf === "panel" ? null : shelf);
        }
      })
      .then((unlisten) => {
        if (gone) unlisten();
        else off = unlisten;
      })
      .catch(() => {
        // Outside Tauri (tests, the browser preview) there is nothing to drop.
      });
    return () => {
      gone = true;
      off?.();
    };
  }, [hasScenario, copyIn]);
}

export function ProjectButton() {
  const setOpen = useProject((s) => s.setPanelOpen);
  const count = useProject((s) => s.files?.files.filter((f) => roleOf(f.path) !== "logs" && roleOf(f.path) !== "work").length ?? 0);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={t.project.toggleTitle}
      className="flex h-8 items-center gap-1.5 rounded-[4px] border border-slate-200 bg-sheet/95 px-2.5 text-[12px] text-slate-600 shadow-raised backdrop-blur hover:text-ink"
    >
      <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
      {t.project.toggle}
      {count > 0 && <span className="text-slate-400">{count}</span>}
    </button>
  );
}

export function ProjectPanel() {
  const files = useProject((s) => s.files);
  const p = useProject((s) => s);
  const keepWork = useStudio((s) => s.scenario?.settings?.keepWork ?? false);
  const [menu, setMenu] = useState<Menu>(null);
  const [over, setOver] = useState<Role | "panel" | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  useFileDrop(setOver);
  useEffect(() => {
    if (!p.notice) return;
    const timer = setTimeout(() => p.dismiss(), 4000);
    return () => clearTimeout(timer);
  }, [p.notice, p]);
  const all = files?.files ?? [];
  const byRole = (role: Role) => all.filter((f) => roleOf(f.path) === role);
  const others = all.filter((f) => roleOf(f.path) === null);
  const work = all.filter((f) => roleOf(f.path) === "work");
  const logs = all.filter((f) => roleOf(f.path) === "logs");
  const latest = latestLog(all);
  const status = latest ? logStatus(latest.path) : null;
  const count = all.length - work.length - logs.length;
  return (
    <aside
      data-project-panel
      aria-label={t.project.title}
      className={`flex h-full w-[264px] flex-col overflow-hidden rounded-[4px] border bg-sheet/95 shadow-raised backdrop-blur ${over ? "border-brand-500" : "border-slate-200"}`}
    >
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-slate-100 pr-1 pl-3">
        <b className="text-[13px] font-semibold text-ink">{t.project.title}</b>
        <span className="text-[11px] text-slate-400">{t.project.files(count)}</span>
        <span className="ml-auto flex items-center">
          <span className="relative">
            <IconButton icon={Plus} title={t.project.add} onClick={() => setAdding(!adding)} />
            {adding && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setAdding(false)} />
                <div className="absolute top-8 right-0 z-50 w-52 rounded-[4px] border border-slate-200 bg-sheet py-1 shadow-lifted">
                  <MenuItem
                    icon={Plus}
                    label={t.project.add}
                    onClick={() => {
                      setAdding(false);
                      picker.current?.click();
                    }}
                  />
                  <MenuItem
                    icon={FilePlus2}
                    label={t.project.newSettings}
                    onClick={() => {
                      setAdding(false);
                      void p.newSettings();
                    }}
                  />
                </div>
              </>
            )}
          </span>
          <IconButton icon={ExternalLink} title={t.project.openFolder} onClick={() => void p.open("", false)} />
          <IconButton icon={PanelLeftClose} title={t.close} onClick={() => p.setPanelOpen(false)} />
        </span>
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const list = e.target.files;
            if (list && list.length > 0) void readAll(list).then((read) => p.upload(read, null));
            e.target.value = "";
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {ROLES.map((role) => (
          <Shelf key={role} role={role} files={byRole(role)} over={over === role} onMenu={setMenu} />
        ))}
        {others.length > 0 && (
          <section className="pb-1">
            <div className="px-2 pt-2 pb-1 text-[11px] font-semibold text-slate-600">…</div>
            {others.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => void p.openFile(f.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, path: f.path });
                }}
                className="flex w-full items-center gap-2 rounded-[4px] px-2 py-1 text-left text-[12px] text-slate-600 hover:bg-slate-100"
              >
                <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="truncate">{f.path}</span>
              </button>
            ))}
          </section>
        )}
      </div>
      {(p.notice || p.error) && (
        <div className={`flex items-start gap-2 border-t px-3 py-2 text-[11.5px] ${p.error ? "border-shu-100 bg-shu-50 text-shu-600" : "border-slate-100 text-brand-500"}`}>
          <span className="min-w-0 flex-1">{p.error ?? p.notice}</span>
          <button type="button" onClick={p.dismiss} title={t.close} className="text-slate-400 hover:text-ink">
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="shrink-0 space-y-1 border-t border-slate-100 px-3 pt-2 pb-2 text-[11.5px] text-slate-600">
        <div className="flex items-center gap-2">
          <Eraser size={14} strokeWidth={1.75} className="text-slate-400" aria-hidden="true" />
          <button type="button" className="hover:underline" onClick={() => void p.open("work", false)}>
            {t.project.work} {work.length}
          </button>
          <span className="ml-auto text-slate-400">{keepWork ? t.project.workKept : t.project.workHint}</span>
          {work.length > 0 && (
            <button type="button" onClick={() => void p.remove("work")} className="rounded-[3px] px-1 text-brand-500 hover:bg-brand-50">
              {t.project.emptyWork}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ScrollText size={14} strokeWidth={1.75} className="text-slate-400" aria-hidden="true" />
          <button type="button" className="hover:underline" onClick={() => latest && void p.openFile(latest.path)} disabled={!latest}>
            {t.project.logs} {logs.length}
          </button>
          {status && <span className={`ml-auto ${status === "failed" ? "text-shu-500" : "text-slate-400"}`}>{t.project.latest[status]}</span>}
        </div>
        <div
          className={`mt-2 flex items-start gap-2 rounded-[4px] border-[1.5px] border-dashed px-2.5 py-2 leading-normal ${over === "panel" ? "border-brand-500 text-brand-500" : "border-slate-200 text-slate-400"}`}
        >
          <Sparkles size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
          <span>{t.project.dropHint}</span>
        </div>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

function IconButton({ icon: Icon, title, onClick }: { icon: LucideIcon; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="grid h-7 w-7 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-100 hover:text-ink"
    >
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

function MenuItem({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12.5px] text-ink hover:bg-slate-100">
      <Icon size={14} strokeWidth={1.75} className="text-slate-500" aria-hidden="true" />
      {label}
    </button>
  );
}
