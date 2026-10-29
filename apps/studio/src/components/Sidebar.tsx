// The one column on the left, as in Linear and Notion: the workspace at the
// top (where the work is stored), the places that are not a scenario (what
// waits for review, logins), the scenarios themselves, and settings at the
// foot, apart from the work. A new kind of work (run history, schedules) is a
// new row in PLACES, not a new button somewhere in a toolbar.
import { Inbox, KeyRound, type LucideIcon, PanelLeftClose, Settings } from "lucide-react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import type { Place } from "../store";
import { useUpdate } from "./AppMenu";
import { useInbox } from "./ReviewDesk";
import { ScenarioList } from "./ScenarioList";

type ItemProps = {
  place: Place;
  icon: LucideIcon;
  label: string;
  count?: number;
  tone?: "shu" | "accent";
  dot?: boolean;
  title?: string;
  onEnter?: () => void;
};

function PlaceItem({ place, icon: Icon, label, count, tone, dot, title, onEnter }: ItemProps) {
  const on = useStudio((s) => s.place === place);
  const setPlace = useStudio((s) => s.setPlace);
  return (
    <button
      type="button"
      onClick={() => {
        setPlace(place);
        onEnter?.();
      }}
      aria-current={on ? "page" : undefined}
      title={title ?? label}
      className={`flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-[13px] ${on ? "bg-slate-200/70 font-semibold text-ink" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
    >
      <Icon size={16} strokeWidth={1.75} className={on ? "text-ink" : "text-slate-500"} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {/* Only what waits on the person is counted (see ui-principles.md). */}
      {count !== undefined && count > 0 && (
        <span className={`min-w-5 rounded-[3px] px-1 text-center text-[11px] leading-[18px] font-semibold text-white ${tone === "accent" ? "bg-accent-500" : "bg-shu-500"}`}>
          {count}
        </span>
      )}
      {dot && <span className="h-2 w-2 rounded-full bg-brand-500" />}
    </button>
  );
}

/** The folder the scenarios live in; the full path and the change are in Settings. */
function Workspace() {
  const workspace = useStudio((s) => s.workspace);
  const setPlace = useStudio((s) => s.setPlace);
  const name = workspace ? (workspace.root.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.root) : "Shikigami";
  return (
    <button
      type="button"
      onClick={() => setPlace("settings")}
      title={workspace ? t.bar.workspaceTitle(workspace.root, workspace.localRoot) : undefined}
      className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[4px] px-1.5 text-[13px] font-semibold text-ink hover:bg-slate-100"
    >
      <img src="/mark.png" alt="" className="h-5 w-5 shrink-0" draggable={false} />
      <span className="truncate">{name}</span>
      {workspace?.shared && <span className="shrink-0 rounded-[2px] bg-mizu-100 px-1 text-[10px] font-normal text-mizu-500">{t.workspaceShared}</span>}
    </button>
  );
}

export const SIDEBAR_WIDTH = 240;

export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  // Sent-back scenarios wait on the AI, not on the person.
  const inbox = useInbox().filter((i) => !i.waiting);
  const open = useStudio((s) => s.open);
  const currentId = useStudio((s) => s.scenario?.id);
  // Land on something to review rather than a scenario with nothing new.
  const enterReview = () => {
    const first = inbox[0];
    if (first && !inbox.some((i) => i.scenarioId === currentId)) void open(first.scenarioId);
  };
  const asks = useStudio((s) => s.secretRequests.length);
  const update = useUpdate();
  return (
    <aside aria-label={t.shell.places} style={{ width: SIDEBAR_WIDTH }} className="flex h-full shrink-0 flex-col border-r border-slate-200 bg-paper">
      {/* The top of the window: room to drag it by, level with the title bar. */}
      <div data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-2 select-none">
        <Workspace />
        <button
          type="button"
          onClick={onCollapse}
          title={`${t.list.collapse} (Ctrl+B)`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-100 hover:text-ink"
        >
          <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <nav className="space-y-px px-2 pb-1">
        <PlaceItem place="review" icon={Inbox} label={t.awaitingReview} count={inbox.length} title={t.bar.reviewTitle} onEnter={enterReview} />
        <PlaceItem
          place="secrets"
          icon={KeyRound}
          label={t.secrets}
          count={asks}
          tone="accent"
          title={asks > 0 ? t.bar.secretAskTitle : t.secretsIntro}
        />
      </nav>
      <div className="min-h-0 flex-1">
        <ScenarioList />
      </div>
      <div className="border-t border-slate-200 px-2 py-1.5">
        <PlaceItem place="settings" icon={Settings} label={t.shell.settings} dot={update !== null} title={update ? `${t.updateAvailable} v${update}` : t.shell.settings} />
      </div>
    </aside>
  );
}
