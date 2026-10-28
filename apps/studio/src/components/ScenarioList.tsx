import { useRef, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

/** Picks a bundle or scenario file and asks what to do when it already exists. */
function ImportBox() {
  const importFile = useStudio((s) => s.importFile);
  const pending = useStudio((s) => s.pendingImport);
  const cancelImport = useStudio((s) => s.cancelImport);
  const input = useRef<HTMLInputElement>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await importFile(await file.text());
  };

  return (
    <div className="px-3 pb-3">
      <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={onPick} />
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="w-full rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-ink hover:text-ink"
      >
        {t.importScenario}
      </button>
      {pending && (
        <div className="mt-2 space-y-1.5 rounded border border-shu-100 bg-paper p-2 text-xs">
          <p>
            {t.importConflict}
            {pending.name && <span className="font-semibold">「{pending.name}」</span>}
          </p>
          <button
            type="button"
            onClick={() => void importFile(pending.contents, "update")}
            className="w-full rounded bg-ink px-2 py-1 text-paper hover:bg-slate-700"
          >
            {t.importUpdate}
          </button>
          <button
            type="button"
            onClick={() => void importFile(pending.contents, "copy")}
            className="w-full rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
          >
            {t.importCopy}
          </button>
          <button type="button" onClick={cancelImport} className="w-full text-slate-500 hover:underline">
            {t.cancel}
          </button>
        </div>
      )}
    </div>
  );
}

/** Where scenarios are stored, and switching to another (e.g. shared) folder. */
function WorkspaceFooter() {
  const workspace = useStudio((s) => s.workspace);
  const setWorkspace = useStudio((s) => s.setWorkspace);
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState("");
  const [shared, setShared] = useState(false);
  if (!workspace) return null;

  return (
    <div className="border-t border-slate-200 px-3 py-2 text-[11px] text-slate-500">
      <div className="flex items-center gap-1">
        <span>{t.workspace}</span>
        {workspace.shared && <span className="rounded bg-mizu-100 px-1 text-mizu-500">{t.workspaceShared}</span>}
        <button
          type="button"
          className="ml-auto hover:text-ink"
          onClick={() => {
            setPath(workspace.root);
            setShared(workspace.shared);
            setEditing(!editing);
          }}
        >
          {t.changeWorkspace}
        </button>
      </div>
      <div className="truncate font-mono" title={workspace.root}>
        {workspace.root}
      </div>
      {editing && (
        <form
          className="mt-2 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void setWorkspace(path.trim(), shared);
          }}
        >
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t.workspacePath}
            className="w-full rounded border border-slate-300 px-1.5 py-0.5 font-mono text-[11px] text-ink focus:border-ink focus:outline-none"
          />
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            {t.workspaceSharedLabel}
          </label>
          <button type="submit" className="w-full rounded bg-ink px-2 py-1 text-paper hover:bg-slate-700">
            {t.workspaceApply}
          </button>
        </form>
      )}
    </div>
  );
}

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
      <ImportBox />
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
      <WorkspaceFooter />
    </aside>
  );
}
