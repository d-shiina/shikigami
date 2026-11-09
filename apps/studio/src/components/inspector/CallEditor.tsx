// The settings of a `flow.call` node: which flow, what goes in and out.
import { ArrowUpRight } from "lucide-react";
import type { Step, StepPatch } from "@spellsheet/schema";
import { useStudio } from "../../context";
import { t } from "../../lib/i18n";
import { callMap, referencedVariables, TYPE_COLOR } from "../../lib/nodeRows";
import { inputClass, CommitInput, Row, Section } from "./fields";


/** Which flow a call runs, what it passes in and where its outputs go. */
export function CallEditor({
  step,
  vars,
  update,
}: {
  step: Step;
  vars: Map<string, string | undefined>;
  update: (p: StepPatch) => void;
}) {
  const flow = useStudio((s) => s.flow);
  const summaries = useStudio((s) => s.summaries);
  const called = useStudio((s) => s.called);
  const open = useStudio((s) => s.open);
  const target = typeof step.params?.flow === "string" ? step.params.flow : "";
  const callee = called[target];
  const inputs = callMap(step, "inputs");
  const outs = callMap(step, "outputs");
  const known = new Set(vars.keys());
  const choices = summaries.filter((s) => s.id !== flow?.id);
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
              className="inline-flex items-center gap-0.5 text-[10px] text-brand-600 hover:underline"
              onClick={(e) => {
                e.preventDefault();
                void open(target);
              }}
            >
              {t.flow.open}
              <ArrowUpRight size={10} aria-hidden="true" />
            </button>
          )
        }
      >
        <Row label={`${t.props.flow} *`} hint={target !== "" && !callee ? t.props.notInWorkspace : undefined}>
          <select
            className={inputClass}
            value={target}
            // Inputs and outputs belong to the old target: start over.
            onChange={(e) => update({ replaceParams: { flow: e.target.value } })}
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

