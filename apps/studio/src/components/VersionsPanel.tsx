import type { DiffKind, ScenarioDiff, StepTypeDef, VersionSummary } from "@shikigami/schema";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { formatValue, relativeTime } from "../lib/changes";
import { stepLabel, t } from "../lib/i18n";

const KIND_STYLE: Record<DiffKind, string> = {
  added: "bg-moegi-100 text-moegi-500",
  removed: "bg-shu-50 text-shu-600",
  changed: "bg-brand-50 text-brand-600",
  moved: "bg-slate-100 text-slate-600",
};

const scenarioField = (field: string) => (t.versionField as Record<string, string>)[field] ?? field;

function Kind({ kind }: { kind: DiffKind }) {
  return <span className={`rounded px-1 text-[10px] font-semibold ${KIND_STYLE[kind]}`}>{t.diffKind[kind]}</span>;
}

/** Differences from a version to the current content. */
function DiffView({ diff, defs }: { diff: ScenarioDiff; defs: Map<string, StepTypeDef> }) {
  const goTo = useStudio((s) => s.goTo);
  if (diff.identical) return <p className="text-xs text-slate-500">{t.noDiff}</p>;
  return (
    <ul className="space-y-1.5 rounded border border-slate-200 bg-paper p-2 text-xs">
      {diff.scenario.map((f) => (
        <li key={`s-${f.field}`} className="flex flex-wrap items-baseline gap-1.5">
          <Kind kind="changed" />
          <span>{scenarioField(f.field)}</span>
        </li>
      ))}
      {diff.variables.map((v) => (
        <li key={`v-${v.name}`} className="flex items-baseline gap-1.5">
          <Kind kind={v.kind} />
          <span>
            {t.variables} <span className="font-mono">{v.name}</span>
          </span>
        </li>
      ))}
      {diff.steps.map((s) => (
        <li key={`${s.kind}-${s.stepId}`}>
          <button
            type="button"
            disabled={s.kind === "removed"}
            onClick={() => goTo(s.stepId)}
            className="flex w-full items-baseline gap-1.5 text-left enabled:hover:text-brand-600"
          >
            <Kind kind={s.kind} />
            <span className="truncate">{s.name || stepLabel(s.type, defs.get(s.type)?.label)}</span>
            {s.stepCount != null && s.stepCount > 1 && <span className="text-slate-400">{t.paren(String(s.stepCount))}</span>}
          </button>
          {s.fields && s.fields.length > 0 && (
            <dl className="mt-0.5 space-y-0.5 pl-6 font-mono text-[11px]">
              {s.fields.map((f) => (
                <div key={f.field} className="flex flex-wrap items-baseline gap-x-1.5">
                  <dt className="text-slate-500">{f.field.replace(/^params\./, "")}</dt>
                  <dd className="text-shu-600 line-through decoration-shu-500/50">{formatValue(f.before)}</dd>
                  <span className="text-slate-400">→</span>
                  <dd className="text-moegi-500">{formatValue(f.after)}</dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

function VersionRow({ version, defs }: { version: VersionSummary; defs: Map<string, StepTypeDef> }) {
  const scenario = useStudio((s) => s.scenario);
  const restoreVersion = useStudio((s) => s.restoreVersion);
  const [diff, setDiff] = useState<ScenarioDiff | null>(null);
  const [confirm, setConfirm] = useState(false);
  const revision = scenario?.revision ?? 0;

  // Keep an open diff current while the scenario is edited.
  useEffect(() => {
    if (!diff || !scenario) return;
    let alive = true;
    void api.diffVersions(scenario.id, version.number).then((d) => alive && setDiff(d));
    return () => {
      alive = false;
    };
  }, [revision]);

  const toggleDiff = async () => {
    if (diff) return setDiff(null);
    if (scenario) setDiff(await api.diffVersions(scenario.id, version.number));
  };

  return (
    <li className="group relative flex gap-3 pb-4 pl-1">
      <span className="absolute top-7 bottom-0 left-[16px] w-px bg-slate-200 group-last:hidden" />
      <span className="grid h-6 min-w-6 shrink-0 place-items-center rounded-[3px] bg-ink px-1 font-serif text-[10px] font-bold text-paper">
        v{version.number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold">{version.name}</span>
          <span className="ml-auto shrink-0 text-xs text-slate-400">{relativeTime(version.createdAt)}</span>
        </div>
        <div className="text-xs text-slate-500">
          {t.actor[version.createdBy.kind]}
          {version.createdBy.name ? t.paren(version.createdBy.name) : ""} · rev {version.revision} · {version.stepCount} steps
        </div>
        {version.note && <p className="mt-1 text-xs whitespace-pre-wrap text-slate-700">{version.note}</p>}
        <div className="mt-1 flex gap-3 text-xs">
          <button type="button" className="text-slate-500 hover:text-ink" onClick={() => void toggleDiff()}>
            {diff ? t.hideDiff : t.showDiff}
          </button>
          <button
            type="button"
            className={confirm ? "font-semibold text-shu-600" : "text-slate-500 hover:text-shu-600"}
            onClick={() => {
              if (!confirm) return setConfirm(true);
              setConfirm(false);
              void restoreVersion(version.number);
            }}
            onBlur={() => setConfirm(false)}
          >
            ↶ {confirm ? t.confirmRestoreAgain : t.restore}
          </button>
        </div>
        {diff && (
          <div className="mt-2">
            <DiffView diff={diff} defs={defs} />
          </div>
        )}
      </div>
    </li>
  );
}

/** Named versions: save, compare with the current content, restore, share. */
export function VersionsPanel() {
  const versions = useStudio((s) => s.versions);
  const stepTypes = useStudio((s) => s.stepTypes);
  const loadVersions = useStudio((s) => s.loadVersions);
  const scenarioId = useStudio((s) => s.scenario?.id);
  const createVersion = useStudio((s) => s.createVersion);
  const exportScenario = useStudio((s) => s.exportScenario);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  // Reload on every scenario switch; others may also have saved versions in
  // a shared workspace since we opened it.
  useEffect(() => {
    void loadVersions();
  }, [loadVersions, scenarioId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await createVersion(name.trim(), note.trim())) {
      setName("");
      setNote("");
    }
  };

  return (
    <div className="space-y-5 p-4">
      <form onSubmit={submit} className="space-y-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.versionName}
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-ink focus:outline-none"
        />
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t.versionNote}
          rows={2}
          className="w-full resize-none rounded border border-slate-300 px-2 py-1 text-sm focus:border-ink focus:outline-none"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="w-full rounded-[4px] bg-ink px-2 py-1 text-sm font-medium text-paper hover:bg-slate-700 disabled:bg-slate-300"
        >
          {t.saveVersion}
        </button>
        <p className="text-[11px] leading-relaxed text-slate-500">{t.versionsHint}</p>
      </form>
      <section>
        <h3 className="mb-3 font-serif text-sm font-semibold">{t.versions}</h3>
        {versions.length === 0 ? (
          <p className="text-sm text-slate-400">{t.versionsEmpty}</p>
        ) : (
          <ol>
            {versions.map((v) => (
              <VersionRow key={`${scenarioId}-${v.number}`} version={v} defs={defs} />
            ))}
          </ol>
        )}
      </section>
      <section>
        <h3 className="mb-2 font-serif text-sm font-semibold">{t.share}</h3>
        <button
          type="button"
          onClick={() => void exportScenario()}
          className="rounded-[4px] border border-slate-300 px-3 py-1 text-xs hover:bg-slate-100"
        >
          {t.exportScenario}
        </button>
      </section>
    </div>
  );
}
