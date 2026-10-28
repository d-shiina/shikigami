import type { Step, StepPatch, StepTypeDef } from "@shikigami/schema";
import { useEffect, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { findStep, revertBlocker, touchedSteps } from "../store";
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
  "w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-ink focus:outline-none";

/** Text field that commits on blur / Enter, so each edit is one undoable change. */
function CommitInput(props: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

function ParamField({
  name,
  schema,
  value,
  required,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = `${name}${required ? " *" : ""}`;
  if (schema.enum) {
    return (
      <Field label={label} hint={schema.description}>
        <select className={inputClass} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">（未設定）</option>
          {schema.enum.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (schema.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  // number | expression string (oneOf), or plain number
  if (schema.type === "integer" || schema.type === "number" || schema.oneOf) {
    return (
      <Field label={label} hint={schema.description ?? "数値、または式（例: count * 2）"}>
        <CommitInput
          value={value === undefined ? "" : String(value)}
          onCommit={(text) => {
            const trimmed = text.trim();
            if (trimmed === "") return onChange(null);
            const n = Number(trimmed);
            onChange(Number.isFinite(n) ? n : trimmed);
          }}
        />
      </Field>
    );
  }
  if (schema.type === "string") {
    return (
      <Field label={label} hint={schema.description}>
        <CommitInput value={String(value ?? "")} onCommit={(text) => onChange(text === "" ? null : text)} />
      </Field>
    );
  }
  // Anything else (objects, arrays, untyped values): edit as JSON.
  return (
    <Field label={label} hint="JSON（文字列は {{ 式 }} テンプレートも可）">
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
    </Field>
  );
}

function ParamsEditor({ step, def, update }: { step: Step; def?: StepTypeDef; update: (p: StepPatch) => void }) {
  const schema = (def?.paramsSchema ?? {}) as JsonSchema;
  const props = schema.properties ?? {};
  const params = step.params ?? {};
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(JSON.stringify(params, null, 2));
    setError(null);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3">
      <div className="flex items-center">
        <span className="text-xs font-semibold text-slate-500">{t.params}</span>
        <button type="button" className="ml-auto text-xs text-brand-600 hover:underline" onClick={() => setRaw(!raw)}>
          {raw ? "フォーム" : t.rawJson}
        </button>
      </div>
      {raw || Object.keys(props).length === 0 ? (
        <div className="space-y-1">
          <textarea
            className={`${inputClass} font-mono text-xs`}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {error && <div className="text-xs text-shu-600">{error}</div>}
          <button
            type="button"
            className="rounded bg-ink px-2 py-1 text-xs text-paper"
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
        Object.entries(props).map(([key, propSchema]) => (
          <ParamField
            key={key}
            name={key}
            schema={propSchema}
            value={params[key]}
            required={schema.required?.includes(key) ?? false}
            // JSON Merge Patch: null removes the key.
            onChange={(value) => update({ params: { [key]: value } })}
          />
        ))
      )}
    </div>
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

  if (!scenario || selection?.kind !== "step") {
    return <p className="p-4 text-sm text-slate-400">{t.selectStep}</p>;
  }
  const step = findStep(scenario.steps ?? [], selection.stepId);
  if (!step?.id) return <p className="p-4 text-sm text-slate-400">{t.selectStep}</p>;
  const id = step.id;
  const def = stepTypes.find((d) => d.type === step.type);
  const update = (patch: StepPatch) => updateStep(id, patch);
  const issues = validation?.issues.filter((i) => i.stepId === id) ?? [];

  return (
    <div className="space-y-4 p-4">
      <div>
        <div className="text-xs text-slate-500">{t.stepType}</div>
        <div className="font-medium">
          {def?.label ?? step.type} <span className="font-mono text-xs text-slate-400">{step.type}</span>
        </div>
        {def?.description && <p className="mt-1 text-xs text-slate-500">{def.description}</p>}
        <div className="mt-1 font-mono text-[10px] text-slate-400">{id}</div>
      </div>
      {pending
        .filter((e) => touchedSteps(e).includes(id))
        .map((e) => (
          <div key={e.revision} className="flex items-center gap-2 rounded-md border border-shu-100 bg-shu-50 px-2 py-1.5 text-xs">
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
        <ul className="space-y-1 rounded border border-shu-100 bg-shu-50 p-2 text-xs text-shu-600">
          {issues.map((i) => (
            <li key={`${i.code}${i.path}${i.message}`}>
              {i.severity === "warning" ? "⚠" : "✕"} {i.message}
            </li>
          ))}
        </ul>
      )}
      <Field label={t.stepName}>
        <CommitInput value={step.name ?? ""} onCommit={(name) => update({ name })} />
      </Field>
      <ParamsEditor step={step} def={def} update={update} />
      <div className="space-y-3 border-t border-slate-200 pt-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={step.disabled ?? false} onChange={(e) => update({ disabled: e.target.checked })} />
          {t.disabled}
        </label>
        {!step.type.startsWith("control.") && (
          <>
            <Field label={t.timeoutMs}>
              <CommitInput
                value={step.timeoutMs?.toString() ?? ""}
                placeholder="30000"
                onCommit={(v) => update({ timeoutMs: v.trim() === "" ? null : Number(v) })}
              />
            </Field>
            <Field label={t.retry}>
              <CommitInput
                value={step.retry?.maxAttempts?.toString() ?? ""}
                placeholder="1"
                onCommit={(v) => {
                  const n = Number(v);
                  update({ retry: v.trim() === "" || n <= 1 ? null : { maxAttempts: n, backoffMs: 1000, backoffMultiplier: 2 } });
                }}
              />
            </Field>
            <Field label={t.onError}>
              <select
                className={inputClass}
                value={step.onError ?? ""}
                onChange={(e) => update({ onError: (e.target.value || null) as StepPatch["onError"] })}
              >
                <option value="">（シナリオ設定に従う）</option>
                <option value="fail">{t.onErrorFail}</option>
                <option value="continue">{t.onErrorContinue}</option>
              </select>
            </Field>
            {def?.hasOutput && (
              <Field label={t.saveAs}>
                <CommitInput value={step.saveAs ?? ""} onCommit={(v) => update({ saveAs: v.trim() === "" ? null : v.trim() })} />
              </Field>
            )}
          </>
        )}
      </div>
    </div>
  );
}
