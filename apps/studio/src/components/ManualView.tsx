// The 手順書: the open flow read as a procedure, with the screens of the last
// run from Studio (docs/design/manual.md). 「編集する」 switches to the
// editable outline (StoryView).
import type { Flow, Step } from "@shikigami/schema";
import { Camera, Clock, Download, EyeOff, Maximize2, MessageSquareText, Pencil, Play, RotateCw, Workflow } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAgentApi } from "../agent";
import { currentChat } from "../agent";
import { useStudio } from "../context";
import { api, type ScheduleView, manualApi } from "../lib/api";
import { locale, t } from "../lib/i18n";
import {
  buildManual,
  type Chapter,
  cropOf,
  type ManualDoc,
  type ManualItem,
  type ManualManifest,
  type ManualShot,
  type ManualStep,
  type Mask,
  type MaskBox,
  maskStale,
  type Rect,
  type Scene,
} from "../lib/manual";
import { burnShot, manualHtml, sceneMarks, scenesOf } from "../lib/manualExport";
import { describeWhen } from "../lib/schedule";
import { CALL } from "../lib/stepTypes";
import { isActive } from "../store";
import { Sentence, StoryView } from "./StoryView";
import { CanvasDock } from "./Toolbar";

type View = "flow" | "story" | "variables";

/** The flows `flow.call` nodes run, read once per flow (nested calls too). */
function useSubflows(flow: Flow | null): Map<string, Flow> {
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

function madeLine(manifest: ManualManifest | null): string | null {
  if (!manifest) return null;
  const when = new Date(manifest.startedAt).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return t.manual.made(when, duration(manifest.durationMs));
}

/** Loads pictures as data URLs, each once. */
function usePictures(flowId: string | undefined, runId: string | undefined) {
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

type Ctx = {
  urls: Record<string, string>;
  want: (file: string) => void;
  masks: Record<string, Mask>;
  onMask: (shot: ManualShot) => void;
  onWhole: (shot: ManualShot) => void;
  onDiffers: (step: ManualStep) => void;
  onShow: (step: ManualStep) => void;
};

export function ManualView({ onView }: { onView: (view: View) => void }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const startRun = useStudio((s) => s.startRun);
  const goToPlace = useStudio((s) => s.goToPlace);
  const running = useStudio((s) => isActive(s.run));
  const agent = useAgentApi();
  const [editing, setEditing] = useState(false);
  const [manifest, setManifest] = useState<ManualManifest | null>(null);
  const [masks, setMasks] = useState<Record<string, Mask>>({});
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [masking, setMasking] = useState<ManualShot | null>(null);
  const [whole, setWhole] = useState<ManualShot | null>(null);
  const [exporting, setExporting] = useState(false);
  const subflows = useSubflows(flow);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const flowId = flow?.id;

  // Read again when the flow changes and when a run of it ends.
  useEffect(() => {
    if (!flowId || running) return;
    let live = true;
    void manualApi
      .get(flowId)
      .then((m) => {
        if (!live) return;
        setManifest(m.manifest ?? null);
        setMasks(m.masks ?? {});
      })
      .catch(() => {});
    void api
      .listSchedules()
      .then((list) => live && setSchedules(list.schedules.filter((s) => s.flowId === flowId && s.enabled)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [flowId, running]);

  const { urls, want } = usePictures(flowId, manifest?.runId);
  const doc = useMemo(() => (flow ? buildManual(flow, defs, manifest, subflows, masks) : null), [flow, defs, manifest, subflows, masks]);

  if (!flow || !doc) return <StoryView />;
  if (editing) {
    return (
      <div className="relative h-full">
        <StoryView />
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-16">
          <CanvasDock />
        </div>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="absolute top-3 right-4 z-10 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-sheet px-3 py-1 text-[13px] text-ink hover:bg-paper"
        >
          {t.manual.read}
        </button>
      </div>
    );
  }

  const saveMasks = (next: Record<string, Mask>) => {
    setMasks(next);
    void manualApi.saveMasks(flow.id, next).catch(() => {});
  };
  const ctx: Ctx = {
    urls,
    want,
    masks,
    onMask: setMasking,
    onWhole: setWhole,
    onDiffers: (step) => {
      const state = agent.getState();
      goToPlace({ path: step.callPath, stepId: step.stepId });
      state.setOpen(true);
      const chat = currentChat(agent.getState());
      state.setDraft(chat.id, t.manual.differsDraft(step.text));
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-agent-input]")?.focus());
    },
    onShow: (step) => {
      goToPlace({ path: step.callPath, stepId: step.stepId });
      onView("flow");
    },
  };
  const made = madeLine(manifest);
  const when = schedules.map((s) => describeWhen(s.when));

  return (
    <div className="canvas-bg h-full overflow-y-auto px-6 pt-14 pb-24">
      <article className="mx-auto max-w-[940px] rounded-lg border border-slate-200 bg-sheet px-11 py-9 shadow-sheet" data-manual>
        <h1 className="text-[24px] font-semibold">{doc.title}</h1>
        <div className="mt-1.5 mb-5 flex flex-wrap items-center gap-2.5 text-[12.5px] text-slate-500">
          {made ? (
            <>
              <span className="h-2 w-2 rounded-full bg-moegi-500" />
              <span>{made}</span>
            </>
          ) : (
            <span>{t.manual.noRun}</span>
          )}
          <span className="ml-auto flex gap-2">
            <ToolButton icon={made ? RotateCw : Play} label={made ? t.manual.retake : t.manual.runNow} title={t.manual.retakeTitle} disabled={running} onClick={() => void startRun()} />
            <ToolButton icon={Download} label={t.manual.export} onClick={() => setExporting(true)} />
            <ToolButton icon={Pencil} label={t.manual.edit} title={t.manual.editTitle} onClick={() => setEditing(true)} />
          </span>
        </div>
        {doc.description && <p className="mb-4 text-[15px] leading-[1.85] text-slate-600">{doc.description}</p>}
        <Facts doc={doc} when={when} />
        {doc.missing > 0 && manifest && <p className="mt-3 text-[12.5px] text-slate-500">{t.manual.missing(doc.missing)}</p>}
        <Toc chapters={doc.chapters} />
        {doc.chapters.map((c) => (
          <ChapterSection key={c.number} chapter={c} ctx={ctx} />
        ))}
        {manifest && <p className="mt-10 text-right text-[11.5px] text-slate-400">{t.manual.privacy}</p>}
      </article>
      {masking && (
        <MaskEditor
          shot={masking}
          url={urls[masking.file]}
          mask={masks[masking.key]}
          onCancel={() => setMasking(null)}
          onSave={(mask) => {
            saveMasks({ ...masks, [masking.key]: mask });
            setMasking(null);
          }}
        />
      )}
      {whole && <WholeShot shot={whole} url={urls[whole.file]} mask={masks[whole.key]} onClose={() => setWhole(null)} />}
      {exporting && <ExportDialog doc={doc} flowId={flow.id} made={made} when={when} masks={masks} onClose={() => setExporting(false)} />}
    </div>
  );
}

function ToolButton({ icon: Icon, label, title, disabled, onClick }: { icon: typeof Play; label: string; title?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-sheet px-2.5 py-1 text-[13px] text-ink enabled:hover:bg-paper disabled:opacity-50"
    >
      <Icon size={14} strokeWidth={1.75} />
      {label}
    </button>
  );
}

function Facts({ doc, when }: { doc: ManualDoc; when: string[] }) {
  const rows: [string, string[]][] = [
    [t.manual.uses, doc.uses],
    [t.manual.inputs, doc.inputs],
    [t.manual.outputs, doc.outputs],
    [t.manual.runsWhen, [...when, t.manual.byHand]],
  ];
  return (
    <dl className="grid grid-cols-[120px_1fr] border-t border-slate-200 text-[13.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="border-b border-slate-200 py-2 text-slate-500">{k}</dt>
          <dd className="border-b border-slate-200 py-2">{v.length > 0 ? v.join("、") : <span className="text-slate-400">{t.manual.none}</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

function Toc({ chapters }: { chapters: Chapter[] }) {
  return (
    <ol className="mt-6 mb-2" aria-label={t.manual.contents}>
      {chapters.map((c) => (
        <li key={c.number} className="flex items-baseline gap-3 py-1.5 text-[14.5px]">
          <Num n={c.number} />
          <button
            type="button"
            className="text-left hover:underline"
            onClick={() => document.getElementById(`manual-c${c.number}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            {c.title}
          </button>
          {c.alongside.length > 0 && <span className="text-[12.5px] text-slate-500">（{t.manual.alongsideNote(c.alongside).replace(/。$/, "")}）</span>}
          <span className="ml-auto shrink-0 text-[12.5px] text-slate-500">
            {c.screens > 0 ? t.manual.screens(c.screens) : t.manual.noScreen}
            {c.loops ? `・${t.manual.loop}` : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Num({ n, big }: { n: number; big?: boolean }) {
  return (
    <span
      className={`grid shrink-0 translate-y-[3px] place-items-center rounded-[5px] bg-ink font-semibold text-sheet ${big ? "h-7 w-7 text-[14px]" : "h-6 w-6 text-[12.5px]"}`}
    >
      {n}
    </span>
  );
}

function ChapterSection({ chapter, ctx }: { chapter: Chapter; ctx: Ctx }) {
  return (
    <section id={`manual-c${chapter.number}`} className="scroll-mt-4">
      <h2 className="mt-10 mb-1.5 flex items-center gap-3 text-[19px] font-semibold">
        <Num n={chapter.number} big />
        {chapter.title}
      </h2>
      {chapter.alongside.length > 0 && <p className="mb-3 ml-10 text-[13px] text-slate-500">{t.manual.alongsideNote(chapter.alongside)}</p>}
      <div className="ml-10">
        <Items items={chapter.items} ctx={ctx} />
      </div>
    </section>
  );
}

function Items({ items, ctx }: { items: ManualItem[]; ctx: Ctx }) {
  return (
    <>
      {items.map((item, i) => (
        <ItemView key={i} item={item} ctx={ctx} />
      ))}
    </>
  );
}

function Taken({ taken }: { taken: boolean | null }) {
  if (taken === null) return null;
  return (
    <span className={`rounded-full border bg-sheet px-2 text-[11.5px] ${taken ? "border-moegi-500 text-moegi-600" : "border-slate-300 text-slate-500"}`}>
      {taken ? t.manual.took : t.manual.notTaken}
    </span>
  );
}

function ItemView({ item, ctx }: { item: ManualItem; ctx: Ctx }) {
  switch (item.kind) {
    case "scene":
      return <SceneCard scene={item} ctx={ctx} />;
    case "action":
      return (
        <ol className="mb-2">
          <StepRow step={item.step} ctx={ctx} />
        </ol>
      );
    case "quiet":
      return (
        <div className="mb-3 flex items-start gap-2 text-[13px] leading-[1.7] text-slate-500">
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] bg-slate-100">
            <Workflow size={11} />
          </span>
          <div>
            <b className="font-semibold text-slate-600">{t.manual.quiet}</b>　{item.texts.join("・")}
          </div>
        </div>
      );
    case "branch":
      return (
        <div className={item.taken === false ? "opacity-70" : ""}>
          <div
            className="mb-2.5 inline-flex items-center gap-2 rounded-md border px-2.5 py-0.5 text-[13px]"
            style={{ background: "var(--flow-decide-fill)", borderColor: "var(--flow-decide-line)" }}
          >
            ◆ {item.label} <Taken taken={item.taken} />
          </div>
          <Items items={item.items} ctx={ctx} />
        </div>
      );
    case "loop":
      return (
        <div className="mb-4 border-l-[3px] border-slate-300 py-0.5 pl-4">
          <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
            ↻ {item.label}
            {item.times !== null && <span className="text-[12.5px] font-normal text-slate-500">{t.manual.loopTimes(item.times)}</span>}
          </div>
          <Items items={item.items} ctx={ctx} />
        </div>
      );
    case "group":
      return (
        <div className="mb-3">
          <div className="mb-2 text-[14px] font-semibold">{item.label}</div>
          <Items items={item.items} ctx={ctx} />
        </div>
      );
  }
}

function StepRow({ step, ctx }: { step: ManualStep; ctx: Ctx }) {
  return (
    <li className="group/step relative flex gap-2.5 border-b border-dashed border-slate-200 py-2 last:border-b-0">
      <span className="mt-0.5 grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full bg-primary text-[12px] font-bold text-on-primary">{step.number}</span>
      <div className="min-w-0 flex-1 text-[14px] leading-[1.65]">
        {step.text}
        {step.how && (
          <span className="block text-[12.5px] leading-[1.6] text-slate-500">
            <Sentence parts={step.how} />
          </span>
        )}
        <span className="mt-1 hidden gap-1.5 group-hover/step:flex group-focus-within/step:flex">
          <button
            type="button"
            title={t.manual.differsTitle}
            onClick={() => ctx.onDiffers(step)}
            className="inline-flex items-center gap-1 rounded-[5px] border border-primary px-2 text-[12px] text-primary hover:bg-brand-50"
          >
            <MessageSquareText size={12} />
            {t.manual.differs}
          </button>
          <button
            type="button"
            onClick={() => ctx.onShow(step)}
            className="rounded-[5px] border border-slate-300 px-2 text-[12px] text-slate-600 hover:bg-paper"
          >
            {t.manual.showInChart}
          </button>
        </span>
      </div>
    </li>
  );
}

function SceneRows({ waits, step, ctx }: { waits: Scene["waits"]; step: ManualStep | null; ctx: Ctx }) {
  return (
    <>
      {waits.map((w, i) => (
        <li key={i} className="flex items-start gap-2 py-1 text-[12.5px] text-slate-500">
          <Clock size={13} className="mt-[3px] shrink-0" />
          {w.text}
        </li>
      ))}
      {step && <StepRow step={step} ctx={ctx} />}
    </>
  );
}

function SceneCard({ scene, ctx }: { scene: Scene; ctx: Ctx }) {
  const shot = scene.shot;
  const mask = shot ? ctx.masks[shot.key] : undefined;
  return (
    <div className="mb-3.5 overflow-hidden rounded-lg border border-slate-200">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[12.5px] text-slate-500">
        <Camera size={13} />
        <b className="font-semibold text-ink">{t.manual.screenOf(scene.title, scene.app === "desktop")}</b>
        {shot && maskStale(mask, shot) && <span className="text-accent-600">{t.manual.maskStale}</span>}
        {shot && (
          <button
            type="button"
            title={t.manual.hideTitle}
            onClick={() => ctx.onMask(shot)}
            className="ml-auto inline-flex items-center gap-1 rounded-[5px] px-1.5 text-slate-600 hover:bg-slate-200"
          >
            <EyeOff size={13} />
            {t.manual.hide}
            {mask && mask.boxes.length > 0 ? ` ${mask.boxes.length}` : ""}
          </button>
        )}
      </div>
      <div className={shot ? "grid grid-cols-[1.45fr_1fr]" : ""}>
        {shot ? (
          <ShotFrame shot={shot} marks={sceneMarks(scene)} ctx={ctx} />
        ) : (
          <p className="px-3.5 pt-2.5 text-[12px] text-slate-400">{t.manual.noPicture}</p>
        )}
        <ol className="px-3.5 py-2">
          {[...scene.steps, null].map((s, i) => (
            <SceneRows key={s?.key ?? "end"} waits={scene.waits.filter((w) => w.at === i)} step={s} ctx={ctx} />
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Boxes over a picture: what is hidden (blurred or black). */
function MaskBoxes({ boxes, crop, k }: { boxes: MaskBox[]; crop: Rect; k: number }) {
  return (
    <>
      {boxes.map((b, i) => (
        <span
          key={i}
          className={`absolute ${b.kind === "black" ? "bg-slate-900" : "bg-slate-200/50 backdrop-blur-[6px]"}`}
          style={{ left: (b.x - crop.x) * k, top: (b.y - crop.y) * k, width: b.width * k, height: b.height * k }}
        />
      ))}
    </>
  );
}

function ShotFrame({ shot, marks, ctx }: { shot: ManualShot; marks: { number: number; rect: Rect }[]; ctx: Ctx }) {
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
  const crop = cropOf(shot.width, shot.height, marks.map((m) => m.rect));
  const k = width > 0 ? width / crop.width : 0;
  const url = ctx.urls[shot.file];
  const mask = ctx.masks[shot.key];
  return (
    <div ref={box} className="relative overflow-hidden border-r border-slate-200 bg-paper" style={{ height: k > 0 ? crop.height * k : 200 }}>
      {url && k > 0 && (
        <>
          <img
            src={url}
            alt=""
            className="absolute max-w-none"
            style={{ width: shot.width * k, height: shot.height * k, left: -crop.x * k, top: -crop.y * k }}
          />
          <MaskBoxes boxes={mask?.boxes ?? []} crop={crop} k={k} />
          {marks.map((m) => (
            <span
              key={m.number}
              className="absolute rounded-[4px] border-[2.5px] border-primary shadow-[0_0_0_3px_rgb(10_111_168/0.2)]"
              style={{ left: (m.rect.x - crop.x) * k - 3, top: (m.rect.y - crop.y) * k - 3, width: m.rect.width * k + 6, height: m.rect.height * k + 6 }}
            >
              <i className="absolute top-1/2 -left-[30px] -mt-[10.5px] grid h-[21px] w-[21px] place-items-center rounded-full bg-primary text-[12px] font-bold text-on-primary not-italic shadow-[0_0_0_2px_white]">
                {m.number}
              </i>
            </span>
          ))}
          <button
            type="button"
            onClick={() => ctx.onWhole(shot)}
            className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-[5px] border border-slate-300 bg-sheet/95 px-2 py-0.5 text-[11.5px] text-slate-600 hover:bg-sheet"
          >
            <Maximize2 size={11} />
            {t.manual.whole}
          </button>
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

function WholeShot({ shot, url, mask, onClose }: { shot: ManualShot; url: string | undefined; mask: Mask | undefined; onClose: () => void }) {
  const k = useFit(shot, window.innerWidth * 0.9, window.innerHeight * 0.85);
  return (
    <Overlay onClose={onClose} label={t.manual.whole}>
      <div className="relative" style={{ width: shot.width * k, height: shot.height * k }}>
        {url && <img src={url} alt="" className="absolute inset-0 h-full w-full" />}
        <MaskBoxes boxes={mask?.boxes ?? []} crop={{ x: 0, y: 0, width: shot.width, height: shot.height }} k={k} />
      </div>
    </Overlay>
  );
}

/** Draw boxes over a picture to blur or black out what it shows. */
function MaskEditor({
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
          <MaskBoxes boxes={boxes} crop={{ x: 0, y: 0, width: shot.width, height: shot.height }} k={k} />
          {boxes.map((b, i) => (
            <button
              key={i}
              type="button"
              aria-label="×"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setBoxes(boxes.filter((_, j) => j !== i))}
              className="absolute grid h-5 w-5 place-items-center rounded-full bg-sheet text-[12px] text-slate-600 shadow"
              style={{ left: (b.x + b.width) * k - 10, top: b.y * k - 10 }}
            >
              ×
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

function ExportDialog({
  doc,
  flowId,
  made,
  when,
  masks,
  onClose,
}: {
  doc: ManualDoc;
  flowId: string;
  made: string | null;
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
      const html = manualHtml(doc, pictures, { blurFields, noPictures, made, when, date });
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
