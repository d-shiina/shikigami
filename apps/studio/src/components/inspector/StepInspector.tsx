import { nodeIcon } from "../../lib/nodeIcons";
// A node in the inspector (read-only summary) and in the node editor (the
// full form): docs/design/ui-principles.md §2.
import type { Step, StepPatch, StepTypeDef } from "@spellsheet/schema";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../../context";
import { Maximize2, MessageSquareText } from "lucide-react";
import { openAsk, useAgentApiMaybe, useAgentMaybe } from "../../agent";
import { t } from "../../lib/i18n";
import { GROUP } from "../../lib/stepTypes";
import { type DataLink, dataLinks, INPUT_NODE, OUTPUT_NODE } from "../../lib/dataFlow";
import { stepSummary } from "../../lib/palette";
import { issueText } from "../../lib/issueText";
import { CALL, knownVariables, TYPE_COLOR } from "../../lib/nodeRows";
import { typeTitle } from "../../lib/sentence";
import { AppTag } from "../AppTag";
import { extractChoices, findStep, revertBlocker, touchedSteps } from "../../store";
import { ActorMark, usePendingReview } from "../Timeline";
import { VarIcon } from "../VarIcon";
import { inputClass, CommitInput, Row, AddRow, Section, StackedRows } from "./fields";
import { ParamsEditor, STEP_KEY } from "./params";
import { CallEditor } from "./CallEditor";
import { FlowInspector } from "./FlowInspector";
import { NameInput, Result, RunButtons } from "../NodeEditor";

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

/** Moves the selected nodes (Shift+click), or this one and the next few, into a new sub-flow. Opened from the step's tools. */
export function ExtractForm({ step }: { step: Step }) {
  const flow = useStudio((s) => s.flow);
  const selection = useStudio((s) => s.selection);
  const range = useStudio((s) => s.range);
  const extract = useStudio((s) => s.extract);
  const choices = useMemo(() => extractChoices(flow?.steps ?? [], { selection, range }) ?? { from: [step] }, [flow, selection, range, step]);
  const [count, setCount] = useState(1);
  // In the store: Shift+click to widen the range moves the form to another node.
  const name = useStudio((s) => s.extractName);
  const setName = useStudio((s) => s.setExtractName);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCount(1);
  }, [step.id]);
  const picked = "picked" in choices ? choices.picked : choices.from.slice(0, Math.min(count, choices.from.length));
  const names = picked.map((s) => s.name || s.type).join(" → ");
  return (
    <div className="w-[320px] p-3">
      <div className="pb-1 text-[11px] font-bold tracking-wider text-slate-600">{t.props.extract}</div>
      <Row label={t.props.extractRange} hint={names}>
        {"picked" in choices ? (
          <div className="py-1 text-[13px] text-ink">{t.props.pickedSteps(picked.length)}</div>
        ) : (
          <select className={inputClass} value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {choices.from.map((_, i) => (
              <option key={i} value={i + 1}>
                {i === 0 ? t.props.thisStep : t.props.stepsFromHere(i + 1)}
              </option>
            ))}
          </select>
        )}
      </Row>
      {!("picked" in choices) && <p className="pb-2 text-[11px] leading-snug text-slate-500">{t.props.extractShiftHint}</p>}
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
  const openEditor = useStudio((s) => s.openEditor);
  const selection = useStudio((s) => s.selection);
  const stepTypes = useStudio((s) => s.stepTypes);
  const validation = useStudio((s) => s.validation);
  const updateStep = useStudio((s) => s.updateStep);
  const approve = useStudio((s) => s.approve);
  const revert = useStudio((s) => s.revert);
  const pending = usePendingReview();
  const history = useStudio((s) => s.history);
  const agent = useAgentApiMaybe();
  const agentName = useAgentMaybe((a) => a.info?.name ?? "AI", "AI");
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
  const isCall = step.type === CALL;

  return (
    <div className="pb-6">
      <div className={inEditor ? "px-4 pt-1 pb-2" : "px-4 pt-4 pb-3"}>
        {/* The editor's header already says what the node is. */}
        {!inEditor && (
        <div>
          <div className="flex items-center gap-2" title={`${step.type} · ID: ${id}`}>
            <StepIcon size={16} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
            <span className="min-w-0 truncate text-[14px] font-semibold text-ink">{typeTitle(step, def)}</span>
            <AppTag def={def} title={typeTitle(step, def)} />
            {/* Bigger changes go to the AI (docs/design/ai-authoring.md, 人の手の役割). */}
            {agent && (
            <button
              type="button"
              title={t.props.askFixTitle(agentName)}
              onClick={() => agent && openAsk(agent, { about: { id: flow.id, name: flow.name }, draft: t.props.askFixDraft(step.name || typeTitle(step, def)) })}
              className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] whitespace-nowrap text-slate-500 hover:bg-slate-100 hover:text-ink"
            >
              <MessageSquareText size={12} strokeWidth={1.75} aria-hidden="true" />
              {t.props.askFix}
            </button>
            )}
            <button
              type="button"
              title={t.props.expandTitle}
              onClick={() => openEditor(id)}
              className={`${agent ? "" : "ml-auto "}flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[11.5px] text-slate-500 hover:bg-slate-100 hover:text-ink`}
            >
              <Maximize2 size={12} strokeWidth={1.75} aria-hidden="true" />
              {t.props.expand}
            </button>
          </div>
          <div className="-mx-1.5 mt-1">
            <NameInput step={step} />
          </div>
          {def && <p className="mt-0.5 text-[11.5px] leading-snug text-slate-500">{stepSummary(def.type, def.description)}</p>}
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
        <EditorForm step={step} def={def} vars={vars} isCall={isCall} update={update} />
      ) : (
        <StackedRows.Provider value>
          <EditorForm step={step} def={def} vars={vars} isCall={isCall} update={update} />
          {/* What the node gave, right under what it is set to, with the buttons that run it: change a setting, run it alone, see. */}
          <Section title={t.editor.result}>
            <div className="flex flex-wrap gap-2 pb-1 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-[12px]">
              <RunButtons step={step} def={def} />
            </div>
            <div className="-mx-4 -mb-3">
              <Result stepId={id} hasOutput={def?.hasOutput ?? false} />
            </div>
          </Section>
        </StackedRows.Provider>
      )}
      {/* Where the values come from is on the left of the opened node (使える値). */}
      {!inEditor && <Connections stepId={id} links={links} vars={vars} />}
    </div>
  );
}

/**
 * The settings of the node opened full size, as one list: the settings it
 * needs and those in use, then one 「＋ 設定を追加」 for everything else —
 * its optional settings, the variable for its result, how it runs
 * (無効化・タイムアウト・再試行・エラー時) and a memo. A node starts with the
 * one or two rows it needs (docs/design/ui-principles.md §2).
 */
function EditorForm({
  step,
  def,
  vars,
  isCall,
  update,
}: {
  step: Step;
  def: StepTypeDef | undefined;
  vars: Map<string, string | undefined>;
  isCall: boolean;
  update: (p: StepPatch) => void;
}) {
  // Rows opened with 「＋ 設定を追加」 but still empty.
  const [added, setAdded] = useState<Set<string>>(new Set());
  useEffect(() => setAdded(new Set()), [step.id]);
  const control = step.type.startsWith("control.");
  const others: { key: string; label: string; group: string; set: boolean; hide?: boolean }[] = [
    { key: "saveAs", label: t.saveAs, group: t.props.output, set: Boolean(step.saveAs), hide: isCall || !def?.hasOutput },
    { key: "disabled", label: t.disabled, group: t.props.execution, set: step.disabled === true },
    { key: "timeoutMs", label: t.timeoutMs, group: t.props.execution, set: step.timeoutMs != null, hide: control },
    { key: "retry", label: t.retry, group: t.props.execution, set: step.retry != null, hide: (control && step.type !== GROUP) || isCall },
    { key: "onError", label: t.onError, group: t.props.execution, set: step.onError != null, hide: control },
    { key: "description", label: t.memo, group: t.memo, set: Boolean(step.description) },
  ].filter((r) => !r.hide);
  const shown = (key: string) => (others.find((r) => r.key === key)?.set ?? false) || added.has(key);
  const more = others.filter((r) => !shown(r.key)).map(({ key, label, group }) => ({ key: `${STEP_KEY}${key}`, label, group }));
  const add = (key: string) => setAdded((prev) => new Set(prev).add(key.startsWith(STEP_KEY) ? key.slice(STEP_KEY.length) : key));
  const drop = (key: string, patch: StepPatch) => {
    setAdded((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    update(patch);
  };
  const rows = (
    <>
      {shown("saveAs") && (
        <Row
          label={t.saveAs}
          socket={step.saveAs ? TYPE_COLOR[vars.get(step.saveAs) ?? "any"] : undefined}
          onRemove={() => drop("saveAs", { saveAs: null })}
        >
          <CommitInput mono value={step.saveAs ?? ""} placeholder={t.props.variableName} onCommit={(v) => update({ saveAs: v.trim() === "" ? null : v.trim() })} />
        </Row>
      )}
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
          <select className={inputClass} value={step.onError ?? ""} onChange={(e) => update({ onError: (e.target.value || null) as StepPatch["onError"] })}>
            <option value="">{t.props.followFlow}</option>
            <option value="fail">{t.onErrorFail}</option>
            <option value="continue">{t.onErrorContinue}</option>
          </select>
        </Row>
      )}
      {shown("description") && (
        <Row label={t.memo} onRemove={() => drop("description", { description: "" })}>
          <CommitInput multiline value={step.description ?? ""} placeholder={t.memoPlaceholder} onCommit={(description) => update({ description: description.trim() })} />
        </Row>
      )}
    </>
  );
  if (isCall)
    return (
      <>
        <CallEditor step={step} vars={vars} update={update} />
        <div className="px-4 py-2.5">
          {rows}
          <AddRow choices={more} onAdd={add} />
        </div>
      </>
    );
  return (
    <div data-node-settings>
      <ParamsEditor flat step={step} def={def} vars={vars} update={update} more={more} onMore={add} after={rows} />
    </div>
  );
}
