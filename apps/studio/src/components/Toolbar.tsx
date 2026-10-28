import { useMemo } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

const CATEGORY_LABEL: Record<string, string> = {
  control: "制御",
  variable: "変数",
  log: "ログ",
  flow: "フロー",
  browser: "ブラウザ",
  windows: "Windows",
  file: "ファイル",
  other: "その他",
};

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "danger" }) {
  const { tone, className, ...rest } = props;
  const color =
    tone === "primary"
      ? "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300"
      : tone === "danger"
        ? "bg-red-600 text-white hover:bg-red-700"
        : "border border-slate-300 bg-white hover:bg-slate-100 disabled:text-slate-300";
  return (
    <button type="button" className={`rounded px-2.5 py-1 text-sm ${color} ${className ?? ""}`} {...rest} />
  );
}

export function Toolbar() {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const canUndo = useStudio((s) => s.canUndo);
  const canRedo = useStudio((s) => s.canRedo);
  const validation = useStudio((s) => s.validation);
  const run = useStudio((s) => s.run);
  const actions = useStudio((s) => s);

  const groups = useMemo(() => {
    const map = new Map<string, typeof stepTypes>();
    for (const def of stepTypes) map.set(def.category, [...(map.get(def.category) ?? []), def]);
    return [...map.entries()];
  }, [stepTypes]);

  if (!scenario) return null;
  const errors = validation?.issues.filter((i) => i.severity === "error").length ?? 0;
  const running = run?.status === "running";
  const stepSelected = selection?.kind === "step";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
      <div className="mr-2 min-w-0">
        <div className="truncate font-semibold">{scenario.name}</div>
        <div className="text-xs text-slate-500">
          {t.revision} {scenario.revision}
        </div>
      </div>
      <Button onClick={() => actions.undo()} disabled={!canUndo} title="Ctrl+Z">
        ↶ {t.undo}
      </Button>
      <Button onClick={() => actions.redo()} disabled={!canRedo} title="Ctrl+Y">
        ↷ {t.redo}
      </Button>
      <span className="mx-1 h-6 w-px bg-slate-200" />
      <select
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        value=""
        onChange={(e) => e.target.value && actions.addStep(e.target.value)}
        title={selection?.kind === "slot" ? t.addInto : t.addAfterSelection}
      >
        <option value="">＋ {t.addStep}</option>
        {groups.map(([category, defs]) => (
          <optgroup key={category} label={CATEGORY_LABEL[category] ?? category}>
            {defs.map((d) => (
              <option key={d.type} value={d.type}>
                {d.label}（{d.type}）
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <Button onClick={() => actions.moveSelected(-1)} disabled={!stepSelected}>
        ↑ {t.moveUp}
      </Button>
      <Button onClick={() => actions.moveSelected(1)} disabled={!stepSelected}>
        ↓ {t.moveDown}
      </Button>
      <Button onClick={() => actions.removeSelected()} disabled={!stepSelected}>
        ✕ {t.delete}
      </Button>
      <span className="ml-auto" />
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${errors ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}
      >
        {errors ? `エラー ${errors} 件` : "検証OK"}
      </span>
      {running ? (
        <Button tone="danger" onClick={() => actions.stopRun()}>
          ■ {t.stop}
        </Button>
      ) : (
        <Button tone="primary" onClick={() => actions.startRun()} disabled={errors > 0}>
          ▶ {t.run}
        </Button>
      )}
    </div>
  );
}
