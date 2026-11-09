// The run band (src-tauri/src/run_band.rs): the strip at the bottom of the
// screen while Writer is minimised for a run that works on the screen. The
// flow's nodes in a row (lib/runBand.ts), the one running kept in view;
// left the flow's name and time, right 一時停止・中止・Writer に戻す.
//
// The window never takes the focus, so the buttons act on a press without
// leaving the app the flow types into.
import type { Flow, RunEventEnvelope, StepTypeDef } from "@shikigami/schema";
import { Check, ChevronRight, Maximize2, Pause, Repeat, Square, TriangleAlert, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { laneLabel, loopRoundsText } from "../lib/keywords";
import { nodeIcon } from "../lib/nodeIcons";
import { type BandItem, type BandState, bandItems, bandStep, emptyBand, focusStep } from "../lib/runBand";
import { clockView } from "../lib/runClock";
import { LOOP_TYPES } from "../lib/stepTypes";
import { plain, sentence, typeTitle } from "../lib/sentence";
import { type BandRun, bandApi } from "./api";

export function RunBand() {
  const [run, setRun] = useState<BandRun | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [defs, setDefs] = useState<Map<string, StepTypeDef>>(new Map());
  const [usual, setUsual] = useState<Record<string, number>>({});
  const [state, setState] = useState<BandState>(emptyBand);
  const steps = flow?.steps ?? [];
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const runRef = useRef<string | null>(null);

  // The run: the one going now, and each new one the band is shown for.
  useEffect(() => {
    const show = (next: BandRun | null) => {
      // Told again when Writer steps aside again: the same run goes on.
      if (next && next.runId === runRef.current) return;
      runRef.current = next?.runId ?? null;
      setRun(next);
      setState(emptyBand());
    };
    void bandApi.current().then((r) => r && runRef.current === null && show(r), () => undefined);
    const off = bandApi.onRun(show);
    return () => void off.then((f) => f());
  }, []);

  useEffect(() => {
    void bandApi.stepTypes().then((list) => setDefs(new Map(list.map((d) => [d.type, d]))), () => undefined);
  }, []);

  // Its flow, what it did before the band opened, and the events from now on.
  useEffect(() => {
    if (!run) return;
    let live = true;
    const queue: RunEventEnvelope[] = [];
    let ready = false;
    const apply = (env: RunEventEnvelope) => setState((s) => bandStep(s, env, stepsRef.current));
    const off = bandApi.onEvent((env) => {
      if (env.runId !== run.runId) return;
      if (ready) apply(env);
      else queue.push(env);
    });
    void (async () => {
      try {
        const f = await bandApi.flow(run.flowId);
        if (!live) return;
        stepsRef.current = f.steps ?? [];
        setFlow(f);
        const record = await bandApi.record(run.runId).catch(() => null);
        if (!live) return;
        for (const env of [...(record?.events ?? []), ...queue].sort((a, b) => a.seq - b.seq)) apply(env);
      } finally {
        // A run the band no longer shows leaves its events alone.
        if (live) {
          ready = true;
          for (const env of queue) apply(env);
        }
      }
    })();
    void bandApi.stepTimes(run.flowId).then((times) => live && setUsual(times), () => undefined);
    return () => {
      live = false;
      void off.then((f) => f());
    };
  }, [run]);

  const items = useMemo(() => bandItems(steps, state, defs), [steps, state, defs]);
  const now = useNow(state.finishedAt === null);
  const ended = state.finishedAt !== null;
  const elapsed = state.startedAt === null ? 0 : (state.finishedAt ?? now) - state.startedAt;

  return (
    <div className="flex h-screen items-center gap-2.5 overflow-hidden border border-slate-200 bg-paper pr-1.5 pl-3 text-[12px] text-ink select-none">
      <div className="flex w-[150px] shrink-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 font-semibold">
          <img src="/mark.png" alt="" className="h-[18px] w-[18px] shrink-0" draggable={false} />
          <span className="truncate" title={flow?.name}>
            {flow?.name ?? t.band.title}
          </span>
        </span>
        <span className="pl-6 text-[11px] text-slate-500 tabular-nums">
          {ended ? (t.band.result[state.status] ?? "") : state.status === "paused" ? t.band.paused : t.band.elapsed(clock(elapsed))}
        </span>
      </div>
      {state.human ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-accent-500 bg-sheet px-3 py-1.5 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent-500)_15%,transparent)]">
          <TriangleAlert size={15} className="shrink-0 text-accent-600" aria-hidden="true" />
          <span className="shrink-0 font-semibold">{t.band.waiting}</span>
          <span className="truncate text-slate-600" title={state.human}>
            {state.human}
          </span>
        </div>
      ) : (
        <Track items={items} focus={focusStep(state)} defs={defs} state={state} usual={usual} now={now} ended={ended} />
      )}
      <div className="flex shrink-0 items-center gap-0.5 border-l border-slate-200 pl-1.5">
        {!ended && run && (
          <>
            <BandButton label={t.band.pause} onClick={() => void bandApi.pause(run.runId).catch(() => undefined)}>
              <Pause size={15} />
            </BandButton>
            <BandButton label={t.band.stop} onClick={() => void bandApi.stop(run.runId).catch(() => undefined)}>
              <Square size={14} />
            </BandButton>
          </>
        )}
        <BandButton label={t.band.writer} onClick={() => void bandApi.writer()}>
          <Maximize2 size={15} />
        </BandButton>
        {ended && (
          <BandButton label={t.band.close} onClick={() => void bandApi.close()}>
            <X size={15} />
          </BandButton>
        )}
      </div>
    </div>
  );
}

function BandButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-[30px] w-[30px] place-items-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-ink"
    >
      {children}
    </button>
  );
}

/** The row of nodes, scrolled so the running one sits a little left of the middle. */
function Track({
  items,
  focus,
  defs,
  state,
  usual,
  now,
  ended,
}: {
  items: BandItem[];
  focus: string | null;
  ended: boolean;
  defs: Map<string, StepTypeDef>;
  state: BandState;
  usual: Record<string, number>;
  now: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const smooth = !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // The run is over: its end.
    if (ended) {
      box.scrollTo({ left: box.scrollWidth, behavior: smooth ? "smooth" : "auto" });
      return;
    }
    const node = focus ? box.querySelector<HTMLElement>(`[data-band-step="${CSS.escape(focus)}"]`) : null;
    if (!node) return;
    // Where the node is in the row (it may sit inside frames): from the boxes on the screen.
    const at = node.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    const left = box.scrollLeft + at.left - view.left + at.width / 2 - box.clientWidth * 0.42;
    box.scrollTo({ left: Math.max(0, left), behavior: smooth ? "smooth" : "auto" });
  }, [focus, items, ended]);
  return (
    <div
      ref={scroller}
      className="band-track relative h-full min-w-0 flex-1 overflow-hidden"
      style={{ maskImage: "linear-gradient(90deg, transparent, #000 24px, #000 calc(100% - 36px), transparent)" }}
    >
      <div className="flex h-full w-max items-center px-6 pt-1">
        <Row items={items} defs={defs} state={state} usual={usual} now={now} />
      </div>
    </div>
  );
}

function Row({
  items,
  defs,
  state,
  usual,
  now,
}: {
  items: BandItem[];
  defs: Map<string, StepTypeDef>;
  state: BandState;
  usual: Record<string, number>;
  now: number;
}) {
  return (
    <>
      {items.map((item, i) => {
        const id = item.step.id ?? String(i);
        const passed = i > 0 && items[i - 1]?.state === "done";
        return (
          <div key={id} className="flex items-center">
            {i > 0 && <span aria-hidden="true" className={`h-px w-4 shrink-0 ${passed ? "bg-moegi-500" : "bg-slate-300"}`} />}
            {item.kind === "node" ? (
              <Chip item={item} defs={defs} state={state} usual={usual} now={now} />
            ) : (
              <div
                data-band-step={id}
                className={`relative flex items-center rounded-lg border px-2 pt-3 pb-1 ${
                  item.state === "now"
                    ? "border-[color-mix(in_srgb,var(--color-accent-500)_65%,var(--color-slate-300))]"
                    : "border-slate-300"
                }`}
              >
                {/* Across the frame's top edge; its name stays in view while the row scrolls under it. */}
                <span className="pointer-events-none absolute inset-x-0 top-0 flex -translate-y-1/2">
                  <span className="sticky left-7 ml-2 flex w-max items-center gap-1 bg-paper px-1 text-[11px] whitespace-nowrap text-slate-600">
                    <FrameIcon step={item.step} def={defs.get(item.step.type)} />
                    {item.step.name || typeTitle(item.step, defs.get(item.step.type))}
                    {!item.round && Object.keys(item.step.blocks ?? {}).length > 1 && (
                      <span className="flex items-center gap-1 font-semibold text-slate-700">
                        <ChevronRight size={11} aria-hidden="true" className="text-slate-400" />
                        {laneLabel(item.step, item.block, laneName(defs.get(item.step.type), item.block))}
                      </span>
                    )}
                    {item.round && (
                      <b className={`font-semibold tabular-nums ${item.state === "now" ? "text-accent-600" : "text-slate-600"}`}>
                        {loopRoundsText(item.step.type, item.round.round, item.round.total, "running")}
                      </b>
                    )}
                  </span>
                </span>
                <Row items={item.items} defs={defs} state={state} usual={usual} now={now} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function Chip({
  item,
  defs,
  state,
  usual,
  now,
}: {
  item: BandItem;
  defs: Map<string, StepTypeDef>;
  state: BandState;
  usual: Record<string, number>;
  now: number;
}) {
  const def = defs.get(item.step.type);
  const Icon = item.state === "done" ? Check : nodeIcon(item.step.type, def?.category ?? item.step.type.split(".")[0] ?? "other");
  const label = item.step.name || plain(sentence(item.step, def));
  const id = item.step.id ?? "";
  const clockOf = state.clocks[id];
  const view = item.state === "now" && clockOf ? clockView(clockOf, usual[id], now) : null;
  return (
    <span
      data-band-step={id}
      title={label}
      className={`relative flex h-[26px] max-w-[240px] shrink-0 items-center gap-1.5 rounded-md border bg-sheet px-2.5 whitespace-nowrap ${
        item.state === "now"
          ? "border-accent-500 font-medium text-ink shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent-500)_15%,transparent)]"
          : item.state === "failed"
            ? "border-shu-500 text-shu-600"
            : item.state === "done"
              ? "border-slate-200 text-slate-600"
              : "border-slate-200 text-slate-500"
      }`}
    >
      <Icon
        size={14}
        aria-hidden="true"
        className={`shrink-0 ${item.state === "done" ? "text-moegi-500" : item.state === "now" ? "text-accent-600" : ""}`}
      />
      <span className="truncate">{label}</span>
      {view?.bar && (
        <span aria-hidden="true" className="absolute inset-x-1.5 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-accent-500/20">
          <span
            className="block h-full bg-accent-500"
            style={{ width: `${Math.min(100, (view.bar.elapsed / view.bar.total) * 100)}%`, opacity: view.kind === "long" ? 0.5 : 1 }}
          />
        </span>
      )}
    </span>
  );
}

function FrameIcon({ step, def }: { step: BandItem["step"]; def: StepTypeDef | undefined }) {
  const Icon = LOOP_TYPES.has(step.type) ? Repeat : nodeIcon(step.type, def?.category ?? step.type.split(".")[0] ?? "other");
  return <Icon size={12} aria-hidden="true" />;
}

/** The label a step type gives one of its blocks (the block's name when it gives none). */
function laneName(def: StepTypeDef | undefined, block: string): string {
  return def?.blocks?.find((b) => b.name === block)?.label ?? block;
}

/** The time now, a tick a second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** 1:24, 12:05, 1:02:03. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
