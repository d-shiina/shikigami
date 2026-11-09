// Fetching the flow's input/ from cloud storage before each run, and
// sending what it writes to output/ after it, through the storage's API: for
// PCs where the sync app (Box Drive and the like) is not installed, and for
// unattended runs.
//
// It is a setting of the flow's folder (config/cloud.json), not nodes: the
// nodes keep reading input/受注.xlsx and writing output/請求書.pdf, and a
// whole run first has the plugin (box.downloadFolder,
// googledrive.downloadFolder, onedrive.downloadFolder) fetch the folder's
// files into input/, then after the last node has it upload each file the run
// wrote to output/. Whoever receives the flow changes only this setting.
// The run signs in first (oauth.signIn), asking a person only the first time.
import type { CloudFile, CloudPlace } from "@spellsheet/schema";

/** A cloud storage reached through its API, and the plugin that does it. */
export interface CloudService {
  id: "box" | "googledrive" | "onedrive";
  /** The plugin (code: extension) that reaches the storage. */
  plugin: string;
  /** Its node that fetches a folder; Writer tells from it whether the plugin is installed. */
  download: string;
  /** For oauth.signIn. */
  authorizeUrl: string;
  tokenUrl: string;
  /** The access asked for at sign-in, and what else the sign-in page needs (Google's refresh token). */
  scope?: string;
  authorizeParams?: Record<string, string>;
  /** What a person pasted for a folder, as the setting keeps it. */
  target: (text: string) => string;
  /** What the OAuth secret must allow: the token URL's and the API's sites, and the extension. */
  sites: string[];
  /** Where people make the app that gives the client ID. */
  console: string;
  /** The plugin comes with Writer, so the dialog can add it there and then; otherwise it is added on the Plugins page. */
  shipped: boolean;
}

export const BOX: CloudService = {
  id: "box",
  plugin: "box",
  download: "box.downloadFolder",
  authorizeUrl: "https://account.box.com/api/oauth2/authorize",
  tokenUrl: "https://api.box.com/oauth2/token",
  sites: ["https://api.box.com", "plugin:box"],
  console: "https://app.box.com/developers/console",
  shipped: false,
  target: (text) => boxTarget(text),
};

export const GOOGLE_DRIVE: CloudService = {
  id: "googledrive",
  plugin: "googledrive",
  download: "googledrive.downloadFolder",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/drive",
  // Without these Google gives no refresh token, and the flow would ask for a sign-in every hour.
  authorizeParams: { access_type: "offline", prompt: "consent" },
  sites: ["https://oauth2.googleapis.com", "https://www.googleapis.com", "plugin:googledrive"],
  console: "https://console.cloud.google.com/apis/credentials",
  target: (text) => googleTarget(text),
  shipped: true,
};

export const ONE_DRIVE: CloudService = {
  id: "onedrive",
  plugin: "onedrive",
  download: "onedrive.downloadFolder",
  // Work and school accounts (OneDrive for Business and SharePoint).
  authorizeUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  scope: "offline_access Files.ReadWrite.All Sites.ReadWrite.All",
  sites: ["https://login.microsoftonline.com", "https://graph.microsoft.com", "plugin:onedrive"],
  console: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  // A link (sharing link, SharePoint address) is kept whole: Graph finds the item from it.
  target: (text) => (/^https?:\/\//i.test(text.trim()) ? text.trim() : pathTarget(text)),
  shipped: true,
};

export const CLOUD_SERVICES: CloudService[] = [BOX, GOOGLE_DRIVE, ONE_DRIVE];

const pathTarget = (text: string) =>
  text
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

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

/** Where the setting is kept in the flow's folder. */
export const CLOUD_PATH = "config/cloud.json";
export const CLOUD_FORMAT = "spellsheet.cloud";

export type CloudSide = "input" | "output";

/** The storage a place names, when Writer knows it. */
export const serviceOf = (place: CloudPlace | null | undefined): CloudService | undefined =>
  place ? CLOUD_SERVICES.find((s) => s.plugin === place.service) : undefined;

/** A place in `service`, as config/cloud.json keeps it. */
export function cloudPlace(
  service: CloudService,
  args: { label: string; secret: string; redirectUrl: string; folder: string; folderName?: string; pattern?: string; files?: string[] },
): CloudPlace {
  const pattern = args.pattern?.trim() ?? "";
  const folderName = args.folderName?.trim() ?? "";
  const files = args.files ?? [];
  return {
    service: service.plugin,
    label: args.label,
    secret: args.secret,
    signIn: signInParams(service, args.redirectUrl),
    folder: args.folder,
    ...(folderName && folderName !== args.folder ? { folderName } : {}),
    ...(files.length > 0 ? { files } : pattern ? { pattern } : {}),
  };
}

/** What the run passes to oauth.signIn besides the secret. */
export const signInParams = (service: CloudService, redirectUrl: string): Record<string, unknown> => ({
  authorizeUrl: service.authorizeUrl,
  tokenUrl: service.tokenUrl,
  redirectUrl,
  ...(service.scope ? { scope: service.scope } : {}),
  ...(service.authorizeParams ? { authorizeParams: service.authorizeParams } : {}),
});

/** The folder for people (経理/受注). */
export const folderNameOf = (place: CloudPlace) => place.folderName || place.folder;

/**
 * The text of config/cloud.json with `side` set to `place` (or removed, for
 * null), keeping the other side; null when neither is left (delete the file).
 */
export function withCloudPlace(current: CloudFile | null | undefined, side: CloudSide, place: CloudPlace | null): string | null {
  const next: CloudFile = { format: CLOUD_FORMAT };
  const input = side === "input" ? place : (current?.input ?? null);
  const output = side === "output" ? place : (current?.output ?? null);
  if (input) next.input = input;
  if (output) next.output = output;
  if (!input && !output) return null;
  return `${JSON.stringify(next, null, 2)}\n`;
}
