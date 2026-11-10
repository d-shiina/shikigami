import type { ApprovalRequest, Flow, StepTypeDef } from "@spellsheet/schema";
import { ChevronDown, ChevronRight, CloudUpload, MonitorCog, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { clientName, fillTarget, type InputRow, inputRows, minutesLeft, readSubject } from "../lib/approval";
import { relativeTime } from "../lib/changes";
import { type Effect, effectOf, effects as flowEffects } from "../lib/effects";
import { stepLabel, t } from "../lib/i18n";
import { flatten } from "../lib/review";
import { calledName, sentence } from "../lib/sentence";
import { Sentence } from "./StoryView";
import { shortText } from "./ValueView";

const primary = "rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-on-primary hover:bg-primary-hover";
const primaryDanger = "rounded-md bg-shu-600 px-4 py-1.5 text-sm font-semibold text-on-primary hover:bg-shu-500";
const danger = "rounded-md border border-shu-500/60 px-3 py-1.5 text-sm text-shu-600 hover:bg-shu-50";
const quiet = "rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100";

/**
 * Opens by itself when an AI client asks to do something the workspace
 * policy holds for a person (run_flow, test_step, delete_flow).
 * Approving lets that exact request run once; the AI repeats its call to use
 * it. One request at a time, oldest first; "Later" hides the ones seen so far
 * until a new request comes in.
 *
 * The request is read out for a person: what runs, with which values, and
 * what it does to files and other systems. The raw request stays one click
 * away for those who want to see exactly what the AI sent.
 */
export function ApprovalDialog() {
  const approvals = useStudio((s) => s.approvals);
  const decide = useStudio((s) => s.decideApproval);
  const [later, setLater] = useState<string[]>([]);
  const waiting = approvals.filter((r) => !later.includes(r.id));
  const request: ApprovalRequest | undefined = waiting[0];
  if (!request) return null;
  return (
    <Request
      key={request.id}
      request={request}
      others={waiting.length - 1}
      answer={(approve) => void decide(request.id, approve)}
      later={() => setLater(approvals.map((r) => r.id))}
    />
  );
}

function Request({
  request,
  others,
  answer,
  later,
}: {
  request: ApprovalRequest;
  others: number;
  answer: (approve: boolean) => void;
  later: () => void;
}) {
  const stepTypes = useStudio((s) => s.stepTypes);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const flow = useFlow(request.flowId ?? null);
  const subject = readSubject(request);
  const [showRaw, setShowRaw] = useState(false);
  const now = useNow();

  const who = clientName(request.requestedBy.name) ?? "AI";
  const flowName = request.flowName ?? flow?.name ?? t.approval.someFlow;
  const step = subject.step;
  const def = step ? defs.get(step.type) : undefined;
  const title =
    request.action === "deleteFlow"
      ? t.approval.title.deleteFlow(flowName)
      : request.action === "testStep"
        ? t.approval.title.testStep(step?.name?.trim() || stepLabel(step?.type ?? "", def?.label))
        : subject.testCases.length > 0
          ? t.approval.title.runTests(flowName, subject.testCases.length)
          : t.approval.title.runFlow(flowName);
  const lead =
    request.action === "deleteFlow"
      ? t.approval.lead.deleteFlow
      : request.action === "testStep"
        ? t.approval.lead.testStep
        : subject.published
          ? t.approval.lead.published
          : t.approval.lead.working;

  const effectList: Effect[] = useMemo(() => {
    if (request.action === "testStep") {
      const e = step ? effectOf(step, def, "same") : null;
      return e ? [e] : [];
    }
    return flow ? flowEffects(flow.steps ?? [], new Map(), [], defs) : [];
  }, [request.action, step, def, flow, defs]);

  // The values targets read, for a single run (a test run has several sets).
  const runValues =
    request.action === "runFlow" && subject.testCases.length === 0
      ? inputRows(flow, subject.inputs)
      : request.action === "testStep"
        ? inputRows(null, subject.variables)
        : [];
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => boxRef.current?.focus(), []);

  const riskyOps = [...new Set((request.stepTypes ?? []).map((type) => stepLabel(type, defs.get(type)?.label)))];
  const deleting = request.action === "deleteFlow";

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30 p-4">
      <div
        ref={boxRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            later();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88vh] w-[min(640px,100%)] flex-col overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-dialog outline-none"
      >
        <header className="space-y-2 px-6 pt-5 pb-4">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-brand-500 text-white">
              <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="font-medium text-slate-700">{t.approval.from(who)}</span>
            <span aria-hidden="true">・</span>
            <span>{relativeTime(request.requestedAt, now)}</span>
            <span aria-hidden="true">・</span>
            <span>{t.approval.expires(minutesLeft(request.requestedAt, now))}</span>
            {others > 0 && <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{t.approval.others(others)}</span>}
          </div>
          <h2 className="text-xl leading-snug font-bold [word-break:auto-phrase]">{title}</h2>
          <p className="text-sm text-slate-600">{lead}</p>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-5">
          <RiskBand risk={deleting ? "deleteFlow" : request.risk} ops={riskyOps} />

          <Section title={t.approval.explanation}>
            {request.reason ? (
              // The AI's own words: a quote, never SpellSheet's instruction.
              <blockquote className="border-l-[3px] border-brand-500/60 pl-3 text-sm leading-relaxed whitespace-pre-wrap text-ink">
                {request.reason}
              </blockquote>
            ) : (
              <p className="text-sm text-slate-500">{t.approval.noReason}</p>
            )}
          </Section>

          {request.action === "runFlow" &&
            (subject.testCases.length > 0 ? (
              <Section title={t.approval.testCases(subject.testCases.length)} note={t.approval.valuesNote}>
                <div className="space-y-3">
                  {subject.testCases.map((c) => (
                    <div key={c.name}>
                      <p className="mb-1 text-[13px] font-semibold">{c.name}</p>
                      <Values rows={inputRows(flow, c.inputs)} />
                    </div>
                  ))}
                </div>
              </Section>
            ) : (
              <Section title={t.approval.values} note={t.approval.valuesNote}>
                <Values rows={inputRows(flow, subject.inputs)} />
              </Section>
            ))}

          {request.action === "testStep" && step && (
            <>
              <Section title={t.approval.node}>
                <div className="rounded-md border border-slate-200 px-3 py-2 text-sm leading-relaxed">
                  <Sentence parts={sentence(step, def)} />
                </div>
              </Section>
              {Object.keys((subject.variables as Record<string, unknown>) ?? {}).length > 0 && (
                <Section title={t.approval.nodeValues}>
                  <Values rows={inputRows(null, subject.variables)} />
                </Section>
              )}
            </>
          )}

          {deleting ? (
            <Section title={t.approval.deleting}>
              <div className="rounded-md border border-slate-200 px-3 py-2 text-sm">
                <p className="font-semibold">{flowName}</p>
                {flow?.description && <p className="mt-0.5 text-[13px] text-slate-600">{flow.description}</p>}
                {flow && <p className="mt-1 text-xs text-slate-500">{t.approval.stepCount(countSteps(flow))}</p>}
              </div>
            </Section>
          ) : (
            <Section
              title={request.action === "testStep" ? t.approval.nodeEffects : t.approval.effects}
              note={t.approval.effectsNote}
            >
              <Effects effects={effectList} values={runValues} loading={request.action === "runFlow" && !flow && !!request.flowId} />
            </Section>
          )}

          {subject.calledIds.length > 0 && (
            <Section title={t.approval.called}>
              <ul className="space-y-0.5 text-sm">
                {subject.calledIds.map((id) => (
                  <li key={id}>{calledName(id) ?? id}</li>
                ))}
              </ul>
            </Section>
          )}

          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-ink"
              aria-expanded={showRaw}
              onClick={() => setShowRaw(!showRaw)}
            >
              {showRaw ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              {t.approval.raw}
            </button>
            {showRaw && (
              <pre className="mt-1.5 max-h-48 overflow-auto rounded bg-paper p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-700">
                {JSON.stringify(request.subject, null, 2)}
              </pre>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-200 bg-paper/60 px-6 py-3">
          <div className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-slate-500">
            {deleting ? t.approval.noteDelete : t.approval.note}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className={quiet} title={t.approval.laterTitle} onClick={later}>
              {t.approvalLater}
            </button>
            <button type="button" className={danger} title={t.approval.denyTitle} onClick={() => answer(false)}>
              {t.approval.deny}
            </button>
            <button type="button" className={deleting ? primaryDanger : primary} onClick={() => answer(true)}>
              {t.approval.approve[request.action]}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[13px] font-bold text-ink">{title}</h3>
      {note && <p className="mb-1.5 text-[11.5px] text-slate-500">{note}</p>}
      <div className={note ? "" : "mt-1.5"}>{children}</div>
    </section>
  );
}

const BAND: Record<
  StepTypeDef["risk"] | "deleteFlow",
  { icon: typeof TriangleAlert; box: string; iconClass: string }
> = {
  dangerous: { icon: TriangleAlert, box: "border-shu-500/40 bg-shu-50", iconClass: "text-shu-600" },
  deleteFlow: { icon: TriangleAlert, box: "border-shu-500/40 bg-shu-50", iconClass: "text-shu-600" },
  interactive: { icon: MonitorCog, box: "border-amber-500/40 bg-amber-50", iconClass: "text-amber-700" },
  safe: { icon: ShieldCheck, box: "border-moegi-500/40 bg-moegi-100/60", iconClass: "text-moegi-600" },
};

function RiskBand({ risk, ops }: { risk: StepTypeDef["risk"] | "deleteFlow"; ops: string[] }) {
  const look = BAND[risk];
  const Icon = look.icon;
  const sub = risk === "dangerous" ? t.approval.bandSub.dangerous(ops) : t.approval.bandSub[risk];
  return (
    <div className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 ${look.box}`}>
      <Icon size={18} strokeWidth={1.75} className={`mt-0.5 shrink-0 ${look.iconClass}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${look.iconClass}`}>{t.approval.band[risk]}</p>
        <p className="text-[12.5px] text-slate-700">{sub}</p>
      </div>
    </div>
  );
}

function Values({ rows }: { rows: InputRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">{t.approval.noValues}</p>;
  return (
    <table className="w-full table-fixed border-collapse text-sm">
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} className="border-t border-slate-200 first:border-t-0">
            <th scope="row" className="w-[42%] py-1.5 pr-3 text-left align-top font-normal">
              <span className="block">{row.label ?? row.name}</span>
              {row.label && <span className="block font-mono text-[11px] text-slate-500">{row.name}</span>}
            </th>
            <td className="py-1.5 align-top">
              <span className={`font-mono text-[12.5px] break-all ${row.given ? "text-ink" : "text-slate-500"}`}>
                {shortText(row.value)}
              </span>
              {!row.given && (
                <span className="ml-2 rounded bg-slate-100 px-1.5 py-px text-[10.5px] text-slate-500">{t.approval.defaultTag}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Effects({ effects, values, loading }: { effects: Effect[]; values: InputRow[]; loading: boolean }) {
  if (loading) return null;
  if (effects.length === 0) return <p className="text-sm text-slate-500">{t.approval.noEffects}</p>;
  return (
    <ul className="space-y-1">
      {effects.map((e) => {
        const danger = e.risk === "dangerous";
        return (
          <li key={`${e.action}\u0000${e.target}`} className="flex items-start gap-2 text-sm leading-relaxed">
            <span
              className={`mt-[7px] size-1.5 shrink-0 rounded-full ${danger ? "bg-shu-600" : e.reads ? "bg-slate-300" : "bg-slate-500"}`}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className={danger ? "font-semibold text-shu-600" : e.reads ? "text-slate-600" : "font-semibold"}>{e.action}</span>
              {e.target && (
                <span className="ml-1.5 font-mono text-[12.5px] break-all text-slate-700" title={e.target}>
                  {fillTarget(e.target, values)}
                </span>
              )}
              {e.external && (
                <span className="mt-0.5 flex items-center gap-1 text-[12px] text-amber-700">
                  <CloudUpload size={12} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                  {t.desk.sentOutside(e.external.service, e.external.data)}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const countSteps = (flow: Flow) => flatten(flow.steps ?? []).length;

/** The flow a request is about, read once; null while loading or when it is gone. */
function useFlow(id: string | null): Flow | null {
  const [flow, setFlow] = useState<Flow | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    api
      .getFlow(id)
      .then((f) => live && setFlow(f))
      .catch(() => live && setFlow(null));
    return () => {
      live = false;
    };
  }, [id]);
  return flow;
}

/** Ticks every 30 seconds, for "1 min ago" and the time left. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
