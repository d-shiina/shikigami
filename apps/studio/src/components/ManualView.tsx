// The 手順書: the open flow read as a procedure, with the screens of the last
// run from Studio (docs/design/manual.md). 「編集する」 switches to the
// editable outline (StoryView).
import { Masthead, Stripe } from "./Masthead";
import type { Flow, PublishedState, Step, VersionSummary } from "@spellsheet/schema";
import { AppWindow, Clock, Download, EyeOff, Lightbulb, Maximize2, MessageSquareText, Pencil, Play, Repeat, RotateCw, Split, TriangleAlert, Workflow, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAgentApi } from "../agent";
import { currentChat } from "../agent";
import { useStudio } from "../context";
import { api, type ScheduleView, manualApi } from "../lib/api";
import { locale, t } from "../lib/i18n";
import {
  buildManual,
  cropOf,
  type Drafts,
  type Edition,
  editionOf,
  frameTree,
  type ManualDoc,
  type ManualManifest,
  type ManualShot,
  type ManualStep,
  blurRegions,
  type Mask,
  type MaskBox,
  maskStale,
  type Page,
  type PageNode,
  pagesOf,
  type Rect,
  type Scene,
  overviewRows,
} from "../lib/manual";
import { burnShot, manualHtml, operated, type SceneMark, sceneMarks, scenesOf } from "../lib/manualExport";
import { describeWhen } from "../lib/schedule";
import { CALL } from "../lib/stepTypes";
import { isActive } from "../store";
import { Sentence, StoryView } from "./StoryView";
import { CanvasDock } from "./Toolbar";
import { SheetHeading, SheetSubheading } from "./SheetHeading";
import { SheetNumber } from "./SheetNumber";

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

/** A day as the cover and the revision history say it (2026/11/09). */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Where the screens came from, short: 「11月9日 09:20 の実行」. */
function shotLine(manifest: ManualManifest | null, doc: ManualDoc): string {
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
  /** 「業務どおり」 ticked, by step key (this PC only). */
  checks: Record<string, boolean>;
  onCheck: (key: string, on: boolean) => void;
  /** Moves the desk to a page. */
  onPage: (n: number) => void;
};

const CHECKS_KEY = "spellsheet.studio.manualChecks.";

/** The 「業務どおり」 ticks of a flow: a convenience on this PC, kept in the browser. */
function useChecks(flowId: string | undefined) {
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let read: Record<string, boolean> = {};
    try {
      read = flowId ? (JSON.parse(localStorage.getItem(CHECKS_KEY + flowId) ?? "{}") as Record<string, boolean>) : {};
    } catch {
      read = {};
    }
    setChecks(read);
  }, [flowId]);
  const onCheck = (key: string, on: boolean) =>
    setChecks((now) => {
      const next = { ...now };
      if (on) next[key] = true;
      else delete next[key];
      try {
        if (flowId) localStorage.setItem(CHECKS_KEY + flowId, JSON.stringify(next));
      } catch {
        // Not kept: the ticks last until Studio closes.
      }
      return next;
    });
  return { checks, onCheck };
}

/** The page most in view on the desk. */
function useActivePage(desk: React.RefObject<HTMLDivElement | null>, count: number): number {
  const [active, setActive] = useState(1);
  useEffect(() => {
    const root = desk.current;
    if (!root) return;
    const seen = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRatio);
        let best = 1;
        let ratio = -1;
        for (const [n, r] of seen) if (r > ratio || (r === ratio && n < best)) [best, ratio] = [n, r];
        setActive(best);
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    for (const el of root.querySelectorAll("[data-page]")) observer.observe(el);
    return () => observer.disconnect();
  }, [desk, count]);
  return active;
}

/** A4 sheet width in CSS pixels, and the desk's side padding (px-6). */
const SHEET_WIDTH = 794;
const DESK_PADDING = 24;

/**
 * How much to shrink the sheets so a whole page width fits the desk, like a PDF viewer's
 * "fit to width". Never enlarges: at full size the sheet keeps its print proportions.
 */
function useSheetFit(desk: React.RefObject<HTMLDivElement | null>, count: number): number {
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const root = desk.current;
    if (!root) return;
    const measure = () => {
      const room = root.clientWidth - DESK_PADDING * 2;
      if (room > 0) setFit(Math.min(1, Math.round((room / SHEET_WIDTH) * 1000) / 1000));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [desk, count]);
  return fit;
}

export function ManualView({ onView }: { onView: (view: View) => void }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const startRun = useStudio((s) => s.startRun);
  const goToPlace = useStudio((s) => s.goToPlace);
  const running = useStudio((s) => isActive(s.run));
  const testing = useStudio((s) => s.stepTest?.running ?? false);
  const revision = useStudio((s) => s.flow?.revision);
  const agent = useAgentApi();
  const editing = useStudio((s) => s.manualEditing);
  const setEditing = useStudio((s) => s.setManualEditing);
  // Leaving the 手順書 leaves its editing too.
  useEffect(() => () => setEditing(false), [setEditing]);
  const [manifest, setManifest] = useState<ManualManifest | null>(null);
  const [masks, setMasks] = useState<Record<string, Mask>>({});
  const [drafts, setDrafts] = useState<Drafts>({});
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [published, setPublished] = useState<PublishedState | null>(null);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [masking, setMasking] = useState<ManualShot | null>(null);
  const [whole, setWhole] = useState<ManualShot | null>(null);
  const [exporting, setExporting] = useState(false);
  const subflows = useSubflows(flow);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const flowId = flow?.id;

  // Read again when the flow changes (a changed node loses its old
  // picture), when a run of it ends and when a node tried alone ends.
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
      .publishedState(flowId)
      .then((p) => live && setPublished(p))
      .catch(() => {});
    void api
      .listVersions(flowId)
      .then((list) => live && setVersions(list))
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
  const pages = useMemo(() => (doc ? pagesOf(doc) : []), [doc]);
  const desk = useRef<HTMLDivElement>(null);
  const active = useActivePage(desk, editing ? 0 : pages.length);
  const fit = useSheetFit(desk, editing ? 0 : pages.length);
  const { checks, onCheck } = useChecks(flowId);

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
    checks,
    onCheck,
    onPage: (n) => desk.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
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
  const edition = editionOf(published, versions, day);
  const shotAt = shotLine(manifest, doc);

  return (
    <div className="@container/manual h-full min-h-0">
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] @[40rem]/manual:grid-cols-[196px_minmax(0,1fr)]">
        <div className="hidden @[40rem]/manual:contents">
          <PageList pages={pages} active={active} ctx={ctx} />
        </div>
        <div ref={desk} className="relative min-h-0 overflow-y-auto bg-[var(--manual-desk)] px-6 pb-16" data-manual>
          <div className="@container/bar sticky top-0 z-10 -mx-6 mb-2 bg-[var(--manual-desk)]/95 px-6 py-2.5 text-[12.5px] text-slate-500 backdrop-blur-sm">
            <div className="flex items-center gap-2.5">
              {made ? (
                <BarNote dot="bg-moegi-500" text={made} />
              ) : doc.drafts > 0 ? (
                <BarNote dot="bg-slate-400" text={t.manual.draftsOnly} />
              ) : (
                <BarNote text={t.manual.noRun} />
              )}
              <span className="ml-auto flex shrink-0 gap-2">
                <ToolButton icon={made ? RotateCw : Play} label={made ? t.manual.retake : t.manual.runNow} title={t.manual.retakeTitle} disabled={running} onClick={() => void startRun()} />
                <ToolButton icon={Download} label={t.manual.export} onClick={() => setExporting(true)} />
                <ToolButton icon={Pencil} label={t.manual.edit} title={t.manual.editTitle} onClick={() => setEditing(true)} />
              </span>
            </div>
          </div>
          <div style={{ zoom: fit }}>
            {pages.map((page) => (
              <Sheet key={page.number} page={page} total={pages.length} title={doc.title} edition={edition}>
                {page.kind === "cover" ? (
                  <Cover
                    doc={doc}
                    made={made}
                    shotAt={shotAt}
                    edition={edition}
                    when={when}
                    pages={pages}
                    showMissing={doc.missing > 0 && (manifest !== null || doc.drafts > 0)}
                  />
                ) : (
                  <BodyPage page={page} ctx={ctx} />
                )}
              </Sheet>
            ))}
          </div>
        </div>
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
        {exporting && (
          <ExportDialog doc={doc} flowId={flow.id} made={made} shotAt={shotAt} edition={edition} when={when} masks={masks} onClose={() => setExporting(false)} />
        )}
      </div>
    </div>
  );
}

/** What the screens on the desk came from. Wraps to two lines at most; the whole text is on hover. */
function BarNote({ dot, text }: { dot?: string; text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5" title={text}>
      {dot && <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
      <span className="line-clamp-2 min-w-0 break-words">{text}</span>
    </span>
  );
}

/** A button on the bar above the sheets. When the bar is narrow only the icon stays; the name moves to the hover text. */
function ToolButton({ icon: Icon, label, title, disabled, onClick }: { icon: typeof Play; label: string; title?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title ? `${label}\n${title}` : label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 bg-sheet px-1.5 py-1 text-[13px] whitespace-nowrap text-ink enabled:hover:bg-paper disabled:opacity-50 @[36rem]/bar:px-2.5"
    >
      <Icon size={14} strokeWidth={1.75} className="shrink-0" />
      <span className="hidden @[36rem]/bar:inline">{label}</span>
    </button>
  );
}

function Facts({ doc, when }: { doc: ManualDoc; when: string[] }) {
  const rows = overviewRows(doc, when).map((r) => [r.label, r.values, r.role ? `var(--color-role-${r.role})` : null] as const);
  return (
    <table className="w-full border-collapse text-[13px]">
      <tbody>
        {rows.map(([k, v, colour]) => (
          <tr key={k}>
            <th
              scope="row"
              className="w-[150px] border border-slate-200 bg-paper px-2.5 py-1.5 text-left font-normal text-slate-500"
              style={colour ? { boxShadow: `inset 3px 0 ${colour}` } : undefined}
            >
              {k}
            </th>
            <td className="border border-slate-200 px-2.5 py-1.5">{v.length > 0 ? v.join("、") : <span className="text-slate-400">{t.manual.none}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The list of sheets beside the desk: where each screen is, which one is in view. */
function PageList({ pages, active, ctx }: { pages: Page[]; active: number; ctx: Ctx }) {
  useEffect(() => {
    document.querySelector(`[data-page-item="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <nav aria-label={t.manual.pages} className="min-h-0 overflow-y-auto border-r border-slate-200 bg-paper px-2 py-3">
      <h4 className="mb-2 ml-2 text-[12px] font-medium text-slate-500">{t.manual.pages}</h4>
      {pages.map((page) => {
        const shot = page.kind === "body" ? page.shot : null;
        // A picture with hidden parts stays out of the thumbnail: at this size the boxes would not hide anything reliably.
        const masked = shot ? (ctx.masks[shot.key]?.boxes.length ?? 0) > 0 : false;
        const url = shot && !masked ? ctx.urls[shot.file] : undefined;
        return (
          <button
            key={page.number}
            type="button"
            data-page-item={page.number}
            onClick={() => ctx.onPage(page.number)}
            className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] ${page.number === active ? "bg-brand-50 text-ink" : "text-slate-600 hover:bg-slate-100"}`}
          >
            <span className="relative h-[42px] w-[30px] shrink-0 overflow-hidden rounded-[2px] border border-slate-300 bg-sheet shadow-[0_1px_1px_rgb(0_0_0/0.05)]">
              <span className="absolute top-[5px] left-[4px] h-[2px] w-[18px] bg-slate-400" />
              {url ? (
                <img src={url} alt="" className="absolute top-[11px] left-[3px] w-[22px] border border-slate-200" />
              ) : (
                <>
                  <span className="absolute top-[11px] left-[4px] h-[2px] w-[12px] bg-slate-300" />
                  <span className="absolute top-[16px] left-[4px] h-[2px] w-[16px] bg-slate-300" />
                  <span className="absolute top-[21px] left-[4px] h-[2px] w-[10px] bg-slate-300" />
                </>
              )}
            </span>
            <span className="min-w-0 leading-[1.35]">
              {page.number}
              <small className="block truncate text-[11.5px] text-slate-500">
                {page.kind === "cover" ? t.manual.cover : shortTitle(page.title)}
              </small>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/** 「サンプル商事 受注管理システム - ログイン」 → 「ログイン」: the part that changes from screen to screen. */
function shortTitle(title: string): string {
  const parts = title.split(/\s+[-|–—:：]\s+/);
  return parts.length > 1 ? (parts.at(-1) ?? title) : title;
}

/** One A4 sheet on the desk: the flow's name and version above, the page number below. */
function Sheet({ page, total, title, edition, children }: { page: Page; total: number; title: string; edition: Edition; children: React.ReactNode }) {
  return (
    <section
      data-page={page.number}
      className={`relative mx-auto mb-7 flex min-h-[1123px] w-[794px] scroll-mt-14 flex-col overflow-hidden bg-sheet px-12 pb-16 shadow-[0_1px_2px_rgb(20_30_50/0.08),0_8px_24px_rgb(20_30_50/0.08)] pt-11`}
    >
      <Stripe className="top-0 h-1" />
      {page.kind === "body" && (
        <>
          <header className="mb-5 flex items-baseline justify-between gap-4 border-b border-[var(--manual-navy)] pb-1.5 text-[11.5px] text-slate-500">
            <b className="truncate font-semibold text-[var(--manual-navy)]">{title}</b>
            <span className="shrink-0">{[edition.label, edition.updated].filter(Boolean).join("　")}</span>
          </header>
        </>
      )}
      {children}
      <footer className="absolute inset-x-12 bottom-6 flex justify-between border-t border-slate-200 pt-1.5 text-[10.5px] text-slate-400">
        <span className="text-[var(--manual-navy)]">{t.manual.madeWith}</span>
        <span>{t.manual.pageOf(page.number, total)}</span>
      </footer>
    </section>
  );
}

function CoverHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-6 mb-2">
      <SheetSubheading>{children}</SheetSubheading>
    </h2>
  );
}

function Cover({
  doc,
  made,
  shotAt,
  edition,
  when,
  pages,
  showMissing,
}: {
  doc: ManualDoc;
  made: string | null;
  shotAt: string;
  edition: Edition;
  when: string[];
  pages: Page[];
  showMissing: boolean;
}) {
  const firstPage = (n: number) => pages.find((p) => p.kind === "body" && p.chapter.number === n && p.first)?.number;
  const info: [string, string][] = [
    [t.manual.edition, edition.label],
    ...(edition.updated ? ([[t.manual.updated, edition.updated]] as [string, string][]) : []),
    [t.manual.shotAt, shotAt],
  ];
  return (
    <>
      <Masthead kind={t.manual.kind} title={doc.title} facts={info.map(([label, value]) => ({ label, value }))}>
        {edition.changedSince !== null && <p className="mt-2 text-[12px] text-slate-500">{t.manual.changedSince(edition.changedSince)}</p>}
      </Masthead>
      {doc.description && (
        <>
          <CoverHeading>{t.manual.about}</CoverHeading>
          <p className="text-[14px] leading-[1.85] text-slate-700">{doc.description}</p>
        </>
      )}
      <CoverHeading>{t.manual.overview}</CoverHeading>
      <Facts doc={doc} when={when} />
      {showMissing && <p className="mt-2 text-[12.5px] text-slate-500">{t.manual.missing(doc.missing)}</p>}
      {made && doc.drafts > 0 && <p className="mt-2 text-[12.5px] text-slate-500">{t.manual.someDrafts(doc.drafts)}</p>}
      <CoverHeading>{t.manual.contents}</CoverHeading>
      <ol aria-label={t.manual.contents}>
        {doc.chapters.map((c) => (
          <li key={c.number} className="flex items-baseline gap-2.5 py-1 text-[13.5px]">
            <SheetNumber n={c.number} className="size-[18px] self-center text-[11px]" />
            <span className="min-w-0">
              {c.title}
              {c.alongside.length > 0 && <span className="ml-2 text-[12px] text-slate-500">（{t.manual.alongsideNote(c.alongside).replace(/。$/, "")}）</span>}
            </span>
            <span className="min-w-4 flex-1 -translate-y-1 border-b border-dotted border-slate-300" />
            <span className="shrink-0 text-[12.5px] text-slate-500 tabular-nums">{firstPage(c.number) ?? ""}</span>
          </li>
        ))}
      </ol>
      {edition.revisions.length > 0 && (
        <>
          <CoverHeading>{t.manual.revisions}</CoverHeading>
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="bg-paper text-left text-slate-600">
                <th className="w-[84px] border border-slate-200 px-2 py-1 font-semibold">{t.manual.edition}</th>
                <th className="w-[120px] border border-slate-200 px-2 py-1 font-semibold">{t.manual.revisionDate}</th>
                <th className="border border-slate-200 px-2 py-1 font-semibold">{t.manual.revisionText}</th>
              </tr>
            </thead>
            <tbody>
              {edition.revisions.map((r) => (
                <tr key={r.label}>
                  <td className="border border-slate-200 px-2 py-1">{r.label}</td>
                  <td className="border border-slate-200 px-2 py-1 tabular-nums">{r.date}</td>
                  <td className="border border-slate-200 px-2 py-1">{r.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="mt-6 flex gap-1.5 text-[12.5px] leading-[1.7] text-slate-500">
        <Pencil size={12} className="mt-[5px] shrink-0" />
        {t.manual.checkHint}
      </p>
      {doc.pictures > 0 && <p className="mt-auto pt-8 text-[11.5px] text-slate-400">{t.manual.privacy}</p>}
    </>
  );
}

function BodyPage({ page, ctx }: { page: Extract<Page, { kind: "body" }>; ctx: Ctx }) {
  const { chapter } = page;
  return (
    <>
      {page.first ? (
        <>
          <h2 className="mb-1.5 border-b-2 border-[var(--manual-navy)] pb-2">
            <SheetHeading n={chapter.number} size="chapter">
              {chapter.title}
            </SheetHeading>
          </h2>
          <p className="mb-4 min-h-[1px] text-[12.5px] text-slate-500">{chapter.alongside.length > 0 ? t.manual.alongsideNote(chapter.alongside) : ""}</p>
        </>
      ) : (
        <p className="mb-4 text-[12.5px] text-slate-500">
          {chapter.number}. {chapter.title}
          {t.manual.continued}
        </p>
      )}
      {frameTree(page.blocks).map((n, i) => (
        <NodeView key={i} node={n} ctx={ctx} />
      ))}
    </>
  );
}

function Taken({ taken }: { taken: boolean | null }) {
  if (taken === null) return null;
  return (
    <span className={`rounded-full border bg-sheet px-2 text-[11.5px] font-normal ${taken ? "border-moegi-500 text-moegi-600" : "border-slate-300 text-slate-500"}`}>
      {taken ? t.manual.took : t.manual.notTaken}
    </span>
  );
}

/** A branch, loop or group as a frame with its heading; anything else as itself. */
function NodeView({ node, ctx }: { node: PageNode; ctx: Ctx }) {
  if (node.kind === "item") {
    const item = node.block.item;
    if (item.kind === "scene") return <SceneCard scene={item} ctx={ctx} />;
    if (item.kind === "action")
      return (
        <div className="mb-3">
          <ol className="border-t border-slate-200">
            <StepRow step={item.step} ctx={ctx} />
          </ol>
          <Logins steps={[item.step]} />
        </div>
      );
    return (
      <div className="my-2.5 flex items-start gap-2 text-[12.5px] leading-[1.7] text-slate-500">
        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] bg-slate-100">
          <Workflow size={11} />
        </span>
        <div>
          <b className="font-semibold text-slate-600">{t.manual.quiet}</b>　{item.texts.join("・")}
        </div>
      </div>
    );
  }
  const item = node.label.item;
  const more = node.label.continued ? t.manual.continued : "";
  const look =
    item.kind === "branch"
      ? { border: "var(--flow-decide-line)", head: "var(--flow-decide-fill)", colour: undefined }
      : item.kind === "loop"
        ? { border: "var(--manual-loop-line)", head: "var(--manual-loop-bg)", colour: "var(--manual-navy)" }
        : { border: "var(--color-slate-300)", head: "var(--color-paper)", colour: undefined };
  return (
    <div className="my-3 rounded-md border" style={{ borderColor: look.border }}>
      <div
        className="flex flex-wrap items-center gap-2 rounded-t-md border-b px-3.5 py-1.5 text-[13px] font-semibold"
        style={{ borderColor: look.border, background: look.head, color: look.colour }}
      >
        {item.kind === "branch" && <Split size={14} className="shrink-0" />}
        {item.kind === "loop" && <Repeat size={14} className="shrink-0" />}
        <span>
          {item.label}
          {more}
        </span>
        {item.kind === "branch" && <Taken taken={item.taken} />}
        {item.kind === "loop" && item.times !== null && <span className="ml-auto text-[12px] font-normal text-slate-500">{t.manual.loopTimes(item.times)}</span>}
      </div>
      <div className={`px-3.5 pt-0.5 pb-2.5 ${item.kind === "branch" && item.taken === false ? "opacity-70" : ""}`}>
        {node.children.map((c, i) => (
          <NodeView key={i} node={c} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

/** A boxed note under a step: 確認 (what the flow waits for), 注意 (a login), ポイント (the node's メモ). */
function Note({ kind, text }: { kind: "check" | "caution" | "point"; text: string }) {
  const [name, Icon, line, bg, colour] =
    kind === "check"
      ? [t.manual.noteCheck, Clock, "var(--manual-check)", "var(--manual-check-bg)", "var(--manual-check)"]
      : kind === "caution"
        ? [t.manual.noteCaution, TriangleAlert, "var(--manual-caution)", "var(--manual-caution-bg)", "var(--manual-caution)"]
        : [t.manual.notePoint, Lightbulb, "var(--manual-point-line)", "var(--manual-point-bg)", "var(--manual-point)"];
  return (
    <div className="my-2 flex gap-2.5 rounded-[4px] border-l-[3px] px-3 py-2 text-[12.5px] leading-[1.7] font-normal text-slate-600" style={{ borderColor: line, background: bg }}>
      <Icon size={15} className="mt-[3px] shrink-0" style={{ color: colour }} />
      <div>
        <b className="block font-semibold text-ink">{name}</b>
        {text}
      </div>
    </div>
  );
}

function Logins({ steps }: { steps: ManualStep[] }) {
  const names = [...new Set(steps.flatMap((s) => (s.login ? [s.login] : [])))];
  return (
    <>
      {names.map((name) => (
        <Note key={name} kind="caution" text={t.manual.loginCaution(name)} />
      ))}
    </>
  );
}

function StepRow({ step, ctx }: { step: ManualStep; ctx: Ctx }) {
  return (
    <li className="group/step relative flex gap-2.5 border-b border-slate-200 py-2">
      <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-primary text-[13px] font-bold text-on-primary">{step.number}</span>
      <div className="min-w-0 flex-1 text-[14.5px] leading-[1.65] font-semibold">
        {step.text}
        {step.how && (
          <span className="block text-[12.5px] leading-[1.6] font-normal text-slate-500">
            <Sentence parts={step.how} />
          </span>
        )}
        {step.note && <Note kind="point" text={step.note} />}
        <span className="mt-1 hidden gap-1.5 font-normal group-hover/step:flex group-focus-within/step:flex">
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
      <label title={t.manual.asExpectedTitle} className="flex w-[84px] shrink-0 cursor-pointer items-start justify-end gap-1.5 pt-[3px] text-[12px] text-slate-500">
        {t.manual.asExpected}
        <input
          type="checkbox"
          checked={ctx.checks[step.key] ?? false}
          onChange={(e) => ctx.onCheck(step.key, e.target.checked)}
          className="mt-[1px] h-4 w-4 accent-[var(--color-moegi-600)]"
        />
      </label>
    </li>
  );
}

function SceneRows({ waits, step, ctx }: { waits: Scene["waits"]; step: ManualStep | null; ctx: Ctx }) {
  return (
    <>
      {waits.map((w, i) => (
        <li key={i}>
          <Note kind="check" text={w.text} />
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
    <div className="mt-3 mb-4">
      <div className="mb-1.5 flex items-center gap-2 text-[12.5px] text-slate-500">
        <AppWindow size={14} />
        <b className="font-semibold text-ink">{t.manual.screenOf(scene.title, scene.app === "desktop")}</b>
        {shot?.draft && (
          <span title={shot.draft === "ai" ? t.manual.draftByAi : t.manual.draftByStudio} className="rounded-[4px] border border-slate-300 px-1.5 text-[11.5px] text-slate-500">
            {t.manual.draft}
          </span>
        )}
        {shot && maskStale(mask, shot) && <span className="text-accent-600">{t.manual.maskStale}</span>}
        {shot && (
          <button
            type="button"
            title={t.manual.hideTitle}
            onClick={() => ctx.onMask(shot)}
            className="ml-auto inline-flex items-center gap-1 rounded-[5px] px-1.5 text-slate-600 hover:bg-slate-100"
          >
            <EyeOff size={13} />
            {t.manual.hide}
            {mask && mask.boxes.length > 0 ? ` ${mask.boxes.length}` : ""}
          </button>
        )}
      </div>
      {shot ? (
        <div className="overflow-hidden border border-slate-300">
          <ShotFrame shot={shot} marks={sceneMarks(scene)} ctx={ctx} />
        </div>
      ) : (
        <p className="text-[12px] text-slate-400">{t.manual.noPicture}</p>
      )}
      <ol className="mt-2.5 border-t border-slate-200">
        {[...scene.steps, null].map((s, i) => (
          <SceneRows key={s?.key ?? "end"} waits={scene.waits.filter((w) => w.at === i)} step={s} ctx={ctx} />
        ))}
      </ol>
      <Logins steps={scene.steps} />
    </div>
  );
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

function ShotFrame({ shot, marks, ctx }: { shot: ManualShot; marks: SceneMark[]; ctx: Ctx }) {
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
          {marks.map((m, i) => (
            <span
              key={m.number ?? `wait-${i}`}
              title={m.number === null ? t.manual.waitsHere : undefined}
              className={`absolute rounded-[4px] border-[2.5px] ${
                m.number === null ? "border-dashed border-slate-600" : "border-primary shadow-[0_0_0_3px_rgb(10_111_168/0.2)]"
              }`}
              style={{ left: (m.rect.x - crop.x) * k - 3, top: (m.rect.y - crop.y) * k - 3, width: m.rect.width * k + 6, height: m.rect.height * k + 6 }}
            >
              <i
                className={`absolute top-1/2 -left-[30px] -mt-[10.5px] grid h-[21px] w-[21px] place-items-center rounded-full text-[12px] font-bold not-italic shadow-[0_0_0_2px_white] ${
                  m.number === null ? "bg-slate-600 text-white" : "bg-primary text-on-primary"
                }`}
              >
                {m.number ?? <Clock size={12} />}
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
        <MaskBoxes boxes={mask?.boxes ?? []} regions={shot.regions} crop={{ x: 0, y: 0, width: shot.width, height: shot.height }} k={k} />
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

function ExportDialog({
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
