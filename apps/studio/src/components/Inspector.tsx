import type { Step, StepPatch, StepTypeDef } from "@shikigami/schema";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import type { SecretField } from "../lib/api";
import { stepLabel, t } from "../lib/i18n";
import { type DataLink, dataLinks, INPUT_NODE, OUTPUT_NODE } from "../lib/dataFlow";
import { CALL, callMap, knownVariables, outputs, paramLabel, referencedVariables, TYPE_COLOR } from "../lib/nodeRows";
import { sentence } from "../lib/sentence";
import { findStep, revertBlocker, touchedSteps } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";
import { Sentence } from "./StoryView";
import { ActorMark, usePendingReview } from "./Timeline";
import { VarIcon } from "./VarIcon";
import { VariablesPanel } from "./VariablesPanel";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

const inputClass =
  "w-full rounded-[4px] border border-slate-200 bg-slate-50 px-2 py-1 text-xs focus:border-brand-500 focus:bg-sheet focus:outline-none";

/** Text field that commits on blur / Enter, so each edit is one undoable change. */
function CommitInput(props: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);
  const commit = () => draft !== props.value && props.onCommit(draft);
  const common = {
    value: draft,
    placeholder: props.placeholder,
    className: `${inputClass} ${props.mono ? "font-mono text-xs" : ""}`,
    onBlur: commit,
  };
  return props.multiline ? (
    <textarea {...common} rows={4} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input
      {...common}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

/** One "項目 | 値" row, Blender-style: the label sits left of its value. */
function Row({
  label,
  hint,
  title,
  socket,
  children,
}: {
  label: string;
  hint?: string;
  title?: string;
  socket?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid grid-cols-[84px_1fr] items-start gap-x-2 py-1">
      <span className="relative flex min-h-[26px] items-center justify-end text-right text-[11px] leading-tight text-slate-500" title={title}>
        {socket && <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-white" style={{ background: socket }} />}
        {label}
      </span>
      <span className="min-w-0">
        {children}
        {hint && <span className="mt-0.5 block text-[10px] leading-snug text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

/** A collapsible group of rows, like a Blender properties panel. */
function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <details open className="group border-t border-slate-100 px-4 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-[11px] font-bold tracking-wider text-slate-600 select-none">
        <span className="text-[9px] text-slate-400 transition-transform group-open:rotate-90">▶</span>
        {title}
        {aside && <span className="ml-auto font-normal tracking-normal">{aside}</span>}
      </summary>
      <div className="pt-1">{children}</div>
    </details>
  );
}

type SecretRef = { secret: string; field: SecretField };

/** The `field` enum of the secret reference in a text-or-secret param schema. */
function secretFieldsOf(schema: JsonSchema): string[] | undefined {
  return schema.oneOf?.find((v) => v.properties?.field?.enum)?.properties?.field?.enum?.map(String);
}

const isSecretRef = (v: unknown): v is SecretRef =>
  typeof v === "object" && v !== null && "secret" in v && "field" in v;

/**
 * Text, or a registered secret picked by name. The value itself is never
 * shown or stored in the scenario: only `{ secret, field }`.
 */
function TextOrSecretField({
  label,
  schema,
  value,
  onChange,
}: {
  label: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const secrets = useStudio((s) => s.secrets);
  const openSecrets = useStudio((s) => s.setSecretsOpen);
  const ref = isSecretRef(value) ? value : null;
  const [mode, setMode] = useState<"text" | "secret">(ref ? "secret" : "text");
  useEffect(() => setMode(ref ? "secret" : "text"), [ref]);
  // The param's schema lists the fields it takes (http.request auth also takes the OAuth access token).
  const fields = (secretFieldsOf(schema) ?? ["username", "password", "totp"]) as SecretField[];

  // A <div>, not Field's <label>: a label would forward clicks to its first button.
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div className="flex gap-1 text-xs">
        {(["text", "secret"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-[3px] px-2 py-0.5 ${mode === m ? "bg-ink text-paper" : "text-slate-500 hover:bg-slate-100"}`}
          >
            {m === "text" ? t.secretText : `🔑 ${t.secretUse}`}
          </button>
        ))}
      </div>
      {mode === "text" ? (
        <CommitInput value={typeof value === "string" ? value : ""} onCommit={(text) => onChange(text === "" ? null : text)} />
      ) : (
        <div className="flex items-center gap-1">
          <select
            className={inputClass}
            aria-label={t.secretUse}
            value={ref?.secret ?? ""}
            onChange={(e) =>
              e.target.value && onChange({ secret: e.target.value, field: ref?.field ?? "password" })
            }
          >
            <option value="">{t.secretChoose}</option>
            {secrets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
            {ref && !secrets.some((s) => s.name === ref.secret) && <option value={ref.secret}>{t.props.unregistered(ref.secret)}</option>}
          </select>
          <select
            className={`${inputClass} w-36`}
            aria-label={t.secretFieldLabel}
            value={ref?.field ?? "password"}
            disabled={!ref}
            onChange={(e) => ref && onChange({ secret: ref.secret, field: e.target.value as SecretField })}
          >
            {fields.map((f) => (
              <option key={f} value={f}>
                {t.secretField[f]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="whitespace-nowrap text-xs text-brand-600 hover:underline"
            onClick={() => openSecrets(true)}
          >
            ＋{t.secretRegister}
          </button>
        </div>
      )}
    </div>
  );
}

function ParamField({
  name,
  schema,
  value,
  required,
  socket,
  secretCapable,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  socket?: string;
  secretCapable: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = `${paramLabel(name)}${required ? " *" : ""}`;
  if (secretCapable) {
    return <TextOrSecretField label={label} schema={schema} value={value} onChange={onChange} />;
  }
  let hint = schema.description;
  let editor: React.ReactNode;
  if (schema.enum) {
    editor = (
      <select className={inputClass} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{t.props.unset}</option>
        {schema.enum.map((v) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === "boolean") {
    editor = <input type="checkbox" className="mt-1.5" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  } else if (schema.type === "integer" || schema.type === "number" || schema.oneOf) {
    // number | expression string (oneOf), or plain number
    hint ??= t.props.numberHint;
    editor = (
      <CommitInput
        value={value === undefined ? "" : String(value)}
        onCommit={(text) => {
          const trimmed = text.trim();
          if (trimmed === "") return onChange(null);
          const n = Number(trimmed);
          onChange(Number.isFinite(n) ? n : trimmed);
        }}
      />
    );
  } else if (schema.type === "string") {
    editor = <CommitInput value={String(value ?? "")} onCommit={(text) => onChange(text === "" ? null : text)} />;
  } else {
    // Anything else (objects, arrays, untyped values): edit as JSON.
    hint = t.props.jsonHint;
    editor = (
      <CommitInput
        mono
        value={value === undefined ? "" : JSON.stringify(value)}
        onCommit={(text) => {
          try {
            onChange(text.trim() === "" ? null : JSON.parse(text));
          } catch {
            onChange(text);
          }
        }}
      />
    );
  }
  return (
    <Row label={label} title={name} socket={socket} hint={hint}>
      {editor}
    </Row>
  );
}

function ParamsEditor({
  step,
  def,
  vars,
  update,
}: {
  step: Step;
  def?: StepTypeDef;
  vars: Map<string, string | undefined>;
  update: (p: StepPatch) => void;
}) {
  const schema = (def?.paramsSchema ?? {}) as JsonSchema;
  const props = schema.properties ?? {};
  const params = step.params ?? {};
  const known = new Set(vars.keys());
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(JSON.stringify(params, null, 2));
    setError(null);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (
    <button
      type="button"
      className="text-[10px] text-brand-600 hover:underline"
      onClick={(e) => {
        e.preventDefault();
        setRaw(!raw);
      }}
    >
      {raw ? t.props.form : t.rawJson}
    </button>
  );

  return (
    <Section title={t.params} aside={toggle}>
      {raw || Object.keys(props).length === 0 ? (
        <div className="space-y-1">
          <textarea className={`${inputClass} font-mono`} rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          {error && <div className="text-xs text-shu-600">{error}</div>}
          <button
            type="button"
            className="rounded-[3px] bg-ink px-2.5 py-0.5 text-xs text-paper"
            onClick={() => {
              try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                setError(null);
                update({ replaceParams: parsed });
              } catch {
                setError(t.invalidJson);
              }
            }}
          >
            {t.apply}
          </button>
        </div>
      ) : (
        Object.entries(props).map(([key, propSchema]) => {
          const ref = referencedVariables(params[key], known)[0];
          return (
            <ParamField
              key={key}
              name={key}
              schema={propSchema}
              value={params[key]}
              required={schema.required?.includes(key) ?? false}
              socket={ref ? TYPE_COLOR[vars.get(ref) ?? "any"] : undefined}
              secretCapable={def?.secretParams?.includes(key) ?? false}
              // JSON Merge Patch: null removes the key.
              onChange={(value) => update({ params: { [key]: value } })}
            />
          );
        })
      )}
    </Section>
  );
}

/** Where this step's variables come from and go to, matching the links on the chart. */
function Connections({ stepId, links, vars }: { stepId: string; links: DataLink[]; vars: Map<string, string | undefined> }) {
  const scenario = useStudio((s) => s.scenario);
  const goTo = useStudio((s) => s.goTo);
  const incoming = links.filter((l) => l.to === stepId);
  const outgoing = links.filter((l) => l.from === stepId);
  if (incoming.length === 0 && outgoing.length === 0) return null;
  const nameOf = (id: string) => {
    if (id === INPUT_NODE) return t.props.scenarioInput;
    if (id === OUTPUT_NODE) return t.props.scenarioOutput;
    const s = findStep(scenario?.steps ?? [], id);
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

/** Which scenario a call runs, what it passes in and where its outputs go. */
function CallEditor({
  step,
  vars,
  update,
}: {
  step: Step;
  vars: Map<string, string | undefined>;
  update: (p: StepPatch) => void;
}) {
  const scenario = useStudio((s) => s.scenario);
  const summaries = useStudio((s) => s.summaries);
  const called = useStudio((s) => s.called);
  const open = useStudio((s) => s.open);
  const target = typeof step.params?.scenario === "string" ? step.params.scenario : "";
  const callee = called[target];
  const inputs = callMap(step, "inputs");
  const outs = callMap(step, "outputs");
  const known = new Set(vars.keys());
  const choices = summaries.filter((s) => s.id !== scenario?.id);
  const calleeVars = callee?.variables ?? [];
  const ins = calleeVars.filter((v) => v.direction === "input" || v.direction === "inOut");
  const results = calleeVars.filter((v) => v.direction === "output" || v.direction === "inOut");
  return (
    <>
      <Section
        title={t.props.callee}
        aside={
          callee && (
            <button
              type="button"
              className="text-[10px] text-brand-600 hover:underline"
              onClick={(e) => {
                e.preventDefault();
                void open(target);
              }}
            >
              {t.flow.open} ↗
            </button>
          )
        }
      >
        <Row label={`${t.props.scenario} *`} hint={target !== "" && !callee ? t.props.notInWorkspace : undefined}>
          <select
            className={inputClass}
            value={target}
            // Inputs and outputs belong to the old target: start over.
            onChange={(e) => update({ replaceParams: { scenario: e.target.value } })}
          >
            <option value="">{t.props.choose}</option>
            {target !== "" && !choices.some((c) => c.id === target) && <option value={target}>{target}</option>}
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Row>
      </Section>
      {callee && (
        <Section title={t.props.inputs}>
          {ins.length === 0 && <p className="py-1 text-[11px] text-slate-400">{t.props.noInputs}</p>}
          {ins.map((v) => {
            const value = inputs[v.name];
            const ref = referencedVariables(value, known)[0];
            const required = v.default === undefined || v.default === null;
            return (
              <Row
                key={v.name}
                label={`${v.name}${required ? " *" : ""}`}
                title={v.description ?? v.name}
                socket={ref ? TYPE_COLOR[vars.get(ref) ?? "any"] : TYPE_COLOR[v.type ?? "any"]}
                hint={v.secret ? t.props.secretInput : required ? undefined : t.props.defaultIs(JSON.stringify(v.default))}
              >
                <CommitInput
                  mono
                  value={value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)}
                  placeholder={`{{ ${v.name} }}`}
                  onCommit={(text) => {
                    const trimmed = text.trim();
                    let next: unknown = trimmed === "" ? null : trimmed;
                    if (trimmed !== "" && !trimmed.includes("{{")) {
                      try {
                        next = JSON.parse(trimmed);
                      } catch {
                        next = trimmed;
                      }
                    }
                    update({ params: { inputs: { [v.name]: next } } });
                  }}
                />
              </Row>
            );
          })}
        </Section>
      )}
      {callee && (
        <Section title={t.props.outputs}>
          {results.length === 0 && <p className="py-1 text-[11px] text-slate-400">{t.props.noOutputs}</p>}
          {results.map((v) => {
            const into = typeof outs[v.name] === "string" ? (outs[v.name] as string) : "";
            return (
              <Row key={v.name} label={v.name} title={v.description ?? v.name} socket={into ? TYPE_COLOR[vars.get(into) ?? v.type ?? "any"] : undefined}>
                <CommitInput
                  mono
                  value={into}
                  placeholder={t.props.ignoreOutput}
                  onCommit={(text) => update({ params: { outputs: { [v.name]: text.trim() === "" ? null : text.trim() } } })}
                />
              </Row>
            );
          })}
        </Section>
      )}
    </>
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

/** Moves this step (and the next few) into a new scenario called from here. */
/** Moves the selected step (and the ones after it) into a new sub-scenario. Opened from the step's tools. */
export function ExtractForm({ step }: { step: Step }) {
  const scenario = useStudio((s) => s.scenario);
  const extract = useStudio((s) => s.extract);
  const after = useMemo(() => siblingsFrom(scenario?.steps ?? [], step.id ?? "") ?? [step], [scenario, step]);
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
          className="rounded-[3px] bg-ink px-2.5 py-0.5 text-xs text-paper disabled:opacity-40"
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

function StepInspector() {
  const scenario = useStudio((s) => s.scenario);
  const selection = useStudio((s) => s.selection);
  const stepTypes = useStudio((s) => s.stepTypes);
  const validation = useStudio((s) => s.validation);
  const updateStep = useStudio((s) => s.updateStep);
  const approve = useStudio((s) => s.approve);
  const revert = useStudio((s) => s.revert);
  const pending = usePendingReview();
  const history = useStudio((s) => s.history);
  const vars = useMemo(() => knownVariables(scenario?.variables, scenario?.steps ?? []), [scenario]);
  const links = useMemo(() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
    return dataLinks(scenario?.steps ?? [], scenario?.variables, defs, new Set(vars.keys()));
  }, [scenario, stepTypes, vars]);

  if (!scenario) return null;
  if (selection?.kind !== "step") return <ScenarioInspector />;
  const step = findStep(scenario.steps ?? [], selection.stepId);
  if (!step?.id) return <p className="p-4 text-sm text-slate-400">{t.selectStep}</p>;
  const id = step.id;
  const def = stepTypes.find((d) => d.type === step.type);
  const update = (patch: StepPatch) => updateStep(id, patch);
  const issues = validation?.issues.filter((i) => i.stepId === id) ?? [];
  const color = CATEGORY_COLOR[def?.category ?? step.type.split(".")[0] ?? "other"] ?? CATEGORY_COLOR.other;
  const outs = outputs(step);
  const isCall = step.type === CALL;

  return (
    <div className="pb-6">
      <div className="px-4 pt-4 pb-3">
        <div className="overflow-hidden rounded-[4px] border border-slate-200">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            <span className="text-sm font-bold" style={{ color }}>
              {stepLabel(step.type, def?.label)}
            </span>
            <span className="ml-auto font-mono text-[10px] text-slate-400" title={`ID: ${id}`}>
              {step.type}
            </span>
          </div>
          <div className="space-y-1 px-3 py-2">
            <div className="text-[13px] leading-snug">
              <Sentence parts={sentence(step, def)} />
            </div>
            {def?.description && <p className="text-[11px] text-slate-500">{def.description}</p>}
          </div>
        </div>
        {pending
          .filter((e) => touchedSteps(e).includes(id))
          .map((e) => (
            <div key={e.revision} className="mt-2 flex items-center gap-2 rounded-[4px] border border-shu-100 bg-shu-50 px-2 py-1.5 text-xs">
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
          <ul className="mt-2 space-y-1 rounded-[4px] border border-shu-100 bg-shu-50 p-2 text-xs text-shu-600">
            {issues.map((i) => (
              <li key={`${i.code}${i.path}${i.message}`}>
                {i.severity === "warning" ? "⚠" : "✕"} {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>
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
      <Connections stepId={id} links={links} vars={vars} />
      <Section title={t.props.execution}>
        <Row label={t.disabled}>
          <input type="checkbox" className="mt-1.5" checked={step.disabled ?? false} onChange={(e) => update({ disabled: e.target.checked })} />
        </Row>
        {!step.type.startsWith("control.") && (
          <>
          <Row label={t.timeoutMs}>
            <CommitInput
              value={step.timeoutMs?.toString() ?? ""}
              placeholder={isCall ? t.props.callTimeout : "30000"}
              onCommit={(v) => update({ timeoutMs: v.trim() === "" ? null : Number(v) })}
            />
          </Row>
          {!isCall && (
            <Row label={t.retry}>
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
          <Row label={t.onError}>
            <select
              className={inputClass}
              value={step.onError ?? ""}
              onChange={(e) => update({ onError: (e.target.value || null) as StepPatch["onError"] })}
            >
              <option value="">{t.props.followScenario}</option>
              <option value="fail">{t.onErrorFail}</option>
              <option value="continue">{t.onErrorContinue}</option>
            </select>
          </Row>
          </>
        )}
      </Section>
      <p className="px-4 pt-2 font-mono text-[10px] text-slate-400 select-all">{id}</p>
    </div>
  );
}

/** With nothing selected, the inspector shows the scenario itself: what it is, its variables, how it runs. */
function ScenarioInspector() {
  const scenario = useStudio((s) => s.scenario);
  const updateScenario = useStudio((s) => s.updateScenario);
  if (!scenario) return null;
  const settings = scenario.settings ?? {};
  const setSettings = (patch: Partial<typeof settings>) => updateScenario({ settings: { ...settings, ...patch } });
  return (
    <div className="pb-6">
      <Section title={t.props.basics}>
        <Row label={t.shell.name}>
          <CommitInput value={scenario.name} onCommit={(name) => name.trim() && updateScenario({ name: name.trim() })} />
        </Row>
        <Row label={t.shell.description}>
          <CommitInput multiline value={scenario.description ?? ""} placeholder={t.shell.descriptionPlaceholder} onCommit={(description) => updateScenario({ description })} />
        </Row>
      </Section>
      <Section title={t.variables}>
        <div className="-mx-4 -my-3">
          <VariablesPanel />
        </div>
      </Section>
      <Section title={t.shell.runSettings}>
        <Row label={t.shell.defaultTimeout}>
          <CommitInput
            value={settings.defaultTimeoutMs?.toString() ?? ""}
            placeholder="30000"
            onCommit={(v) => setSettings({ defaultTimeoutMs: v.trim() === "" ? null : Number(v) })}
          />
        </Row>
        <Row label={t.shell.onError}>
          <select className={inputClass} value={settings.onError ?? ""} onChange={(e) => setSettings({ onError: (e.target.value || null) as typeof settings.onError })}>
            <option value="">{t.shell.onErrorDefault}</option>
            <option value="fail">{t.onErrorFail}</option>
            <option value="continue">{t.onErrorContinue}</option>
          </select>
        </Row>
      </Section>
      <p className="px-4 pt-2 font-mono text-[10px] text-slate-400 select-all">{scenario.id}</p>
    </div>
  );
}

/**
 * The inspector: the properties of what is selected, and nothing else. A
 * step when one is selected, otherwise the scenario. The path at the top says
 * which, and steps back up to the scenario.
 */
export function Inspector() {
  const scenario = useStudio((s) => s.scenario);
  const selection = useStudio((s) => s.selection);
  const stepTypes = useStudio((s) => s.stepTypes);
  const select = useStudio((s) => s.select);
  if (!scenario) return null;
  const step = selection?.kind === "step" ? findStep(scenario.steps ?? [], selection.stepId) : undefined;
  const def = step ? stepTypes.find((d) => d.type === step.type) : undefined;
  return (
    <aside className="relative z-[1] flex h-full min-h-0 flex-col border-l border-slate-200 bg-sheet">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-200 px-4 text-[12px]">
        {step ? (
          <>
            {/* The scenario's name is in the title bar; here it is the way back to its properties. */}
            <button type="button" onClick={() => select(null)} className="shrink-0 text-slate-500 hover:text-ink hover:underline" title={t.shell.toScenario}>
              {t.shell.scenario}
            </button>
            <span className="text-slate-400">›</span>
            <span className="truncate font-semibold">{step.name || stepLabel(step.type, def?.label)}</span>
          </>
        ) : (
          <span className="font-semibold">{t.shell.scenario}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{step ? <StepInspector /> : <ScenarioInspector />}</div>
    </aside>
  );
}
