// The 「自動実行」 place (ui-principles.md): what runs on this PC by itself. Its
// first tab is the schedules, with the agent that fires them; past runs will
// be the next tab. Studio edits `schedules.json` and the agent, a separate
// process, picks the change up (docs/schedules.md).
import { CalendarClock, Play, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useStudio } from "../context";
import { type AgentStatus, api, type Schedule, type ScheduleList, type ScheduleView, type ScheduleWhen } from "../lib/api";
import { t } from "../lib/i18n";
import { blankWhen, DAYS, describeWhen, KINDS, normalizeDays, shortTime, type WhenKind, whenProblem } from "../lib/schedule";

const inputClass = "w-full rounded border border-slate-300 bg-sheet px-2 py-1 text-sm focus:border-primary focus:outline-none";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

function DayPicker({ days: given, onChange }: { days: string[]; onChange: (days: string[]) => void }) {
  const names = t.runs.dayNames as Record<string, string>;
  // "月" or "Mon" written by hand or with the CLI shows as selected, and is
  // saved back as "mon".
  const days: string[] = normalizeDays(given);
  return (
    <div className="flex gap-1">
      {DAYS.map((d) => {
        const on = days.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? days.filter((x) => x !== d) : [...days, d])}
            className={`h-7 min-w-8 rounded-lg border px-1.5 text-xs ${on ? "border-slate-400 bg-slate-100 font-medium text-ink" : "border-slate-300 text-slate-600 hover:bg-slate-100"}`}
          >
            {names[d]}
          </button>
        );
      })}
    </div>
  );
}

/** Whether a daily or every-few-minutes schedule rests on holidays. */
function SkipHolidays({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-ink">{t.runs.skipHolidays}</span>
        <span className="block text-[11px] text-slate-500">{t.runs.holidaysHint}</span>
      </span>
    </label>
  );
}

/** The fields of one kind of `when`. */
function WhenFields({ when, onChange, inputs }: { when: ScheduleWhen; onChange: (w: ScheduleWhen) => void; inputs: string[] }) {
  const r = t.runs;
  switch (when.kind) {
    case "daily":
      return (
        <>
          <Labeled label={r.at}>
            <input type="time" className={inputClass} value={when.at} onChange={(e) => onChange({ ...when, at: e.target.value })} required />
          </Labeled>
          <Labeled label={r.days} hint={r.everyDay}>
            <DayPicker days={when.days ?? []} onChange={(days) => onChange({ ...when, days })} />
          </Labeled>
          <SkipHolidays checked={when.skipHolidays ?? false} onChange={(skipHolidays) => onChange({ ...when, skipHolidays: skipHolidays || undefined })} />
        </>
      );
    case "monthly": {
      const business = when.businessDay ?? false;
      return (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Labeled label={r.counting}>
              <select
                className={inputClass}
                value={business ? "business" : "calendar"}
                onChange={(e) => {
                  const toBusiness = e.target.value === "business";
                  onChange({
                    ...when,
                    businessDay: toBusiness || undefined,
                    onHoliday: undefined,
                    day: toBusiness && when.day > 23 ? -1 : when.day,
                  });
                }}
              >
                <option value="calendar">{r.calendarDays}</option>
                <option value="business">{r.businessDays}</option>
              </select>
            </Labeled>
            <Labeled label={r.dayOfMonth}>
              <select className={inputClass} value={when.day} onChange={(e) => onChange({ ...when, day: Number(e.target.value) })}>
                {Array.from({ length: business ? 23 : 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {business ? r.describe.businessDay(d) : r.describe.day(d)}
                  </option>
                ))}
                <option value={-1}>{business ? r.lastBusinessDay : r.lastDay}</option>
              </select>
            </Labeled>
            <Labeled label={r.at}>
              <input type="time" className={inputClass} value={when.at} onChange={(e) => onChange({ ...when, at: e.target.value })} required />
            </Labeled>
          </div>
          {!business && (
            <Labeled label={r.onHoliday} hint={r.holidaysHint}>
              <select
                className={inputClass}
                value={when.onHoliday ?? ""}
                onChange={(e) => onChange({ ...when, onHoliday: (e.target.value || undefined) as typeof when.onHoliday })}
              >
                <option value="">{r.onHolidayChoices.run}</option>
                <option value="before">{r.onHolidayChoices.before}</option>
                <option value="after">{r.onHolidayChoices.after}</option>
                <option value="skip">{r.onHolidayChoices.skip}</option>
              </select>
            </Labeled>
          )}
        </>
      );
    }
    case "every":
      return (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Labeled label={r.minutes}>
              <input
                type="number"
                min={1}
                className={inputClass}
                value={when.minutes}
                onChange={(e) => onChange({ ...when, minutes: Math.floor(Number(e.target.value)) })}
                required
              />
            </Labeled>
            <Labeled label={r.between} hint={r.betweenHint}>
              <input type="time" className={inputClass} value={when.from ?? ""} onChange={(e) => onChange({ ...when, from: e.target.value || undefined })} />
            </Labeled>
            <Labeled label={"\u00a0"}>
              <input type="time" className={inputClass} value={when.to ?? ""} onChange={(e) => onChange({ ...when, to: e.target.value || undefined })} />
            </Labeled>
          </div>
          <Labeled label={r.days} hint={r.everyDay}>
            <DayPicker days={when.days ?? []} onChange={(days) => onChange({ ...when, days })} />
          </Labeled>
          <SkipHolidays checked={when.skipHolidays ?? false} onChange={(skipHolidays) => onChange({ ...when, skipHolidays: skipHolidays || undefined })} />
        </>
      );
    case "once":
      return (
        <Labeled label={r.onceAt}>
          <input type="datetime-local" className={inputClass} value={when.at} onChange={(e) => onChange({ ...when, at: e.target.value })} required />
        </Labeled>
      );
    case "fileAdded":
      return (
        <>
          <Labeled label={r.folder} hint={r.folderHint}>
            <input className={`${inputClass} font-mono text-xs`} value={when.folder} onChange={(e) => onChange({ ...when, folder: e.target.value })} required />
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label={r.pattern} hint={r.patternHint}>
              <input className={`${inputClass} font-mono text-xs`} value={when.pattern} onChange={(e) => onChange({ ...when, pattern: e.target.value })} />
            </Labeled>
            <Labeled label={r.fileInput}>
              <select className={inputClass} value={when.input ?? ""} onChange={(e) => onChange({ ...when, input: e.target.value || undefined })}>
                <option value="">{r.noInput}</option>
                {inputs.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Labeled>
          </div>
        </>
      );
  }
}

type InputVar = { name: string; type: string; required: boolean };

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** What was typed, as the variable's type (numbers and true/false). */
function asValue(text: string, type: string): unknown {
  if (type === "number" && text.trim() !== "" && !Number.isNaN(Number(text))) return Number(text);
  if (type === "boolean" && (text === "true" || text === "false")) return text === "true";
  return text;
}

/** Values for the flow's inputs; ones without a default must be given. */
function InputFields({ vars, values, onChange }: { vars: InputVar[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const r = t.runs;
  if (vars.length === 0) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-slate-600">{r.inputs}</legend>
      {vars.map((v) => (
        <Labeled key={v.name} label={v.required ? `${v.name}（${r.required}）` : v.name}>
          <input
            className={inputClass}
            value={asText(values[v.name])}
            required={v.required}
            placeholder={v.required ? "" : r.defaultPlaceholder}
            onChange={(e) => {
              const next = { ...values };
              if (e.target.value === "") delete next[v.name];
              else next[v.name] = asValue(e.target.value, v.type);
              onChange(next);
            }}
          />
        </Labeled>
      ))}
    </fieldset>
  );
}

function ScheduleForm({ initial, onSaved, onCancel }: { initial: Schedule; onSaved: (list: ScheduleList) => void; onCancel: () => void }) {
  const summaries = useStudio((s) => s.summaries);
  // Only a published version runs unattended: the others are listed, but cannot be chosen.
  const [published, setPublished] = useState<Set<string> | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all(summaries.map((s) => api.publishedState(s.id).then((p) => (p ? s.id : null), () => null))).then(
      (ids) => live && setPublished(new Set(ids.filter((id): id is string => id !== null))),
    );
    return () => {
      live = false;
    };
  }, [summaries]);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [vars, setVars] = useState<InputVar[]>([]);
  const inputs = vars.map((v) => v.name);
  const r = t.runs;
  // The input variables of the flow: the file trigger's path goes in one,
  // and the others are given here (the agent passes them to every run).
  useEffect(() => {
    if (!draft.flowId) return setVars([]);
    let live = true;
    api
      .getFlow(draft.flowId)
      .then(
        (s) =>
          live &&
          setVars(
            (s.variables ?? [])
              .filter((v) => v.direction === "input" || v.direction === "inOut")
              .map((v) => ({ name: v.name, type: v.type ?? "any", required: v.default === undefined })),
          ),
      )
      .catch(() => live && setVars([]));
    return () => {
      live = false;
    };
  }, [draft.flowId]);
  const setKind = (kind: WhenKind) => setDraft((d) => ({ ...d, when: d.when.kind === kind ? d.when : blankWhen(kind) }));
  return (
    <form
      className="space-y-3 rounded-lg border border-slate-200 bg-sheet p-4 shadow-sheet"
      onSubmit={async (e) => {
        e.preventDefault();
        const problem = whenProblem(draft.when);
        if (problem) return setError(problem);
        try {
          onSaved(await api.saveSchedule(draft));
        } catch (err) {
          setError(message(err));
        }
      }}
    >
      <Labeled label={r.flow}>
        <select className={inputClass} value={draft.flowId} required onChange={(e) => setDraft({ ...draft, flowId: e.target.value })}>
          <option value="" disabled>
            {r.chooseFlow}
          </option>
          {summaries.map((s) => {
            const off = published !== null && !published.has(s.id) && s.id !== initial.flowId;
            return (
              <option key={s.id} value={s.id} disabled={off}>
                {off ? `${s.name}（${t.notPublishedBadge}）` : s.name}
              </option>
            );
          })}
        </select>
      </Labeled>
      <Labeled label={r.name}>
        <input className={inputClass} value={draft.name} placeholder={r.namePlaceholder} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </Labeled>
      <div className="space-y-1">
        <span className="text-xs font-medium text-slate-600">{r.when}</span>
        <div className="flex flex-wrap gap-1" role="radiogroup">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={draft.when.kind === k}
              onClick={() => setKind(k)}
              className={`rounded-lg border px-2 py-1 text-xs ${draft.when.kind === k ? "border-slate-400 bg-slate-100 font-medium text-ink" : "border-slate-300 text-slate-600 hover:bg-slate-100"}`}
            >
              {r.kinds[k]}
            </button>
          ))}
        </div>
      </div>
      <WhenFields when={draft.when} inputs={inputs} onChange={(when) => setDraft({ ...draft, when })} />
      <InputFields
        vars={vars.filter((v) => !(draft.when.kind === "fileAdded" && draft.when.input === v.name))}
        values={draft.inputs ?? {}}
        onChange={(inputs) => setDraft({ ...draft, inputs })}
      />
      <p className="text-xs text-slate-600">{describeWhen(draft.when)}</p>
      {error && <p className="rounded border border-shu-600/40 bg-shu-600/5 px-2 py-1.5 text-xs text-shu-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-lg px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={onCancel}>
          {r.cancel}
        </button>
        <button type="submit" className="rounded-lg bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover">
          {r.save}
        </button>
      </div>
    </form>
  );
}

function AgentCard({ status, onChange, idle }: { status: AgentStatus | null | undefined; onChange: (s: AgentStatus | null) => void; idle: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = t.runs;
  const act = async (f: () => Promise<AgentStatus | null>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await f());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (status === undefined) return null;
  return (
    // Stopped is only a problem when there is something to run.
    <div className={`mb-4 rounded-lg border p-3 ${status || idle ? "border-slate-200 bg-sheet" : "border-shu-600/40 bg-shu-600/5"}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${status ? "bg-moegi-500" : idle ? "bg-slate-400" : "bg-shu-500"}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{status ? r.agentOn : idle ? r.agentIdle : r.agentOff}</p>
          {status && <p className="text-[11px] text-slate-500">{r.agentOnDetail(shortTime(status.startedAt))}</p>}
        </div>
        {status ? (
          <button
            type="button"
            disabled={busy}
            title={r.agentStopHint}
            onClick={() => act(async () => (await api.stopAgent(), null))}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            <Square size={12} aria-hidden="true" />
            {r.agentStop}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            title={r.agentStartHint}
            onClick={() => act(api.startAgent)}
            className="flex items-center gap-1 rounded-lg border border-slate-300 bg-sheet px-3 py-1 text-sm font-medium text-ink hover:bg-slate-100 disabled:opacity-60"
          >
            <Play size={13} aria-hidden="true" />
            {r.agentStart}
          </button>
        )}
      </div>
      {!status && <p className="mt-1 pl-4 text-[11px] text-slate-600">{r.agentStartHint}</p>}
      {status?.problem && <p className="mt-2 text-xs text-shu-600">{r.problem(status.problem)}</p>}
      {status && status.running.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs">
          {status.running.map((run) => (
            <li key={run.runId} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" aria-hidden="true" />
              <span className="font-medium">{run.flowName}</span>
              <span className="text-slate-500">
                {r.running} · {shortTime(run.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-shu-600">{error}</p>}
    </div>
  );
}

function ScheduleRow({
  item,
  status,
  onEdit,
  onList,
}: {
  item: ScheduleView;
  status: AgentStatus | null | undefined;
  onEdit: () => void;
  onList: (list: ScheduleList) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const r = t.runs;
  const live = status?.schedules.find((s) => s.id === item.id);
  const { flowName, published, ...schedule } = item;
  const warn = !flowName ? r.flowMissing : !published ? r.notPublished : null;
  return (
    <li className={`rounded-lg border border-slate-200 bg-sheet p-3 shadow-sheet ${item.enabled ? "" : "opacity-70"}`}>
      <div className="flex items-center gap-2">
        <CalendarClock size={15} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium">{item.name}</span>
        <label className="ml-auto flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={item.enabled}
            onChange={async (e) => onList(await api.saveSchedule({ ...schedule, enabled: e.target.checked }))}
          />
          {r.enabled}
        </label>
        <button type="button" className="text-xs text-brand-600 hover:underline" onClick={onEdit}>
          {r.edit}
        </button>
        <button
          type="button"
          className={`text-xs ${confirm ? "font-semibold text-shu-600" : "text-slate-500 hover:text-shu-600"}`}
          onBlur={() => setConfirm(false)}
          onClick={async () => (confirm ? onList(await api.deleteSchedule(item.id)) : setConfirm(true))}
        >
          {confirm ? r.confirmDelete : r.delete}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-6 text-xs text-slate-600">
        <span>{describeWhen(item.when)}</span>
        {flowName && flowName !== item.name && <span className="text-slate-500">{flowName}</span>}
        {!item.enabled ? (
          <span className="text-slate-500">{r.paused}</span>
        ) : (
          live?.next && <span className="text-slate-500">{r.next(shortTime(live.next))}</span>
        )}
        {live?.last && <span className="text-slate-500">{r.last(shortTime(live.last))}</span>}
      </div>
      {warn && <p className="mt-1 pl-6 text-xs text-shu-600">{warn}</p>}
    </li>
  );
}

/** Set by the inspector's 「スケジュールを追加」: the page opens with the form. */
let pendingNew = false;
export function openNewSchedule() {
  pendingNew = true;
}

/** This flow's schedules, for the inspector (ui-principles.md). */
export function useSchedulesOf(flowId: string | undefined): ScheduleView[] | null {
  const [list, setList] = useState<ScheduleView[] | null>(null);
  useEffect(() => {
    if (!flowId) return;
    let live = true;
    api
      .listSchedules()
      .then((l) => live && setList(l.schedules.filter((s) => s.flowId === flowId)))
      .catch(() => live && setList(null));
    return () => {
      live = false;
    };
  }, [flowId]);
  return list;
}

export function RunsPage() {
  const [list, setList] = useState<ScheduleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  // undefined: not asked yet; null: not running.
  const [status, setStatus] = useState<AgentStatus | null | undefined>(undefined);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const openId = useStudio((s) => s.flow?.id);
  const r = t.runs;
  const load = useCallback(async () => {
    try {
      setList(await api.listSchedules());
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  const poll = useCallback(async () => {
    try {
      setStatus(await api.agentStatus());
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => {
    if (pendingNew) {
      pendingNew = false;
      setEditing({ id: "", name: "", flowId: openId ?? "", enabled: true, when: blankWhen("daily") });
    }
  }, [openId]);
  useEffect(() => {
    void load();
    void poll();
    // Runs start and end, and the next times move on, without Studio.
    const timer = setInterval(() => void poll(), 5000);
    return () => clearInterval(timer);
  }, [load, poll]);
  const saved = (next: ScheduleList) => {
    setList(next);
    setEditing(null);
    // The agent reads the file within a second; then the next times show.
    setTimeout(() => void poll(), 1500);
  };
  const blank: Schedule = { id: "", name: "", flowId: openId ?? "", enabled: true, when: blankWhen("daily") };
  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[680px] px-6 py-6">
        <div className="mb-3 flex items-end gap-4 border-b border-slate-200">
          <h2 className="pb-2 text-lg font-bold">{r.place}</h2>
          <div role="tablist" className="flex">
            <button type="button" role="tab" aria-selected="true" className="-mb-px border-b-2 border-ink px-2 pb-2 text-sm font-semibold">
              {r.schedules}
            </button>
          </div>
          {!editing && (
            <button
              type="button"
              className="mb-2 ml-auto rounded-lg bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-hover"
              onClick={() => setEditing(blank)}
            >
              {r.add}
            </button>
          )}
        </div>
        <p className="mb-4 text-xs text-slate-600">{r.intro}</p>
        <AgentCard status={status} onChange={setStatus} idle={(list?.schedules.length ?? 0) === 0} />
        {error && <p className="mb-3 text-xs text-shu-600">{error}</p>}
        {editing && (
          <div className="mb-4">
            <ScheduleForm key={editing.id || "new"} initial={editing} onSaved={saved} onCancel={() => setEditing(null)} />
          </div>
        )}
        {list && (
          <>
            <ul className="space-y-2">
              {list.schedules.length === 0 && !editing && <li className="text-sm text-slate-500">{r.none}</li>}
              {list.schedules.map((item) => {
                const { flowName: _n, published: _p, ...schedule } = item;
                return (
                  <ScheduleRow
                    key={item.id}
                    item={item}
                    status={status}
                    onEdit={() => setEditing(schedule)}
                    onList={(next) => {
                      setList(next);
                      setTimeout(() => void poll(), 1500);
                    }}
                  />
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
