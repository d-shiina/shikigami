// The 「自動実行」 place (ui-principles.md): what runs on this PC by itself. Its
// first tab is the schedules, with the agent that fires them; past runs will
// be the next tab. Studio edits `schedules.json` and the agent, a separate
// process, picks the change up (docs/schedules.md).
import { CalendarClock, CirclePause, CirclePlay, Pencil, Play, Square, Trash2, TriangleAlert, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useStudio } from "../context";
import { type AgentStatus, api, type Schedule, type ScheduleList, type ScheduleView, type ScheduleWhen, type ScreenLock } from "../lib/api";
import { agentErrorText } from "../lib/agentError";
import { type MenuSpec, menuFor } from "../lib/contextMenu";
import { t } from "../lib/i18n";
import { blankWhen, DAYS, describeWhen, KINDS, normalizeDays, shortTime, type WhenKind, whenProblem } from "../lib/schedule";
import { BulkButton, ClearFilters, type Column, DataTable, FacetFilter, RowMenuButton, SearchBox, SelectionBar, StatusBadge, Switch, type Tone, toneDot, useTableView, ViewMenu } from "./DataTable";

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
    case "mailReceived":
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label={r.mailbox}>
              <select
                className={inputClass}
                value={when.via ?? "outlook"}
                onChange={(e) => {
                  const m365 = e.target.value === "microsoft365";
                  onChange({ ...when, via: m365 ? "microsoft365" : undefined, account: m365 ? { secret: "", field: "accessToken" } : undefined });
                }}
              >
                <option value="outlook">Outlook</option>
                <option value="microsoft365">Microsoft 365</option>
              </select>
            </Labeled>
            {when.via === "microsoft365" ? (
              <Labeled label={r.mailAccount} hint={r.mailAccountHint}>
                <input
                  className={inputClass}
                  value={when.account?.secret ?? ""}
                  onChange={(e) => onChange({ ...when, account: { secret: e.target.value, field: "accessToken" } })}
                  required
                />
              </Labeled>
            ) : (
              <div />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label={r.mailFolder} hint={r.mailFolderHint}>
              <input className={inputClass} value={when.folder ?? ""} placeholder={r.inbox} onChange={(e) => onChange({ ...when, folder: e.target.value || undefined })} />
            </Labeled>
            <Labeled label={r.mailMinutes}>
              <input
                type="number"
                min={1}
                className={inputClass}
                value={when.minutes ?? 5}
                onChange={(e) => onChange({ ...when, minutes: Math.floor(Number(e.target.value)) })}
              />
            </Labeled>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label={r.subjectContains}>
              <input className={inputClass} value={when.subjectContains ?? ""} onChange={(e) => onChange({ ...when, subjectContains: e.target.value || undefined })} />
            </Labeled>
            <Labeled label={r.fromContains}>
              <input className={inputClass} value={when.fromContains ?? ""} onChange={(e) => onChange({ ...when, fromContains: e.target.value || undefined })} />
            </Labeled>
          </div>
          <Labeled label={r.mailInput} hint={r.mailInputHint}>
            <select className={inputClass} value={when.input ?? ""} onChange={(e) => onChange({ ...when, input: e.target.value || undefined })}>
              <option value="">{r.noInput}</option>
              {inputs.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Labeled>
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
      className="space-y-3 rounded-lg border border-slate-200 bg-sheet p-4"
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
        vars={vars.filter((v) => !((draft.when.kind === "fileAdded" || draft.when.kind === "mailReceived") && draft.when.input === v.name))}
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
  const [error, setError] = useState<{ text: string; raw: string } | null>(null);
  const r = t.runs;
  const act = async (f: () => Promise<AgentStatus | null>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await f());
    } catch (e) {
      setError({ text: agentErrorText(e), raw: message(e) });
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
      {error && (
        <p className="mt-2 text-xs text-shu-600" title={error.raw}>
          {error.text}
        </p>
      )}
    </div>
  );
}

/**
 * Shown in a Remote Desktop session: closing the window locks the screen
 * and desktop flows stop, so offer to leave without locking (tscon).
 */
function RemoteCard() {
  const [confirm, setConfirm] = useState(false);
  const [failed, setFailed] = useState(false);
  const r = t.runs;
  return (
    <div className="mb-4 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-xs leading-5 text-slate-700">
      <p>{r.remoteNote}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`rounded-lg border px-2 py-1 ${confirm ? "border-ink bg-ink text-white" : "border-slate-300 bg-sheet text-ink hover:bg-slate-100"}`}
          onBlur={() => setConfirm(false)}
          onClick={async () => {
            if (!confirm) return setConfirm(true);
            setFailed(false);
            try {
              await api.releaseRemoteSession();
            } catch {
              setFailed(true);
            }
            setConfirm(false);
          }}
        >
          {confirm ? r.releaseConfirm : r.release}
        </button>
        {confirm && <span className="text-slate-600">{r.releaseWarn}</span>}
      </div>
      {failed && <p className="mt-1 text-shu-600">{r.releaseFailed}</p>}
    </div>
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
  const schedules = list?.schedules ?? [];
  const [query, setQuery] = useState("");
  const [states, setStates] = useState<Set<State>>(new Set());
  const [kinds, setKinds] = useState<Set<WhenKind>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const facts = (item: ScheduleView) => factsOf(item, status, list?.screenLock);
  const q = query.trim().toLowerCase();
  // Each filter's counts are over the rows the others keep.
  const keep = (item: ScheduleView, skip?: "state" | "kind") =>
    (skip === "state" || !states.size || states.has(facts(item).state)) &&
    (skip === "kind" || !kinds.size || kinds.has(item.when.kind)) &&
    (!q || [item.name, item.flowName ?? "", describeWhen(item.when)].join(" ").toLowerCase().includes(q));
  const rows = schedules.filter((item) => keep(item));
  const stateOptions = STATES.map((value) => ({ value, label: stateLabel(value), dot: toneDot(STATE_TONE[value]), count: schedules.filter((i) => keep(i, "state") && facts(i).state === value).length }));
  const kindOptions = KINDS.map((value) => ({ value, label: r.kinds[value], count: schedules.filter((i) => keep(i, "kind") && i.when.kind === value).length })).filter(
    (o) => o.count > 0 || kinds.has(o.value),
  );
  // Picked rows the list no longer shows drop out, so bulk actions only touch rows on screen.
  const picked = rows.filter((item) => selected.has(item.id));
  const plain = ({ flowName: _n, published: _p, usesScreen: _u, ...schedule }: ScheduleView): Schedule => schedule;
  const changed = (next: ScheduleList) => {
    setList(next);
    setTimeout(() => void poll(), 1500);
  };
  // Each save is kept as it lands, so a later one failing leaves the list showing what was really saved.
  const each = async (items: ScheduleView[], save: (item: ScheduleView) => Promise<ScheduleList> | null) => {
    try {
      for (const item of items) {
        const next = await save(item);
        if (next) changed(next);
      }
    } catch (e) {
      setError(message(e));
      void load();
    }
  };
  const setEnabled = (items: ScheduleView[], enabled: boolean) => each(items, (item) => (item.enabled === enabled ? null : api.saveSchedule({ ...plain(item), enabled })));
  const remove = async (items: ScheduleView[]) => {
    await each(items, (item) => api.deleteSchedule(item.id));
    setSelected(new Set());
  };
  const menu = (item: ScheduleView): MenuSpec[] => [
    { label: r.edit, icon: Pencil, run: () => setEditing(plain(item)) },
    { label: item.enabled ? r.disable : r.enable, icon: item.enabled ? CirclePause : CirclePlay, run: () => void setEnabled([item], !item.enabled) },
    "-",
    { label: r.delete, icon: Trash2, danger: true, confirm: r.confirmDelete, run: () => void remove([item]) },
  ];
  const columns = useColumns(facts, (item, on) => void setEnabled([item], on));
  const view = useTableView(columns, { storageKey: "spellsheet.studio.schedules.sort", initialSort: { column: "next", descending: false } });
  const filtered = states.size + kinds.size > 0;
  const lockNote = schedules.map((item) => facts(item).locks).find(Boolean);
  return (
    <div className="@container h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[1280px] px-6 pt-5 pb-3">
        <AgentCard status={status} onChange={setStatus} idle={schedules.length === 0} />
        {list?.remote && <RemoteCard />}
        {error && <p className="mb-3 text-xs text-shu-600">{error}</p>}
        {/* Finding and narrowing on the left; adding one, the filled button, at the end. */}
        <div className="mb-3 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {schedules.length > 0 && (
              <>
                <SearchBox value={query} onChange={setQuery} placeholder={r.search} hits={rows.length} />
                <FacetFilter label={r.stateColumn} value={states} onChange={setStates} options={stateOptions} />
                <FacetFilter label={r.kindColumn} value={kinds} onChange={setKinds} options={kindOptions} />
                {filtered && (
                  <ClearFilters
                    onClear={() => {
                      setStates(new Set());
                      setKinds(new Set());
                    }}
                  />
                )}
              </>
            )}
          </div>
          {schedules.length > 0 && <ViewMenu view={view} />}
          <button
            type="button"
            hidden={!!editing}
            onClick={() => setEditing(blank)}
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-primary px-3 text-[13px] font-medium text-on-primary hover:bg-primary-hover"
          >
            ＋ {r.add}
          </button>
        </div>
        {editing && (
          <div className="mb-4 max-w-[680px]">
            <h3 className="mb-2 text-[13px] font-semibold">{editing.id ? r.editTitle : r.add}</h3>
            <ScheduleForm key={editing.id || "new"} initial={editing} onSaved={saved} onCancel={() => setEditing(null)} />
          </div>
        )}
        {list &&
          (schedules.length === 0 ? (
            !editing && (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center text-[13px] text-slate-600">
                <CalendarClock size={22} strokeWidth={1.5} className="text-slate-400" aria-hidden="true" />
                {r.none}
              </div>
            )
          ) : (
            <>
              {/* The screen-lock warning is the same for every row it applies to: said once, marked on the rows. */}
              {lockNote && (
                <p className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-[12px] leading-5 text-amber-700">
                  <TriangleAlert size={14} strokeWidth={1.75} className="mt-[3px] shrink-0 text-amber-600" aria-hidden="true" />
                  {lockNote}
                </p>
              )}
              <DataTable
                columns={columns}
                view={view}
                rows={rows}
                total={schedules.length}
                rowKey={(item) => item.id}
                onOpen={(item) => setEditing(plain(item))}
                selected={new Set(picked.map((i) => i.id))}
                onSelect={setSelected}
                empty={t.list.notFound}
                actionsWidth={44}
                rowActions={(item) => <RowMenuButton items={() => menu(item)} />}
                rowProps={(item) => ({ onContextMenu: menuFor(() => menu(item)) })}
              />
              <SelectionBar count={picked.length} onClear={() => setSelected(new Set())}>
                <BulkButton icon={CirclePlay} label={r.enable} onClick={() => setEnabled(picked, true)} />
                <BulkButton icon={CirclePause} label={r.disable} onClick={() => setEnabled(picked, false)} />
                <BulkButton icon={Trash2} danger label={r.delete} confirmLabel={r.confirmDeleteMany(picked.length)} onClick={() => remove(picked)} />
              </SelectionBar>
            </>
          ))}
        {/* What this place does, said once under the list. */}
        <p className="mt-3 text-[12px] leading-relaxed text-slate-500">{r.intro}</p>
      </div>
    </div>
  );
}

type State = "running" | "on" | "blocked" | "off";
const STATES: State[] = ["running", "on", "blocked", "off"];
const STATE_TONE: Record<State, Tone> = { running: "blue", on: "green", blocked: "red", off: "slate" };
const stateLabel = (s: State) => (s === "running" ? t.runs.running : s === "on" ? t.runs.stateOn : s === "blocked" ? t.runs.stateBlocked : t.runs.stateOff);

/** What a row says besides its schedule: the agent's times and what keeps it from running. */
function factsOf(item: ScheduleView, status: AgentStatus | null | undefined, screenLock: ScreenLock | undefined) {
  const r = t.runs;
  const live = status?.schedules.find((s) => s.id === item.id);
  const running = !!status?.running.some((run) => run.scheduleId === item.id);
  const warn = !item.flowName ? r.flowMissing : !item.published ? r.notPublished : null;
  const state: State = !item.enabled ? "off" : warn ? "blocked" : running ? "running" : "on";
  // Said before the night it stops (docs/design/locked-runs.md).
  const locks =
    item.enabled && item.usesScreen && screenLock ? r.locksScreen(Math.max(1, Math.round(screenLock.afterSecs / 60)), screenLock.by === "inactivityLimit") : null;
  return { state, warn, locks, next: item.enabled ? live?.next : undefined, last: live?.last };
}

function TimeCell({ at }: { at: string | undefined }) {
  return (
    <span className="text-[12.5px] whitespace-nowrap text-slate-600 tabular-nums" title={at ? new Date(at).toLocaleString("ja-JP") : undefined}>
      {at ? shortTime(at) : "—"}
    </span>
  );
}

function useColumns(facts: (item: ScheduleView) => ReturnType<typeof factsOf>, onEnabled: (item: ScheduleView, on: boolean) => void): Column<ScheduleView>[] {
  const r = t.runs;
  return [
    {
      id: "name",
      header: r.name,
      sortValue: (item) => item.name,
      cell: (item) => {
        const { locks } = facts(item);
        return (
          <span className="flex min-w-0 items-center gap-2.5">
            <CalendarClock size={15} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{item.name || item.flowName}</span>
                {locks && (
                  <span className="shrink-0 text-amber-600" role="img" aria-label={r.locksShort} title={locks}>
                    <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                )}
              </span>
              {/* The flow it runs, under the name (as a secret's user name): its own column is for grouping. */}
              {item.flowName ? (
                <span className="flex min-w-0 items-center gap-1 text-[12px] text-slate-500">
                  <Workflow size={12} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.flowName}</span>
                </span>
              ) : (
                <span className="block text-[12px] text-shu-600">{r.flowMissing}</span>
              )}
            </span>
          </span>
        );
      },
    },
    {
      id: "flow",
      header: r.flow,
      width: "w-[200px]",
      hideBelow: 860,
      hiddenByDefault: true,
      sortValue: (item) => item.flowName ?? "",
      group: (item) => ({ key: item.flowId, label: item.flowName ?? r.flowMissing }),
      cell: (item) =>
        item.flowName ? (
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-slate-700">
            <Workflow size={13} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
            <span className="truncate">{item.flowName}</span>
          </span>
        ) : (
          <span className="text-[12.5px] text-shu-600">{r.flowMissing}</span>
        ),
    },
    {
      id: "when",
      header: r.when,
      width: "w-[230px]",
      sortValue: (item) => `${KINDS.indexOf(item.when.kind)}${describeWhen(item.when)}`,
      group: (item) => ({ key: item.when.kind, order: KINDS.indexOf(item.when.kind), label: r.kinds[item.when.kind] }),
      cell: (item) => {
        const text = describeWhen(item.when);
        return (
          <span className="block truncate text-[12.5px] text-slate-700" title={text}>
            {text}
          </span>
        );
      },
    },
    {
      id: "state",
      header: r.stateColumn,
      width: "w-[132px]",
      sortValue: (item) => STATES.indexOf(facts(item).state),
      group: (item) => {
        const { state } = facts(item);
        return { key: state, order: STATES.indexOf(state), label: <StatusBadge tone={STATE_TONE[state]} label={stateLabel(state)} /> };
      },
      cell: (item) => {
        const { state, warn } = facts(item);
        return <StatusBadge tone={STATE_TONE[state]} label={stateLabel(state)} title={warn ?? undefined} />;
      },
    },
    {
      id: "next",
      header: r.nextColumn,
      width: "w-[108px]",
      // Off and never-run rows go last either way.
      sortValue: (item) => facts(item).next ?? "9999",
      cell: (item) => <TimeCell at={facts(item).next} />,
    },
    {
      id: "last",
      header: r.lastColumn,
      width: "w-[108px]",
      hideBelow: 1000,
      sortValue: (item) => facts(item).last ?? "",
      cell: (item) => <TimeCell at={facts(item).last} />,
    },
    {
      id: "enabled",
      header: r.enabled,
      width: "w-[88px]",
      hideable: false,
      sortValue: (item) => (item.enabled ? 0 : 1),
      cell: (item) => <Switch checked={item.enabled} label={item.enabled ? r.disable : r.enable} onChange={(on) => onEnabled(item, on)} />,
    },
  ];
}
