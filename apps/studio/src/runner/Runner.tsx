// The run window (competitive-gaps.md #17): pick a published flow, fill
// in the form made from its inputs, run it, and see what came out. Nothing
// here edits a flow; that stays in Studio.
import type { ProjectFile, RunEventEnvelope, RunReport, StepTypeDef } from "@shikigami/schema";
import { Check, Circle, FileText, FolderOpen, Loader2, Play, Search, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { WindowControls } from "../components/WindowControls";
import { ApiError, api } from "../lib/api";
import { relativeTime } from "../lib/changes";
import { explainError } from "../lib/errorText";
import { t } from "../lib/i18n";
import { plain, sentence } from "../lib/sentence";
import { findStep } from "../store";
import { type RunnerApi, type RunnerItem, runnerApi } from "./api";
import { choiceLabel, collect, type Field, fieldsOf, formatValue, initialValues, isOutput, labelOf, type Values } from "./form";
import { progress, type TopState } from "./progress";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function TitleBar() {
  return (
    <header data-tauri-drag-region className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-200 bg-sheet pl-3 select-none">
      <img src="/mark.png" alt="" className="h-4 w-4" draggable={false} />
      <span data-tauri-drag-region className="flex-1 text-[12.5px] font-semibold">
        {t.runner.title}
      </span>
      <WindowControls />
    </header>
  );
}

const DOT: Record<string, string> = { succeeded: "bg-moegi-500", failed: "bg-shu-500", cancelled: "bg-slate-400" };

function LastRun({ item }: { item: RunnerItem }) {
  const last = item.lastRun;
  if (!last) return <span>{t.runner.never}</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-[7px] w-[7px] rounded-full ${DOT[last.status] ?? "bg-accent-500"}`} aria-hidden="true" />
      {t.runner.last(relativeTime(last.finishedAt), t.runner.status[last.status] ?? last.status)}
    </span>
  );
}

function List({ items, selected, onSelect, locked }: { items: RunnerItem[]; selected: string | null; onSelect: (id: string) => void; locked: boolean }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = items.filter((i) => !q || `${i.flow.name} ${i.flow.description ?? ""}`.toLowerCase().includes(q));
  return (
    <nav aria-label={t.flows} className="flex w-[240px] shrink-0 flex-col border-r border-slate-200 bg-sheet">
      <div className="m-2.5 flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2 focus-within:border-brand-500">
        <Search size={14} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder={t.runner.search}
          className="min-w-0 flex-1 bg-transparent text-[13px] focus:outline-none"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && q && <li className="px-3 py-2 text-[12px] text-slate-500">{t.runner.notFound}</li>}
        {rows.map((item) => {
          const on = item.flow.id === selected;
          return (
            <li key={item.flow.id}>
              <button
                type="button"
                disabled={locked}
                onClick={() => onSelect(item.flow.id)}
                aria-current={on}
                className={`block w-full border-l-[3px] px-3 py-2 text-left disabled:opacity-50 ${on ? "border-brand-500 bg-brand-50" : "border-transparent hover:bg-slate-50"}`}
              >
                <div className="text-[13px] leading-snug font-semibold">{item.flow.name}</div>
                <div className="mt-0.5 text-[11.5px] text-slate-500">
                  <LastRun item={item} />
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const INPUT = "w-full rounded-lg border border-slate-300 bg-sheet px-2.5 text-[13px] focus:border-brand-500 focus:outline-none";

function FieldRow({
  field,
  value,
  error,
  onChange,
  onPick,
}: {
  field: Field;
  value: string | boolean;
  error?: string;
  onChange: (v: string | boolean) => void;
  onPick: (kind: "file" | "folder", start: string) => Promise<string | null>;
}) {
  const id = `in-${field.name}`;
  if (field.kind === "checkbox") {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-[13px]">
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-brand-500" />
        {field.label}
      </label>
    );
  }
  const text = String(value);
  const kind = field.kind;
  let control: React.ReactNode;
  if (kind === "lines" || kind === "json") {
    control = <textarea id={id} value={text} rows={4} onChange={(e) => onChange(e.target.value)} className={`${INPUT} py-1.5 font-mono text-[12.5px]`} />;
  } else if (kind === "select") {
    control = (
      <select id={id} value={text} onChange={(e) => onChange(e.target.value)} className={`${INPUT} h-8 max-w-[360px]`}>
        {text === "" && (
          <option value="" disabled>
            {t.runner.choose}
          </option>
        )}
        {(field.choices ?? []).map((c, i) => (
          <option key={JSON.stringify(c)} value={String(i)}>
            {choiceLabel(c)}
          </option>
        ))}
      </select>
    );
  } else if (kind === "date" || kind === "month") {
    control = <input id={id} type={kind} value={text} onChange={(e) => onChange(e.target.value)} className={`${INPUT} h-8 max-w-[200px]`} />;
  } else if (kind === "file" || kind === "folder") {
    control = (
      <div className="flex gap-2">
        <input id={id} type="text" value={text} onChange={(e) => onChange(e.target.value)} spellCheck={false} className={`${INPUT} h-8 min-w-0 flex-1`} />
        <button
          type="button"
          title={kind === "file" ? t.runner.browseFile : t.runner.browseFolder}
          onClick={() =>
            void onPick(kind, text).then(
              (path) => path && onChange(path),
              () => {},
            )
          }
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-sheet px-3 text-[12.5px] font-semibold hover:bg-slate-50"
        >
          {kind === "file" ? <FileText size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
          {t.runner.browse}
        </button>
      </div>
    );
  } else {
    control = (
      <input
        id={id}
        type={kind === "password" ? "password" : "text"}
        inputMode={kind === "number" ? "decimal" : undefined}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} h-8 ${kind === "number" ? "max-w-[200px] text-right" : ""}`}
      />
    );
  }
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12.5px] font-semibold">
        {field.label}
        {field.required && <span className="ml-1 text-shu-600">*</span>}
      </label>
      {control}
      {error ? (
        <div className="mt-1 text-[11.5px] text-shu-600">{error}</div>
      ) : (
        kind === "lines" && <div className="mt-1 text-[11.5px] text-slate-500">{t.runner.linesHint}</div>
      )}
    </div>
  );
}

const MARK: Record<TopState, React.ReactNode> = {
  done: <Check size={14} strokeWidth={2.5} className="text-moegi-500" aria-hidden="true" />,
  running: <Loader2 size={14} strokeWidth={2.5} className="animate-spin text-accent-500" aria-hidden="true" />,
  failed: <X size={14} strokeWidth={2.5} className="text-shu-600" aria-hidden="true" />,
  waiting: <Circle size={10} strokeWidth={2} className="mx-0.5 text-slate-300" aria-hidden="true" />,
};

function useTick(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

type Run = { runId: string | null; startedAt: number; stopping?: boolean };

export function Runner({ backend = runnerApi }: { backend?: RunnerApi }) {
  const [items, setItems] = useState<RunnerItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [defs, setDefs] = useState<StepTypeDef[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEventEnvelope[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const seen = useRef<RunEventEnvelope[]>([]);

  const reload = () =>
    backend.list().then(
      (list) => {
        setItems(list);
        setSelected((s) => (s && list.some((i) => i.flow.id === s) ? s : (list[0]?.flow.id ?? null)));
      },
      (e) => setProblem(message(e)),
    );
  useEffect(() => {
    document.title = t.runner.title;
    void reload();
    api.listStepTypes().then(setDefs, () => {});
    const off = backend.onEvent((e) => {
      // Events can come before `run` answers with the run's id: keep them all.
      seen.current = [...seen.current, e];
      setEvents(seen.current);
    });
    return () => void off.then((f) => f(), () => {});
    // Once, on opening.
  }, []);

  const item = items?.find((i) => i.flow.id === selected) ?? null;
  // Per flow and version: the list is read again after each run, and
  // that must not wipe what the person typed (「もう一度」 runs with it).
  const formKey = item ? `${item.flow.id}@${item.version}` : "";
  const fields = useMemo(() => (item ? fieldsOf(item.flow) : []), [formKey]);
  useEffect(() => {
    setValues(initialValues(fields));
    setErrors({});
  }, [fields]);

  const mine = run?.runId ? events.filter((e) => e.runId === run.runId) : [];
  const state = item && run ? progress(item.flow, mine) : null;
  const finished = state?.finished ?? null;

  // Closed to the tray, the window keeps its page: read the list again
  // when it comes back (a flow may have been published meanwhile), but not
  // while a run goes, whose progress follows the version it started with.
  const busy = useRef(false);
  busy.current = !!run && !finished;
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible" && !busy.current) void reload();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  const now = useTick(!!run && !finished);

  // When it ends: the outputs from the report, the files it wrote to output/.
  // Keyed on the run and its end, not `finished` (a new object each render).
  const ended = finished && run?.runId ? `${run.runId}:${finished.status}` : null;
  useEffect(() => {
    if (!ended || !run?.runId || !item) return;
    const runId = run.runId;
    const id = item.flow.id;
    let tries = 0;
    const fetchReport = () =>
      backend.report(runId).then(
        (r) => (r ? setReport(r) : ++tries < 10 && setTimeout(fetchReport, 300)),
        () => {},
      );
    void fetchReport();
    backend.files(id).then(
      (f) => setFiles(f.files.filter((file) => file.path.startsWith("output/") && (!file.modified || Date.parse(file.modified) >= run.startedAt - 2000))),
      () => setFiles([]),
    );
    void reload();
    // Once per finished run.
  }, [ended]);

  const text = (step: { name?: string; type: string; params?: Record<string, unknown> }) =>
    step.name?.trim() || plain(sentence(step as never, defs.find((d) => d.type === step.type)));

  const start = async () => {
    if (!item) return;
    const { inputs, errors } = collect(fields, values);
    setErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setProblem(null);
    setReport(null);
    setFiles([]);
    setRun({ runId: null, startedAt: Date.now() });
    try {
      const runId = await backend.run(item.flow.id, inputs);
      setRun({ runId, startedAt: Date.now() });
    } catch (e) {
      setRun(null);
      const err = e as { code?: string; message?: string };
      setProblem(err.code ? explainError({ code: err.code, message: err.message ?? "" }).what : message(e));
    }
  };
  const stop = () => {
    const runId = run?.runId;
    if (!runId) return;
    setRun((r) => (r?.runId === runId ? { ...r, stopping: true } : r));
    backend.stop(runId).catch(async (e) => {
      if (!(e instanceof ApiError && e.code === "RUN_NOT_FOUND")) return setProblem(message(e));
      // It already ended but its last event never came: end it from its record.
      const r = await backend.report(runId).catch(() => null);
      const end: RunEventEnvelope = {
        runId,
        seq: Number.MAX_SAFE_INTEGER,
        at: new Date().toISOString(),
        type: "runFinished",
        status: r?.status ?? "cancelled",
        error: r?.error ?? null,
        durationMs: r ? Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : Date.now() - (run?.startedAt ?? Date.now()),
      } as RunEventEnvelope;
      seen.current = [...seen.current, end];
      setEvents(seen.current);
    });
  };
  const reset = () => {
    setRun(null);
    setReport(null);
    setFiles([]);
  };

  const running = !!run && !finished;
  const seconds = run ? Math.max(0, Math.round(((finished ? run.startedAt + finished.durationMs : now) - run.startedAt) / 1000)) : 0;

  return (
    <div className="flex h-screen flex-col bg-paper text-ink">
      <TitleBar />
      {items && items.length === 0 ? (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <div>
            <div className="text-[14px] font-semibold">{t.runner.empty}</div>
            <div className="mt-1 text-[12.5px] text-slate-500">{t.runner.emptyHint}</div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <List items={items ?? []} selected={selected} onSelect={(id) => {
              // A run going on stays on screen until it ends (the rows are disabled too).
              if (running) return;
              reset();
              setSelected(id);
            }} locked={running} />
          {item && (
            <main className="flex min-w-0 flex-1 flex-col">
              <div className="px-5 pt-4 pb-2">
                <h1 className="text-[16px] font-bold">{item.flow.name}</h1>
                {!run && item.flow.description && <p className="mt-1 text-[12.5px] leading-relaxed whitespace-pre-line text-slate-600">{item.flow.description}</p>}
                <div className="mt-1.5 text-[11.5px] text-slate-500">
                  {run ? (finished ? t.runner.duration(seconds) : t.runner.elapsed(t.runner.duration(seconds))) : t.runner.version(item.version)}
                </div>
              </div>

              {!run && (
                <form
                  id="runner-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void start();
                  }}
                  className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-2"
                >
                  {fields.length === 0 && <p className="text-[12.5px] text-slate-500">{t.runner.noInputs}</p>}
                  {fields.map((f) => (
                    <FieldRow key={f.name} field={f} value={values[f.name] ?? f.initial} error={errors[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} onPick={backend.pick} />
                  ))}
                </form>
              )}

              {run && state && !finished && (
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full bg-brand-500 transition-[width] duration-300"
                      style={{ width: `${(state.tops.filter((s) => s.state === "done").length / Math.max(1, state.tops.length)) * 100}%` }}
                    />
                  </div>
                  <div className="text-[14px] font-semibold">{state.now ? text(state.now) : t.runner.starting}</div>
                  <ol className="space-y-1.5 text-[12.5px] text-slate-600">
                    {state.tops.map(({ step, state }) => (
                      <li key={step.id} className={`flex items-center gap-2 ${state === "running" ? "font-semibold text-ink" : ""}`}>
                        <span className="grid w-4 shrink-0 place-items-center">{MARK[state]}</span>
                        <span className="truncate">{text(step)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {finished && (
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
                  <Result
                    item={item}
                    status={finished.status}
                    error={finished.error}
                    report={report}
                    files={files}
                    onOpen={(path) => void backend.open(item.flow.id, path).catch((e) => setProblem(message(e)))}
                    failedStep={finished.error?.stepId ? findStep(item.flow.steps ?? [], finished.error.stepId) : null}
                  />
                </div>
              )}

              {problem && <div className="mx-5 mb-2 rounded-lg border border-shu-100 bg-shu-50 px-3 py-2 text-[12.5px] text-shu-600">{problem}</div>}

              <footer className="flex shrink-0 items-center gap-2.5 border-t border-slate-200 bg-sheet px-5 py-2.5">
                <span className="flex-1 text-[12px] text-slate-500">{!run ? t.runner.runNote(item.version) : running ? t.runner.stopNote : ""}</span>
                {!run && (
                  <button type="submit" form="runner-form" className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary hover:bg-primary-hover">
                    <Play size={14} strokeWidth={2} aria-hidden="true" />
                    {t.runner.run}
                  </button>
                )}
                {running && (
                  <button
                    type="button"
                    onClick={stop}
                    title={run?.stopping ? t.stopAgainTitle : undefined}
                    disabled={!run?.runId}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-shu-500 bg-sheet px-4 text-[13px] font-semibold text-shu-600 hover:bg-shu-50 disabled:opacity-60"
                  >
                    <Square size={12} strokeWidth={2.5} aria-hidden="true" className={run?.stopping ? "animate-pulse" : undefined} />
                    {run?.stopping ? t.stopping : t.runner.stop}
                  </button>
                )}
                {finished && (
                  <>
                    <button type="button" onClick={reset} className="h-8 rounded-lg border border-slate-300 bg-sheet px-4 text-[13px] hover:bg-slate-50">
                      {t.runner.back}
                    </button>
                    <button type="button" onClick={() => void start()} className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary hover:bg-primary-hover">
                      <Play size={14} strokeWidth={2} aria-hidden="true" />
                      {t.runner.again}
                    </button>
                  </>
                )}
              </footer>
            </main>
          )}
        </div>
      )}
    </div>
  );
}

function Result({
  item,
  status,
  error,
  report,
  files,
  onOpen,
  failedStep,
}: {
  item: RunnerItem;
  status: string;
  error: { code: string; message: string; details?: unknown } | null;
  report: RunReport | null;
  files: ProjectFile[];
  onOpen: (path: string) => void;
  failedStep: ReturnType<typeof findStep>;
}) {
  const good = status === "succeeded";
  const outputs = (item.flow.variables ?? []).filter(isOutput);
  const explained = error ? explainError(error, failedStep) : null;
  return (
    <div className={`rounded-lg border-l-4 bg-sheet px-4 py-3 shadow-sheet ${good ? "border-moegi-500" : status === "failed" ? "border-shu-500" : "border-slate-400"}`}>
      <div className="flex items-center gap-2 text-[14px] font-bold">
        <span className={`inline-block h-2 w-2 rounded-full ${DOT[status] ?? "bg-slate-400"}`} aria-hidden="true" />
        {good ? t.runner.succeeded : status === "failed" ? t.runner.failed : t.runner.cancelled}
      </div>
      {explained && error && (
        <div className="mt-2 space-y-1 text-[13px]">
          <div className="flex items-start gap-2">
            <span className="shrink-0 rounded-md bg-shu-50 px-1.5 text-[11.5px] font-bold text-shu-600">{error.code}</span>
            <span className="font-semibold">{explained.what}</span>
          </div>
          {explained.todo && <div className="text-slate-600">{explained.todo}</div>}
          <div className="text-[12px] text-slate-500">{t.runner.tellAuthor}</div>
        </div>
      )}
      {good && outputs.length > 0 && report && (
        <dl className="mt-3 grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          {outputs.map((v) => (
            <div key={v.name} className="contents">
              <dt className="text-slate-500">{labelOf(v)}</dt>
              <dd className="break-words">{formatValue(report.outputs?.[v.name])}</dd>
            </div>
          ))}
        </dl>
      )}
      {files.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center text-[12px] font-semibold text-slate-600">
            <span className="flex-1">{t.runner.files}</span>
            <button type="button" onClick={() => onOpen("output")} className="flex items-center gap-1 font-semibold text-brand-600 hover:underline">
              <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
              {t.runner.openFolder}
            </button>
          </div>
          <ul>
            {files.slice(0, 12).map((f) => (
              <li key={f.path} className="flex items-center gap-2 border-t border-slate-100 py-1.5 text-[12.5px]">
                <FileText size={14} strokeWidth={1.75} className="shrink-0 text-accent-500" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{f.path.slice("output/".length)}</span>
                <button type="button" onClick={() => onOpen(f.path)} className="text-[12px] font-semibold text-brand-600 hover:underline">
                  {t.runner.openFile}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
