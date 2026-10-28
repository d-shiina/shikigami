import { useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

export function ScenarioList() {
  const summaries = useStudio((s) => s.summaries);
  const currentId = useStudio((s) => s.scenario?.id);
  const open = useStudio((s) => s.open);
  const create = useStudio((s) => s.create);
  const duplicate = useStudio((s) => s.duplicate);
  const remove = useStudio((s) => s.remove);
  const [name, setName] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await create(name.trim() || t.defaultScenarioName);
    setName("");
  };

  return (
    <aside className="flex h-full flex-col border-r border-slate-200 bg-sheet">
      <div className="px-3 pt-4 pb-2 font-serif text-sm font-semibold text-ink">{t.scenarios}</div>
      <form onSubmit={submit} className="flex gap-1 px-3 pb-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.newScenarioPrompt}
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm focus:border-ink focus:outline-none"
        />
        <button type="submit" className="rounded bg-ink px-2 py-1 text-sm text-paper hover:bg-slate-700">
          {t.newScenario}
        </button>
      </form>
      <ul className="flex-1 overflow-y-auto">
        {summaries.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">{t.noScenarios}</li>}
        {summaries.map((s) => (
          <li key={s.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => open(s.id)}
              onKeyDown={(e) => e.key === "Enter" && open(s.id)}
              className={`group cursor-pointer border-l-4 px-3 py-2 ${
                s.id === currentId ? "border-shu-500 bg-slate-100" : "border-transparent hover:bg-slate-50"
              }`}
            >
              <div className="truncate text-sm font-medium">{s.name}</div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>
                  {s.stepCount} steps · rev {s.revision}
                </span>
                <span className="ml-auto hidden gap-1 group-hover:flex">
                  <button
                    type="button"
                    className="rounded px-1 hover:bg-slate-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      void duplicate(s.id);
                    }}
                  >
                    {t.duplicate}
                  </button>
                  <button
                    type="button"
                    className={`rounded px-1 ${confirmId === s.id ? "bg-shu-600 text-white" : "hover:bg-shu-100 hover:text-shu-600"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirmId === s.id) {
                        setConfirmId(null);
                        void remove(s.id);
                      } else {
                        setConfirmId(s.id);
                      }
                    }}
                    onBlur={() => setConfirmId(null)}
                    title={t.confirmDelete}
                  >
                    {confirmId === s.id ? "削除する" : t.delete}
                  </button>
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
