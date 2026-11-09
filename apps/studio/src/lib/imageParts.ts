// Image parts: a picture cut out of the screen ("画面から切り取る"), kept in
// the flow's templates/ folder and named like any other part. In the file
// it is a desktop part whose target finds a picture:
//
//   "parts": { "saveImage": { "label": "保存ボタン", "app": "desktop",
//     "target": { "window": { "process": "billing.exe" },
//                 "image": { "path": "templates/saveImage.png", "threshold": 0.9 },
//                 "offset": { "x": 0, "y": 0 } } } }
//
// so nothing new is stored, and the runtime and AI clients read it as they
// always have. Studio calls it the 画像 kind.
import type { EditOp, Flow, Part, ProjectFiles, Step, StepTypeDef } from "@spellsheet/schema";
import { partUses } from "./parts";

/** The folder cut-out pictures go to. */
export const IMAGE_FOLDER = "templates";
/** What the runtime uses when the part does not say (target.image.threshold). */
export const DEFAULT_THRESHOLD = 0.9;

export type ImageQuery = { path: string; threshold?: number; nth?: number };
export type Offset = { x: number; y: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The picture an image part looks for, or undefined for any other part. */
export function imageOf(part: Part | undefined | null): ImageQuery | undefined {
  if (!part || part.app !== "desktop" || !isRecord(part.target)) return undefined;
  const image = part.target.image;
  return isRecord(image) && typeof image.path === "string" ? (image as ImageQuery) : undefined;
}

export type PartKind = "browser" | "desktop" | "image";

/** What Studio calls the part: ブラウザ, デスクトップアプリ or 画像. */
export function partKind(part: Part): PartKind {
  return imageOf(part) ? "image" : part.app;
}

/** Whether the node finds its target by a picture too (desktop.mouseClick, waitFor, readText…). */
export function takesImage(def: StepTypeDef | undefined): boolean {
  const target = (def?.paramsSchema as { properties?: Record<string, { properties?: Record<string, unknown> }> } | undefined)?.properties?.target;
  return Boolean(target?.properties?.image);
}

/** Where the part's own picture lives, relative to the flow's folder (`/` separated). */
export function normPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** A key and file for a new image part: image1, image2… whose file is not taken either. */
export function newImagePart(parts: Iterable<string>, files: ProjectFiles | null | undefined): { name: string; path: string } {
  const used = new Set(parts);
  const have = new Set((files?.files ?? []).map((f) => normPath(f.path).toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `image${n}`;
    const path = `${IMAGE_FOLDER}/${name}.png`;
    if (!used.has(name) && !have.has(path.toLowerCase())) return { name, path };
  }
}

/** Whether `path` is inside the flow's folder (relative, not climbing out), so Studio can read and write it. */
export function inProject(path: string): boolean {
  const norm = normPath(path);
  return norm !== "" && !/^[A-Za-z]:|^\/|:\/\//.test(norm) && !norm.split("/").includes("..");
}

/** The file for the picture of the part `name`: templates/<name>.png, or numbered when that is taken. */
export function imagePathFor(name: string, files: ProjectFiles | null | undefined): string {
  const have = new Set((files?.files ?? []).map((f) => normPath(f.path).toLowerCase()));
  for (let n = 1; ; n++) {
    const path = `${IMAGE_FOLDER}/${n === 1 ? name : `${name}${n}`}.png`;
    if (!have.has(path.toLowerCase())) return path;
  }
}

/** The label offered for a new image part: 画像 1, 画像 2… (the next free one). */
export function newImageLabel(parts: Record<string, Part> | undefined, word: string): string {
  const labels = new Set(Object.values(parts ?? {}).map((p) => p.label ?? ""));
  for (let n = 1; ; n++) if (!labels.has(`${word} ${n}`)) return `${word} ${n}`;
}

/**
 * The part for a picture just cut out and the edit that points `step` at it:
 * one batch, so one undo. `window` is the window under the picture.
 */
export function imagePartOps(step: Step | null, name: string, label: string, window: unknown, path: string): EditOp[] {
  const part = {
    app: "desktop",
    ...(label.trim() ? { label: label.trim() } : {}),
    target: { window, image: { path } },
  } as unknown as Part;
  const ops: EditOp[] = [{ op: "setPart", name, part }];
  if (step?.id) ops.push({ op: "updateStep", stepId: step.id, patch: { replaceParams: { ...step.params, target: { part: name } } } });
  return ops;
}

/** The part after a new picture of it was cut out: the same file, the window it was cut from now. */
export function reshot(part: Part, window: unknown): Part {
  const target = isRecord(part.target) ? part.target : {};
  return { ...part, target: { ...target, window } as Part["target"] };
}

/** The part with its picture's settings changed (`undefined` drops one: the default applies). */
export function withImage(part: Part, patch: Partial<ImageQuery>, offset?: Offset | null): Part {
  const target = { ...(isRecord(part.target) ? part.target : {}) } as Record<string, unknown>;
  const image = { ...(isRecord(target.image) ? target.image : {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete image[k];
    else image[k] = v;
  }
  target.image = image;
  if (offset === null || (offset && offset.x === 0 && offset.y === 0)) delete target.offset;
  else if (offset) target.offset = offset;
  return { ...part, target: target as Part["target"] };
}

/** Where on the picture the node acts: the click on a shown picture, as pixels from its centre. */
export function offsetAt(clickX: number, clickY: number, shownWidth: number, shownHeight: number, width: number, height: number): Offset {
  const sx = width / Math.max(1, shownWidth);
  const sy = height / Math.max(1, shownHeight);
  return { x: Math.round(clickX * sx - width / 2), y: Math.round(clickY * sy - height / 2) };
}

/** The parts no node uses. */
export function unusedParts(flow: Flow | null | undefined): string[] {
  if (!flow) return [];
  return Object.keys(flow.parts ?? {}).filter((name) => partUses(flow.steps ?? [], name).length === 0);
}

function* walk(steps: readonly Step[]): Generator<Step> {
  for (const step of steps) {
    yield step;
    for (const children of Object.values(step.blocks ?? {})) yield* walk(children);
  }
}

/**
 * Cleaning up the unused parts: the edits that remove them (one undo), and
 * the pictures of theirs in templates/ that nothing else names (another
 * part, or a node's own target), to delete with them.
 */
export function cleanUp(flow: Flow, names: readonly string[]): { ops: EditOp[]; files: string[] } {
  const gone = new Set(names);
  const ops: EditOp[] = names.map((name) => ({ op: "removePart", name }));
  const kept = Object.entries(flow.parts ?? {})
    .filter(([name]) => !gone.has(name))
    .map(([, p]) => imageOf(p)?.path)
    .filter((p): p is string => Boolean(p))
    .map((p) => normPath(p).toLowerCase());
  const mentioned = [...walk(flow.steps ?? [])].map((s) => normPath(JSON.stringify(s.params ?? {}).replace(/\\\\/g, "/")).toLowerCase());
  const files: string[] = [];
  for (const name of names) {
    const path = imageOf(flow.parts?.[name])?.path;
    if (!path) continue;
    const norm = normPath(path);
    const key = norm.toLowerCase();
    if (!key.startsWith(`${IMAGE_FOLDER}/`) || kept.includes(key) || files.some((f) => f.toLowerCase() === key)) continue;
    if (mentioned.some((m) => m.includes(key))) continue;
    files.push(norm);
  }
  return { ops, files };
}

/** The image parts whose picture is not in the flow's folder (an AI named it; a person cuts it out). */
export function missingImages(flow: Flow, files: ProjectFiles | null | undefined): string[] {
  if (!files) return [];
  const have = new Set(files.files.map((f) => normPath(f.path).toLowerCase()));
  return Object.entries(flow.parts ?? {})
    .filter(([, p]) => {
      const path = imageOf(p)?.path;
      if (!path) return false;
      // A full path is outside the folder: not ours to check.
      if (!inProject(path)) return false;
      return !have.has(normPath(path).toLowerCase());
    })
    .map(([name]) => name);
}

/** The parts a node can use: the same app, and pictures only where the node finds by picture. */
export function partChoices(parts: Record<string, Part> | undefined, app: string, def: StepTypeDef | undefined): [string, Part][] {
  const images = takesImage(def);
  return Object.entries(parts ?? {}).filter(([, p]) => p.app === app && (images || !imageOf(p)));
}

