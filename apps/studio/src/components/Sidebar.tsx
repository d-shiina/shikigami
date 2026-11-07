// The one column on the left, as in Linear and Notion: the workspace at the
// top (where the work is stored), then the places: the flow library with
// the open flow under it, what waits for review, logins, and settings at
// the foot, apart from the work. Lists live in their places, not here. Runs
// (schedules now, run history next) are one row here. Above the places,
// the AI: its chat opens right beside this column, as Notion AI and Linear's
// agent do, since it works on whatever place is open.
//
// Folded (Ctrl+B, or a window too narrow for it), the column keeps its icons
// as a strip, as Linear and VS Code do: the places stay one click away and
// their counts stay in sight. Hovering an icon names it.
import { AppWindow, CalendarClock, Inbox, KeyRound, LayoutList, type LucideIcon, MessageSquareText, PanelLeftClose, PanelLeftOpen, Settings2, Workflow } from "lucide-react";
import { anyBusy, useAgent } from "../agent";
import { useStudio, useStudioApi } from "../context";
import { SIDEBAR_MINI } from "../lib/fit";
import { t } from "../lib/i18n";
import { runnerApi } from "../runner/api";
import type { Place } from "../store";
import { useUpdate } from "./AppMenu";
import { useInbox } from "./ReviewDesk";

type ItemProps = {
  icon: LucideIcon;
  label: string;
  on: boolean;
  onClick: () => void;
  count?: number;
  tone?: "shu" | "accent";
  dot?: boolean;
  /** The dot pulses: something is under way. */
  busy?: boolean;
  title?: string;
  indent?: boolean;
  /** The folded sidebar: the icon alone, named on hover. */
  mini?: boolean;
};

function Item({ icon: Icon, label, on, onClick, count, tone, dot, busy, title, indent, mini }: ItemProps) {
  if (mini) return <MiniItem icon={Icon} label={label} on={on} onClick={onClick} count={count} tone={tone} dot={dot} busy={busy} title={title} />;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on ? "page" : undefined}
      title={title ?? label}
      className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-[13px] ${indent ? "pl-7" : "pl-2"} ${on ? "bg-slate-200/70 font-semibold text-ink" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
    >
      <Icon size={indent ? 14 : 16} strokeWidth={1.75} className={`shrink-0 ${on ? "text-ink" : "text-slate-500"}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {/* Only what waits on the person is counted (see ui-principles.md). */}
      {count !== undefined && count > 0 && (
        <span className={`min-w-5 rounded-md px-1 text-center text-[11px] leading-[18px] font-semibold text-white ${tone === "accent" ? "bg-accent-500" : "bg-shu-500"}`}>
          {count}
        </span>
      )}
      {(dot || busy) && <span className={`h-2 w-2 rounded-full bg-brand-500 ${busy ? "animate-pulse" : ""}`} />}
    </button>
  );
}

/** The name shown beside an icon of the folded sidebar while it is hovered or focused. */
function Tip({ label, note }: { label: string; note?: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute top-1/2 left-full z-50 ml-2 hidden w-max max-w-64 -translate-y-1/2 rounded-md border border-slate-200 bg-sheet px-2 py-1 text-left text-[12px] leading-snug font-medium text-ink shadow-lifted group-hover:block group-focus-visible:block"
    >
      {label}
      {note && <span className="mt-0.5 block font-normal text-slate-600">{note}</span>}
    </span>
  );
}

function MiniItem({ icon: Icon, label, on, onClick, count, tone, dot, busy, title }: Omit<ItemProps, "indent" | "mini">) {
  const badge = count !== undefined && count > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on ? "page" : undefined}
      aria-label={badge ? `${label} (${count})` : label}
      className={`group relative mx-auto grid h-8 w-8 place-items-center rounded-lg ${on ? "bg-slate-200/70 text-ink" : "text-slate-500 hover:bg-slate-100 hover:text-ink"}`}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      {badge && (
        <span
          className={`absolute -top-0.5 -right-0.5 min-w-4 rounded-md px-0.5 text-center text-[10px] leading-4 font-semibold text-white ring-2 ring-frame ${tone === "accent" ? "bg-accent-500" : "bg-shu-500"}`}
        >
          {count}
        </span>
      )}
      {!badge && (dot || busy) && <span className={`absolute top-1 right-1 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-frame ${busy ? "animate-pulse" : ""}`} />}
      <Tip label={label} note={title && title !== label ? title : undefined} />
    </button>
  );
}

/** Opens and closes the AI's chat, which sits right of the sidebar. */
function AgentItem({ mini }: { mini?: boolean }) {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const busy = useAgent(anyBusy);
  // A conversation finished while the pane was closed or showing another.
  const news = useAgent((s) => s.chats.some((c) => c.unread));
  // Named by what it is, not by the AI in use (Claude Code, Codex, …): which
  // one is set in Settings and shown in the pane's head.
  const name = useAgent((s) => s.info?.name ?? "AI");
  return <Item icon={MessageSquareText} label={t.shell.aiChat} on={open} onClick={() => setOpen(!open)} busy={busy} dot={news} title={`${t.shell.aiChat}：${name}（Ctrl+J）`} mini={mini} />;
}

/** The folder the flows live in; the full path and the change are in Settings. */
function Workspace() {
  const workspace = useStudio((s) => s.workspace);
  const setPlace = useStudio((s) => s.setPlace);
  const name = workspace ? (workspace.root.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.root) : "Shikigami";
  return (
    <button
      type="button"
      onClick={() => setPlace("settings")}
      title={workspace ? t.bar.workspaceTitle(workspace.root, workspace.localRoot) : undefined}
      className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 text-[13px] font-semibold text-ink hover:bg-slate-100"
    >
      <img src="/mark.png" alt="" className="h-5 w-5 shrink-0" draggable={false} />
      <span className="truncate">{name}</span>
      {workspace?.shared && <span className="shrink-0 rounded-sm bg-mizu-100 px-1 text-[10px] font-normal text-mizu-500">{t.workspaceShared}</span>}
    </button>
  );
}

/**
 * `mini`: folded to its icons; `onToggle` then unfolds it (or lays it over
 * the chart when the window has no room for it).
 */
export function Sidebar({ width, onToggle, mini = false }: { width: number; onToggle: () => void; mini?: boolean }) {
  const place = useStudio((s) => s.place);
  const setPlace = useStudio((s) => s.setPlace);
  const flow = useStudio((s) => s.flow);
  // Sent-back flows wait on the AI, not on the person.
  const inbox = useInbox().filter((i) => !i.waiting);
  const open = useStudio((s) => s.open);
  // Land on something to review rather than a flow with nothing new.
  const enterReview = () => {
    setPlace("review");
    const first = inbox[0];
    if (first && !inbox.some((i) => i.flowId === flow?.id)) void open(first.flowId);
  };
  const asks = useStudio((s) => s.secretRequests.length);
  const update = useUpdate();
  const go = (p: Place) => () => setPlace(p);
  const store = useStudioApi();
  return (
    <aside aria-label={t.shell.places} style={{ width: mini ? SIDEBAR_MINI : width }} className="relative z-20 flex h-full shrink-0 flex-col bg-frame">
      {/* The top of the window: room to drag it by, level with the title bar. */}
      <div data-tauri-drag-region className={`flex h-10 shrink-0 items-center gap-1 select-none ${mini ? "justify-center" : "pr-1.5 pl-2"}`}>
        {!mini && <Workspace />}
        <button
          type="button"
          onClick={onToggle}
          aria-label={mini ? t.list.expand : t.list.collapse}
          title={`${mini ? t.list.expand : t.list.collapse} (Ctrl+B)`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-ink"
        >
          {mini ? <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" /> : <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
      <div className={mini ? "px-1.5 pt-1 pb-2" : "px-2 pt-1 pb-2"}>
        <AgentItem mini={mini} />
      </div>
      <nav className={`flex-1 border-t border-slate-200 pt-2 ${mini ? "space-y-1 px-1.5" : "space-y-px px-2"}`}>
        <Item icon={LayoutList} label={t.flows} on={place === "library"} onClick={go("library")} mini={mini} />
        {/* The open flow, under the library it came from: the way back to the editor. */}
        {flow && <Item icon={Workflow} label={flow.name} on={place === "flows"} onClick={go("flows")} indent mini={mini} />}
        <Item icon={Inbox} label={t.awaitingReview} on={place === "review"} onClick={enterReview} count={inbox.length} title={t.bar.reviewTitle} mini={mini} />
        <Item icon={CalendarClock} label={t.runs.place} on={place === "runs"} onClick={go("runs")} title={t.runs.placeTitle} mini={mini} />
        <Item
          icon={KeyRound}
          label={t.secrets}
          on={place === "secrets"}
          onClick={go("secrets")}
          count={asks}
          tone="accent"
          title={asks > 0 ? t.bar.secretAskTitle : t.secretsIntro}
          mini={mini}
        />
      </nav>
      <div className={mini ? "space-y-1 px-1.5 py-1.5" : "space-y-px px-2 py-1.5"}>
        {/* Another window, not a place: the published scenarios for the people who only run them. */}
        <Item icon={AppWindow} label={t.runner.open} on={false} onClick={() => void runnerApi.openWindow().catch((e: unknown) => store.setState({ error: e instanceof Error ? e.message : String(e) }))} title={t.runner.openTitle} mini={mini} />
        <Item
          icon={Settings2}
          label={t.shell.settings}
          on={place === "settings"}
          onClick={go("settings")}
          dot={update !== null}
          title={update ? `${t.updateAvailable} v${update}` : t.shell.settings}
          mini={mini}
        />
      </div>
    </aside>
  );
}
