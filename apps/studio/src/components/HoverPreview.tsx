// The popover that shows what a value holds when the pointer rests on it
// for a moment: a picture's thumbnail, the first rows of an Excel sheet or
// CSV, the start of a text file, or a long text whole. Wraps the value as it
// is drawn; nothing changes for values with nothing more to show.
import { FileText, ImageIcon, Sheet, TriangleAlert } from "lucide-react";
import { type HTMLAttributes, type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { StudioContext } from "../context";
import { t } from "../lib/i18n";
import { baseName, type FilePreview, isImagePath, loadFullPicture, loadPreview, type Picture, type PreviewSource, previewSource, shrink, sizeText } from "../lib/preview";
import type { StudioState } from "../store";
import { openImage } from "./ImageViewer";

/** How long the pointer rests before the popover opens. */
export const HOVER_DELAY = 300;

const NO_STUDIO = createStore<Pick<StudioState, "flow">>(() => ({ flow: null }));

/** The open flow, whose folder relative paths are in; none outside Studio's main window. */
function useFlowId(): string | undefined {
  const store: StoreApi<Pick<StudioState, "flow">> = useContext(StudioContext) ?? NO_STUDIO;
  return useStore(store, (s) => s.flow?.id);
}

type State = { loading: true } | { loading: false; preview?: FilePreview; picture?: Picture };

function useLoaded(source: PreviewSource, flowId: string | undefined): State {
  const [state, setState] = useState<State>({ loading: true });
  const key = source.kind === "file" ? `${flowId}|${source.path}|${source.sheet ?? ""}` : source.kind === "imageData" ? source.src : "";
  useEffect(() => {
    let live = true;
    if (source.kind === "file") {
      setState({ loading: true });
      void loadPreview(flowId, source.path, source.sheet).then((loaded) => live && setState({ loading: false, ...loaded }));
    } else if (source.kind === "imageData") {
      setState({ loading: true });
      void shrink(source.src).then((picture) => live && setState({ loading: false, picture }));
    } else setState({ loading: false });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function Head({ icon, name, note, tone }: { icon: ReactNode; name: string; note?: string; tone?: "error" }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
      <span className={`shrink-0 ${tone === "error" ? "text-shu-500" : "text-slate-400"}`}>{icon}</span>
      <span className="min-w-0 truncate font-medium text-ink">{name}</span>
      {note && <span className={`ml-auto shrink-0 pl-2 ${tone === "error" ? "text-shu-600" : "text-slate-400"}`}>{note}</span>}
    </div>
  );
}

/**
 * Where a picture is drawn: in a popover (large enough to read a screen's
 * text, within the window), or across a panel such as the node's result.
 */
export type PictureSize = "popover" | "panel";

const PICTURE_BOX: Record<PictureSize, string> = {
  popover: "max-h-[min(400px,50vh)] max-w-[min(560px,calc(100vw-64px))]",
  panel: "max-h-[360px] max-w-full",
};

/** A picture, opened large in the viewer when pressed. */
function PictureView({ picture, alt, size, bytes, load }: { picture: Picture; alt: string; size: PictureSize; bytes?: number; load?: () => Promise<string | null> }) {
  return (
    <div className="mt-1.5">
      <button
        type="button"
        title={t.preview.enlarge}
        onClick={(e) => {
          e.stopPropagation();
          openImage({ src: picture.src, title: alt, width: picture.width, height: picture.height, bytes, load });
        }}
        className={`preview-checker flex cursor-zoom-in items-center justify-center overflow-hidden rounded-md border border-slate-200 hover:border-brand-500 ${size === "panel" ? "w-full" : ""}`}
      >
        <img src={picture.src} alt={alt} className={`block object-contain ${PICTURE_BOX[size]}`} draggable={false} />
      </button>
      <div className="mt-0.5 text-right text-[10.5px] text-slate-500">{t.preview.enlarge}</div>
    </div>
  );
}

function TableView({ preview }: { preview: Extract<FilePreview, { kind: "table" }> }) {
  return (
    <div className="mt-1.5 max-w-[440px] overflow-hidden rounded-md border border-slate-200">
      <table className="w-full border-collapse text-[11px]">
        {preview.columns.length > 0 && (
          <thead className="bg-slate-50 text-left text-[10.5px] text-slate-500">
            <tr>
              {preview.columns.map((c, i) => (
                <th key={i} className="max-w-[120px] truncate border-b border-slate-200 px-1.5 py-0.5 font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {preview.rows.map((row, r) => (
            <tr key={r} className="border-b border-slate-100 last:border-0">
              {row.map((cell, c) => (
                <td key={c} className={`max-w-[120px] truncate px-1.5 py-0.5 ${/^-?[\d,.]+$/.test(cell) ? "text-right tabular-nums" : ""}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TextBlock = ({ text, more }: { text: string; more?: boolean }) => (
  // Scrolls: the popover stays open while the pointer is on it, so a long text can be read to the end.
  <div className="mt-1.5 max-h-[min(60vh,420px)] max-w-[420px] overflow-y-auto overscroll-contain rounded-md border border-slate-100 bg-paper px-2 py-1 font-mono text-[11px] leading-[1.55] break-all whitespace-pre-wrap text-ink">
    {text}
    {more && <div className="mt-0.5 font-sans text-[10px] text-slate-400">{t.preview.moreText}</div>}
  </div>
);

/** What a value shows in its popover (also drawn inside other popovers, such as a variable's values). */
export function PreviewBody({ source, head = true, flowId: given, size = "popover" }: { source: PreviewSource; head?: boolean; flowId?: string; size?: PictureSize }) {
  const open = useFlowId();
  const flowId = given ?? open;
  const state = useLoaded(source, flowId);
  if (source.kind === "text") {
    return (
      <div>
        {head && <Head icon={<FileText size={12} />} name={t.preview.text(source.text.length)} />}
        <TextBlock text={source.text} />
      </div>
    );
  }
  if (source.kind === "imageData") {
    const pic = state.loading ? undefined : state.picture;
    return (
      <div>
        {head && <Head icon={<ImageIcon size={12} />} name={t.preview.imageData} note={pic?.width ? t.preview.size(pic.width, pic.height ?? 0) : undefined} />}
        {pic ? <PictureView picture={pic} alt={t.preview.imageData} size={size} load={async () => source.src} /> : <div className="mt-1 text-[11px] text-slate-400">{t.preview.loading}</div>}
      </div>
    );
  }
  const name = baseName(source.path);
  if (state.loading) {
    return (
      <div>
        {head && <Head icon={isImagePath(source.path) ? <ImageIcon size={12} /> : <FileText size={12} />} name={name} />}
        <div className="mt-1 text-[11px] text-slate-400">{t.preview.loading}</div>
      </div>
    );
  }
  const preview = state.preview;
  switch (preview?.kind) {
    case "image": {
      const pic = state.picture;
      const note = [pic?.width ? t.preview.size(pic.width, pic.height ?? 0) : null, sizeText(preview.bytes)].filter(Boolean).join(" · ");
      return (
        <div>
          {head && <Head icon={<ImageIcon size={12} />} name={name} note={note} />}
          {pic && <PictureView picture={pic} alt={name} size={size} bytes={preview.bytes} load={() => loadFullPicture(flowId, source.path)} />}
        </div>
      );
    }
    case "table": {
      const note = [preview.sheet ? t.preview.sheet(preview.sheet) : null, t.preview.firstRows(preview.rows.length)].filter(Boolean).join(" · ");
      return (
        <div>
          {head && <Head icon={<Sheet size={12} />} name={name} note={note} />}
          <TableView preview={preview} />
          {preview.more && <div className="mt-0.5 text-[10px] text-slate-400">{t.preview.moreRows}</div>}
        </div>
      );
    }
    case "text":
      return (
        <div>
          {head && <Head icon={<FileText size={12} />} name={name} />}
          <TextBlock text={preview.text} more={preview.more} />
        </div>
      );
    case "missing":
      return (
        <div>
          <Head icon={<TriangleAlert size={12} />} name={name} note={t.preview.missing} tone="error" />
          <div className="mt-0.5 max-w-[420px] text-[11px] break-all text-slate-500">{source.path}</div>
        </div>
      );
    case "tooLarge":
      return <Head icon={<ImageIcon size={12} />} name={name} note={`${t.preview.tooLarge}（${sizeText(preview.bytes)}）`} />;
    case "file":
      return <Head icon={<FileText size={12} />} name={name} note={sizeText(preview.bytes)} />;
    default:
      return <Head icon={<TriangleAlert size={12} />} name={name} note={t.preview.unreadable} tone="error" />;
  }
}

/** Half the popover's widest, to keep it on screen. */
export const HALF = 300;

function Popover({ anchor, children, box, onEnter, onLeave }: { anchor: DOMRect; children: ReactNode; box: RefObject<HTMLDivElement | null>; onEnter: () => void; onLeave: () => void }) {
  const below = anchor.top < window.innerHeight / 2;
  const left = Math.min(Math.max(anchor.left + anchor.width / 2, HALF + 8), Math.max(HALF + 8, window.innerWidth - HALF - 8));
  return createPortal(
    <div
      ref={box}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // The popover sits in the value's React tree: a press in it is not a press on the value (opening, selecting a node).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      style={{ left, top: below ? anchor.bottom + 4 : anchor.top - 4 }}
      className={`fixed z-50 max-w-[min(600px,calc(100vw-16px))] min-w-[120px] -translate-x-1/2 ${below ? "" : "-translate-y-full"} rounded-lg border border-slate-200 bg-sheet px-2.5 py-2 shadow-lifted`}
    >
      {children}
    </div>,
    document.body,
  );
}

/** How long the popover waits for the pointer to come onto it before closing. */
const LEAVE_DELAY = 150;

/**
 * Shows what `value` holds after the pointer rests on `children` for
 * {@link HOVER_DELAY}. `source` names it directly instead (a file of the
 * flow's folder); with neither showing anything, `children` is drawn alone.
 */
export function HoverPreview({
  value,
  source: given,
  longText = false,
  flowId,
  children,
  ...rest
}: {
  value?: unknown;
  /** The flow whose folder relative paths are in, when it is not the open one. */
  flowId?: string;
  source?: PreviewSource | null;
  longText?: boolean;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "onMouseEnter" | "onMouseLeave">) {
  const source = given !== undefined ? given : previewSource(value, { longText });
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    // Zooming, scrolling or pressing elsewhere moves what it points at: it
    // closes. Scrolling or selecting inside the popover (a long text) does not.
    const close = (e: Event) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return;
      setAnchor(null);
    };
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("wheel", close);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [anchor]);
  if (!source) return <span {...rest}>{children}</span>;
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAnchor(null), LEAVE_DELAY);
  };
  return (
    <span
      {...rest}
      data-preview={source.kind}
      onMouseEnter={(e) => {
        const target = e.currentTarget;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setAnchor(target.getBoundingClientRect()), HOVER_DELAY);
      }}
      onMouseLeave={leave}
    >
      {children}
      {anchor && (
        <Popover anchor={anchor} box={box} onEnter={() => clearTimeout(timer.current)} onLeave={leave}>
          <PreviewBody source={source} flowId={flowId} />
        </Popover>
      )}
    </span>
  );
}
