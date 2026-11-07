// Image parts in Studio: "画面から切り取る" (the screen dims, the user drags
// a rectangle), the picture kept in templates/, and its settings (一致率,
// クリック位置, 探す範囲). See lib/imageParts.ts for what is stored.
import type { Part, Step } from "@shikigami/schema";
import { Crosshair, RotateCcw, Scissors } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStudio } from "../../context";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import {
  DEFAULT_THRESHOLD,
  imageOf,
  imagePartOps,
  newImageLabel,
  newImagePart,
  normPath,
  offsetAt,
  reshot,
  withImage,
  type Offset,
} from "../../lib/imageParts";
import { projectApi, useProjectMaybe } from "../../project";
import { inputClass } from "./fields";

/** What a cut gives: the window under the picture and the picture (PNG, base64). */
export type Cut = { window: unknown; png: string; width: number; height: number; title?: string };

/** Lets the user cut a picture out of the screen; null when they cancel. */
export async function snipScreen(): Promise<Cut | null> {
  const result = await api.pointAt("desktop", { action: "snip", message: t.parts.snipBanner });
  if (result.cancelled || typeof result.png !== "string") return null;
  const target = (result.target ?? {}) as { window?: unknown };
  const window = (result.window ?? {}) as { title?: string };
  return { window: target.window, png: result.png, width: Number(result.width ?? 0), height: Number(result.height ?? 0), title: window.title };
}

/** Bumped after Studio writes a picture, so every view of it reads it again. */
let written = 0;
const listeners = new Set<() => void>();
function pictureWritten() {
  written += 1;
  for (const l of listeners) l();
}

/** The picture at `path` of the open flow's folder as a data URL (null: not there; undefined: loading). */
export function useProjectImage(path: string | undefined): string | null | undefined {
  const flowId = useStudio((s) => s.flow?.id);
  // The folder's listing changes when the file does (the watcher re-reads it).
  const stamp = useProjectMaybe((s) => {
    const want = path ? normPath(path).toLowerCase() : "";
    const file = s.files?.files.find((f) => normPath(f.path).toLowerCase() === want);
    return file ? `${file.size}:${file.modified ?? ""}` : "none";
  }, "none");
  const [version, setVersion] = useState(written);
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const listener = () => setVersion(written);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  useEffect(() => {
    if (!flowId || !path) {
      setUrl(null);
      return;
    }
    let live = true;
    projectApi
      .readImage(flowId, normPath(path))
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [flowId, path, stamp, version]);
  return url;
}

/** Writes a cut picture into the flow's folder. */
export async function savePicture(flowId: string, path: string, cut: Cut): Promise<void> {
  await projectApi.upload(flowId, normPath(path), cut.png, true);
  pictureWritten();
}

/** The "画面から切り取る" button. */
export function SnipButton({ onCut, large = false, label = t.parts.snip, title = t.parts.snipTitle }: { onCut: (cut: Cut) => void | Promise<void>; large?: boolean; label?: string; title?: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const cut = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await snipScreen();
      if (!result) setNote({ text: t.parts.snipCancelled });
      else await onCut(result);
    } catch (e) {
      setNote({ text: t.parts.snipFailed(e instanceof Error ? e.message : String(e)), warn: true });
    } finally {
      setBusy(false);
    }
  };
  const button = large
    ? "inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-paper px-3 text-[13px] text-ink hover:bg-slate-100 disabled:opacity-50"
    : "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-brand-700 hover:bg-brand-50 disabled:opacity-50";
  return (
    <>
      <button type="button" className={button} title={title} disabled={busy} onClick={() => void cut()}>
        {large && label === t.parts.reshoot ? <RotateCcw size={13} strokeWidth={1.75} /> : <Scissors size={13} strokeWidth={1.75} />}
        {label}
      </button>
      {note && (
        <span role="status" className={`basis-full pt-0.5 text-[11px] ${note.warn ? "text-shu-600" : "text-slate-600"}`}>
          {note.text}
        </span>
      )}
    </>
  );
}

/**
 * A picture on a checkerboard, as large as it fits. With `onPoint`, a click
 * on it chooses where the node acts (the cross).
 */
export function Picture({
  src,
  width,
  height,
  offset,
  onPoint,
  maxHeight = 160,
  alt,
}: {
  src: string | null | undefined;
  width?: number;
  height?: number;
  offset?: Offset;
  onPoint?: (offset: Offset) => void;
  maxHeight?: number;
  alt: string;
}) {
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(width && height ? { w: width, h: height } : null);
  if (src === undefined) return <div className="h-12 animate-pulse rounded-md bg-slate-100" />;
  if (src === null)
    return (
      <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">
        {t.parts.imageMissing}
      </p>
    );
  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  // The cross, in % of the shown picture (it may sit outside: an offset can reach past the picture).
  const cross = offset && w && h ? { left: ((w / 2 + offset.x) / w) * 100, top: ((h / 2 + offset.y) / h) * 100 } : null;
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        className="relative inline-block max-w-full rounded-md border border-slate-200 p-1"
        style={{ backgroundImage: "repeating-conic-gradient(var(--color-slate-100) 0 25%, transparent 0 50%)", backgroundSize: "12px 12px" }}
      >
        <img
          ref={img}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className={`block max-w-full object-contain [image-rendering:pixelated] ${onPoint ? "cursor-crosshair" : ""}`}
          // Small pictures (a button) shown twice their size, pixel for pixel.
          style={{ maxHeight, height: size ? Math.min(maxHeight, size.h * 2) : undefined }}
          onClick={(e) => {
            if (!onPoint || !w || !h) return;
            const r = e.currentTarget.getBoundingClientRect();
            onPoint(offsetAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height, w, h));
          }}
        />
        {cross && cross.left >= 0 && cross.left <= 100 && cross.top >= 0 && cross.top <= 100 && (
          <Crosshair
            size={18}
            strokeWidth={2.25}
            aria-hidden="true"
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-shu-500 drop-shadow-[0_0_1px_white]"
            style={{ left: `calc(4px + (100% - 8px) * ${cross.left / 100})`, top: `calc(4px + (100% - 8px) * ${cross.top / 100})` }}
          />
        )}
      </div>
      {w > 0 && <span className="text-[11px] text-slate-500">{t.parts.imageSize(w, h)}</span>}
    </div>
  );
}

/**
 * After a cut on a node: the picture, a name for it, and 作成, which keeps the
 * picture in templates/ and points the node at the new image part.
 */
export function NewImagePart({ cut, step, onDone }: { cut: Cut; step: Step; onDone: (made: string | null) => void }) {
  const flow = useStudio((s) => s.flow);
  const applyOps = useStudio((s) => s.applyOps);
  const files = useProjectMaybe((s) => s.files, null);
  const [label, setLabel] = useState(() => newImageLabel(flow?.parts, t.parts.imageWord));
  const [error, setError] = useState<string | null>(null);
  const src = `data:image/png;base64,${cut.png}`;
  const create = async () => {
    if (!flow) return;
    const { name, path } = newImagePart(Object.keys(flow.parts ?? {}), files);
    try {
      await savePicture(flow.id, path, cut);
    } catch (e) {
      setError(t.parts.snipFailed(e instanceof Error ? e.message : String(e)));
      return;
    }
    const final = label.trim() || name;
    if (await applyOps(imagePartOps(step, name, final, cut.window, path))) onDone(final);
  };
  return (
    <div className="mt-1 space-y-2 rounded-lg border border-slate-200 bg-paper p-2.5" role="group" aria-label={t.parts.imageNew}>
      <div className="text-[12px] font-medium text-ink">{t.parts.imageNew}</div>
      <Picture src={src} width={cut.width} height={cut.height} alt={label} maxHeight={120} />
      <p className="text-[11px] text-slate-500">{t.parts.imageNewHint}</p>
      <div className="flex items-center gap-1">
        <input
          autoFocus
          className={inputClass}
          aria-label={t.parts.label}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
            if (e.key === "Escape") onDone(null);
          }}
        />
        <button type="button" className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-on-primary hover:bg-primary-hover" onClick={() => void create()}>
          {t.parts.create}
        </button>
        <button type="button" className="shrink-0 rounded-md px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100" onClick={() => onDone(null)}>
          {t.cancel}
        </button>
      </div>
      {error && <p className="text-[11px] text-shu-600">{error}</p>}
    </div>
  );
}

/** 一致率: a slider from 50% to 100%, empty meaning the default. */
export function ThresholdField({ value, onChange }: { value: number | undefined; onChange: (value: number | undefined) => void }) {
  const [draft, setDraft] = useState(value ?? DEFAULT_THRESHOLD);
  useEffect(() => setDraft(value ?? DEFAULT_THRESHOLD), [value]);
  const commit = () => {
    const v = Math.round(draft * 100) / 100;
    const next = v === DEFAULT_THRESHOLD ? undefined : v;
    if (next !== value) onChange(next);
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0.5}
        max={1}
        step={0.01}
        value={draft}
        aria-label={t.parts.threshold}
        className="h-1 min-w-0 flex-1 accent-[var(--color-primary)]"
        onChange={(e) => setDraft(Number(e.target.value))}
        onMouseUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        onTouchEnd={commit}
      />
      <span className="w-20 shrink-0 text-right text-[12px] tabular-nums text-ink">
        {Math.round(draft * 100)}%
        {value === undefined && <span className="ml-1 text-[11px] text-slate-500">{t.parts.thresholdDefault}</span>}
      </span>
    </div>
  );
}

/** The screen of an image part (inside the part's edit dialog). */
export function ImagePartEditor({ name, part, set, scopeFields }: { name: string; part: Part; set: (part: Part) => void; scopeFields: React.ReactNode }) {
  const flow = useStudio((s) => s.flow);
  const image = imageOf(part);
  const src = useProjectImage(image?.path);
  const [note, setNote] = useState<string | null>(null);
  if (!image) return null;
  const target = (part.target ?? {}) as Record<string, unknown>;
  const offset = (target.offset as Offset | undefined) ?? { x: 0, y: 0 };
  const retake = async (cut: Cut) => {
    if (!flow) return;
    await savePicture(flow.id, image.path, cut);
    set(reshot(part, cut.window));
    setNote(t.parts.reshot);
  };
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <Picture
          src={src}
          offset={offset}
          alt={part.label || name}
          maxHeight={200}
          onPoint={(o) => set(withImage(part, {}, o))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SnipButton large label={src === null ? t.parts.snip : t.parts.reshoot} title={t.parts.reshootTitle} onCut={retake} />
        </div>
        {note && (
          <p role="status" className="text-[11px] text-slate-600">
            {note}
          </p>
        )}
      </section>
      <section>
        <h3 className="text-[12px] font-semibold text-slate-700">{t.parts.offset}</h3>
        <p className="mb-1.5 text-[11px] text-slate-500">{t.parts.offsetHint}</p>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-ink">{offset.x === 0 && offset.y === 0 ? t.parts.offsetCenter : t.parts.offsetValue(offset.x, offset.y)}</span>
          {(offset.x !== 0 || offset.y !== 0) && (
            <button type="button" className="rounded-md px-1.5 py-0.5 text-[11px] text-brand-700 hover:bg-brand-50" onClick={() => set(withImage(part, {}, null))}>
              {t.parts.offsetCenter}
            </button>
          )}
        </div>
      </section>
      <section>
        <h3 className="text-[12px] font-semibold text-slate-700">{t.parts.threshold}</h3>
        <p className="mb-1.5 text-[11px] text-slate-500">{t.parts.thresholdHint}</p>
        <ThresholdField value={image.threshold} onChange={(v) => set(withImage(part, { threshold: v }))} />
      </section>
      <section>
        <h3 className="text-[12px] font-semibold text-slate-700">{t.parts.scope}</h3>
        <p className="mb-1.5 text-[11px] text-slate-500">{t.parts.scopeHint}</p>
        {scopeFields}
      </section>
    </div>
  );
}
