// What a file dropped into Studio becomes: the path a file setting keeps
// (relative to the flow's folder whenever it is inside it), and the node a
// file dropped on the chart is read with.
import type { StepTypeDef } from "@shikigami/schema";

/** Forward slashes, so `C:\a\b` and `C:/a/b` compare alike. */
const norm = (p: string) => p.replace(/\\/g, "/");

/** `input/a.xlsx` for a file inside the flow's folder `dir`, else null. */
export function insideFolder(dir: string | null | undefined, path: string): string | null {
  if (!dir) return null;
  const base = norm(dir).replace(/\/+$/, "");
  const full = norm(path);
  return full.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? full.slice(base.length + 1) : null;
}

/** What a folder setting keeps when a file is dropped on it: the folder the file is in. */
export function folderOf(path: string): string {
  const p = norm(path);
  const at = p.lastIndexOf("/");
  return at <= 0 ? p : p.slice(0, at);
}

/** The node that reads a file, by where it sits and what it is; the setting that names it. */
const READERS: { test: (path: string) => boolean; type: string; param: string; extra?: Record<string, unknown> }[] = [
  { test: (p) => /^config\/.+\.json$/i.test(p), type: "config.read", param: "path" },
  { test: (p) => /^templates\/.+\.docx$/i.test(p), type: "word.fillTemplate", param: "template" },
  { test: (p) => /\.(xlsx|xlsm|xls)$/i.test(p), type: "excel.readRows", param: "path" },
  { test: (p) => /\.tsv$/i.test(p), type: "file.readCsv", param: "path", extra: { delimiter: "\t" } },
  { test: (p) => /\.csv$/i.test(p), type: "file.readCsv", param: "path" },
  { test: (p) => /\.pdf$/i.test(p), type: "pdf.readText", param: "path" },
  { test: (p) => /\.docx$/i.test(p), type: "word.readText", param: "path" },
  { test: (p) => /\.(txt|md|log|json|xml|html?)$/i.test(p), type: "file.readText", param: "path" },
];

/**
 * The node a file dropped on the chart becomes (`input/受注.xlsx` → 「Excel を読む」
 * with that file), or null when no node reads it or the node is not installed.
 */
export function nodeForFile(path: string, types: StepTypeDef[]): { type: string; params: Record<string, unknown> } | null {
  const p = norm(path);
  const reader = READERS.find((r) => r.test(p) && types.some((d) => d.type === r.type));
  return reader ? { type: reader.type, params: { [reader.param]: p, ...reader.extra } } : null;
}

/** What a dragged file is called on the chip under the pointer. */
export const fileName = (path: string) => norm(path).split("/").pop() ?? path;
