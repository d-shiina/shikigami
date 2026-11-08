// A picture opened large: over the whole window, fitted to it at first,
// with 1:1, zooming on the wheel and dragging to look around. One viewer
// for the whole app, opened from anywhere with `openImage` (a hover
// popover closes on the press that opens it, so the viewer cannot live in it).
import { ImageIcon, Minus, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { t } from "../lib/i18n";
import { baseName, isImagePath, loadFullPicture, previewSource, sizeText } from "../lib/preview";

export type ImageToOpen = {
  /** What to draw at once: the picture, or its thumbnail while the whole one loads. */
  src: string;
  title: string;
  /** The picture's real size, when `src` is only its thumbnail. */
  width?: number;
  height?: number;
  bytes?: number;
  /** Reads the whole picture; null keeps `src`. */
  load?: () => Promise<string | null>;
};

const viewer = createStore<{ open: ImageToOpen | null }>(() => ({ open: null }));

export function openImage(image: ImageToOpen) {
  viewer.setState({ open: image });
}

export function closeImage() {
  viewer.setState({ open: null });
}

/**
 * Opens the picture a value holds (a path to an image, or its data) and
 * says whether there was one. `flowId` is the flow whose folder a relative
 * path is in.
 */
export function openImageValue(value: unknown, flowId: string | undefined): boolean {
  const source = previewSource(value);
  if (source?.kind === "imageData") {
    openImage({ src: source.src, title: t.preview.imageData });
    return true;
  }
  if (source?.kind === "file" && isImagePath(source.path)) {
    openImage({ src: "", title: baseName(source.path), load: () => loadFullPicture(flowId, source.path) });
    return true;
  }
  return false;
}

/** Mounted once beside the app; draws the viewer while a picture is open. */
export function ImageViewerHost() {
  const open = useStore(viewer, (s) => s.open);
  if (!open) return null;
  // A new picture starts afresh (fitted, at the centre).
  return <Viewer key={`${open.title}|${open.src.length}|${open.src.slice(-32)}`} image={open} onClose={closeImage} />;
}

const MIN = 0.05;
const MAX = 8;
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

type View = { scale: number; x: number; y: number };

export function Viewer({ image, onClose }: { image: ImageToOpen; onClose: () => void }) {
  const [src, setSrc] = useState(image.src);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(image.width && image.height ? { w: image.width, h: image.height } : null);
  const [view, setView] = useState<View | null>(null);
  const [mode, setMode] = useState<"fit" | "actual" | "free">("fit");
  const stage = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    void image.load?.().then((full) => live && full && setSrc(full));
    return () => {
      live = false;
    };
  }, [image]);

  useEffect(() => {
    // Every key stays in the viewer: the editor under it must not delete or cut the selected nodes.
    const key = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === "Escape") onClose();
      else if (e.key === "0") setMode("fit");
      else if (e.key === "1") setMode("actual");
      else if (e.key === "+" || e.key === "=") zoomBy(1.25);
      else if (e.key === "-") zoomBy(0.8);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  /** The picture at `scale`, centred in the stage. */
  const centred = (scale: number): View | null => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || !natural) return null;
    return { scale, x: (box.width - natural.w * scale) / 2, y: (box.height - natural.h * scale) / 2 };
  };
  const fitScale = () => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || !natural) return 1;
    // A small picture (a part's image) stays at its size; a screen shrinks to fit.
    return Math.min(1, (box.width - 32) / natural.w, (box.height - 32) / natural.h);
  };

  useLayoutEffect(() => {
    if (mode === "fit") setView(centred(fitScale()));
    else if (mode === "actual") setView(centred(1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, natural]);

  useEffect(() => {
    const resize = () => {
      if (mode === "fit") setView(centred(fitScale()));
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  });

  /** Zooms keeping the point under (cx, cy) in place; the stage's centre by default. */
  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    const box = stage.current?.getBoundingClientRect();
    // Before the picture has a place (still loading), there is nothing to zoom; it opens fitted.
    if (!box || !view) return;
    setMode("free");
    setView((v) => {
      if (!v) return v;
      const px = cx ?? box.width / 2;
      const py = cy ?? box.height / 2;
      const scale = clamp(v.scale * factor);
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };

  // React's wheel handler is passive; the page must not scroll or zoom under the viewer.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - box.left, e.clientY - box.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  const percent = view ? Math.round(view.scale * 100) : null;
  const note = [natural ? t.preview.size(natural.w, natural.h) : null, image.bytes ? sizeText(image.bytes) : null].filter(Boolean).join(" · ");
  const seg = (on: boolean) =>
    `h-6 rounded-[5px] px-2 text-[12px] ${on ? "bg-sheet text-ink shadow-sheet" : "text-slate-500 hover:text-ink"}`;

  return createPortal(
    <div
      lang="ja"
      role="dialog"
      aria-modal="true"
      aria-label={image.title}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/60 p-4"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="flex h-full w-full max-w-[1600px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-dialog">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 px-3">
          <ImageIcon size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="min-w-0 truncate text-[13px] font-medium text-ink">{image.title}</span>
          {note && <span className="shrink-0 text-[12px] text-slate-500">{note}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button type="button" title={t.viewer.zoomOut} aria-label={t.viewer.zoomOut} onClick={() => zoomBy(0.8)} className="grid h-6 w-6 place-items-center rounded-[5px] text-slate-500 hover:bg-slate-100 hover:text-ink">
              <Minus size={14} />
            </button>
            <span className="w-11 text-center text-[12px] text-slate-500 tabular-nums" aria-live="polite">
              {percent !== null ? `${percent}%` : ""}
            </span>
            <button type="button" title={t.viewer.zoomIn} aria-label={t.viewer.zoomIn} onClick={() => zoomBy(1.25)} className="grid h-6 w-6 place-items-center rounded-[5px] text-slate-500 hover:bg-slate-100 hover:text-ink">
              <Plus size={14} />
            </button>
            <div className="ml-1 flex items-center rounded-md bg-slate-100 p-0.5">
              <button type="button" title={t.viewer.fitHint} className={seg(mode === "fit")} onClick={() => setMode("fit")}>
                {t.viewer.fit}
              </button>
              <button type="button" title={t.viewer.actualHint} className={seg(mode === "actual")} onClick={() => setMode("actual")}>
                {t.viewer.actual}
              </button>
            </div>
            <button type="button" title={t.viewer.close} aria-label={t.viewer.close} onClick={onClose} className="ml-1 grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink">
              <X size={16} />
            </button>
          </div>
        </div>
        <div
          ref={stage}
          data-testid="image-stage"
          className={`preview-checker relative min-h-0 flex-1 overflow-hidden ${drag.current ? "cursor-grabbing" : "cursor-grab"}`}
          onPointerDown={(e) => {
            if (!view || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            setMode("free");
            setView((v) => (v ? { ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py } : v));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onDoubleClick={() => setMode((m) => (m === "fit" ? "actual" : "fit"))}
        >
          {src && <img
            src={src}
            alt={image.title}
            draggable={false}
            onLoad={(e) => {
              if (!natural) setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
            }}
            style={
              view && natural
                ? {
                    width: natural.w,
                    height: natural.h,
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    // Enlarged, each pixel shows as a square: a captured button can be checked dot by dot.
                    imageRendering: view.scale >= 2 ? "pixelated" : "auto",
                  }
                : { visibility: "hidden" }
            }
            className="absolute top-0 left-0 max-w-none origin-top-left select-none"
          />}
          {!natural && <div className="absolute inset-0 grid place-items-center text-[12px] text-slate-500">{t.preview.loading}</div>}
        </div>
        <div className="flex h-7 shrink-0 items-center border-t border-slate-200 px-3 text-[11px] text-slate-500">{t.viewer.help}</div>
      </div>
    </div>,
    document.body,
  );
}
