// The screens of a flow's last run, as the sheet shows and hides them: the
// pictures and their loading, the marks on them, the dialog that blurs or
// blacks out a part of one, and the manual written out as a file.
import type { Flow, Step } from "@spellsheet/schema";
import { Clock, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { api, manualApi } from "../../lib/api";
import { locale, t } from "../../lib/i18n";
import { type Edition, type ManualDoc, type ManualManifest, type ManualShot, blurRegions, cropOf, type Mask, type MaskBox, type Rect, type Scene } from "../../lib/manual";
import { burnShot, manualHtml, operated, type SceneMark, sceneMarks, scenesOf } from "../../lib/manualExport";
import { CALL } from "../../lib/stepTypes";

/** The pictures of the screens and what is done about them. */
export type Pictures = {
  urls: Record<string, string>;
  want: (file: string) => void;
  masks: Record<string, Mask>;
  onWhole: (shot: ManualShot, marks: SceneMark[]) => void;
  onMask: (shot: ManualShot) => void;
};

/** The flows `flow.call` nodes run, read once per flow (nested calls too). */
export function useSubflows(flow: Flow | null): Map<string, Flow> {
  const [flows, setFlows] = useState<Map<string, Flow>>(new Map());
  useEffect(() => {
    let live = true;
    const found = new Map<string, Flow>();
    const ids = (steps: Step[]): string[] =>
      steps.flatMap((s) => [
        ...(s.type === CALL && typeof (s.params as Record<string, unknown> | undefined)?.flow === "string" ? [String(s.params?.flow)] : []),
        ...Object.values(s.blocks ?? {}).flatMap(ids),
      ]);
    const load = async (list: string[], depth: number) => {
      for (const id of list) {
        if (found.has(id) || id === flow?.id || depth > 3) continue;
        const called = await api.getFlow(id).catch(() => null);
        if (!called) continue;
        found.set(id, called);
        await load(ids(called.steps ?? []), depth + 1);
      }
    };
    if (flow) void load(ids(flow.steps ?? []), 0).then(() => live && setFlows(new Map(found)));
    return () => {
      live = false;
    };
  }, [flow]);
  return flows;
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? t.manual.seconds(s) : t.manual.minutes(Math.floor(s / 60), s % 60);
}

export function madeLine(manifest: ManualManifest | null): string | null {
  if (!manifest) return null;
  const when = new Date(manifest.startedAt).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return t.manual.made(when, duration(manifest.durationMs));
}

/** A day as the cover and the revision history say it (2026/11/09). */
export function day(iso: string): string {
  return new Date(iso).toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Where the screens came from, short: 「11月9日 09:20 の実行」. */
export function shotLine(manifest: ManualManifest | null, doc: ManualDoc): string {
  if (manifest) {
    const when = new Date(manifest.startedAt).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return t.manual.shotRun(when);
  }
  return doc.drafts > 0 ? t.manual.shotDrafts : t.manual.shotNone;
}

/** Loads pictures as data URLs, each once. */
export function usePictures(flowId: string | undefined, runId: string | undefined) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    setUrls({});
    asked.current = new Set();
  }, [flowId, runId]);
  const want = (file: string) => {
    if (!flowId || asked.current.has(file)) return;
    asked.current.add(file);
    void manualApi
      .image(flowId, file)
      .then((url) => setUrls((now) => ({ ...now, [file]: url })))
      .catch(() => {});
  };
  return { urls, want };
}

/**
 * Boxes over a picture: what is hidden (blurred or black). The values the
 * page showed (`regions`: fields, cells, "label  value" rows) are blurred
 * here too, as the 書き出し does by default, so what is on the screen is
 * what goes out and a screen shared from here does not show them either.
 */
function MaskBoxes({ boxes, regions, crop, k }: { boxes: MaskBox[]; regions?: Rect[]; crop: Rect; k: number }) {
  const all: MaskBox[] = [...(regions ?? []).map((r) => ({ ...r, kind: "blur" as const })), ...boxes];
  return (
    <>
      {all.map((b, i) => (
        <span
          key={i}
          className={`absolute ${b.kind === "black" ? "bg-slate-900" : "bg-slate-200/50 backdrop-blur-[6px]"}`}
          style={{ left: (b.x - crop.x) * k, top: (b.y - crop.y) * k, width: b.width * k, height: b.height * k }}
        />
      ))}
    </>
  );
}

/** The frame around what each step touches, with the step's number on its corner. */
function Marks({ marks, crop, k, bare = false }: { marks: SceneMark[]; crop: Rect; k: number; bare?: boolean }) {
  return (
    <>
      {marks.map((m, i) => (
        <span
          key={m.number ?? `wait-${i}`}
          title={m.number === null ? t.manual.waitsHere : undefined}
          className={`absolute rounded-[4px] border-2 ${
            m.number === null ? "border-dashed border-slate-600" : "border-primary shadow-[0_0_0_3px_rgb(10_111_168/0.2)]"
          }`}
          style={{ left: (m.rect.x - crop.x) * k - 3, top: (m.rect.y - crop.y) * k - 3, width: m.rect.width * k + 6, height: m.rect.height * k + 6 }}
        >
          {!bare && <i
            style={{ left: Math.max(-8, 4 - (m.rect.x - crop.x) * k) }}
            className={`absolute -top-[8px] grid size-[14px] place-items-center rounded-full text-[9.5px] font-bold not-italic shadow-[0_0_0_1.5px_white] ${m.number === null ? "bg-slate-600 text-white" : "bg-primary text-on-primary"}`}
          >
            {m.number ?? <Clock size={9} />}
          </i>}
        </span>
      ))}
    </>
  );
}

/**
 * A picture in the sheet's margin, cut to what its steps touch, with their
 * numbers on the corners of what they touch (beside it, a number would cover
 * the next field or fall off the picture's edge).
 */
/** `bare`: the picture is of one step, so the frame needs no number on it. */
export function ShotFrame({ shot, marks, ctx, bare = false, crop: cut }: { shot: ManualShot; marks: SceneMark[]; ctx: Pick<Pictures, "urls" | "want" | "masks">; bare?: boolean; crop?: Rect }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    ctx.want(shot.file);
  }, [ctx, shot.file]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const crop = cut ?? cropOf(shot.width, shot.height, marks.map((m) => m.rect));
  const k = width > 0 ? width / crop.width : 0;
  const url = ctx.urls[shot.file];
  const mask = ctx.masks[shot.key];
  return (
    <div ref={box} className="relative overflow-hidden bg-paper" style={{ height: k > 0 ? crop.height * k : 200 }}>
      {url && k > 0 && (
        <>
          <img
            src={url}
            alt=""
            className="absolute max-w-none"
            style={{ width: shot.width * k, height: shot.height * k, left: -crop.x * k, top: -crop.y * k }}
          />
          <MaskBoxes boxes={mask?.boxes ?? []} regions={blurRegions(shot.regions, operated(marks))} crop={crop} k={k} />
          <Marks marks={marks} crop={crop} k={k} bare={bare} />
        </>
      )}
    </div>
  );
}

function Overlay({ children, onClose, label }: { children: React.ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/40" onClick={onClose}>
      <div
        role="dialog"
        aria-label={label}
        className="flex max-h-[92vh] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** Fits a picture into the space a dialog has. */
function useFit(shot: ManualShot, maxWidth: number, maxHeight: number): number {
  return Math.min(1, maxWidth / shot.width, maxHeight / shot.height);
}

/** The whole picture, large: with the same frames and numbers as in the margin, so the steps can still be found on it. */
export function WholeShot({ shot, marks, url, mask, onClose }: { shot: ManualShot; marks: SceneMark[]; url: string | undefined; mask: Mask | undefined; onClose: () => void }) {
  const k = useFit(shot, window.innerWidth * 0.9, window.innerHeight * 0.85);
  return (
    <Overlay onClose={onClose} label={t.manual.whole}>
      <div className="relative" style={{ width: shot.width * k, height: shot.height * k }}>
        {url && <img src={url} alt="" className="absolute inset-0 h-full w-full" />}
        <MaskBoxes boxes={mask?.boxes ?? []} regions={blurRegions(shot.regions, operated(marks))} crop={{ x: 0, y: 0, width: shot.width, height: shot.height }} k={k} />
        <Marks marks={marks} crop={{ x: 0, y: 0, width: shot.width, height: shot.height }} k={k} />
      </div>
    </Overlay>
  );
}

/** Draw boxes over a picture to blur or black out what it shows. */
export function MaskEditor({
  shot,
  url,
  mask,
  onCancel,
  onSave,
}: {
  shot: ManualShot;
  url: string | undefined;
  mask: Mask | undefined;
  onCancel: () => void;
  onSave: (mask: Mask) => void;
}) {
  const [boxes, setBoxes] = useState<MaskBox[]>(mask?.boxes ?? []);
  const [hidden, setHidden] = useState(mask?.hidden ?? false);
  const [kind, setKind] = useState<MaskBox["kind"]>("blur");
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const k = useFit(shot, Math.min(window.innerWidth * 0.86, 1200), window.innerHeight * 0.66);
  const at = (e: ReactPointerEvent) => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(shot.width, (e.clientX - r.left) / k)), y: Math.max(0, Math.min(shot.height, (e.clientY - r.top) / k)) };
  };
  const rectOf = (d: NonNullable<typeof drawing>): Rect => ({
    x: Math.min(d.x0, d.x1),
    y: Math.min(d.y0, d.y1),
    width: Math.abs(d.x1 - d.x0),
    height: Math.abs(d.y1 - d.y0),
  });
  return (
    <Overlay onClose={onCancel} label={t.manual.masks.title}>
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
        <h3 className="text-[15px] font-semibold">{t.manual.masks.title}</h3>
        <span className="text-[12.5px] text-slate-500">{t.manual.masks.hint}</span>
      </div>
      <div className="overflow-auto bg-paper p-3">
        <div
          ref={area}
          className="relative cursor-crosshair touch-none select-none"
          style={{ width: shot.width * k, height: shot.height * k }}
          onPointerDown={(e) => {
            const p = at(e);
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            setDrawing({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onPointerMove={(e) => {
            if (!drawing) return;
            const p = at(e);
            setDrawing({ ...drawing, x1: p.x, y1: p.y });
          }}
          onPointerUp={() => {
            if (!drawing) return;
            const r = rectOf(drawing);
            if (r.width >= 4 && r.height >= 4) setBoxes([...boxes, { ...r, kind }]);
            setDrawing(null);
          }}
        >
          {url && <img src={url} alt="" draggable={false} className={`absolute inset-0 h-full w-full ${hidden ? "opacity-30" : ""}`} />}
          <MaskBoxes boxes={boxes} regions={shot.regions} crop={{ x: 0, y: 0, width: shot.width, height: shot.height }} k={k} />
          {boxes.map((b, i) => (
            <button
              key={i}
              type="button"
              aria-label={t.delete}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setBoxes(boxes.filter((_, j) => j !== i))}
              className="absolute grid h-5 w-5 place-items-center rounded-full bg-sheet text-slate-600 shadow"
              style={{ left: (b.x + b.width) * k - 10, top: b.y * k - 10 }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          ))}
          {drawing && (
            <span
              className="absolute border-2 border-dashed border-primary bg-primary/10"
              style={{ left: rectOf(drawing).x * k, top: rectOf(drawing).y * k, width: rectOf(drawing).width * k, height: rectOf(drawing).height * k }}
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-2.5 text-[13px]">
        <span className="inline-flex rounded-md bg-slate-100 p-0.5">
          {(["blur", "black"] as const).map((kd) => (
            <button
              key={kd}
              type="button"
              onClick={() => setKind(kd)}
              className={`rounded-[5px] px-2.5 py-0.5 ${kind === kd ? "bg-sheet font-semibold shadow-sm" : "text-slate-500"}`}
            >
              {kd === "blur" ? t.manual.masks.blur : t.manual.masks.black}
            </button>
          ))}
        </span>
        <span className="text-slate-500">{t.manual.masks.count(boxes.length)}</span>
        {boxes.length > 0 && (
          <button type="button" className="text-slate-600 underline" onClick={() => setBoxes([])}>
            {t.manual.masks.clear}
          </button>
        )}
        <label className="ml-2 inline-flex items-center gap-1.5">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          {t.manual.masks.leaveOut}
        </label>
        <span className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-paper">
            {t.manual.masks.cancel}
          </button>
          <button
            type="button"
            onClick={() => onSave({ hidden, boxes, width: shot.width, height: shot.height })}
            className="rounded-md bg-primary px-3 py-1 text-on-primary hover:bg-primary-hover"
          >
            {t.manual.masks.save}
          </button>
        </span>
      </div>
    </Overlay>
  );
}

export function ExportDialog({
  doc,
  flowId,
  made,
  shotAt,
  edition,
  when,
  masks,
  onClose,
}: {
  doc: ManualDoc;
  flowId: string;
  made: string | null;
  shotAt: string;
  edition: Edition;
  when: string[];
  masks: Record<string, Mask>;
  onClose: () => void;
}) {
  const [blurFields, setBlurFields] = useState(true);
  const [noPictures, setNoPictures] = useState(false);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; path: string } | { kind: "error"; message: string }>({ kind: "idle" });
  const save = async () => {
    setState({ kind: "busy" });
    try {
      const pictures = new Map<Scene, string>();
      if (!noPictures) {
        for (const scene of scenesOf(doc)) {
          const shot = scene.shot;
          if (!shot) continue;
          const src = await manualApi.image(flowId, shot.file);
          pictures.set(scene, await burnShot(src, shot, sceneMarks(scene), masks[shot.key], blurFields));
        }
      }
      const date = new Date().toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US");
      const html = manualHtml(doc, pictures, { blurFields, noPictures, made, shotAt, edition, when, date });
      setState({ kind: "done", path: await manualApi.saveExport(doc.title, html) });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <Overlay onClose={onClose} label={t.manual.exportDialog.title}>
      <div className="w-[480px] p-5 text-[13.5px]">
        <h3 className="mb-3 text-[15px] font-semibold">{t.manual.exportDialog.title}</h3>
        <p className="mb-3 text-[12.5px] text-slate-500">{t.manual.exportDialog.format}</p>
        <label className="flex gap-2.5 py-1.5">
          <input type="checkbox" checked={blurFields} disabled={noPictures} onChange={(e) => setBlurFields(e.target.checked)} className="mt-1" />
          <span>
            {t.manual.exportDialog.blurFields}
            <small className="block text-[12px] text-slate-500">{t.manual.exportDialog.blurFieldsHint}</small>
          </span>
        </label>
        <label className="flex gap-2.5 py-1.5">
          <input type="checkbox" checked={noPictures} onChange={(e) => setNoPictures(e.target.checked)} className="mt-1" />
          <span>
            {t.manual.exportDialog.noPictures}
            <small className="block text-[12px] text-slate-500">{t.manual.exportDialog.noPicturesHint}</small>
          </span>
        </label>
        {!noPictures && <p className="mt-2 rounded-md bg-shu-50 px-3 py-2 text-[12.5px] leading-relaxed text-shu-600">{t.manual.exportDialog.warn}</p>}
        {state.kind === "done" && <p className="mt-3 text-[12.5px] break-all text-moegi-600">{t.manual.exportDialog.saved(state.path)}</p>}
        {state.kind === "error" && <p className="mt-3 text-[12.5px] text-shu-600">{state.message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-paper">
            {t.manual.exportDialog.cancel}
          </button>
          <button
            type="button"
            disabled={state.kind === "busy"}
            onClick={() => void save()}
            className="rounded-md bg-primary px-3 py-1 text-on-primary enabled:hover:bg-primary-hover disabled:opacity-60"
          >
            {state.kind === "busy" ? t.manual.exportDialog.saving : t.manual.exportDialog.save}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
