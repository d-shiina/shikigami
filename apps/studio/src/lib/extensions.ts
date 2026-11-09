// What Studio knows about the extensions (node plugins) whose nodes are
// loaded: their palette group and its name, the tag and icon of their nodes,
// the names their manifests give settings and choices, and the kind of
// secret a setting takes. Filled from the step type definitions when they
// load, so the display helpers (paramLabel, groupLabel, appTag…) can stay
// plain functions of a type, as they are for built-in nodes.
import type { PluginCredential, PluginInfo, StepTypeDef } from "@spellsheet/schema";

/** An extension's own palette group: `ext:<name>`. */
export const EXT_GROUP = "ext:";

type Schema = { title?: unknown; properties?: Record<string, Schema>; "x-enumLabels"?: unknown };

const plugins = new Map<string, PluginInfo>();
const titles = new Map<string, Record<string, string>>();
const summaries = new Map<string, string>();
const choices = new Map<string, Record<string, Record<string, string>>>();

const strings = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
};

/** Reads the extensions' parts of `defs` (built-in definitions are skipped). */
export function registerExtensions(defs: readonly StepTypeDef[]) {
  plugins.clear();
  titles.clear();
  choices.clear();
  summaries.clear();
  for (const def of defs) {
    if (!def.plugin) continue;
    if (!plugins.has(def.plugin.name)) plugins.set(def.plugin.name, def.plugin);
    if (def.plugin.summary) summaries.set(def.type, def.plugin.summary);
    const props = (def.paramsSchema as Schema | undefined)?.properties ?? {};
    const named: Record<string, string> = {};
    const listed: Record<string, Record<string, string>> = {};
    for (const [key, prop] of Object.entries(props)) {
      if (typeof prop?.title === "string" && prop.title.trim()) named[key] = prop.title;
      const labels = strings(prop?.["x-enumLabels"]);
      if (labels) listed[key] = labels;
    }
    titles.set(def.type, named);
    choices.set(def.type, listed);
  }
}

/** The extension providing `type`, when an extension does. */
export const extensionOf = (type: string): PluginInfo | undefined => plugins.get(type.split(".")[0] ?? "") ?? undefined;

/** What an extension's node does, for people (its manifest's `summary`). */
export const extensionSummary = (type: string): string | undefined => summaries.get(type);

/** The palette group of an extension. */
export const extensionGroup = (plugin: Pick<PluginInfo, "name">) => `${EXT_GROUP}${plugin.name}`;

/** The extension of a palette group, when it is one. */
export const groupExtension = (group: string): PluginInfo | undefined =>
  group.startsWith(EXT_GROUP) ? plugins.get(group.slice(EXT_GROUP.length)) : undefined;

/** A setting's name from its manifest (`title`). */
export const extensionParamTitle = (type: string, key: string): string | undefined => titles.get(type)?.[key];

/** A choice's name from its manifest (`x-enumLabels`). */
export const extensionChoiceLabel = (type: string, key: string, value: string): string | undefined => choices.get(type)?.[key]?.[value];

/** The secret a setting of an extension's node takes, by kind. */
export function credentialFor(def: Pick<StepTypeDef, "plugin"> | undefined, key: string): PluginCredential | undefined {
  return def?.plugin?.credentials?.find((c) => c.params.includes(key));
}

/** The tag before an extension's node names ("AI-OCR"). */
export const extensionTag = (plugin: PluginInfo): string => plugin.tag || plugin.label || plugin.name;
