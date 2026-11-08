// 「実行に必要な入力」: Studio's 「実行」 on a flow whose inputs have no
// default asks for them here, instead of starting a run that fails at once.
// The same fields as the run window's form; what was entered is offered
// again next time (secrets excepted), and can be kept as the defaults.
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { missingInputs } from "../lib/runInputs";
import { FieldRow } from "../runner/FieldRow";
import { runnerApi } from "../runner/api";
import { collect, type Field, initialValues, type Values } from "../runner/form";

/** What was entered last, by flow, for this session (never secrets). */
const remembered = new Map<string, Values>();

/** What was remembered, as the fields show it: a choice by its value, since the flow's choices may have changed. */
function restore(fields: Field[], saved: Values | undefined): Values {
  const out: Values = {};
  for (const f of fields) {
    const v = saved?.[f.name];
    if (v === undefined) continue;
    if (f.kind === "select") {
      const at = (f.choices ?? []).findIndex((c) => JSON.stringify(c) === v);
      if (at >= 0) out[f.name] = String(at);
    } else out[f.name] = v;
  }
  return out;
}

export function RunInputsDialog() {
  const ask = useStudio((s) => s.askInputs);
  const flow = useStudio((s) => s.flow);
  if (!ask || !flow || flow.id !== ask.flowId) return null;
  return <Ask key={`${ask.flowId}:${JSON.stringify(ask.options)}`} />;
}

function Ask() {
  const ask = useStudio((s) => s.askInputs)!;
  const flow = useStudio((s) => s.flow)!;
  const answer = useStudio((s) => s.answerInputs);
  const cancel = useStudio((s) => s.cancelInputs);
  const setVariable = useStudio((s) => s.setVariable);
  const fields = useMemo(() => missingInputs(flow, ask.options.startAt ? ask.options.startValues : undefined), [flow, ask]);
  const [values, setValues] = useState<Values>(() => ({ ...initialValues(fields), ...restore(fields, remembered.get(flow.id)) }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const keepable = fields.some((f) => f.kind !== "password");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  const submit = async () => {
    const result = collect(fields, values);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    remembered.set(flow.id, Object.fromEntries(fields.filter((f) => f.kind !== "password").map((f) => [f.name, f.kind === "select" ? JSON.stringify(result.inputs[f.name]) : (values[f.name] ?? f.initial)])));
    setBusy(true);
    if (keep) {
      for (const f of fields) {
        const def = flow.variables?.find((v) => v.name === f.name);
        if (def && !def.secret && f.name in result.inputs) await setVariable({ ...def, default: result.inputs[f.name] });
      }
    }
    await answer(result.inputs);
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <form
        role="dialog"
        aria-label={t.runInputs.title}
        className="max-h-[85vh] w-[480px] overflow-y-auto rounded-lg border border-slate-200 bg-sheet p-5 shadow-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-[15px] font-bold">{t.runInputs.title}</h2>
        <p className="mt-1 text-[12.5px] text-slate-500">{t.runInputs.lead}</p>
        <div className="mt-4 space-y-3">
          {fields.map((f, i) => (
            <FieldRow
              key={f.name}
              // The author knows the variable by its name; the description is the hint.
              field={{ ...f, label: f.name }}
              hint={flow.variables?.find((v) => v.name === f.name)?.description?.split("\n")[0]}
              value={values[f.name] ?? f.initial}
              error={errors[f.name]}
              autoFocus={i === 0}
              onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
              onPick={runnerApi.pick}
            />
          ))}
        </div>
        {keepable && (
          <label className="mt-4 flex items-center gap-2 text-[12.5px] text-slate-600">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="h-4 w-4 accent-brand-500" />
            {t.runInputs.keep}
          </label>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={cancel} className="h-8 rounded-lg px-3 text-[13px] text-slate-600 hover:bg-slate-100">
            {t.cancel}
          </button>
          <button type="submit" disabled={busy} className="h-8 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-60">
            {t.run}
          </button>
        </div>
      </form>
    </div>
  );
}
