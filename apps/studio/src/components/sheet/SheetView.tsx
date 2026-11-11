// The flow as one sheet of paper: what it is for and what it works with at
// the top, then its work in order, in sentences, with the screens it touches
// in the margin. Read as a chart, the same paper keeps its heading and shows
// the chart (components/chart/ChartBody.tsx) under it.
import { CircleCheck, Clock, EyeOff, FileInput, FileOutput, KeyRound, type LucideIcon, Play, Repeat, Split } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, manualApi, type ScheduleView } from "../../lib/api";
import { useStudio } from "../../context";
import { locale, t } from "../../lib/i18n";
import { buildManual, type Chapter, type Drafts, type ManualDoc, type ManualItem, type ManualManifest, type ManualShot, type ManualStep, type Mask, maskStale, type Scene } from "../../lib/manual";
import { sceneMarks } from "../../lib/manualExport";
import { describeWhen } from "../../lib/schedule";
import { type Part, plain } from "../../lib/sentence";
import { isActive } from "../../store";
import { ChartBody } from "../chart/ChartBody";
import { MaskEditor, ShotFrame, WholeShot, usePictures, useSubflows } from "../ManualView";
import { SheetHeading } from "../SheetHeading";

/** The pictures of the screens and what is done about them. */
type Pictures = {
  urls: Record<string, string>;
  want: (file: string) => void;
  masks: Record<string, Mask>;
  onWhole: (shot: ManualShot) => void;
  onMask: (shot: ManualShot) => void;
};

/** A sentence with the values it names set apart, as on a form. */
function Words({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        "text" in p ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span key={i} className="mx-0.5 rounded-[4px] border border-slate-200 bg-paper px-1.5 py-px text-[13px] text-ink">
            {p.code}
          </span>
        ),
      )}
    </>
  );
}

function Value({ icon: Icon, children }: { icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-slate-200 bg-paper px-1.5 py-px text-[13px] text-ink">
      {Icon && <Icon size={12} strokeWidth={1.75} aria-hidden="true" className="text-slate-500" />}
      {children}
    </span>
  );
}

/** What the flow takes in, gives back, runs on and logs in with: only the rows it has something to say on. */
function Facts({ doc, when }: { doc: ManualDoc; when: string[] }) {
  const w = t.sheetView;
  const rows: { icon: LucideIcon; label: string; values: string[]; plain: string[]; mark?: LucideIcon }[] = [
    { icon: FileInput, label: w.input, values: doc.uses.inputFiles, plain: doc.inputs },
    { icon: FileOutput, label: w.output, values: doc.uses.outputFiles, plain: doc.outputs },
    { icon: Clock, label: w.schedule, values: when, plain: [] },
    { icon: KeyRound, label: w.secrets, values: doc.uses.logins, plain: [], mark: KeyRound },
  ].filter((r) => r.values.length + r.plain.length > 0);
  if (rows.length === 0) return null;
  return (
    <dl className="mt-6 grid grid-cols-[124px_minmax(0,1fr)] gap-x-4 gap-y-3 border-y border-slate-200 py-5 text-[14px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="flex items-center gap-2 self-start pt-px text-slate-500">
            <r.icon size={14} strokeWidth={1.75} aria-hidden="true" />
            {r.label}
          </dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-ink">
            {r.values.map((v) => (
              <Value key={v} icon={r.mark}>
                {v}
              </Value>
            ))}
            {r.plain.length > 0 && <span>{r.plain.join(t.sheetView.and)}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The last run, and the way to run again: said once, beside the heading. */
function LastRun({ manifest, running, onRun }: { manifest: ManualManifest | null; running: boolean; onRun: () => void }) {
  const w = t.sheetView;
  const at = manifest
    ? new Date(manifest.startedAt).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div className="text-[12.5px] leading-[1.7] text-slate-500">
      {at ? (
        <p className="flex items-center gap-1.5">
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-moegi-600" />
          <b className="font-semibold text-ink">{w.lastRun}</b>
          <span className="tabular-nums">{at}</span>
        </p>
      ) : (
        <p>{w.noRun}</p>
      )}
      <button type="button" disabled={running} onClick={onRun} className="mt-0.5 inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50">
        <Play size={12} strokeWidth={2} aria-hidden="true" />
        {w.run}
      </button>
    </div>
  );
}

function StepRow({ step, picked, onPick }: { step: ManualStep; picked: boolean; onPick: (step: ManualStep) => void }) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] py-2.5">
      <span className="pt-[3px] text-[12px] text-slate-400 tabular-nums">{step.number}</span>
      <div className="min-w-0">
        <button type="button" onClick={() => onPick(step)} className={`text-left text-[15px] leading-[1.6] text-ink ${step.how ? "font-semibold" : ""}`}>
          <span className={picked ? "flow-chart-on" : ""}>{step.text}</span>
        </button>
        {step.how && plain(step.how) !== step.text && (
          <p className="mt-0.5 text-[14px] leading-[1.8] text-slate-700">
            <Words parts={step.how} />
          </p>
        )}
        {step.note && <p className="mt-1 text-[12.5px] leading-[1.7] text-slate-500">{step.note}</p>}
      </div>
    </li>
  );
}

/** A screen's picture in the margin, with what it is under it. */
function Figure({ scene, pictures }: { scene: Scene; pictures: Pictures }) {
  const shot = scene.shot;
  if (!shot) return null;
  const mask = pictures.masks[shot.key];
  return (
    <figure className="group/fig">
      {/* The whole picture opens from the picture itself: there is no room on it for a button. */}
      <div
        role="button"
        tabIndex={0}
        title={t.manual.whole}
        onClick={() => pictures.onWhole(shot)}
        onKeyDown={(e) => e.key === "Enter" && pictures.onWhole(shot)}
        className="cursor-zoom-in overflow-hidden rounded-[4px] border border-slate-200 [&_button]:hidden"
      >
        <ShotFrame shot={shot} marks={sceneMarks(scene)} ctx={pictures} small />
      </div>
      <figcaption className="mt-1.5 flex items-start gap-2 text-[12px] leading-[1.5] text-slate-500">
        <span className="min-w-0 flex-1">
          {t.manual.screenOf(scene.title, scene.app === "desktop")}
          {shot.draft && `（${t.manual.draft}）`}
          {maskStale(mask, shot) && <span className="block text-shu-600">{t.manual.maskStale}</span>}
        </span>
        <button
          type="button"
          title={t.manual.hideTitle}
          onClick={() => pictures.onMask(shot)}
          className="inline-flex shrink-0 items-center gap-1 text-slate-500 opacity-0 group-focus-within/fig:opacity-100 group-hover/fig:opacity-100 hover:text-ink"
        >
          <EyeOff size={12} strokeWidth={1.75} aria-hidden="true" />
          {t.manual.hide}
          {mask && mask.boxes.length > 0 ? ` ${mask.boxes.length}` : ""}
        </button>
      </figcaption>
    </figure>
  );
}

/** The width of the margin beside the words, and the room between the two. */
const MARGIN = "@[52rem]/paper:mr-[298px]";

/**
 * What goes with the words, in the margin beside them: hung from where it is
 * said, and stacked down the margin when the words beside it are short, so a
 * tall picture never pushes the next step down. On a narrow paper it lies
 * between the lines instead.
 */
function Aside({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 @[52rem]/paper:clear-right @[52rem]/paper:float-right @[52rem]/paper:mt-2.5 @[52rem]/paper:-mr-[298px] @[52rem]/paper:w-[250px]">{children}</div>;
}

type RowCtx = { pictures: Pictures; picked: string | null; onPick: (step: ManualStep) => void };

function Item({ item, ctx }: { item: ManualItem; ctx: RowCtx }) {
  if (item.kind === "scene") {
    return (
      <>
        {item.shot && (
          <Aside>
            <Figure scene={item} pictures={ctx.pictures} />
          </Aside>
        )}
        <ol>
          {[...item.steps, null].map((s, i) => (
            <li key={s?.key ?? "end"} className="contents">
              {item.waits
                .filter((x) => x.at === i)
                .map((x, k) => (
                  <p key={k} className="flex items-start gap-1.5 py-1 pl-7 text-[12.5px] leading-[1.7] text-slate-500">
                    <Clock size={12} strokeWidth={1.75} aria-hidden="true" className="mt-[5px] shrink-0" />
                    {x.text}
                  </p>
                ))}
              {s && (
                <ol>
                  <StepRow step={s} picked={ctx.picked === s.stepId} onPick={ctx.onPick} />
                </ol>
              )}
            </li>
          ))}
        </ol>
      </>
    );
  }
  if (item.kind === "action") {
    return (
      <ol>
        <StepRow step={item.step} picked={ctx.picked === item.step.stepId} onPick={ctx.onPick} />
      </ol>
    );
  }
  if (item.kind === "quiet") return <p className="py-1.5 pl-7 text-[13px] leading-[1.7] text-slate-500">{item.texts.join(t.sheetView.and)}</p>;
  // What repeats, what runs only sometimes and what belongs together: a rule down the side, named at its top.
  const Icon = item.kind === "loop" ? Repeat : item.kind === "branch" ? Split : null;
  const more = item.kind === "loop" && item.times !== null ? t.manual.loopTimes(item.times) : item.kind === "branch" && item.taken !== null ? (item.taken ? t.manual.took : t.manual.notTaken) : null;
  return (
    <div className={`my-2 ml-[5px] border-l-2 pl-[21px] ${item.kind === "loop" ? "border-[var(--manual-loop-line)]" : "border-slate-200"}`}>
      {(item.label || more) && (
        <p className="flex flex-wrap items-center gap-x-2 py-1.5 text-[13px] text-slate-600">
          {Icon && <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-slate-500" />}
          <span className="font-medium">{item.label}</span>
          {more && <span className="text-[12px] text-slate-400">{more}</span>}
        </p>
      )}
      <div className={item.kind === "branch" && item.taken === false ? "opacity-70" : ""}>
        {item.items.map((c, i) => (
          <Item key={i} item={c} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

function ChapterView({ chapter, ctx }: { chapter: Chapter; ctx: RowCtx }) {
  // A chapter that is one loop or one branch is named by it: its name is not said twice.
  const only = chapter.items.length === 1 ? chapter.items[0] : undefined;
  const whole = only && "items" in only && only.label === chapter.title ? only : null;
  return (
    <section data-chapter={chapter.number} className="mt-10 scroll-mt-6">
      <h2 className="mb-2">
        <SheetHeading n={chapter.role ? undefined : chapter.number} size="chapter" aside={whole?.kind === "loop" && whole.times !== null ? t.manual.loopTimes(whole.times) : undefined}>
          {chapter.title}
        </SheetHeading>
      </h2>
      {(whole?.items ?? chapter.items).map((item, i) => (
        <Item key={i} item={item} ctx={ctx} />
      ))}
    </section>
  );
}

/** The paper every way of reading the flow lies on: its outline, its corners, and the flow's name at its top. */
const PAPER = "rounded-[3px] bg-sheet shadow-[0_0_0_1px_var(--color-slate-300),0_1px_2px_rgb(16_24_40/0.07),0_10px_24px_-12px_rgb(16_24_40/0.16)]";

export function SheetView({ mode }: { mode: "sheet" | "chart" }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const startRun = useStudio((s) => s.startRun);
  const select = useStudio((s) => s.select);
  const selection = useStudio((s) => s.selection);
  const running = useStudio((s) => isActive(s.run));
  const testing = useStudio((s) => s.stepTest?.running ?? false);
  const revision = useStudio((s) => s.flow?.revision);
  const [manifest, setManifest] = useState<ManualManifest | null>(null);
  const [masks, setMasks] = useState<Record<string, Mask>>({});
  const [drafts, setDrafts] = useState<Drafts>({});
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [masking, setMasking] = useState<ManualShot | null>(null);
  const [whole, setWhole] = useState<ManualShot | null>(null);
  const subflows = useSubflows(flow);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const flowId = flow?.id;
  const desk = useRef<HTMLDivElement>(null);

  // Read again when the flow changes (a changed step loses its old picture),
  // when a run of it ends and when a step tried alone ends.
  useEffect(() => {
    if (!flowId || running || testing) return;
    let live = true;
    void manualApi
      .get(flowId)
      .then((m) => {
        if (!live) return;
        setManifest(m.manifest ?? null);
        setMasks(m.masks ?? {});
        setDrafts(m.drafts ?? {});
      })
      .catch(() => {});
    void api
      .listSchedules()
      .then((list) => live && setSchedules(list.schedules.filter((s) => s.flowId === flowId && s.enabled)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [flowId, running, testing, revision]);

  const { urls, want } = usePictures(flowId, manifest?.runId);
  const doc = useMemo(() => (flow ? buildManual(flow, defs, manifest, subflows, masks, drafts) : null), [flow, defs, manifest, subflows, masks, drafts]);
  if (!flow || !doc) return null;

  const pictures: Pictures = { urls, want, masks, onWhole: setWhole, onMask: setMasking };
  const ctx: RowCtx = {
    pictures,
    picked: selection?.kind === "step" ? selection.stepId : null,
    onPick: (step) => select({ kind: "step", stepId: step.stepId }),
  };
  const when = schedules.map((s) => describeWhen(s.when));
  const chart = mode === "chart";

  return (
    <div ref={desk} className="flow-chart absolute inset-0 overflow-auto px-5 py-7" data-sheet={mode}>
      <div className="mx-auto flex w-fit max-w-full items-start gap-6">
        {!chart && doc.chapters.length > 1 && (
          <nav className="sticky top-0 hidden w-[168px] shrink-0 pt-11 text-[12.5px] leading-[1.5] text-slate-500 @[76rem]:block">
            <ol className="space-y-2.5">
              {doc.chapters.map((c) => (
                <li key={c.number}>
                  <button
                    type="button"
                    onClick={() => desk.current?.querySelector(`[data-chapter="${c.number}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                    className="grid w-full grid-cols-[18px_minmax(0,1fr)] text-left hover:text-ink"
                  >
                    <span className="text-slate-400 tabular-nums">{c.number}</span>
                    {c.title}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        {/* As a chart the paper is as wide as the chart (so it cannot be measured against, and keeps the plain margins). */}
        <article className={`min-w-0 ${PAPER} ${chart ? "w-fit" : "@container/paper w-[980px] max-w-full"}`}>
          <header className={`flow-root px-10 pt-11 @[52rem]/paper:pr-7 @[52rem]/paper:pl-[72px]`}>
            <div className={MARGIN}>
              {!chart && (
                <Aside>
                  <LastRun manifest={manifest} running={running} onRun={() => void startRun()} />
                </Aside>
              )}
              <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.01em] text-ink">{doc.title}</h1>
              {doc.description && <p className="mt-2 text-[14px] leading-relaxed text-slate-600">{doc.description}</p>}
              <Facts doc={doc} when={when} />
            </div>
          </header>
          {chart ? (
            <ChartBody />
          ) : (
            <div className="flow-root px-10 pb-16 @[52rem]/paper:pr-7 @[52rem]/paper:pl-[72px]">
              <div className={MARGIN}>
                {doc.chapters.map((c) => (
                  <ChapterView key={c.number} chapter={c} ctx={ctx} />
                ))}
              </div>
            </div>
          )}
        </article>
      </div>
      {masking && (
        <MaskEditor
          shot={masking}
          url={urls[masking.file]}
          mask={masks[masking.key]}
          onCancel={() => setMasking(null)}
          onSave={(mask) => {
            const next = { ...masks, [masking.key]: mask };
            setMasks(next);
            void manualApi.saveMasks(flow.id, next).catch(() => {});
            setMasking(null);
          }}
        />
      )}
      {whole && <WholeShot shot={whole} url={urls[whole.file]} mask={masks[whole.key]} onClose={() => setWhole(null)} />}
    </div>
  );
}
