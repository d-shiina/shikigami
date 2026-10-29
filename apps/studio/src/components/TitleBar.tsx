// The window's title bar, right of the rail (which holds the mark), read left
// to right like the rest of Studio: where the work is stored, what is open,
// then what to do with it, ending with Run, and the AI pane and the window
// buttons at the edge. The window holds one
// scenario at a time, so the bar that names the window names the scenario
// too, as an editor names its document. Everything left between controls is
// room to drag the window; double-click maximizes.
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import type { Place } from "../store";
import { AgentButton } from "./AgentPane";
import { ScenarioActions, ScenarioTitle, type View } from "./Toolbar";
import { WindowControls } from "./WindowControls";

/** The folder the scenarios live in, by its last name; the full path and the change are in Settings. */
function Workspace() {
  const workspace = useStudio((s) => s.workspace);
  const setPlace = useStudio((s) => s.setPlace);
  if (!workspace) return null;
  const name = workspace.root.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.root;
  return (
    <button
      type="button"
      onClick={() => setPlace("settings")}
      title={t.bar.workspaceTitle(workspace.root, workspace.localRoot)}
      className="flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-[3px] px-1.5 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-ink"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
        <path d="M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <span className="truncate @max-[1040px]/title:hidden">{name}</span>
      {workspace.shared && <span className="shrink-0 rounded-[2px] @max-[1040px]/title:hidden bg-mizu-100 px-1 text-[10px] text-mizu-500">{t.workspaceShared}</span>}
    </button>
  );
}

const PAGE_TITLE: Partial<Record<Place, () => string>> = {
  secrets: () => t.secrets,
  settings: () => t.shell.settings,
};

export function TitleBar({ view, onView }: { view: View; onView: (view: View) => void }) {
  const place = useStudio((s) => s.place);
  const hasScenario = useStudio((s) => s.scenario !== null);
  // The scenario places open a scenario into the editor; the others are pages.
  const editing = (place === "scenarios" || place === "review") && hasScenario;
  const page = PAGE_TITLE[place]?.();
  return (
    <header data-tauri-drag-region className="@container/title relative flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 bg-sheet pl-2 select-none">
      <Workspace />
      {(editing || page) && (
        <span data-tauri-drag-region className="text-slate-300" aria-hidden="true">
          ›
        </span>
      )}
      {editing ? <ScenarioTitle /> : page && <span className="truncate text-[13px] font-bold">{page}</span>}
      <span data-tauri-drag-region className="min-w-4 flex-1 self-stretch" />
      {editing && <ScenarioActions view={view} onView={onView} />}
      {editing && <span className="mx-1 h-5 w-px bg-slate-200" />}
      <AgentButton />
      <WindowControls />
    </header>
  );
}
