// Reading the flow's files from cloud storage, or writing them there,
// through the storage's API: for PCs where the sync app (Box Drive and the
// like) is not installed, and for unattended runs.
//
// The flow keeps reading and writing its own folder. For a file it reads,
// a download node (box.download, googledrive.download, onedrive.download)
// puts it in work/ at the start of the run and the nodes that read
// input/受注.xlsx read work/受注.xlsx instead. For what it writes, an upload
// node sends each file under output/ after the last node that writes it.
// Where in the storage is a setting in config/settings.json (a path, an ID
// or a link), so whoever receives the flow
// changes the setting, not the nodes; an oauth.signIn node at the start
// keeps the sign-in ready (it asks a person only the first time).
import type { ConfigFile, ConfigItem, EditOp, Flow, Step, StepTypeDef } from "@spellsheet/schema";
import { CONFIG_FORMAT, parseConfig, walkSteps } from "../project";
import { SETTINGS_PATH } from "./filePlaces";

/** A cloud storage reached through its API, and the custom node that does it. */
export interface CloudService {
  id: "box" | "googledrive" | "onedrive";
  /** The custom node (extension) that holds the download and upload nodes. */
  plugin: string;
  download: string;
  upload: string;
  /** For oauth.signIn. */
  authorizeUrl: string;
  tokenUrl: string;
  /** The access asked for at sign-in, and what else the sign-in page needs (Google's refresh token). */
  scope?: string;
  authorizeParams?: Record<string, string>;
  /** What a person pasted for a file or folder, as the setting keeps it. */
  target: (text: string) => string;
  /** What the OAuth secret must allow: the token URL's and the API's sites, and the extension. */
  sites: string[];
  /** Where people make the app that gives the client ID. */
  console: string;
}

export const BOX: CloudService = {
  id: "box",
  plugin: "box",
  download: "box.download",
  upload: "box.upload",
  authorizeUrl: "https://account.box.com/api/oauth2/authorize",
  tokenUrl: "https://api.box.com/oauth2/token",
  sites: ["https://api.box.com", "plugin:box"],
  console: "https://app.box.com/developers/console",
  target: (text) => boxTarget(text),
};

export const GOOGLE_DRIVE: CloudService = {
  id: "googledrive",
  plugin: "googledrive",
  download: "googledrive.download",
  upload: "googledrive.upload",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/drive",
  // Without these Google gives no refresh token, and the flow would ask for a sign-in every hour.
  authorizeParams: { access_type: "offline", prompt: "consent" },
  sites: ["https://oauth2.googleapis.com", "https://www.googleapis.com", "plugin:googledrive"],
  console: "https://console.cloud.google.com/apis/credentials",
  target: (text) => googleTarget(text),
};

export const ONE_DRIVE: CloudService = {
  id: "onedrive",
  plugin: "onedrive",
  download: "onedrive.download",
  upload: "onedrive.upload",
  // Work and school accounts (OneDrive for Business and SharePoint).
  authorizeUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  scope: "offline_access Files.ReadWrite.All Sites.ReadWrite.All",
  sites: ["https://login.microsoftonline.com", "https://graph.microsoft.com", "plugin:onedrive"],
  console: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  // A link (sharing link, SharePoint address) is kept whole: Graph finds the item from it.
  target: (text) => (/^https?:\/\//i.test(text.trim()) ? text.trim() : pathTarget(text)),
};

export const CLOUD_SERVICES: CloudService[] = [BOX, GOOGLE_DRIVE, ONE_DRIVE];

const pathTarget = (text: string) =>
  text
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

const norm = (path: string) => path.trim().replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * What a person pasted for a Box item: a Box link
 * (https://app.box.com/file/123, …/folder/123) becomes its ID; a path from
 * All Files (経理/受注/受注.xlsx) is kept, with / between names.
 */
export function boxTarget(text: string): string {
  const t = text.trim();
  const link = t.match(/^https?:\/\/[^/]*box\.com\/(?:file|folder)\/(\d+)/i);
  if (link?.[1]) return link[1];
  return pathTarget(t);
}

/**
 * A Google Drive address (https://drive.google.com/file/d/<ID>/view,
 * …/drive/folders/<ID>, docs.google.com/spreadsheets/d/<ID>) becomes its ID;
 * a path from My Drive is kept.
 */
export function googleTarget(text: string): string {
  const t = text.trim();
  const link = t.match(/^https?:\/\/(?:drive|docs)\.google\.com\/.*?(?:\/d\/|\/folders\/|[?&]id=)([A-Za-z0-9_-]{10,})/);
  if (link?.[1]) return link[1];
  return pathTarget(t);
}

/** Where a step sits: the list it is in, and how to name that place in an edit. */
interface Place {
  list: Step[];
  index: number;
  parentId?: string;
  block?: string;
}

function locate(steps: Step[], target: Step, parentId?: string, block?: string): Place | null {
  for (const [index, step] of steps.entries()) {
    if (step === target) return { list: steps, index, parentId, block };
    for (const [name, children] of Object.entries(step.blocks ?? {})) {
      const found = locate(children, target, step.id ?? undefined, name);
      if (found) return found;
    }
  }
  return null;
}

/** The top-level step that holds `target` (itself when it is at the top). */
function topOf(steps: Step[], target: Step): Step | null {
  return steps.find((s) => s === target || [...walkSteps(Object.values(s.blocks ?? {}).flat())].includes(target)) ?? null;
}

/** The control step whose block holds `target`, or null at the top level. */
function parentOf(steps: Step[], target: Step): Step | null {
  for (const step of walkSteps(steps)) {
    if (Object.values(step.blocks ?? {}).some((children) => children.includes(target))) return step;
  }
  return null;
}

/**
 * Blocks whose steps run whenever the block's own step does (every turn of a
 * loop, every branch of a group): an upload may move out of them. Out of an
 * if, a switch or a try it may not: there the file is written only sometimes.
 */
const ALWAYS_RUN = new Set(["control.forEach", "control.repeat", "control.while", "control.group", "control.parallel"]);

/** The top-level path params of a step (texts or lists of texts). */
function pathKeys(step: Step, types: StepTypeDef[]): string[] {
  const def = types.find((t) => t.type === step.type);
  return (def?.pathParams ?? []).filter((k) => !k.includes("."));
}

function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

export interface CloudChange {
  configPath: string;
  configText: string;
  ops: EditOp[];
  /** The setting's name (受注のBox). */
  name: string;
  /** How many nodes now read the downloaded file, or how many files are uploaded. */
  count: number;
}

/**
 * What to change so the flow reads `file` (input/受注.xlsx) from the cloud
 * storage, or (`file` null) sends every file it writes under output/ there.
 * `target` is the Box path or ID of the file (reading) or the folder
 * (writing); `settings` is the current text of config/settings.json.
 */
export function cloudChange(args: {
  flow: Flow;
  types: StepTypeDef[];
  service: CloudService;
  file: string | null;
  target: string;
  /** The OAuth secret the nodes sign in with, and the redirect URL its app has. */
  secret: string;
  redirectUrl: string;
  settings: string | null;
  name: string;
  description: string;
  /** Names for the added nodes, in the screen's language. */
  labels: {
    signIn: string;
    download: (file: string) => string;
    upload: (file: string) => string;
  };
}): CloudChange | null {
  const { flow, types, service, file, target, secret, redirectUrl, name, description, labels } = args;
  const parsed = args.settings === null ? { format: CONFIG_FORMAT, items: [] } : parseConfig(args.settings);
  const configPath = parsed ? SETTINGS_PATH : "config/places.json";
  const config: ConfigFile = parsed ?? { format: CONFIG_FORMAT, items: [] };
  const items = (config.items ?? []).filter((i) => i.name !== "" || (i.value as unknown) !== "");
  const item: ConfigItem = { name, type: "text", value: target as unknown as ConfigItem["value"], description };
  const at = items.findIndex((i) => i.name === name);
  const nextItems = at >= 0 ? items.map((i, j) => (j === at ? item : i)) : [...items, item];

  // Edits are worked out on a copy of the flow, so each insert's index is
  // right after the inserts before it.
  const tree: Step[] = structuredClone(flow.steps ?? []);
  const ops: EditOp[] = [];
  const insert = (step: Step, after: Step | null) => {
    const place = after ? locate(tree, after) : null;
    const list = place?.list ?? tree;
    const index = place ? place.index + 1 : 0;
    list.splice(index, 0, step);
    ops.push({
      op: "addStep",
      step,
      position: {
        ...(place?.parentId ? { parentId: place.parentId, block: place.block } : {}),
        index,
      },
    });
  };

  // The nodes the change is about: the readers of the file, or the writers into output/.
  const same = (v: unknown) => file !== null && typeof v === "string" && norm(v).toLowerCase() === norm(file).toLowerCase();
  const users = [...walkSteps(tree)].filter(
    (step) =>
      step.id &&
      pathKeys(step, types).some((key) => texts(step.params?.[key]).some((v) => (file !== null ? same(v) : norm(v).toLowerCase().startsWith("output/")))),
  );
  if (users.length === 0) return null;
  // Nodes reused for the settings and the sign-in must run before the first of them.
  const firstUse = Math.min(...users.map((u) => tree.indexOf(topOf(tree, u) ?? u)));
  const early = (s: Step) => tree.indexOf(s) < firstUse;

  // The settings, read at the top of the flow.
  let reader =
    tree.find((s) => s.type === "config.read" && typeof s.params?.path === "string" && norm(s.params.path) === configPath && early(s)) ?? null;
  let variable = reader?.saveAs ?? "";
  if (!reader || !variable) {
    const taken = new Set([...(flow.variables ?? []).map((v) => v.name), ...[...walkSteps(tree)].map((s) => s.saveAs ?? "")]);
    variable = "settings";
    for (let n = 2; taken.has(variable); n++) variable = `settings${n}`;
    if (reader?.id) {
      ops.push({
        op: "updateStep",
        stepId: reader.id,
        patch: { saveAs: variable },
      });
      reader.saveAs = variable;
    } else {
      reader = {
        type: "config.read",
        params: { path: configPath },
        saveAs: variable,
      } as Step;
      insert(reader, null);
    }
  }
  const setting = `{{ ${variable}.${name} }}`;

  // The sign-in, after the settings (one at the top is reused).
  let signIn = tree.find((s) => s.type === "oauth.signIn" && s.params?.secret === secret && early(s)) ?? null;
  if (!signIn) {
    signIn = {
      type: "oauth.signIn",
      name: labels.signIn,
      params: {
        secret,
        authorizeUrl: service.authorizeUrl,
        tokenUrl: service.tokenUrl,
        redirectUrl,
        ...(service.scope ? { scope: service.scope } : {}),
        ...(service.authorizeParams ? { authorizeParams: service.authorizeParams } : {}),
      },
    } as Step;
    insert(signIn, reader);
  }
  const ready = tree.indexOf(signIn) > tree.indexOf(reader) ? signIn : reader;
  const account = { secret, field: "accessToken" };

  if (file !== null) {
    const fileName = norm(file).split("/").pop() ?? file;
    // input/east/orders.csv → work/east/orders.csv: two files of the same name stay apart.
    const local = `work/${norm(file).replace(/^input\//i, "")}`;
    let count = 0;
    for (const step of users) {
      if (!step.id) continue;
      const patch: Record<string, unknown> = {};
      for (const key of pathKeys(step, types)) {
        const value = step.params?.[key];
        if (same(value)) patch[key] = local;
        else if (Array.isArray(value) && value.some(same)) patch[key] = value.map((v) => (same(v) ? local : v));
      }
      if (Object.keys(patch).length > 0) {
        count++;
        ops.push({
          op: "updateStep",
          stepId: step.id,
          patch: { params: patch },
        });
      }
    }
    // Downloads already added (another file) stay before this one.
    let after: Step = ready;
    for (const s of tree.slice(tree.indexOf(ready) + 1)) {
      if (s.type === service.download) after = s;
      else break;
    }
    insert(
      {
        type: service.download,
        name: labels.download(fileName),
        params: { account, file: setting, to: local, overwrite: true },
      } as Step,
      after,
    );
    return result(configPath, nextItems, ops, name, count);
  }

  // Writing: each file under output/, after the last node that names it.
  const last = new Map<string, Step>();
  for (const step of users) {
    for (const key of pathKeys(step, types)) {
      for (const v of texts(step.params?.[key])) {
        if (norm(v).toLowerCase().startsWith("output/")) last.set(norm(v), step);
      }
    }
  }
  for (const [path, step] of last) {
    // A literal path is sent once, after the loop holding its last writer
    // (not on every turn), but never out of an if, a switch or a try, where
    // the file is written only sometimes. A path built with {{ }} may use the
    // loop's variables, so it is sent right after that node.
    let anchor = step;
    if (!path.includes("{{")) {
      for (let parent = parentOf(tree, anchor); parent && ALWAYS_RUN.has(parent.type); parent = parentOf(tree, anchor)) anchor = parent;
    }
    const fileName = path.split("/").pop() ?? path;
    insert(
      {
        type: service.upload,
        name: labels.upload(fileName.replace(/\{\{.*?\}\}/g, "…")),
        params: { account, path, folder: setting, overwrite: true },
      } as Step,
      anchor,
    );
  }
  return result(configPath, nextItems, ops, name, last.size);
}

function result(configPath: string, items: ConfigItem[], ops: EditOp[], name: string, count: number): CloudChange {
  return {
    configPath,
    configText: `${JSON.stringify({ format: CONFIG_FORMAT, items }, null, 2)}\n`,
    ops,
    name,
    count,
  };
}
