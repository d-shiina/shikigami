// The inspector with nothing selected: the flow itself (name, variables, how it runs).
import { useStudio } from "../../context";
import { t } from "../../lib/i18n";
import { describeWhen } from "../../lib/schedule";
import { openNewSchedule, useSchedulesOf } from "../RunsPage";
import { VariablesPanel } from "../VariablesPanel";
import { inputClass, CommitInput, Row, Section } from "./fields";

/** When this flow runs by itself on this PC; they are edited in 「自動実行」. */
function SchedulesSection({ flowId }: { flowId: string }) {
  const schedules = useSchedulesOf(flowId);
  const setPlace = useStudio((s) => s.setPlace);
  if (!schedules) return null;
  return (
    <Section title={t.runs.schedules}>
      <ul className="space-y-1 text-xs">
        {schedules.length === 0 && <li className="text-slate-500">{t.runs.none}</li>}
        {schedules.map((s) => (
          <li key={s.id} className={s.enabled ? "" : "text-slate-500"}>
            <button type="button" className="text-left hover:underline" onClick={() => setPlace("runs")}>
              {describeWhen(s.when)}
              {!s.enabled && `（${t.runs.paused}）`}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-1.5 text-xs text-brand-600 hover:underline"
        onClick={() => {
          openNewSchedule();
          setPlace("runs");
        }}
      >
        {t.runs.add}
      </button>
    </Section>
  );
}

/** With nothing selected, the inspector shows the flow itself: what it is, its variables, how it runs. */
export function FlowInspector() {
  const flow = useStudio((s) => s.flow);
  const updateFlow = useStudio((s) => s.updateFlow);
  if (!flow) return null;
  const settings = flow.settings ?? {};
  const setSettings = (patch: Partial<typeof settings>) => updateFlow({ settings: { ...settings, ...patch } });
  return (
    <div className="pb-6">
      <Section title={t.props.basics}>
        <Row label={t.shell.name}>
          <CommitInput value={flow.name} onCommit={(name) => name.trim() && updateFlow({ name: name.trim() })} />
        </Row>
        <Row label={t.shell.description}>
          <CommitInput multiline value={flow.description ?? ""} placeholder={t.shell.descriptionPlaceholder} onCommit={(description) => updateFlow({ description })} />
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
      <SchedulesSection flowId={flow.id} />
    </div>
  );
}

