// The 実行結果: a finished run of the open flow on one sheet of paper, with
// the same head as the manual and the review report, and the flow's runs
// beside it to go back to any of them. Read from the run's record
// (report.json, events.jsonl), so a run from Runner, a schedule or an AI
// reads the same as one from Writer, and stays readable as long as the
// record is kept: what the run wrote (the file now, and whether it is still
// as the run left it), what it returned, the last page its browser showed,
// everything it worked on outside itself, and what it was given.
import type { FileStamp, RunReport, StepTypeDef } from "@spellsheet/schema";
import { FolderOpen, Play, FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { api, type RunRecord } from "../lib/api";
import { formatValue } from "../lib/changes";
import { locale, t } from "../lib/i18n";
import {
  appOf,
  durationMs,
  type FlowRun,
  inputValues,
  insideFolder,
  originText,
  outputValues,
  type PlaceRow,
  placeRows,
  runCounts,
  writtenFiles,
} from "../lib/runResult";
import { labelOf } from "../runner/form";
import { projectApi, useProject } from "../project";
import type { View } from "./Toolbar";
import { Masthead, Stripe } from "./Masthead";
import { PaperSection } from "./ReviewDesk";
import { FileBox, OutputValues } from "./ReviewResult";

const DOT: Record<string, string> = {
  succeeded: "bg-moegi-500",
  failed: "bg-shu-500",
  cancelled: "bg-slate-400",
};

const TAG: Record<string, string> = {
  succeeded: "bg-moegi-100 text-moegi-500",
  failed: "bg-shu-50 text-shu-600",
  cancelled: "bg-slate-100 text-slate-600",
};

const dateTime = (at: string) =>
  new Date(at).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shortTime = (at: string) =>
  new Date(at).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const clock = (at: string) => new Date(at).toLocaleTimeString(locale === "ja" ? "ja-JP" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const seconds = (ms: number) => (ms < 1000 ? t.result.underSecond : t.runner.duration(Math.round(ms / 1000)));

/** The flow's runs, newest first; read again when a run of it ends. */
function useFlowRuns(flowId: string | null): FlowRun[] | null {
  const [runs, setRuns] = useState<FlowRun[] | null>(null);
  const ended = useStudio((s) => (s.run && s.run.flowId === flowId && !["running", "paused", "pending"].includes(s.run.status) ? s.run.runId : null));
  useEffect(() => {
    if (!flowId) return;
    let live = true;
    let tries = 0;
    const load = () =>
      api.flowRuns(flowId).then(
        (list) => {
          if (!live) return;
          setRuns(list);
          // The report is written just after the run's last event: look again for it.
          if (ended && !list.some((r) => r.runId === ended) && ++tries < 10) setTimeout(load, 300);
        },
        () => live && setRuns([]),
      );
    void load();
    return () => {
      live = false;
    };
  }, [flowId, ended]);
  return runs;
}

export function RunResultView({ onView }: { onView: (view: View) => void }) {
  const flow = useStudio((s) => s.flow);
  const resultFor = useStudio((s) => s.resultFor);
  const runs = useFlowRuns(flow?.id ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  // A run of the whole flow that just ended is the one to show.
  useEffect(() => {
    if (resultFor && resultFor.flowId === flow?.id) setPicked(resultFor.runId);
  }, [resultFor, flow?.id]);
  useEffect(() => setPicked(null), [flow?.id]);
  const shown = picked && runs?.some((r) => r.runId === picked) ? picked : (runs?.[0]?.runId ?? null);
  return (
    <div className="flex h-full min-h-0">
      <RunList runs={runs} picked={shown} onPick={setPicked} />
      <div className="min-w-0 flex-1">
        {runs === null ? (
          <p className="p-6 text-[12.5px] text-slate-500">{t.result.loading}</p>
        ) : shown ? (
          <RunPaper key={shown} runId={shown} entry={runs.find((r) => r.runId === shown) ?? null} onView={onView} />
        ) : (
          <div className="canvas-bg grid h-full place-items-center p-6 text-center">
            <div>
              <div className="text-[14px] font-semibold">{t.result.empty}</div>
              <div className="mt-1 text-[12.5px] text-slate-500">{t.result.emptyHint}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RunList({ runs, picked, onPick }: { runs: FlowRun[] | null; picked: string | null; onPick: (runId: string) => void }) {
  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col border-r border-slate-200 bg-paper" aria-label={t.result.history}>
      <div className="px-3 pt-3 pb-1">
        <div className="text-[12px] font-bold">{t.result.history}</div>
        <div className="text-[11px] leading-relaxed text-slate-400">{t.result.historyNote}</div>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {(runs ?? []).map((run) => {
          const active = run.runId === picked;
          return (
            <li key={run.runId}>
              <button
                type="button"
                onClick={() => onPick(run.runId)}
                aria-current={active || undefined}
                className={`relative w-full rounded-lg px-2.5 py-1.5 text-left ${active ? "bg-sheet shadow-sheet ring-1 ring-brand-100" : "hover:bg-sheet/70"}`}
              >
                {active && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-xs bg-brand-500" />}
                <div className="flex items-center gap-1.5 text-[12.5px]">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[run.status] ?? "bg-slate-400"}`} aria-hidden="true" />
                  <span className="font-semibold tabular-nums">{shortTime(run.startedAt)}</span>
                  <span className="ml-auto text-[11px] text-slate-500">{t.result.status[run.status] ?? run.status}</span>
                </div>
                <div className="truncate pl-3.5 text-[11px] text-slate-500">
                  {originText(run.origin)}・{seconds(durationMs(run))}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/** The run's record, the last page's picture and the flow's folder, loaded once. */
function useRunPaper(runId: string) {
  const [record, setRecord] = useState<RunRecord | null | "missing">(null);
  const [screen, setScreen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.runRecord(runId).then(
      (r) => live && setRecord(r.report ? r : "missing"),
      () => live && setRecord("missing"),
    );
    api.runLastScreen(runId).then(
      (s) => live && setScreen(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [runId]);
  return { record, screen };
}

function RunPaper({ runId, entry, onView }: { runId: string; entry: FlowRun | null; onView: (view: View) => void }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const startRun = useStudio((s) => s.startRun);
  const goTo = useStudio((s) => s.goTo);
  const projectDir = useProject((s) => s.files?.dir ?? null);
  const { record, screen } = useRunPaper(runId);
  const defs = useMemo(() => new Map<string, StepTypeDef>(stepTypes.map((d) => [d.type, d])), [stepTypes]);
  if (record === null) return <p className="p-6 text-[12.5px] text-slate-500">{t.result.loading}</p>;
  if (record === "missing") return <p className="p-6 text-[12.5px] text-slate-500">{t.result.missing}</p>;
  const report = record.report as RunReport;
  const events = record.events;
  const rows = placeRows(report, defs, projectDir);
  const files = writtenFiles(rows);
  const outputs = outputValues(flow, report);
  const inputs = inputValues(flow, events);
  const counts = runCounts(events);
  const ms = durationMs({ startedAt: report.startedAt, finishedAt: report.finishedAt });
  const status = report.status;
  const flowId = flow?.id;
  const show = (stepId: string) => {
    onView("story");
    goTo(stepId);
  };
  let n = 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="canvas-bg min-h-0 flex-1 overflow-y-auto px-6 pt-8 pb-12">
        <article className="@container relative mx-auto max-w-[940px] overflow-hidden rounded-lg border border-slate-200 bg-sheet px-6 pt-10 pb-7 shadow-sheet xl:px-11 xl:pb-9" data-run-result>
          <Stripe className="top-0 h-[5px]" />
          <Masthead
            kind={t.result.kind}
            title={report.flowName}
            tag={<span className={`ml-2.5 inline-block rounded-md px-2 align-[4px] text-[12px] leading-[22px] font-bold ${TAG[status] ?? TAG.cancelled}`}>{t.result.status[status] ?? status}</span>}
            facts={[
              { label: t.result.factStarted, value: dateTime(report.startedAt) },
              { label: t.result.factDuration, value: seconds(ms) },
              { label: t.result.factVersion, value: report.version != null ? t.result.version(report.version) : t.result.revision(report.revision) },
              { label: t.result.factOrigin, value: originText(report.origin) },
              ...(report.origin?.machine ? [{ label: t.result.factMachine, value: report.origin.machine }] : []),
            ]}
          />
          <p className="text-[13.5px] leading-[1.7] text-slate-600">{t.result.lead[status === "succeeded" && files.length === 0 ? "succeededNoFile" : status] ?? ""}</p>

          {report.error && (
            <div className="mt-4 rounded-lg border border-shu-100 bg-shu-50 px-3.5 py-2.5 text-[13px]">
              <div className="flex items-center gap-2 font-bold text-shu-600">
                {t.result.failure}
                <span className="rounded-md bg-sheet px-1.5 text-[11.5px]">{report.error.code}</span>
                {report.error.stepId && (
                  <button type="button" onClick={() => show(report.error!.stepId!)} className="ml-auto text-[12.5px] font-semibold text-brand-600 hover:underline">
                    {t.result.seeNode}
                  </button>
                )}
              </div>
              <p className="mt-1 break-words text-ink">
                {report.error.stepLabel ? `${report.error.stepLabel}：` : ""}
                {report.error.message}
              </p>
            </div>
          )}

          {files.length > 0 && (
            <PaperSection n={++n} title={t.result.outputFiles} note={t.result.outputFilesNote} aside={t.result.count(files.length)}>
              <div className="space-y-3">
                {files.map((row) => (
                  <WrittenFile key={row.target} flowId={flowId} row={row} projectDir={projectDir} stamp={report.finishedAt} />
                ))}
              </div>
            </PaperSection>
          )}

          {outputs.length > 0 && (
            <PaperSection n={++n} title={t.result.outputs} note={t.result.outputsNote}>
              <OutputValues outputs={outputs} />
            </PaperSection>
          )}

          {screen && (
            <PaperSection n={++n} title={t.result.lastScreen} note={t.result.lastScreenNote}>
              <figure className="overflow-hidden rounded-lg border border-slate-200 bg-paper">
                <img src={screen} alt={t.result.lastScreen} className="mx-auto block h-auto max-h-[560px] w-auto max-w-full" />
              </figure>
            </PaperSection>
          )}

          <PaperSection n={++n} title={t.result.places} note={t.result.placesNote} aside={rows.length > 0 ? t.result.count(rows.length) : undefined}>
            {rows.length === 0 ? <p className="text-[12.5px] text-slate-500">{t.result.noPlaces}</p> : <PlacesTable rows={rows} onShow={show} />}
          </PaperSection>

          {inputs.length > 0 && (
            <PaperSection n={++n} title={t.result.inputs} note={t.result.inputsNote}>
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full border-collapse text-[12.5px]">
                  <tbody>
                    {inputs.map(({ variable, name, value }) => (
                      <tr key={name} className="border-b border-slate-100 last:border-0">
                        <th scope="row" className="w-[45%] px-3 py-1.5 text-left align-top font-normal">
                          {variable ? labelOf(variable) : name}
                          {variable && labelOf(variable) !== name && <span className="ml-2 font-mono text-[11px] text-slate-400">{name}</span>}
                        </th>
                        <td className="px-3 py-1.5 align-top font-semibold break-all">{formatValue(value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </PaperSection>
          )}

          <PaperSection n={++n} title={t.result.details} note={t.result.counts(counts.errors, counts.warnings, counts.nodes)}>
            <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-slate-200 px-3.5 py-2.5 text-[12.5px]">
              <dt className="text-slate-500">{t.result.runId}</dt>
              <dd className="font-mono text-[12px] break-all">{report.runId}</dd>
              <dt className="text-slate-500">{t.result.factStarted}</dt>
              <dd>{dateTime(report.startedAt)}</dd>
              <dt className="text-slate-500">{t.result.finishedAt}</dt>
              <dd>{dateTime(report.finishedAt)}</dd>
              <dt className="text-slate-500">{t.result.secretsUsed}</dt>
              <dd>{report.secretsUsed?.length ? report.secretsUsed.join("、") : t.result.none}</dd>
            </dl>
          </PaperSection>
        </article>
      </div>
      <footer className="flex shrink-0 items-center gap-2.5 border-t border-slate-200 bg-sheet px-5 py-2.5">
        <span className={`h-2 w-2 rounded-full ${DOT[status] ?? "bg-slate-400"}`} aria-hidden="true" />
        <span className="flex-1 truncate text-[12px] text-slate-500">
          {t.result.status[status] ?? status}・{seconds(ms)}
          {entry ? `・${originText(entry.origin)}` : ""}
        </span>
        {flowId && (
          <button
            type="button"
            onClick={() => void projectApi.open(flowId, "output", false).catch(() => undefined)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-sheet px-3.5 text-[13px] hover:bg-slate-50"
          >
            <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
            {t.result.openOutput}
          </button>
        )}
        <button type="button" onClick={() => onView("story")} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-sheet px-3.5 text-[13px] hover:bg-slate-50">
          <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
          {t.result.toChart}
        </button>
        <button
          type="button"
          onClick={() => {
            onView("story");
            void startRun();
          }}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary hover:bg-primary-hover"
        >
          <Play size={14} strokeWidth={2} aria-hidden="true" />
          {t.result.again}
        </button>
      </footer>
    </div>
  );
}

/** Whether a file is still as the run left it: its SHA-256 now against the one recorded. */
function useStillSame(flowId: string | undefined, path: string, recorded: FileStamp | null | undefined): "same" | "changed" | "gone" | null {
  const [state, setState] = useState<"same" | "changed" | "gone" | null>(null);
  useEffect(() => {
    if (!flowId || !recorded?.sha256) return;
    let live = true;
    api.fileStamp(flowId, path).then(
      (now) => live && setState(!now ? "gone" : now.sha256 === recorded.sha256 ? "same" : "changed"),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [flowId, path, recorded?.sha256]);
  return state;
}

function WrittenFile({ flowId, row, projectDir, stamp }: { flowId: string | undefined; row: PlaceRow; projectDir: string | null; stamp: string }) {
  const path = insideFolder(row.target, projectDir) ?? row.target;
  const state = useStillSame(flowId, path, row.touched.file);
  const app = appOf(path);
  const note =
    state === "same" ? (
      <p className="border-b border-slate-200 bg-moegi-100/40 px-3 py-1 text-[11.5px] text-moegi-600">{t.result.sameAsRun}</p>
    ) : state === "changed" ? (
      <p className="border-b border-slate-200 bg-amber-50 px-3 py-1 text-[11.5px] text-amber-700">{t.result.changedSince}</p>
    ) : state === "gone" ? (
      <p className="border-b border-slate-200 bg-slate-100 px-3 py-1 text-[11.5px] text-slate-600">{t.result.fileGone}</p>
    ) : null;
  return <FileBox flowId={flowId} path={path} label={t.result.placeKinds.outputFile ?? ""} stamp={stamp} openLabel={t.result.open[app ?? "other"]} note={note} />;
}

function PlacesTable({ rows, onShow }: { rows: PlaceRow[]; onShow: (stepId: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="bg-paper text-left text-[12px] text-slate-500">
          <tr>
            <th className="w-[8.5em] border-b border-slate-200 px-3 py-1.5 font-semibold">{t.result.colKind}</th>
            <th className="border-b border-slate-200 px-3 py-1.5 font-semibold">{t.result.colTarget}</th>
            <th className="border-b border-slate-200 px-3 py-1.5 font-semibold">{t.result.colAction}</th>
            <th className="w-[6em] border-b border-slate-200 px-3 py-1.5 font-semibold">{t.result.colTime}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const stamp = row.touched.file;
            const changes = !row.reads;
            return (
              <tr
                key={row.target}
                onClick={() => row.callPath.length === 0 && onShow(row.stepId)}
                className={`border-b border-slate-100 align-top last:border-0 ${row.callPath.length === 0 ? "cursor-pointer hover:bg-paper" : ""}`}
              >
                <td className={`px-3 py-2 whitespace-nowrap ${changes ? "font-semibold" : "text-slate-600"}`}>{t.result.placeKinds[row.kind] ?? row.kind}</td>
                <td className="px-3 py-2">
                  <div className="font-mono text-[12px] break-all" title={row.target}>
                    {row.shown}
                  </div>
                  {stamp && (
                    <div className="mt-0.5 font-mono text-[10.5px] break-all text-slate-400" title={t.result.colFile}>
                      {t.result.bytes(stamp.size)}
                      {stamp.sha256 ? ` ・ SHA-256 ${stamp.sha256}` : ""}
                    </div>
                  )}
                </td>
                <td className={`px-3 py-2 ${changes ? "font-semibold" : "text-slate-600"}`}>
                  {row.actions.join("、")}
                  {row.count > 1 && <span className="ml-1.5 text-[11.5px] font-normal text-slate-500">{t.result.times(row.count)}</span>}
                </td>
                <td className="px-3 py-2 text-slate-500 tabular-nums">{clock(row.at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
