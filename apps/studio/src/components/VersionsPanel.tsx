import { ArrowRight, Undo2 } from "lucide-react";
import type { DiffKind, FlowDiff, StepTypeDef, VersionSummary } from "@shikigami/schema";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { formatValue, relativeTime } from "../lib/changes";
import { stepLabel, t } from "../lib/i18n";
import { useFlowHealth } from "../lib/useTodos";

const KIND_STYLE: Record<DiffKind, string> = {
  added: "bg-moegi-100 text-moegi-500",
  removed: "bg-shu-50 text-shu-600",
  changed: "bg-brand-50 text-brand-600",
  moved: "bg-slate-100 text-slate-600",
};

const flowField = (field: string) => (t.versionField as Record<string, string>)[field] ?? field;

function Kind({ kind }: { kind: DiffKind }) {
  return <span className={`rounded px-1 text-[10px] font-semibold ${KIND_STYLE[kind]}`}>{t.diffKind[kind]}</span>;
}

/** Differences from a version to the current content. */
function DiffView({ diff, defs }: { diff: FlowDiff; defs: Map<string, StepTypeDef> }) {
  const goTo = useStudio((s) => s.goTo);
  if (diff.identical) return <p className="text-xs text-slate-500">{t.noDiff}</p>;
  return (
    <ul className="space-y-1.5 rounded border border-slate-200 bg-paper p-2 text-xs">
      {diff.flow.map((f) => (
        <li key={`s-${f.field}`} className="flex flex-wrap items-baseline gap-1.5">
          <Kind kind="changed" />
          <span>{flowField(f.field)}</span>
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
                  <ArrowRight size={11} className="shrink-0 self-center text-slate-400" aria-hidden="true" />
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

/** Which version unattended runs execute, and publishing the current content. */
function PublishedCard() {
  const published = useStudio((s) => s.published);
  const publish = useStudio((s) => s.publish);
  const unpublish = useStudio((s) => s.unpublish);
  const [confirm, setConfirm] = useState(false);
  const health = useFlowHealth();
  // What unattended runs would trip over: said before publishing, not after.
  const warnings = [
    health.errors > 0 && t.publishWarn.errors(health.errors),
    health.unset > 0 && t.publishWarn.unset(health.unset),
    health.todos > 0 && t.publishWarn.todos(health.todos),
    health.lastFailed && t.publishWarn.lastFailed,
  ].filter((w): w is string => Boolean(w));
  const [publishAnyway, setPublishAnyway] = useState(false);
  return (
    <section className="space-y-1.5 rounded-lg border border-slate-200 bg-paper p-3">
      <div className="flex items-center gap-2">
        {published ? (
          <span className="rounded-md bg-moegi-100 px-1.5 text-[11px] font-bold text-moegi-500">{t.published}</span>
        ) : null}
        <span className="truncate text-sm font-semibold">
          {published ? t.publishedLabel(published.version, published.name) : t.notPublished}
        </span>
        {published && <span className="ml-auto shrink-0 text-xs text-slate-400">{relativeTime(published.publishedAt)}</span>}
      </div>
      {published && !published.matchesCurrent && <p className="text-xs text-shu-600">{t.publishedBehind}</p>}
      <p className="text-[11px] leading-relaxed text-slate-500">{t.publishedHint}</p>
      {!published?.matchesCurrent && warnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          <p className="font-semibold">{t.publishWarn.title}</p>
          <ul className="mt-0.5 list-disc pl-4">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-3">
        {!published?.matchesCurrent && (
          <button
            type="button"
            onClick={() => {
              if (warnings.length > 0 && !publishAnyway) return setPublishAnyway(true);
              setPublishAnyway(false);
              void publish();
            }}
            onBlur={() => setPublishAnyway(false)}
            className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-on-primary hover:bg-primary-hover"
          >
            {publishAnyway ? t.publishWarn.anyway : t.publishCurrent}
          </button>
        )}
        {published && (
          <button
            type="button"
            className={confirm ? "text-xs font-semibold text-shu-600" : "text-xs text-slate-500 hover:text-shu-600"}
            onClick={() => {
              if (!confirm) return setConfirm(true);
              setConfirm(false);
              void unpublish();
            }}
            onBlur={() => setConfirm(false)}
          >
            {confirm ? t.unpublishConfirm : t.unpublish}
          </button>
        )}
      </div>
    </section>
  );
}

function VersionRow({ version, defs }: { version: VersionSummary; defs: Map<string, StepTypeDef> }) {
  const flow = useStudio((s) => s.flow);
  const restoreVersion = useStudio((s) => s.restoreVersion);
  const published = useStudio((s) => s.published?.version === version.number);
  const publish = useStudio((s) => s.publish);
  const [diff, setDiff] = useState<FlowDiff | null>(null);
  const [confirm, setConfirm] = useState(false);
  const revision = flow?.revision ?? 0;

  // Keep an open diff current while the flow is edited.
  useEffect(() => {
    if (!diff || !flow) return;
    let alive = true;
    void api.diffVersions(flow.id, version.number).then((d) => alive && setDiff(d));
    return () => {
      alive = false;
    };
  }, [revision]);

  const toggleDiff = async () => {
    if (diff) return setDiff(null);
    if (flow) setDiff(await api.diffVersions(flow.id, version.number));
  };

  return (
    <li className="group relative flex gap-3 pb-4 pl-1">
      <span className="absolute top-7 bottom-0 left-[16px] w-px bg-slate-200 group-last:hidden" />
      <span className="grid h-6 min-w-6 shrink-0 place-items-center rounded-md bg-ink px-1 text-[10px] font-bold text-paper">
        v{version.number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold">{version.name}</span>
          {published && (
            <span className="shrink-0 rounded-md bg-moegi-100 px-1 text-[10px] font-bold text-moegi-500">{t.published}</span>
          )}
          <span className="ml-auto shrink-0 text-xs text-slate-400">{relativeTime(version.createdAt)}</span>
        </div>
        <div className="text-xs text-slate-500">
          {t.actor[version.createdBy.kind]}
          {version.createdBy.name ? t.paren(version.createdBy.name) : ""} · {t.versionMeta(version.revision, version.stepCount)}
        </div>
        {version.note && <p className="mt-1 text-xs whitespace-pre-wrap text-slate-700">{version.note}</p>}
        <div className="mt-1 flex gap-3 text-xs">
          <button type="button" className="text-slate-500 hover:text-ink" onClick={() => void toggleDiff()}>
            {diff ? t.hideDiff : t.showDiff}
          </button>
          <button
            type="button"
            className={`inline-flex items-center gap-1 ${confirm ? "font-semibold text-shu-600" : "text-slate-500 hover:text-shu-600"}`}
            onClick={() => {
              if (!confirm) return setConfirm(true);
              setConfirm(false);
              void restoreVersion(version.number);
            }}
            onBlur={() => setConfirm(false)}
          >
            <Undo2 size={12} aria-hidden="true" />
            {confirm ? t.confirmRestoreAgain : t.restore}
          </button>
          {!published && (
            <button type="button" className="text-slate-500 hover:text-moegi-500" onClick={() => void publish(version.number)}>
              {t.publishThis}
            </button>
          )}
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
  const flowId = useStudio((s) => s.flow?.id);
  const createVersion = useStudio((s) => s.createVersion);
  const openHandOff = useStudio((s) => s.openHandOff);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d] as const)), [stepTypes]);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  // Reload on every flow switch; others may also have saved versions in
  // a shared workspace since we opened it.
  useEffect(() => {
    void loadVersions();
  }, [loadVersions, flowId]);

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
      <PublishedCard />
      <form onSubmit={submit} className="space-y-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.versionName}
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-primary focus:outline-none"
        />
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t.versionNote}
          rows={2}
          className="w-full resize-none rounded border border-slate-300 px-2 py-1 text-sm focus:border-primary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="w-full rounded-lg border border-slate-300 bg-paper px-2 py-1 text-sm font-medium text-ink hover:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-paper"
        >
          {t.saveVersion}
        </button>
        <p className="text-[11px] leading-relaxed text-slate-500">{t.versionsHint}</p>
      </form>
      <section>
        {versions.length === 0 ? (
          <p className="text-sm text-slate-400">{t.versionsEmpty}</p>
        ) : (
          <ol>
            {versions.map((v) => (
              <VersionRow key={`${flowId}-${v.number}`} version={v} defs={defs} />
            ))}
          </ol>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">{t.share}</h3>
        <button
          type="button"
          onClick={() => flowId && void openHandOff(flowId)}
          className="rounded-lg border border-slate-300 px-3 py-1 text-xs hover:bg-slate-100"
        >
          {t.handOff.open}
        </button>
      </section>
    </div>
  );
}
