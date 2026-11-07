// What a value can show when the pointer rests on it: a picture (a path to
// an image file, or the picture's own data), the first rows of a table
// (Excel, CSV), the start of a text file, or the whole of a long text cut
// short on screen. Studio reads files through `preview_file`, which takes a
// path in the flow's folder or a full path, and keeps the last few here.
import { invoke } from "@tauri-apps/api/core";

export type FilePreview =
  | { kind: "image"; mime: string; data: string; bytes: number }
  | { kind: "table"; columns: string[]; rows: string[][]; more: boolean; sheet?: string; sheets?: string[] }
  | { kind: "text"; text: string; more: boolean }
  | { kind: "missing" }
  | { kind: "tooLarge"; bytes: number }
  | { kind: "file"; bytes: number }
  | { kind: "unreadable"; message: string };

/** A picture ready to draw: shrunk to fit the popover, with its real size. */
export type Picture = { src: string; width?: number; height?: number };

export type PreviewSource =
  | { kind: "file"; path: string; sheet?: string }
  | { kind: "imageData"; src: string }
  | { kind: "text"; text: string };

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const FILE = /\.(png|jpe?g|gif|webp|bmp|xlsx|xlsm|csv|tsv|txt|md|log|json|xml|html?|ya?ml|ini|toml)$/i;
/** How a picture's base64 starts, by its format. */
const MAGIC: [string, string][] = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
  ["Qk", "image/bmp"],
];
/** Text longer than this (or on several lines) shows whole in the popover. */
export const LONG_TEXT = 40;

export const isImagePath = (path: string) => IMAGE.test(path.trim());

/** A path-looking text naming a file the popover can show: one line, a known extension, no `{{ }}`. */
export function filePath(text: string): string | null {
  const path = text.trim().replace(/^"(.*)"$/, "$1");
  if (!path || path.length > 500 || /[\r\n]/.test(path) || path.includes("{{") || /^https?:/i.test(path)) return null;
  return FILE.test(path) ? path : null;
}

/** A picture's own data in a value: a `data:image/…` URL, or bare base64 of a PNG/JPEG/GIF/WebP/BMP. */
export function imageData(text: string): string | null {
  const value = text.trim();
  if (/^data:image\/[a-z+.-]+;base64,/i.test(value)) return value;
  if (value.length < 64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return null;
  const mime = MAGIC.find(([head]) => value.startsWith(head))?.[1];
  // "Qk" alone is too common a start; a BMP is only taken when long.
  if (!mime || (mime === "image/bmp" && value.length < 200)) return null;
  return `data:${mime};base64,${value.replace(/\s/g, "")}`;
}

/** The file a value names: a path, or a place given by a picture (`{ image: { path } }`) or a file (`{ path }`). */
function pathIn(value: unknown): string | null {
  if (typeof value === "string") return filePath(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const image = record.image;
  const imagePath = image && typeof image === "object" ? (image as Record<string, unknown>).path : undefined;
  if (typeof imagePath === "string") return filePath(imagePath);
  for (const key of ["path", "file"]) {
    const path = record[key];
    if (typeof path === "string") return filePath(path);
  }
  return null;
}

/**
 * What the popover shows for a value, or null when it has nothing more to
 * show than the value itself. `longText` lets a long text show whole.
 */
export function previewSource(value: unknown, options: { longText?: boolean; sheet?: string } = {}): PreviewSource | null {
  if (typeof value === "string") {
    const data = imageData(value);
    if (data) return { kind: "imageData", src: data };
  }
  const path = pathIn(value);
  if (path) return { kind: "file", path, ...(options.sheet ? { sheet: options.sheet } : {}) };
  if (options.longText && typeof value === "string" && (value.length > LONG_TEXT || /\n/.test(value.trim()))) return { kind: "text", text: value };
  return null;
}

/** The file name at the end of a Windows or POSIX path. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// -- reading, with the last few kept ----------------------------------------

type Loaded = { preview: FilePreview; picture?: Picture };
const KEEP = 24;
/** Files change underneath (a run writes output/): a kept preview is read again after this. */
const FRESH_MS = 10_000;
const kept = new Map<string, { at: number; value: Promise<Loaded> }>();

/** Longest side of the drawn picture, in pixels (twice the popover's, for sharp screens). */
const THUMB = 560;

/** The picture shrunk on a canvas so a large screenshot does not stay in memory whole. */
export function shrink(src: string): Promise<Picture> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve({ src });
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      const scale = Math.min(1, THUMB / Math.max(width, height, 1));
      if (scale === 1) return resolve({ src, width, height });
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve({ src, width, height });
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve({ src: canvas.toDataURL("image/png"), width, height });
      } catch {
        resolve({ src, width, height });
      }
    };
    img.onerror = () => resolve({ src });
    img.src = src;
  });
}

export type PreviewReader = (flowId: string | undefined, path: string, sheet?: string) => Promise<FilePreview>;

let reader: PreviewReader = (id, path, sheet) => invoke<FilePreview>("preview_file", { id: id ?? null, path, sheet: sheet ?? null });

/** For tests and the browser harness. */
export function setPreviewReader(read: PreviewReader) {
  reader = read;
  kept.clear();
}

export function loadPreview(flowId: string | undefined, path: string, sheet?: string): Promise<Loaded> {
  const key = `${flowId ?? ""}|${path}|${sheet ?? ""}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) {
    // Most recently used last.
    kept.delete(key);
    kept.set(key, hit);
    return hit.value;
  }
  const value = reader(flowId, path, sheet)
    .catch((e: unknown): FilePreview => ({ kind: "unreadable", message: e instanceof Error ? e.message : String(e) }))
    .then(async (preview): Promise<Loaded> => (preview.kind === "image"
        ? // The shrunk picture is kept, not the file's bytes.
          { preview: { ...preview, data: "" }, picture: await shrink(`data:${preview.mime};base64,${preview.data}`) }
        : { preview }));
  kept.delete(key);
  kept.set(key, { at: Date.now(), value });
  while (kept.size > KEEP) kept.delete(kept.keys().next().value as string);
  return value;
}
