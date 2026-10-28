import type { Step, StepPatch, StepTypeDef } from "@shikigami/schema";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { type DataLink, dataLinks, INPUT_NODE, OUTPUT_NODE } from "../lib/dataFlow";
import { knownVariables, outputs, paramLabel, referencedVariables, TYPE_COLOR } from "../lib/nodeRows";
import { sentence } from "../lib/sentence";
import { findStep, revertBlocker, touchedSteps } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";
import { Sentence } from "./StoryView";
import { ActorMark, usePendingReview } from "./Timeline";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

const inputClass =
  "w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs focus:border-brand-500 focus:bg-sheet focus:outline-none";

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

function ParamField({
  name,
  schema,
  value,
  required,
  socket,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  socket?: string;
  onChange: (value: unknown) => void;
}) {
  const label = `${paramLabel(name)}${required ? " *" : ""}`;
  let hint = schema.description;
  let editor: React.ReactNode;
  if (schema.enum) {
    editor = (
      <select className={inputClass} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">（未設定）</option>
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
    hint ??= "数値、または式（例: count * 2）";
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
    hint = "JSON（文字列は {{ 式 }} テンプレートも可）";
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
      {raw ? "フォーム" : t.rawJson}
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
            className="rounded-full bg-ink px-2.5 py-0.5 text-xs text-paper"
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
  const select = useStudio((s) => s.select);
  const incoming = links.filter((l) => l.to === stepId);
  const outgoing = links.filter((l) => l.from === stepId);
  if (incoming.length === 0 && outgoing.length === 0) return null;
  const nameOf = (id: string) => {
    if (id === INPUT_NODE) return "シナリオ入力";
    if (id === OUTPUT_NODE) return "シナリオ出力";
    const s = findStep(scenario?.steps ?? [], id);
    return s?.name || s?.type || id;
  };
  const item = (l: DataLink, other: string, arrow: string) => (
    <li key={`${l.from}${l.to}${l.variable}${l.toHandle}`} className="flex items-center gap-1.5 py-0.5 text-[11px]">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_COLOR[vars.get(l.variable) ?? "any"] }} />
      <span className="font-mono font-semibold">{l.variable}</span>
      <span className="text-slate-400">{arrow}</span>
      {other.startsWith("@") ? (
        <span className="truncate text-slate-600">{nameOf(other)}</span>
      ) : (
        <button type="button" className="truncate text-brand-600 hover:underline" onClick={() => select({ kind: "step", stepId: other })}>
          {nameOf(other)}
        </button>
      )}
    </li>
  );
  return (
    <Section title="変数のつながり">
      {incoming.length > 0 && (
        <Row label="受け取る">
          <ul className="pt-1">{incoming.map((l) => item(l, l.from, "←"))}</ul>
        </Row>
      )}
      {outgoing.length > 0 && (
        <Row label="渡す">
          <ul className="pt-1">{outgoing.map((l) => item(l, l.to, "→"))}</ul>
        </Row>
      )}
    </Section>
  );
}

export function PropertyPanel() {
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

  if (!scenario || selection?.kind !== "step") {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-xs text-slate-400">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-lg">◇</span>
        {t.selectStep}
      </div>
    );
  }
  const step = findStep(scenario.steps ?? [], selection.stepId);
  if (!step?.id) return <p className="p-4 text-sm text-slate-400">{t.selectStep}</p>;
  const id = step.id;
  const def = stepTypes.find((d) => d.type === step.type);
  const update = (patch: StepPatch) => updateStep(id, patch);
  const issues = validation?.issues.filter((i) => i.stepId === id) ?? [];
  const color = CATEGORY_COLOR[def?.category ?? step.type.split(".")[0] ?? "other"] ?? CATEGORY_COLOR.other;
  const outs = outputs(step);

  return (
    <div className="pb-6">
      <div className="px-4 pt-4 pb-3">
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: `${color}1a` }}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            <span className="text-sm font-bold" style={{ color }}>
              {def?.label ?? step.type}
            </span>
            <span className="ml-auto font-mono text-[10px] text-slate-400">{step.type}</span>
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
            <div key={e.revision} className="mt-2 flex items-center gap-2 rounded-lg border border-shu-100 bg-shu-50 px-2 py-1.5 text-xs">
              <ActorMark entry={e} size={18} />
              <span className="flex-1">
                {t.actor[e.actor.kind]}が変更（rev {e.revision}・{t.unreviewed}）
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
                {i.severity === "warning" ? "⚠" : "✕"} {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Section title="基本">
        <Row label={t.stepName}>
          <CommitInput value={step.name ?? ""} onCommit={(name) => update({ name })} />
        </Row>
        <Row label={t.disabled}>
          <input
            type="checkbox"
            className="mt-1.5"
            checked={step.disabled ?? false}
            onChange={(e) => update({ disabled: e.target.checked })}
          />
        </Row>
        <Row label="ID">
          <span className="block truncate pt-1.5 font-mono text-[10px] text-slate-400">{id}</span>
        </Row>
      </Section>
      <ParamsEditor step={step} def={def} vars={vars} update={update} />
      {(outs.length > 0 || def?.hasOutput) && (
        <Section title="出力">
          {def?.hasOutput && (
            <Row label={t.saveAs} socket={step.saveAs ? TYPE_COLOR[vars.get(step.saveAs) ?? "any"] : undefined}>
              <CommitInput
                mono
                value={step.saveAs ?? ""}
                placeholder="変数名"
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
      {!step.type.startsWith("control.") && (
        <Section title="実行の設定">
          <Row label={t.timeoutMs}>
            <CommitInput
              value={step.timeoutMs?.toString() ?? ""}
              placeholder="30000"
              onCommit={(v) => update({ timeoutMs: v.trim() === "" ? null : Number(v) })}
            />
          </Row>
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
          <Row label={t.onError}>
            <select
              className={inputClass}
              value={step.onError ?? ""}
              onChange={(e) => update({ onError: (e.target.value || null) as StepPatch["onError"] })}
            >
              <option value="">（シナリオ設定に従う）</option>
              <option value="fail">{t.onErrorFail}</option>
              <option value="continue">{t.onErrorContinue}</option>
            </select>
          </Row>
        </Section>
      )}
    </div>
  );
}
