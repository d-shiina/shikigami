// The open scenario's folder: its files on role shelves (input, config,
// templates, output), the work and logs folders, and the file open in a
// sheet beside the chart (a settings form, a text file, a run log). Files
// change underneath (a run writes output/, the AI adds input/, Excel saves),
// so the list is re-read whenever the watcher says the folder changed.
import type { ConfigFile, ConfigItem, ProjectFile, ProjectFiles, Scenario, Step } from "@shikigami/schema";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError } from "./lib/api";
import { isErrorPayload } from "@shikigami/schema";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    if (isErrorPayload(e)) throw new ApiError(e);
    throw new ApiError({ code: "IPC_ERROR", message: String(e) });
  }
}

// Kept apart from `api` like `agent`: the scenario store never touches files.
export const projectApi = {
  list: (id: string) => call<ProjectFiles>("project_files", { id }),
  readText: (id: string, path: string) => call<string>("read_project_text", { id, path }),
  writeText: (id: string, path: string, text: string, overwrite: boolean) =>
    call<ProjectFile>("write_project_text", { id, path, text, overwrite }),
  /** `data` is the file's bytes in base64. */
  upload: (id: string, path: string, data: string, overwrite: boolean) =>
    call<ProjectFile>("upload_project_file", { id, path, data, overwrite }),
  /** Files from Explorer (full paths) into `folder`, keeping their names. */
  copyIn: (id: string, folder: string, paths: string[], overwrite: boolean) =>
    call<ProjectFile[]>("copy_into_project", { id, folder, paths, overwrite }),
  rename: (id: string, from: string, to: string) => call<ProjectFile>("rename_project_file", { id, from, to }),
  /** To the workspace's trash; a standard folder (work/) is emptied instead. */
  remove: (id: string, path: string) => call<void>("delete_project_file", { id, path }),
  /** With its app (Excel, Notepad), or selected in Explorer with `reveal`. `""` is the folder. */
  open: (id: string, path: string, reveal: boolean) => call<void>("open_project_file", { id, path, reveal }),
  onChanged: (handler: (scenarioId: string) => void): Promise<UnlistenFn> =>
    listen<{ scenarioId: string }>("project-files-changed", (e) => handler(e.payload.scenarioId)),
};

export type ProjectApi = Omit<typeof projectApi, "onChanged">;

/** The shelves, in the logo's colours: what a file is for decides where it sits. */
export type Role = "input" | "config" | "templates" | "output";
export const ROLES: Role[] = ["input", "config", "templates", "output"];

export function roleOf(path: string): Role | "work" | "logs" | null {
  const top = path.split("/")[0];
  return top === "input" || top === "config" || top === "templates" || top === "output" || top === "work" || top === "logs"
    ? top
    : null;
}

/**
 * Where a dropped or picked file most likely belongs, by its name: settings
 * by format or name, templates by name, everything else is input. The person
 * can move it after.
 */
export function shelfFor(name: string): Role {
  const lower = name.toLowerCase();
  if (/\.(json|ya?ml|toml|ini|env|conf|cfg)$/.test(lower) || /(config|setting|設定)/.test(lower)) return "config";
  if (/\.(xltx|xltm|dotx|dotm)$/.test(lower) || /(template|テンプレ|ひな形|雛形|様式|書式|フォーマット)/.test(lower)) return "templates";
  return "input";
}

export const CONFIG_FORMAT = "shikigami.config";

/** A settings file Studio can show as a form, or null for any other text. */
export function parseConfig(text: string): ConfigFile | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && (value as { format?: unknown }).format === CONFIG_FORMAT) {
      const file = value as ConfigFile;
      return { ...file, items: Array.isArray(file.items) ? file.items : [] };
    }
  } catch {
    // Not JSON: shown as text.
  }
  return null;
}

export function formatConfig(file: ConfigFile): string {
  return `${JSON.stringify({ format: CONFIG_FORMAT, items: file.items ?? [] }, null, 2)}\n`;
}

/** Text Studio opens itself; anything else opens with its app. */
export function isText(path: string): boolean {
  return /\.(json|txt|csv|tsv|log|md|ya?ml|toml|ini|xml|html?|js|ps1|bat|cmd|sql)$/i.test(path);
}

function* walk(steps: Step[] | undefined): Generator<Step> {
  for (const step of steps ?? []) {
    yield step;
    for (const children of Object.values(step.blocks ?? {})) yield* walk(children);
  }
}

const norm = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** The steps whose params mention the file (by its relative path). */
export function usersOf(scenario: Scenario | null, path: string): Step[] {
  if (!scenario) return [];
  const needle = norm(path);
  return [...walk(scenario.steps)].filter((step) => norm(JSON.stringify(step.params ?? {})).includes(needle));
}

/**
 * For a settings file: per item, the steps that use it. A step reads the
 * file with `config.read` saved as some variable (`settings`); a step uses an
 * item when it mentions `settings.<name>` or `settings["<name>"]`.
 */
export function itemUsers(scenario: Scenario | null, path: string, items: ConfigItem[]): Map<string, Step[]> {
  const result = new Map<string, Step[]>(items.map((i) => [i.name, []]));
  if (!scenario) return result;
  const steps = [...walk(scenario.steps)];
  const vars = steps
    .filter((s) => s.type === "config.read" && typeof s.params?.path === "string" && norm(s.params.path) === norm(path) && s.saveAs)
    .map((s) => s.saveAs as string);
  for (const step of steps) {
    if (step.type === "config.read") continue;
    const text = JSON.stringify(step.params ?? {});
    for (const item of items) {
      if (vars.some((v) => text.includes(`${v}.${item.name}`) || text.includes(`${v}[\\"${item.name}\\"]`) || text.includes(`${v}['${item.name}']`)))
        result.get(item.name)?.push(step);
    }
  }
  return result;
}

/** The newest run log, by name (they start with the time). */
export function latestLog(files: ProjectFile[]): ProjectFile | null {
  const logs = files.filter((f) => /^logs\/\d{8}-\d{6}.*\.log$/.test(f.path)).sort((a, b) => b.path.localeCompare(a.path));
  return logs[0] ?? null;
}

export function logStatus(path: string): "succeeded" | "failed" | "cancelled" | "running" | null {
  const m = /_(succeeded|failed|cancelled|running)\.log$/.exec(path);
  return (m?.[1] as "succeeded" | "failed" | "cancelled" | "running" | undefined) ?? null;
}

export type Sheet = { path: string; text: string; saved: string; config: ConfigFile | null; raw: boolean } | null;

export type ProjectState = {
  scenarioId: string | null;
  files: ProjectFiles | null;
  panelOpen: boolean;
  sheet: Sheet;
  error: string | null;
  /** Shown for a moment after an action (added 2 files to input/…). */
  notice: string | null;
  setPanelOpen(open: boolean): void;
  /** Follows the open scenario; null clears. */
  load(id: string | null): Promise<void>;
  onChanged(id: string): Promise<void>;
  openFile(path: string): Promise<void>;
  closeSheet(): void;
  /** Edits the sheet's text (or form); saved with `saveSheet`. */
  editSheet(text: string): void;
  editConfig(config: ConfigFile): void;
  setRaw(raw: boolean): void;
  saveSheet(): Promise<boolean>;
  newSettings(): Promise<void>;
  /** Files from Explorer; `folder` null sorts each onto its shelf. */
  copyIn(paths: string[], folder: Role | null): Promise<void>;
  upload(files: { name: string; data: string }[], folder: Role | null): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  open(path: string, reveal?: boolean): Promise<void>;
  dismiss(): void;
};

const PANEL_KEY = "shikigami.studio.project";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function createProjectStore(api: ProjectApi, labels: { added: (n: number, folder: string) => string; discard: () => string }): StoreApi<ProjectState> {
  let panelOpen = true;
  try {
    panelOpen = globalThis.localStorage?.getItem(PANEL_KEY) !== "closed";
  } catch {
    // Only a remembered preference.
  }
  return createStore<ProjectState>()((set, get) => {
    const refresh = async () => {
      const id = get().scenarioId;
      if (!id) return;
      try {
        const files = await api.list(id);
        if (get().scenarioId === id) set({ files });
      } catch (e) {
        set({ error: message(e) });
      }
    };
    const report = (count: number, folder: string) => set({ notice: labels.added(count, folder) });
    return {
      scenarioId: null,
      files: null,
      panelOpen,
      sheet: null,
      error: null,
      notice: null,
      setPanelOpen(open) {
        set({ panelOpen: open });
        try {
          globalThis.localStorage?.setItem(PANEL_KEY, open ? "open" : "closed");
        } catch {
          // Only a remembered preference.
        }
      },
      async load(id) {
        if (id === get().scenarioId) return;
        set({ scenarioId: id, files: null, sheet: null, error: null, notice: null });
        await refresh();
      },
      async onChanged(id) {
        if (id !== get().scenarioId) return;
        await refresh();
        // An unedited sheet follows the file (a run rewrote the log, the AI changed a setting).
        const sheet = get().sheet;
        if (sheet && sheet.text === sheet.saved) {
          try {
            const text = await api.readText(id, sheet.path);
            if (get().sheet?.path === sheet.path && get().sheet?.text === sheet.saved)
              set({ sheet: { ...sheet, text, saved: text, config: parseConfig(text) } });
          } catch {
            // Removed or replaced by something that is not text: keep what is shown.
          }
        }
      },
      async openFile(path) {
        const id = get().scenarioId;
        if (!id) return;
        if (!isText(path)) {
          await get().open(path);
          return;
        }
        // Unsaved edits are not dropped by opening a file over them.
        const sheet = get().sheet;
        if (sheet && sheet.text !== sheet.saved) {
          if (sheet.path === path || !(globalThis.confirm?.(labels.discard()) ?? true)) return;
        }
        try {
          const text = await api.readText(id, path);
          set({ sheet: { path, text, saved: text, config: parseConfig(text), raw: false }, error: null });
        } catch (e) {
          // Too large or not text after all: its app shows it.
          if (e instanceof ApiError && (e.code === "PROJECT_FILE_NOT_TEXT" || e.code === "PROJECT_FILE_TOO_LARGE")) await get().open(path);
          else set({ error: message(e) });
        }
      },
      closeSheet() {
        set({ sheet: null });
      },
      editSheet(text) {
        const sheet = get().sheet;
        if (sheet) set({ sheet: { ...sheet, text, config: sheet.raw ? sheet.config : parseConfig(text) } });
      },
      editConfig(config) {
        const sheet = get().sheet;
        if (sheet) set({ sheet: { ...sheet, config, text: formatConfig(config) } });
      },
      setRaw(raw) {
        const sheet = get().sheet;
        if (!sheet) return;
        // Back to the form only from JSON that still reads as a settings file.
        set({ sheet: { ...sheet, raw, config: raw ? sheet.config : parseConfig(sheet.text) } });
      },
      async saveSheet() {
        const id = get().scenarioId;
        const sheet = get().sheet;
        if (!id || !sheet) return false;
        try {
          await api.writeText(id, sheet.path, sheet.text, true);
          if (get().sheet?.path === sheet.path) set({ sheet: { ...get().sheet!, saved: sheet.text } });
          await refresh();
          return true;
        } catch (e) {
          set({ error: message(e) });
          return false;
        }
      },
      async newSettings() {
        const id = get().scenarioId;
        if (!id) return;
        const taken = new Set(get().files?.files.map((f) => f.path) ?? []);
        let path = "config/settings.json";
        for (let n = 2; taken.has(path); n++) path = `config/settings-${n}.json`;
        const text = formatConfig({ format: CONFIG_FORMAT, items: [] });
        try {
          await api.writeText(id, path, text, false);
          await refresh();
          set({ sheet: { path, text, saved: text, config: parseConfig(text), raw: false } });
        } catch (e) {
          set({ error: message(e) });
        }
      },
      async copyIn(paths, folder) {
        const id = get().scenarioId;
        if (!id || paths.length === 0) return;
        const groups = new Map<Role, string[]>();
        for (const p of paths) {
          const shelf = folder ?? shelfFor(nameOf(p));
          groups.set(shelf, [...(groups.get(shelf) ?? []), p]);
        }
        try {
          let count = 0;
          for (const [shelf, list] of groups) count += (await api.copyIn(id, shelf, list, false)).length;
          report(count, [...groups.keys()].map((g) => `${g}/`).join("・"));
          await refresh();
        } catch (e) {
          set({ error: message(e) });
          await refresh();
        }
      },
      async upload(files, folder) {
        const id = get().scenarioId;
        if (!id || files.length === 0) return;
        const shelves = new Set<Role>();
        try {
          for (const f of files) {
            const shelf = folder ?? shelfFor(f.name);
            shelves.add(shelf);
            await api.upload(id, `${shelf}/${f.name}`, f.data, false);
          }
          report(files.length, [...shelves].map((g) => `${g}/`).join("・"));
        } catch (e) {
          set({ error: message(e) });
        }
        await refresh();
      },
      async rename(from, to) {
        const id = get().scenarioId;
        if (!id || from === to) return;
        try {
          await api.rename(id, from, to);
          if (get().sheet?.path === from) set({ sheet: { ...get().sheet!, path: to } });
        } catch (e) {
          set({ error: message(e) });
        }
        await refresh();
      },
      async remove(path) {
        const id = get().scenarioId;
        if (!id) return;
        try {
          await api.remove(id, path);
          if (get().sheet?.path === path) set({ sheet: null });
        } catch (e) {
          set({ error: message(e) });
        }
        await refresh();
      },
      async open(path, reveal = false) {
        const id = get().scenarioId;
        if (!id) return;
        try {
          await api.open(id, path, reveal);
        } catch (e) {
          set({ error: message(e) });
        }
      },
      dismiss() {
        set({ error: null, notice: null });
      },
    };
  });
}

export const ProjectContext = createContext<StoreApi<ProjectState> | null>(null);

export function useProject<T>(selector: (state: ProjectState) => T): T {
  const store = useContext(ProjectContext);
  if (!store) throw new Error("ProjectContext is missing");
  return useStore(store, selector);
}

/** Like useProject, but null outside a provider (tests, the review desk's previews). */
export function useProjectMaybe<T>(selector: (state: ProjectState) => T, fallback: T): T {
  const store = useContext(ProjectContext);
  return useStore(store ?? EMPTY, store ? selector : () => fallback);
}

const EMPTY = createStore<ProjectState>()(() => ({}) as ProjectState);
