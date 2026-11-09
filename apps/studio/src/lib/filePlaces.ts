// Reading the flow's files from somewhere other than its own folder: a file
// server (\\server\share), or a folder synced with cloud storage (Box
// Drive, OneDrive, Google Drive, Dropbox) on the PC.
//
// The place is kept as a folder setting in config/settings.json, never
// written into the nodes, so whoever receives the flow changes one setting
// in the form instead of editing nodes; a synced folder inside the user's
// profile is kept as %USERPROFILE%\…, so it works for everyone. The nodes
// that read input/受注.xlsx (or write under output/) then read
// {{ settings.受注の場所 }}/受注.xlsx.
import type { ConfigFile, ConfigItem, EditOp, Flow, Step, StepTypeDef } from "@spellsheet/schema";
import { CONFIG_FORMAT, parseConfig, walkSteps } from "../project";

export const SETTINGS_PATH = "config/settings.json";

const norm = (path: string) => path.trim().replace(/\\/g, "/").replace(/^\.\//, "");

/** 受注.xlsx → 受注の場所: a setting name that also works as `settings.受注の場所`. */
export function placeName(file: string, suffix: string): string {
  const stem = (norm(file).split("/").pop() ?? file).replace(/\.[^.]+$/, "");
  let name = `${stem}${suffix}`.replace(/[^\p{L}\p{N}_]/gu, "_");
  if (/^\p{N}/u.test(name)) name = `_${name}`;
  return name;
}

/** C:\Users\taro\Box\経理 → %USERPROFILE%\Box\経理, so the setting fits every user. */
export function portable(folder: string, profile: string | null): string {
  const f = folder.replace(/[\\/]+$/, "");
  if (!profile) return f;
  const p = profile.replace(/[\\/]+$/, "");
  const lower = f.toLowerCase().replace(/\//g, "\\");
  const base = p.toLowerCase().replace(/\//g, "\\");
  if (lower === base || lower.startsWith(`${base}\\`)) return `%USERPROFILE%${f.slice(p.length)}`;
  return f;
}

/** Whether a full path is on a file server or in a synced cloud folder, not a drive of this PC alone. */
export function placeKind(path: string): "fileServer" | "cloud" | "local" {
  const p = path.replace(/\//g, "\\");
  if (p.startsWith("\\\\")) return "fileServer";
  const synced = p
    .toLowerCase()
    .split("\\")
    .some((part) => ["box", "dropbox", "google drive", "my drive", "マイドライブ", "共有ドライブ", "shared drives", "icloud drive", "iclouddrive", "onedrive"].includes(part) || part.startsWith("onedrive - "));
  return synced ? "cloud" : "local";
}

/** The top-level path params of a step that hold text (or a list of texts). */
function pathKeys(step: Step, types: StepTypeDef[]): string[] {
  const def = types.find((t) => t.type === step.type);
  return (def?.pathParams ?? []).filter((k) => !k.includes("."));
}

/**
 * `value` with `prefix/` (input/受注.xlsx, output/…) replaced by the
 * setting, or null when it does not start there. For input, only the one
 * file `only` is moved.
 */
function moved(value: string, prefix: "input" | "output", hole: string, only: string | null): string | null {
  const v = norm(value);
  if (only !== null ? v.toLowerCase() !== norm(only).toLowerCase() : !v.toLowerCase().startsWith(`${prefix}/`)) return null;
  return `${hole}/${v.slice(prefix.length + 1)}`;
}

export interface PlaceChange {
  /** The settings file to write (whole), and its text. */
  configPath: string;
  configText: string;
  /** The edits to the flow: a node reading the settings when none does, and the nodes' new paths. */
  ops: EditOp[];
  /** The name of the setting (受注の場所). */
  name: string;
  /** How many nodes now read or write there. */
  steps: number;
}

/**
 * What to change so the flow reads `file` (input/受注.xlsx), or writes
 * everything it puts under output/ (`file` null), in `folder` instead.
 * `settings` is the current text of config/settings.json (null when there
 * is none).
 */
export function placeChange(args: {
  flow: Flow;
  types: StepTypeDef[];
  prefix: "input" | "output";
  file: string | null;
  folder: string;
  settings: string | null;
  /** The setting's name and description, in the screen's language. */
  name: string;
  description: string;
}): PlaceChange | null {
  const { flow, types, prefix, file, folder, name, description } = args;
  // A settings file that is not a form (plain JSON) is left alone: the place goes in a file of its own.
  const parsed = args.settings === null ? { format: CONFIG_FORMAT, items: [] } : parseConfig(args.settings);
  const configPath = parsed ? SETTINGS_PATH : "config/places.json";
  const config: ConfigFile = parsed ?? { format: CONFIG_FORMAT, items: [] };
  const items = (config.items ?? []).filter((i) => i.name !== "" || (i.value as unknown) !== "");
  const item: ConfigItem = { name, type: "folder", value: folder as unknown as ConfigItem["value"], description };
  const at = items.findIndex((i) => i.name === name);
  const nextItems = at >= 0 ? items.map((i, j) => (j === at ? item : i)) : [...items, item];

  const ops: EditOp[] = [];
  const reader = [...walkSteps(flow.steps)].find(
    (s) => s.type === "config.read" && typeof s.params?.path === "string" && norm(s.params.path) === configPath,
  );
  let variable = reader?.saveAs ?? "";
  if (!reader || !variable) {
    const taken = new Set([...(flow.variables ?? []).map((v) => v.name), ...[...walkSteps(flow.steps)].map((s) => s.saveAs ?? "")]);
    variable = "settings";
    for (let n = 2; taken.has(variable); n++) variable = `settings${n}`;
    if (reader?.id) ops.push({ op: "updateStep", stepId: reader.id, patch: { saveAs: variable } });
    else ops.push({ op: "addStep", step: { type: "config.read", params: { path: configPath }, saveAs: variable } as Step, position: { index: 0 } });
  }
  const hole = `{{ ${variable}.${name} }}`;
  let count = 0;
  for (const step of walkSteps(flow.steps)) {
    if (!step.id) continue;
    const patch: Record<string, unknown> = {};
    for (const key of pathKeys(step, types)) {
      const value = step.params?.[key];
      if (typeof value === "string") {
        const next = moved(value, prefix, hole, file);
        if (next !== null) patch[key] = next;
      } else if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((v) => {
          const m = typeof v === "string" ? moved(v, prefix, hole, file) : null;
          if (m !== null) changed = true;
          return m ?? v;
        });
        if (changed) patch[key] = next;
      }
    }
    if (Object.keys(patch).length > 0) {
      count++;
      ops.push({ op: "updateStep", stepId: step.id, patch: { params: patch } });
    }
  }
  if (count === 0) return null;
  return {
    configPath,
    configText: `${JSON.stringify({ format: CONFIG_FORMAT, items: nextItems }, null, 2)}\n`,
    ops,
    name,
    steps: count,
  };
}
