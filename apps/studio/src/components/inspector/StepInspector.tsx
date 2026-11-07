import { nodeIcon } from "../../lib/nodeIcons";
// A node in the inspector (read-only summary) and in the node editor (the
// full form): docs/design/ui-principles.md §2.
import type { Step, StepPatch, StepTypeDef } from "@shikigami/schema";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../../context";
import { Maximize2 } from "lucide-react";
import { t } from "../../lib/i18n";
import { type DataLink, dataLinks, INPUT_NODE, OUTPUT_NODE } from "../../lib/dataFlow";
import { stepSummary } from "../../lib/palette";
import { issueText } from "../../lib/issueText";
import { CALL, knownVariables, outputs, paramRows, TYPE_COLOR, unsetParams } from "../../lib/nodeRows";
import { sentence, typeTitle } from "../../lib/sentence";
import { AppTag } from "../AppTag";
import { findStep, revertBlocker, touchedSteps } from "../../store";
import { Sentence } from "../StoryView";
import { ActorMark, usePendingReview } from "../Timeline";
import { VarIcon } from "../VarIcon";
import { inputClass, CommitInput, Row, AddRow, Section } from "./fields";
import { ParamsEditor } from "./params";
import { CallEditor } from "./CallEditor";
import { FlowInspector } from "./FlowInspector";

/** Where this step's variables come from and go to, matching the links on the chart. */
function Connections({ stepId, links, vars }: { stepId: string; links: DataLink[]; vars: Map<string, string | undefined> }) {
  const flow = useStudio((s) => s.flow);
  const goTo = useStudio((s) => s.goTo);
  const incoming = links.filter((l) => l.to === stepId);
  const outgoing = links.filter((l) => l.from === stepId);
  if (incoming.length === 0 && outgoing.length === 0) return null;
  const nameOf = (id: string) => {
    if (id === INPUT_NODE) return t.props.flowInput;
    if (id === OUTPUT_NODE) return t.props.flowOutput;
    const s = findStep(flow?.steps ?? [], id);
    return s?.name || s?.type || id;
  };
  const item = (l: DataLink, other: string, arrow: string) => (
    <li key={`${l.from}${l.to}${l.variable}${l.toHandle}`} className="flex items-center gap-1.5 py-0.5 text-[11px]">
      <span style={{ color: TYPE_COLOR[vars.get(l.variable) ?? "any"] }}>
        <VarIcon size={11} />
      </span>
      <span className="font-mono font-semibold">{l.variable}</span>
      <span className="text-slate-400">{arrow}</span>
      {other.startsWith("@") ? (
        <span className="truncate text-slate-600">{nameOf(other)}</span>
      ) : (
        <button type="button" className="truncate text-brand-600 hover:underline" onClick={() => goTo(other)}>
          {nameOf(other)}
        </button>
      )}
    </li>
  );
  return (
    <Section title={t.props.links}>
      {incoming.length > 0 && (
        <Row label={t.props.receives}>
          <ul className="pt-1">{incoming.map((l) => item(l, l.from, "←"))}</ul>
        </Row>
      )}
      {outgoing.length > 0 && (
        <Row label={t.props.passes}>
          <ul className="pt-1">{outgoing.map((l) => item(l, l.to, "→"))}</ul>
        </Row>
      )}
    </Section>
  );
}

/** The selected step and the ones after it, in the same block. */
function siblingsFrom(steps: Step[], id: string): Step[] | null {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) return steps.slice(i);
  for (const step of steps) {
    for (const children of Object.values(step.blocks ?? {})) {
      const found = siblingsFrom(children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Moves this step (and the next few) into a new flow called from here. */
/** Moves the selected step (and the ones after it) into a new sub-flow. Opened from the step's tools. */
export function ExtractForm({ step }: { step: Step }) {
  const flow = useStudio((s) => s.flow);
  const extract = useStudio((s) => s.extract);
  const after = useMemo(() => siblingsFrom(flow?.steps ?? [], step.id ?? "") ?? [step], [flow, step]);
  const [count, setCount] = useState(1);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCount(1);
    setName("");
  }, [step.id]);
  const picked = after.slice(0, Math.min(count, after.length));
  return (
    <div className="w-[320px] p-3">
      <div className="pb-1 text-[11px] font-bold tracking-wider text-slate-600">{t.props.extract}</div>
      <Row label={t.props.extractRange} hint={picked.map((s) => s.name || s.type).join(" → ")}>
        <select className={inputClass} value={count} onChange={(e) => setCount(Number(e.target.value))}>
          {after.map((_, i) => (
            <option key={i} value={i + 1}>
              {i === 0 ? t.props.thisStep : t.props.stepsFromHere(i + 1)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t.props.newName}>
        <input className={inputClass} value={name} placeholder={t.props.newNamePlaceholder} onChange={(e) => setName(e.target.value)} />
      </Row>
      <div className="flex justify-end pt-1">
        <button
          type="button"
          disabled={busy || name.trim() === ""}
          className="rounded-md border border-slate-300 bg-paper text-ink hover:bg-slate-100 px-2.5 py-0.5 text-xs disabled:opacity-40"
          onClick={async (e) => {
            e.preventDefault();
            setBusy(true);
            await extract(
              picked.map((s) => s.id ?? ""),
              name.trim(),
            );
            setBusy(false);
          }}
        >
          {t.props.extractButton}
        </button>
      </div>
      <p className="pt-1 text-[10px] leading-snug text-slate-400">
        {t.props.extractHint}
      </p>
    </div>
  );
}

export function StepInspector({ inEditor }: { inEditor?: boolean } = {}) {
  const flow = useStudio((s) => s.flow);
  const selection = useStudio((s) => s.selection);
  const stepTypes = useStudio((s) => s.stepTypes);
  const validation = useStudio((s) => s.validation);
  const updateStep = useStudio((s) => s.updateStep);
  const approve = useStudio((s) => s.approve);
  const revert = useStudio((s) => s.revert);
  const pending = usePendingReview();
  const history = useStudio((s) => s.history);
  const vars = useMemo(() => knownVariables(flow?.variables, flow?.steps ?? []), [flow]);
  const links = useMemo(() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
    return dataLinks(flow?.steps ?? [], flow?.variables, defs, new Set(vars.keys()));
  }, [flow, stepTypes, vars]);

  if (!flow) return null;
  if (selection?.kind !== "step") return <FlowInspector />;
  const step = findStep(flow.steps ?? [], selection.stepId);
  if (!step?.id) return <p className="p-4 text-sm text-slate-400">{t.selectStep}</p>;
  const id = step.id;
  const def = stepTypes.find((d) => d.type === step.type);
  const update = (patch: StepPatch) => updateStep(id, patch);
  const issues = validation?.issues.filter((i) => i.stepId === id) ?? [];
  const StepIcon = nodeIcon(step.type, def?.category ?? step.type.split(".")[0] ?? "other");
  const outs = outputs(step);
  const isCall = step.type === CALL;

  return (
    <div className="pb-6">
      <div className={inEditor ? "px-4 pt-1 pb-2" : "px-4 pt-4 pb-3"}>
        {/* The editor's header already says what the node is. */}
        {!inEditor && (
        <div>
          <div className="flex items-center gap-2" title={`${step.type} · ID: ${id}`}>
            <StepIcon size={16} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
            <span className="text-[14px] font-semibold text-ink">{typeTitle(step, def)}</span>
            <AppTag def={def} title={typeTitle(step, def)} />
          </div>
          <div className="mt-1.5 text-[13px] leading-snug text-slate-600">
            <Sentence parts={sentence(step, def)} />
          </div>
          {def && <p className="mt-0.5 text-[12px] text-slate-500">{stepSummary(def.type, def.description)}</p>}
        </div>
        )}
        {pending
          .filter((e) => touchedSteps(e).includes(id))
          .map((e) => (
            <div key={e.revision} className="mt-2 flex items-center gap-2 rounded-lg border border-shu-100 bg-shu-50 px-2 py-1.5 text-xs">
              <ActorMark entry={e} size={18} />
              <span className="flex-1">
                {t.props.changedBy(t.actor[e.actor.kind], e.revision)}
              </span>
              <button type="button" className="font-medium hover:underline" onClick={() => approve(e.revision)}>
                {t.approve}
              </button>
              <button
                type="button"
                className="font-medium text-shu-600 enabled:hover:underline disabled:text-slate-400"
                disabled={revertBlocker(e, history) !== null}
                title={revertBlocker(e, history) ?? undefined}
                onClick={() => revert(e)}
              >
                {t.revert}
              </button>
            </div>
          ))}
        {issues.length > 0 && (
          <ul className="mt-2 space-y-1 rounded-lg border border-shu-100 bg-shu-50 p-2 text-xs text-shu-600">
            {issues.map((i) => (
              <li key={`${i.code}${i.path}${i.message}`}>
                {i.severity === "warning" ? "⚠" : "✕"} {issueText(i, flow)}
              </li>
            ))}
          </ul>
        )}
      </div>
      {inEditor ? (
        <>
          <Section title={t.props.basics}>
            <Row label={t.stepName}>
              <CommitInput value={step.name ?? ""} onCommit={(name) => update({ name })} />
            </Row>
          </Section>
          {isCall ? (
            <CallEditor step={step} vars={vars} update={update} />
          ) : (
            <ParamsEditor step={step} def={def} vars={vars} update={update} />
          )}
          {!isCall && (outs.length > 0 || def?.hasOutput) && (
            <Section title={t.props.output}>
              {def?.hasOutput && (
                <Row label={t.saveAs} socket={step.saveAs ? TYPE_COLOR[vars.get(step.saveAs) ?? "any"] : undefined}>
                  <CommitInput
                    mono
                    value={step.saveAs ?? ""}
                    placeholder={t.props.variableName}
                    onCommit={(v) => update({ saveAs: v.trim() === "" ? null : v.trim() })}
                  />
                </Row>
              )}
              {outs
                .filter((o) => o.variable !== step.saveAs)
                .map((o) => (
                  <Row key={o.variable} label={o.label} socket={TYPE_COLOR[vars.get(o.variable) ?? "any"]}>
                    <span className="block pt-1 font-mono text-xs font-semibold">{o.variable}</span>
                  </Row>
                ))}
            </Section>
          )}
          <ExecutionSection step={step} isCall={isCall} update={update} />
        </>
      ) : (
        <StepSummary step={step} def={def} vars={vars} isCall={isCall} />
      )}
      <Connections stepId={id} links={links} vars={vars} />
    </div>
  );
}

/**
 * The right pane's view of a node: what it is set to, read-only. Settings
 * are changed in the node opened full size (NodeEditor), so there is one
 * place to edit them (docs/design/ui-principles.md §2).
 */
function StepSummary({ step, def, vars, isCall }: { step: Step; def: StepTypeDef | undefined; vars: Map<string, string | undefined>; isCall: boolean }) {
  const openEditor = useStudio((s) => s.openEditor);
  const known = useMemo(() => new Set(vars.keys()), [vars]);
  const rows = paramRows(step, def, known);
  const unset = new Set(unsetParams(step, def));
  const outs = outputs(step);
  const execution = [
    step.disabled ? [t.disabled, "✓"] : null,
    step.timeoutMs ? [t.timeoutMs, String(step.timeoutMs)] : null,
    step.retry?.maxAttempts ? [t.retry, String(step.retry.maxAttempts)] : null,
    step.onError ? [t.onError, step.onError === "fail" ? t.onErrorFail : t.onErrorContinue] : null,
  ].filter((r): r is string[] => r !== null);
  const line = (label: string, value: React.ReactNode, key: string, socket?: string) => (
    <div key={key} className="grid grid-cols-[84px_1fr] items-baseline gap-x-2 py-0.5 text-[12px]">
      <span className="flex items-center justify-end text-right text-[11px] leading-tight text-slate-500">
        {socket && <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: socket }} />}
        {label}
      </span>
      <span className="min-w-0 break-words text-ink">{value}</span>
    </div>
  );
  return (
    <>
      <Section title={t.props.settingsSummary}>
        {step.name && line(t.stepName, step.name, "name")}
        {rows.map((r) =>
          line(r.label, unset.has(r.key) ? <span className="text-amber-700">{t.flow.unsetValue}</span> : r.value, r.key),
        )}
        {rows.length === 0 && !step.name && <p className="py-1 text-[12px] text-slate-500">{t.props.noSettings}</p>}
        <button
          type="button"
          title={t.props.editSettingsTitle}
          onClick={() => step.id && openEditor(step.id)}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 py-1.5 text-[12px] font-medium text-slate-700 hover:border-brand-500 hover:text-brand-600"
        >
          <Maximize2 size={12} strokeWidth={1.75} aria-hidden="true" />
          {t.props.editSettings}
        </button>
      </Section>
      {!isCall && (outs.length > 0 || step.saveAs) && (
        <Section title={t.props.output}>
          {[...(step.saveAs ? [{ label: t.saveAs, variable: step.saveAs }] : []), ...outs.filter((o) => o.variable !== step.saveAs)].map((o) =>
            line(o.label, <span className="font-mono text-xs font-semibold">{o.variable}</span>, o.variable, TYPE_COLOR[vars.get(o.variable) ?? "any"]),
          )}
        </Section>
      )}
      {execution.length > 0 && <Section title={t.props.execution}>{execution.map(([label, value]) => line(label!, value, label!))}</Section>}
    </>
  );
}

/**
 * 無効化・タイムアウト・再試行・エラー時: a row only once it is set, so a
 * node's pane is not four rows of things nobody changes.
 */
function ExecutionSection({ step, isCall, update }: { step: Step; isCall: boolean; update: (p: StepPatch) => void }) {
  const [added, setAdded] = useState<Set<string>>(new Set());
  useEffect(() => setAdded(new Set()), [step.id]);
  const control = step.type.startsWith("control.");
  const all: { key: string; label: string; set: boolean; hide?: boolean }[] = [
    { key: "disabled", label: t.disabled, set: step.disabled === true },
    { key: "timeoutMs", label: t.timeoutMs, set: step.timeoutMs != null, hide: control },
    { key: "retry", label: t.retry, set: step.retry != null, hide: control || isCall },
    { key: "onError", label: t.onError, set: step.onError != null, hide: control },
  ].filter((r) => !r.hide);
  const shown = (key: string) => (all.find((r) => r.key === key)?.set ?? false) || added.has(key);
  const drop = (key: string, patch: StepPatch) => {
    setAdded((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    update(patch);
  };
  return (
    <Section title={t.props.execution}>
      {shown("disabled") && (
        <Row label={t.disabled} onRemove={() => drop("disabled", { disabled: false })}>
          <input type="checkbox" className="mt-1.5" checked={step.disabled ?? false} onChange={(e) => update({ disabled: e.target.checked })} />
        </Row>
      )}
      {shown("timeoutMs") && (
        <Row label={t.timeoutMs} onRemove={() => drop("timeoutMs", { timeoutMs: null })}>
          <CommitInput
            value={step.timeoutMs?.toString() ?? ""}
            placeholder={isCall ? t.props.callTimeout : "30000"}
            onCommit={(v) => update({ timeoutMs: v.trim() === "" ? null : Number(v) })}
          />
        </Row>
      )}
      {shown("retry") && (
        <Row label={t.retry} onRemove={() => drop("retry", { retry: null })}>
          <CommitInput
            value={step.retry?.maxAttempts?.toString() ?? ""}
            placeholder="1"
            onCommit={(v) => {
              const n = Number(v);
              update({ retry: v.trim() === "" || n <= 1 ? null : { maxAttempts: n, backoffMs: 1000, backoffMultiplier: 2 } });
            }}
          />
        </Row>
      )}
      {shown("onError") && (
        <Row label={t.onError} onRemove={() => drop("onError", { onError: null })}>
          <select
            className={inputClass}
            value={step.onError ?? ""}
            onChange={(e) => update({ onError: (e.target.value || null) as StepPatch["onError"] })}
          >
            <option value="">{t.props.followFlow}</option>
            <option value="fail">{t.onErrorFail}</option>
            <option value="continue">{t.onErrorContinue}</option>
          </select>
        </Row>
      )}
      <AddRow choices={all.filter((r) => !shown(r.key))} onAdd={(key) => setAdded((prev) => new Set(prev).add(key))} />
    </Section>
  );
}

